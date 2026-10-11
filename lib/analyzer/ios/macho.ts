// Minimal Mach-O reader for the iOS analyzer: picks the arm64 slice of a fat
// binary, lists linked dylibs, reads the ObjC selector / class-name string
// sections, resolves which selectors the code actually references
// (__objc_selrefs), the C-string section, imported/defined symbols, the
// build platform and the embedded entitlements.

import { findXmlPlist, type PlistDict } from "./plist";

const LC_SEGMENT_64 = 0x19;
const LC_SYMTAB = 0x2;
const LC_LOAD_DYLIB = 0xc;
const LC_LOAD_WEAK_DYLIB = 0x80000018;
const LC_REEXPORT_DYLIB = 0x8000001f;
const LC_LAZY_LOAD_DYLIB = 0x20;
const LC_CODE_SIGNATURE = 0x1d;
const LC_BUILD_VERSION = 0x32;
const LC_VERSION_MIN_IPHONEOS = 0x25;
const CPU_ARM64 = 0x0100000c;
const CPU_X86_64 = 0x01000007;

export interface Section {
  seg: string;
  name: string;
  addr: number;
  size: number;
  offset: number;
}

export interface MachO {
  arch: string;
  archs: string[];
  dylibs: string[];
  platform?: "ios" | "ios-simulator" | "other";
  minOs?: string;
  sections: Section[];
  /** selector names present in __objc_methname (called or implemented) */
  methnames: Set<string>;
  /** selectors the code references through __objc_selrefs */
  selrefs: Set<string>;
  classnames: Set<string>;
  cstrings: string[];
  undefinedSymbols: string[]; // CleverTap-related imports only
  definedSymbols: string[]; // CleverTap-related definitions only
  entitlements?: PlistDict;
}

const latin1 = new TextDecoder("latin1");

export function isMachO(buf: Uint8Array): boolean {
  if (buf.length < 8) return false;
  const be = (buf[0] << 24) | (buf[1] << 16) | (buf[2] << 8) | buf[3];
  const le = buf[0] | (buf[1] << 8) | (buf[2] << 16) | (buf[3] << 24);
  return be === (0xcafebabe | 0) || be === (0xcafebabf | 0) || le === (0xfeedfacf | 0) || le === (0xfeedface | 0);
}

/** Parse a (possibly fat) Mach-O. Prefers the arm64 slice. */
export function parseMachO(file: Uint8Array): MachO | null {
  if (!isMachO(file)) return null;
  const dv = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const magicBe = dv.getUint32(0, false);
  let slice = file;
  const archs: string[] = [];
  if (magicBe === 0xcafebabe || magicBe === 0xcafebabf) {
    const n = dv.getUint32(4, false);
    const is64 = magicBe === 0xcafebabf;
    const entry = is64 ? 32 : 20;
    let pick: { off: number; size: number } | null = null;
    for (let i = 0; i < Math.min(n, 16); i++) {
      const b = 8 + i * entry;
      const cpu = dv.getUint32(b, false);
      const off = is64 ? Number(dv.getBigUint64(b + 8, false)) : dv.getUint32(b + 8, false);
      const size = is64 ? Number(dv.getBigUint64(b + 16, false)) : dv.getUint32(b + 12, false);
      archs.push(archName(cpu));
      if (cpu === CPU_ARM64 || !pick) pick = { off, size };
      if (cpu === CPU_ARM64) break;
    }
    if (!pick || pick.off + pick.size > file.length) return null;
    slice = file.subarray(pick.off, pick.off + pick.size);
  }
  return parseThin(slice, archs);
}

function archName(cpu: number) {
  return cpu === CPU_ARM64 ? "arm64" : cpu === CPU_X86_64 ? "x86_64" : `cpu${cpu.toString(16)}`;
}

function parseThin(buf: Uint8Array, fatArchs: string[]): MachO | null {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint32(0, true) !== 0xfeedfacf) return null; // 32-bit iOS builds are long gone
  const cpu = dv.getUint32(4, true);
  const ncmds = dv.getUint32(16, true);
  const out: MachO = {
    arch: archName(cpu),
    archs: fatArchs.length ? fatArchs : [archName(cpu)],
    dylibs: [],
    sections: [],
    methnames: new Set(),
    selrefs: new Set(),
    classnames: new Set(),
    cstrings: [],
    undefinedSymbols: [],
    definedSymbols: [],
  };
  let textVm = 0;
  let symtab: { symoff: number; nsyms: number; stroff: number; strsize: number } | null = null;
  let sig: { off: number; size: number } | null = null;
  const cstr = (o: number, max = 1024) => {
    let e = o;
    while (e < buf.length && buf[e] !== 0 && e - o < max) e++;
    return latin1.decode(buf.subarray(o, e));
  };

  let p = 32;
  for (let i = 0; i < Math.min(ncmds, 4096) && p + 8 <= buf.length; i++) {
    const cmd = dv.getUint32(p, true);
    const size = dv.getUint32(p + 4, true);
    if (size < 8) break;
    if (cmd === LC_SEGMENT_64) {
      const seg = cstr(p + 8, 16);
      if (seg === "__TEXT") textVm = Number(dv.getBigUint64(p + 24, true));
      const nsects = dv.getUint32(p + 64, true);
      for (let s = 0; s < Math.min(nsects, 256); s++) {
        const b = p + 72 + s * 80;
        out.sections.push({
          name: cstr(b, 16),
          seg: cstr(b + 16, 16),
          addr: Number(dv.getBigUint64(b + 32, true)),
          size: Number(dv.getBigUint64(b + 40, true)),
          offset: dv.getUint32(b + 48, true),
        });
      }
    } else if (cmd === LC_SYMTAB) {
      symtab = { symoff: dv.getUint32(p + 8, true), nsyms: dv.getUint32(p + 12, true), stroff: dv.getUint32(p + 16, true), strsize: dv.getUint32(p + 20, true) };
    } else if (cmd === LC_LOAD_DYLIB || cmd === LC_LOAD_WEAK_DYLIB || cmd === LC_REEXPORT_DYLIB || cmd === LC_LAZY_LOAD_DYLIB) {
      out.dylibs.push(cstr(p + dv.getUint32(p + 8, true), 512));
    } else if (cmd === LC_CODE_SIGNATURE) {
      sig = { off: dv.getUint32(p + 8, true), size: dv.getUint32(p + 12, true) };
    } else if (cmd === LC_BUILD_VERSION) {
      const plat = dv.getUint32(p + 8, true);
      out.platform = plat === 2 ? "ios" : plat === 7 ? "ios-simulator" : "other";
      out.minOs = ver(dv.getUint32(p + 12, true));
    } else if (cmd === LC_VERSION_MIN_IPHONEOS) {
      out.platform ??= "ios";
      out.minOs = ver(dv.getUint32(p + 8, true));
    }
    p += size;
  }

  const sect = (seg: RegExp, name: string) => out.sections.find((s) => s.name === name && seg.test(s.seg));
  const strings = (s?: Section, cap = 400_000) => {
    const res: string[] = [];
    if (!s || !s.offset || s.offset + s.size > buf.length) return res;
    let start = s.offset;
    const end = s.offset + s.size;
    for (let o = s.offset; o < end && res.length < cap; o++) {
      if (buf[o] === 0) {
        if (o > start) res.push(latin1.decode(buf.subarray(start, o)));
        start = o + 1;
      }
    }
    return res;
  };

  const meth = sect(/^__TEXT$/, "__objc_methname");
  for (const s of strings(meth)) out.methnames.add(s);
  for (const s of strings(sect(/^__TEXT$/, "__objc_classname"))) out.classnames.add(s);
  out.cstrings = strings(sect(/^__TEXT$/, "__cstring"));

  // selector references: 8-byte pointers into __objc_methname (plain, or
  // chained-fixup rebases whose low 36 bits hold the target vmaddr / offset)
  const refs = sect(/^__DATA/, "__objc_selrefs");
  if (meth && refs && refs.offset + refs.size <= buf.length) {
    for (let o = refs.offset; o + 8 <= refs.offset + refs.size; o += 8) {
      const raw = dv.getBigUint64(o, true);
      const low = Number(raw & BigInt(0xfffffffff));
      const vm = low >= meth.addr && low < meth.addr + meth.size ? low : low + textVm;
      if (vm >= meth.addr && vm < meth.addr + meth.size) out.selrefs.add(cstr(meth.offset + (vm - meth.addr), 512));
    }
  }

  if (symtab && symtab.symoff + symtab.nsyms * 16 <= buf.length && symtab.stroff + symtab.strsize <= buf.length) {
    const ct = /CleverTap|_OBJC_CLASS_\$_CT[A-Z]/;
    for (let i = 0; i < Math.min(symtab.nsyms, 3_000_000); i++) {
      const b = symtab.symoff + i * 16;
      const strx = dv.getUint32(b, true);
      if (strx === 0 || strx >= symtab.strsize) continue;
      const type = buf[b + 4];
      if (type & 0xe0) continue; // stab / debug entries
      const o = symtab.stroff + strx;
      // cheap prefilter before decoding
      if (buf[o] !== 0x5f) continue; // '_'
      const name = cstr(o, 300);
      if (!ct.test(name)) continue;
      const undef = (type & 0x0e) === 0 && (type & 0x01) === 1;
      if (undef) {
        if (out.undefinedSymbols.length < 200) out.undefinedSymbols.push(name);
      } else if (out.definedSymbols.length < 200) out.definedSymbols.push(name);
    }
  }

  // entitlements: code signature blob (device builds) or __TEXT,__entitlements (simulator)
  const entSect = sect(/^__TEXT$/, "__entitlements");
  if (entSect && entSect.offset + entSect.size <= buf.length) out.entitlements = findXmlPlist(buf.subarray(entSect.offset, entSect.offset + entSect.size));
  if (!out.entitlements && sig && sig.off + sig.size <= buf.length) out.entitlements = findXmlPlist(buf.subarray(sig.off, sig.off + sig.size));
  return out;
}

function ver(x: number) {
  return `${x >>> 16}.${(x >> 8) & 0xff}${x & 0xff ? `.${x & 0xff}` : ""}`;
}

/** CleverTap writes its version as MMmmpp (70701 → 7.7.1). */
export function sdkVersionFromStrings(cstrings: string[], sdkOnly: boolean): string | undefined {
  const isCode = (s: string) => /^[1-9]\d{4,5}$/.test(s) && Number(s.slice(0, s.length - 4)) <= 12;
  const anchors = [/content\?os=iOS/, /cleverTapIOSSDKVersion/, /^CleverTap\.DeviceInfo\./];
  const hits = new Map<string, number>();
  cstrings.forEach((s, i) => {
    if (!anchors.some((a) => a.test(s))) return;
    for (let j = Math.max(0, i - 4); j <= Math.min(cstrings.length - 1, i + 4); j++) {
      if (isCode(cstrings[j])) hits.set(cstrings[j], (hits.get(cstrings[j]) ?? 0) + 3);
    }
  });
  if (sdkOnly) for (const s of cstrings) if (isCode(s)) hits.set(s, (hits.get(s) ?? 0) + 1);
  const best = [...hits.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (!best) return undefined;
  const n = Number(best);
  return `${Math.floor(n / 10000)}.${Math.floor(n / 100) % 100}.${n % 100}`;
}
