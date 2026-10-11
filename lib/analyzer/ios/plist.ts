// Property-list reader for Info.plist, entitlements and provisioning profiles.
// Handles binary plists (bplist00) and XML plists. Works in the browser and in
// Node — plain Uint8Array in, plain JS values out.

export type PlistValue = string | number | boolean | Date | Uint8Array | PlistValue[] | { [k: string]: PlistValue } | null;
export type PlistDict = { [k: string]: PlistValue };

const latin1 = new TextDecoder("latin1");
const utf8 = new TextDecoder("utf-8", { fatal: false });

export function parsePlist(buf: Uint8Array): PlistValue {
  if (buf.length >= 8 && latin1.decode(buf.subarray(0, 8)) === "bplist00") return parseBinary(buf);
  return parseXml(utf8.decode(buf));
}

/** Plist embedded in another blob (code signature, mobileprovision CMS envelope). */
export function findXmlPlist(buf: Uint8Array): PlistDict | undefined {
  const text = latin1.decode(buf);
  const start = text.indexOf("<?xml");
  if (start < 0) return undefined;
  const end = text.indexOf("</plist>", start);
  if (end < 0) return undefined;
  const xml = utf8.decode(buf.subarray(start, end + 8));
  const v = parseXml(xml);
  return v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date) && !(v instanceof Uint8Array) ? (v as PlistDict) : undefined;
}

export const asDict = (v: PlistValue | undefined): PlistDict | undefined =>
  v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date) && !(v instanceof Uint8Array) ? (v as PlistDict) : undefined;
export const asArray = (v: PlistValue | undefined): PlistValue[] => (Array.isArray(v) ? v : []);
export const asString = (v: PlistValue | undefined): string | undefined =>
  typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : undefined;

/* ---------------- binary ---------------- */

function parseBinary(buf: Uint8Array): PlistValue {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const t = buf.length - 32;
  if (t < 8) throw new Error("Truncated binary plist");
  const offSize = buf[t + 6];
  const refSize = buf[t + 7];
  const numObjects = Number(view.getBigUint64(t + 8));
  const top = Number(view.getBigUint64(t + 16));
  const tableOff = Number(view.getBigUint64(t + 24));
  if (numObjects > 2_000_000 || tableOff + numObjects * offSize > buf.length) throw new Error("Corrupt binary plist");

  const uint = (o: number, n: number) => {
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 256 + buf[o + i];
    return v;
  };
  const offsets = (i: number) => uint(tableOff + i * offSize, offSize);
  const seen = new Set<number>();

  const read = (idx: number, depth: number): PlistValue => {
    if (depth > 64 || seen.has(idx)) return null; // cycles / absurd nesting
    const o = offsets(idx);
    const marker = buf[o];
    const hi = marker >> 4;
    const lo = marker & 0xf;
    let p = o + 1;
    const count = () => {
      if (lo !== 0xf) return lo;
      const im = buf[p];
      const n = 1 << (im & 0xf);
      const c = uint(p + 1, n);
      p += 1 + n;
      return c;
    };
    switch (hi) {
      case 0x0:
        return lo === 0x9 ? true : lo === 0x8 ? false : null;
      case 0x1: {
        const n = 1 << lo;
        if (n === 8) return Number(view.getBigInt64(p));
        return uint(p, n);
      }
      case 0x2:
        return lo === 2 ? view.getFloat32(p) : view.getFloat64(p);
      case 0x3:
        return new Date(Date.UTC(2001, 0, 1) + view.getFloat64(p) * 1000);
      case 0x4: {
        const n = count();
        return buf.slice(p, p + n);
      }
      case 0x5: {
        const n = count();
        return latin1.decode(buf.subarray(p, p + n));
      }
      case 0x6: {
        const n = count();
        let s = "";
        for (let i = 0; i < n; i++) s += String.fromCharCode(view.getUint16(p + i * 2));
        return s;
      }
      case 0x8:
        return uint(p, lo + 1);
      case 0xa: {
        const n = count();
        seen.add(idx);
        const out: PlistValue[] = [];
        for (let i = 0; i < n; i++) out.push(read(uint(p + i * refSize, refSize), depth + 1));
        seen.delete(idx);
        return out;
      }
      case 0xd: {
        const n = count();
        seen.add(idx);
        const out: PlistDict = {};
        for (let i = 0; i < n; i++) {
          const k = read(uint(p + i * refSize, refSize), depth + 1);
          out[String(k)] = read(uint(p + (n + i) * refSize, refSize), depth + 1);
        }
        seen.delete(idx);
        return out;
      }
      default:
        return null;
    }
  };
  return read(top, 0);
}

/* ---------------- XML ---------------- */

const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const unescape = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) =>
    e[0] === "#" ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENT[e.toLowerCase()] ?? _,
  );

function parseXml(xml: string): PlistValue {
  const re = /<(\/?)([a-zA-Z]+)(\s*\/)?>|([^<]+)/g;
  type Tok = { close: boolean; name: string; selfClose: boolean } | { text: string };
  const toks: Tok[] = [];
  let m: RegExpExecArray | null;
  const body = xml.replace(/<\?xml[^>]*\?>|<!DOCTYPE[^>]*>|<!--[\s\S]*?-->/g, "");
  while ((m = re.exec(body))) {
    if (m[2]) toks.push({ close: !!m[1], name: m[2], selfClose: !!m[3] });
    else if (m[4] && m[4].trim()) toks.push({ text: m[4] });
  }
  let i = 0;
  const textUntil = (name: string) => {
    let s = "";
    while (i < toks.length) {
      const t = toks[i++];
      if ("text" in t) s += t.text;
      else if (t.close && t.name === name) break;
    }
    return unescape(s);
  };
  const value = (depth: number): PlistValue => {
    while (i < toks.length) {
      const t = toks[i++];
      if ("text" in t || t.close) continue;
      if (depth > 64) return null;
      switch (t.name) {
        case "plist":
          continue;
        case "dict": {
          const out: PlistDict = {};
          if (t.selfClose) return out;
          while (i < toks.length) {
            const k = toks[i];
            if (!("text" in k) && k.close && k.name === "dict") {
              i++;
              break;
            }
            if (!("text" in k) && k.name === "key") {
              i++;
              const key = textUntil("key");
              out[key] = value(depth + 1);
            } else i++;
          }
          return out;
        }
        case "array": {
          const out: PlistValue[] = [];
          if (t.selfClose) return out;
          while (i < toks.length) {
            const k = toks[i];
            if (!("text" in k) && k.close && k.name === "array") {
              i++;
              break;
            }
            out.push(value(depth + 1));
          }
          return out;
        }
        case "string":
          return t.selfClose ? "" : textUntil("string");
        case "integer":
          return Number(textUntil("integer"));
        case "real":
          return Number(textUntil("real"));
        case "true":
          return true;
        case "false":
          return false;
        case "date":
          return new Date(textUntil("date"));
        case "data": {
          const b64 = textUntil("data").replace(/\s+/g, "");
          try {
            const bin = atob(b64);
            const out = new Uint8Array(bin.length);
            for (let j = 0; j < bin.length; j++) out[j] = bin.charCodeAt(j);
            return out;
          } catch {
            return new Uint8Array();
          }
        }
        default:
          return null;
      }
    }
    return null;
  };
  return value(0);
}
