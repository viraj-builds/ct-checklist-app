import { Reader, decodeUtf8 } from "./bytes";

// ---------------------------------------------------------------------------
// Minimal DEX reader. It does three things:
//   1. lists every class defined in the file,
//   2. finds call sites (invoke-*) of a set of target methods from code that is
//      NOT the SDK itself, capturing constant string arguments where possible
//      (event names, channel ids, account ids),
//   3. reads static String constants of selected classes (BuildConfig).
// Format reference: https://source.android.com/docs/core/runtime/dex-format
// ---------------------------------------------------------------------------

export interface DexTarget {
  key: string; // stable id used by the rule engine, e.g. "ct.onUserLogin"
  cls: string; // type descriptor, e.g. "Lcom/clevertap/android/sdk/CleverTapAPI;"
  names: string[]; // method names that count as this target
  strArgs?: number[]; // argument positions (in the register list) to capture as strings
}

export interface CallSite {
  caller: string; // dotted class name of the calling code
  method: string; // calling method name
  strings: string[]; // captured constant string args (may be empty)
}

export interface DexScanResult {
  classes: Set<string>;
  calls: Record<string, CallSite[]>;
  staticStrings: Record<string, Record<string, string>>; // class -> field -> value
  methodRefs: Set<string>; // "Lcls;->name" for target classes referenced at all
  ctSubclasses: Record<string, string>; // app class -> CleverTap superclass (e.g. extends sdk.Application)
}

// Instruction length (in 16-bit code units) per opcode.
const OP_LEN = new Uint8Array(256);
(() => {
  const set = (from: number, to: number, len: number) => {
    for (let i = from; i <= to; i++) OP_LEN[i] = len;
  };
  set(0x00, 0xff, 1);
  set(0x02, 0x02, 2); set(0x03, 0x03, 3);
  set(0x05, 0x05, 2); set(0x06, 0x06, 3);
  set(0x08, 0x08, 2); set(0x09, 0x09, 3);
  set(0x13, 0x13, 2); set(0x14, 0x14, 3); set(0x15, 0x16, 2);
  set(0x17, 0x17, 3); set(0x18, 0x18, 5); set(0x19, 0x1a, 2);
  set(0x1b, 0x1b, 3); set(0x1c, 0x1c, 2); set(0x1f, 0x20, 2);
  set(0x22, 0x23, 2); set(0x24, 0x26, 3); set(0x29, 0x29, 2);
  set(0x2a, 0x2c, 3); set(0x2d, 0x3d, 2); set(0x44, 0x6d, 2);
  set(0x6e, 0x72, 3); set(0x74, 0x78, 3); set(0x90, 0xaf, 2);
  set(0xd0, 0xe2, 2); set(0xfa, 0xfb, 4); set(0xfc, 0xfd, 3);
  set(0xfe, 0xff, 2);
})();

function isInvoke(op: number) {
  return (op >= 0x6e && op <= 0x72) || (op >= 0x74 && op <= 0x78) || op === 0xfa || op === 0xfb;
}
function isRangeInvoke(op: number) {
  return (op >= 0x74 && op <= 0x78) || op === 0xfb;
}

export function scanDex(
  buf: Uint8Array,
  targets: DexTarget[],
  opts: { skipCallerPrefixes: string[]; staticClasses: string[] },
): DexScanResult {
  const r = new Reader(buf);
  const result: DexScanResult = {
    classes: new Set(),
    calls: {},
    staticStrings: {},
    methodRefs: new Set(),
    ctSubclasses: {},
  };
  if (buf.length < 0x70 || decodeUtf8(buf.subarray(0, 3)) !== "dex") return result;

  const stringIdsSize = r.u32(56);
  const stringIdsOff = r.u32(60);
  const typeIdsSize = r.u32(64);
  const typeIdsOff = r.u32(68);
  const fieldIdsOff = r.u32(84);
  const methodIdsSize = r.u32(88);
  const methodIdsOff = r.u32(92);
  const classDefsSize = r.u32(96);
  const classDefsOff = r.u32(100);

  const strCache = new Map<number, string>();
  const str = (idx: number): string => {
    if (idx >= stringIdsSize) return "";
    let s = strCache.get(idx);
    if (s !== undefined) return s;
    const off = r.u32(stringIdsOff + idx * 4);
    let [, o] = r.uleb(off); // utf16 length — skip
    const start = o;
    while (o < buf.length && buf[o] !== 0) o++;
    s = decodeUtf8(buf.subarray(start, o)); // MUTF-8 ≈ UTF-8 for our purposes
    strCache.set(idx, s);
    return s;
  };
  const typeName = (tIdx: number) => (tIdx < typeIdsSize ? str(r.u32(typeIdsOff + tIdx * 4)) : "");

  // --- map method ids -> target keys ---------------------------------
  const targetsByClass = new Map<string, DexTarget[]>();
  for (const t of targets) {
    const arr = targetsByClass.get(t.cls) ?? [];
    arr.push(t);
    targetsByClass.set(t.cls, arr);
  }
  const typeIsTarget = new Map<number, DexTarget[]>();
  for (let i = 0; i < typeIdsSize; i++) {
    const tg = targetsByClass.get(typeName(i));
    if (tg) typeIsTarget.set(i, tg);
  }
  const methodTarget = new Map<number, DexTarget>();
  if (typeIsTarget.size > 0) {
    for (let m = 0; m < methodIdsSize; m++) {
      const base = methodIdsOff + m * 8;
      const tg = typeIsTarget.get(r.u16(base));
      if (!tg) continue;
      const name = str(r.u32(base + 4));
      for (const t of tg) {
        if (t.names.includes(name)) {
          methodTarget.set(m, t);
          result.methodRefs.add(`${t.cls}->${name}`);
        }
      }
    }
  }

  const staticSet = new Set(opts.staticClasses);

  // --- walk class defs ------------------------------------------------
  for (let c = 0; c < classDefsSize; c++) {
    const def = classDefsOff + c * 32;
    const cls = typeName(r.u32(def));
    result.classes.add(cls);
    const superIdx = r.u32(def + 8);
    if (superIdx !== 0xffffffff && !cls.startsWith("Lcom/clevertap/")) {
      const sup = typeName(superIdx);
      if (sup.startsWith("Lcom/clevertap/")) result.ctSubclasses[cls] = sup;
    }

    const classDataOff = r.u32(def + 24);
    const staticValuesOff = r.u32(def + 28);

    if (staticSet.has(cls) && classDataOff && staticValuesOff) {
      try {
        result.staticStrings[cls] = readStaticStrings(r, str, fieldIdsOff, classDataOff, staticValuesOff);
      } catch {
        /* corrupt / unusual encoding — ignore */
      }
    }

    if (methodTarget.size === 0 || !classDataOff) continue;
    if (opts.skipCallerPrefixes.some((p) => cls.startsWith(p))) continue;

    try {
      walkClassCode(r, buf, cls, classDataOff, methodIdsOff, str, methodTarget, result);
    } catch {
      /* skip malformed class */
    }
  }
  return result;
}

function walkClassCode(
  r: Reader,
  buf: Uint8Array,
  cls: string,
  classDataOff: number,
  methodIdsOff: number,
  str: (i: number) => string,
  methodTarget: Map<number, DexTarget>,
  result: DexScanResult,
) {
  let o = classDataOff;
  const next = () => {
    const [v, n] = r.uleb(o);
    o = n;
    return v;
  };
  const sf = next();
  const inf = next();
  const dm = next();
  const vm = next();
  for (let i = 0; i < sf + inf; i++) {
    next();
    next();
  }
  const dotted = cls.slice(1, -1).replace(/\//g, ".");

  for (const count of [dm, vm]) {
    let methodIdx = 0;
    for (let i = 0; i < count; i++) {
      methodIdx += next();
      next(); // access flags
      const codeOff = next();
      if (!codeOff) continue;

      const insnsSize = r.u32(codeOff + 12);
      const insns = codeOff + 16;
      const end = insns + insnsSize * 2;
      if (end > buf.length) continue;

      const regStr = new Map<number, string>();
      let pc = insns;
      while (pc < end) {
        const unit = r.u16(pc);
        const op = unit & 0xff;

        if (op === 0x00 && unit !== 0) {
          // payload pseudo-instructions
          const ident = unit;
          let len = 1;
          if (ident === 0x0100) len = r.u16(pc + 2) * 2 + 4;
          else if (ident === 0x0200) len = r.u16(pc + 2) * 4 + 2;
          else if (ident === 0x0300) {
            const width = r.u16(pc + 2);
            const size = r.u32(pc + 4);
            len = Math.ceil((size * width) / 2) + 4;
          }
          pc += len * 2;
          continue;
        }

        if (op === 0x1a) {
          regStr.set(unit >> 8, str(r.u16(pc + 2)));
        } else if (op === 0x1b) {
          regStr.set(unit >> 8, str(r.u32(pc + 2)));
        } else if (isInvoke(op)) {
          const mIdx = r.u16(pc + 2);
          const t = methodTarget.get(mIdx);
          if (t) {
            const regs: number[] = [];
            if (isRangeInvoke(op)) {
              const n = unit >> 8;
              const first = r.u16(pc + 4);
              for (let k = 0; k < n; k++) regs.push(first + k);
            } else {
              const n = unit >> 12;
              const g = (unit >> 8) & 0xf;
              const fedc = r.u16(pc + 4);
              const all = [fedc & 0xf, (fedc >> 4) & 0xf, (fedc >> 8) & 0xf, (fedc >> 12) & 0xf, g];
              for (let k = 0; k < n; k++) regs.push(all[k]);
            }
            const strings: string[] = [];
            for (const a of t.strArgs ?? []) {
              const s = regStr.get(regs[a]);
              if (s) strings.push(s);
            }
            const callerMethod = str(r.u32(methodIdsOff + methodIdx * 8 + 4));
            (result.calls[t.key] ??= []).push({ caller: dotted, method: callerMethod, strings });
          }
        } else if (op >= 0x01 && op <= 0x19) {
          // moves / consts / move-result overwrite vAA (low byte for 12x forms)
          const narrow = op === 0x01 || op === 0x04 || op === 0x07 || op === 0x12;
          const dest = narrow ? (unit >> 8) & 0xf : op === 0x03 || op === 0x06 || op === 0x09 ? r.u16(pc + 2) : unit >> 8;
          const src = op === 0x07 ? regStr.get(unit >> 12) : undefined; // move-object keeps the string
          if (src !== undefined) regStr.set(dest, src);
          else regStr.delete(dest);
        }

        pc += (OP_LEN[op] || 1) * 2;
      }
    }
  }
}

function readStaticStrings(
  r: Reader,
  str: (i: number) => string,
  fieldIdsOff: number,
  classDataOff: number,
  staticValuesOff: number,
): Record<string, string> {
  // static field order from class_data
  let o = classDataOff;
  const next = () => {
    const [v, n] = r.uleb(o);
    o = n;
    return v;
  };
  const sf = next();
  next();
  next();
  next();
  const fieldNames: string[] = [];
  let fIdx = 0;
  for (let i = 0; i < sf; i++) {
    fIdx += next();
    next();
    fieldNames.push(str(r.u32(fieldIdsOff + fIdx * 8 + 4)));
  }

  const out: Record<string, string> = {};
  const [size, start] = r.uleb(staticValuesOff);
  let p = start;
  for (let i = 0; i < size && i < fieldNames.length; i++) {
    const b = r.u8(p++);
    const type = b & 0x1f;
    const arg = b >> 5;
    if (type === 0x17) {
      let idx = 0;
      for (let k = 0; k <= arg; k++) idx |= r.u8(p + k) << (8 * k);
      out[fieldNames[i]] = str(idx >>> 0);
      p += arg + 1;
    } else if (type === 0x04) {
      let v = 0;
      for (let k = 0; k <= arg; k++) v |= r.u8(p + k) << (8 * k);
      // sign-extend
      const bits = (arg + 1) * 8;
      if (bits < 32 && v & (1 << (bits - 1))) v |= ~0 << bits;
      out[fieldNames[i]] = String(v);
      p += arg + 1;
    } else if (type === 0x1e || type === 0x1f) {
      if (type === 0x1f) out[fieldNames[i]] = arg ? "true" : "false";
    } else if (type === 0x1c || type === 0x1d) {
      break; // arrays/annotations: not needed, stop safely
    } else {
      p += arg + 1;
    }
  }
  return out;
}

