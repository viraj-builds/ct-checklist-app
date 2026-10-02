import { Reader, decodeUtf8 } from "./bytes";

// A minimal element tree — enough to interpret AndroidManifest.xml.
export interface XmlEl {
  tag: string;
  attrs: Record<string, string>; // keyed by local name (android:name -> "name")
  children: XmlEl[];
}

// Framework attribute resource ids, used when the string pool has the
// attribute name stripped (common in obfuscated/shrunk manifests).
const ATTR_BY_RES_ID: Record<number, string> = {
  0x01010000: "theme",
  0x01010001: "label",
  0x01010002: "icon",
  0x01010003: "name",
  0x01010006: "permission",
  0x0101000e: "enabled",
  0x0101000f: "debuggable",
  0x01010010: "exported",
  0x01010018: "authorities",
  0x01010024: "value",
  0x01010025: "resource",
  0x01010027: "scheme",
  0x01010028: "host",
  0x01010029: "port",
  0x0101002a: "path",
  0x0101002b: "pathPrefix",
  0x0101002c: "pathPattern",
  0x0101020c: "minSdkVersion",
  0x01010270: "targetSdkVersion",
  0x0101021b: "versionCode",
  0x0101021c: "versionName",
  0x010104ee: "autoVerify",
  0x01010572: "compileSdkVersion",
};

/* ------------------------------------------------------------------ */
/* Binary XML (AXML) — the format used inside APKs                     */
/* ------------------------------------------------------------------ */

const RES_STRING_POOL = 0x0001;
const RES_XML = 0x0003;
const RES_XML_START_ELEMENT = 0x0102;
const RES_XML_END_ELEMENT = 0x0103;
const RES_XML_RESOURCE_MAP = 0x0180;

function readStringPool(r: Reader, start: number): string[] {
  const count = r.u32(start + 8);
  const flags = r.u32(start + 16);
  const stringsStart = r.u32(start + 20);
  const isUtf8 = (flags & (1 << 8)) !== 0;
  const headerSize = r.u16(start + 2);
  const out: string[] = new Array(count);
  for (let i = 0; i < count; i++) {
    let o = start + stringsStart + r.u32(start + headerSize + i * 4);
    try {
      if (isUtf8) {
        // utf16 length (skip), then utf8 byte length
        let n = r.u8(o++);
        if (n & 0x80) o++;
        n = r.u8(o++);
        if (n & 0x80) n = ((n & 0x7f) << 8) | r.u8(o++);
        out[i] = decodeUtf8(r.buf.subarray(o, o + n));
      } else {
        let n = r.u16(o);
        o += 2;
        if (n & 0x8000) {
          n = ((n & 0x7fff) << 16) | r.u16(o);
          o += 2;
        }
        let s = "";
        for (let k = 0; k < n; k++) s += String.fromCharCode(r.u16(o + k * 2));
        out[i] = s;
      }
    } catch {
      out[i] = "";
    }
  }
  return out;
}

function typedValue(strings: string[], dataType: number, data: number): string {
  switch (dataType) {
    case 0x03:
      return strings[data] ?? "";
    case 0x10:
      return String(data | 0);
    case 0x11:
      return "0x" + data.toString(16);
    case 0x12:
      return data !== 0 ? "true" : "false";
    case 0x01:
      return "@0x" + data.toString(16).padStart(8, "0");
    default:
      return String(data);
  }
}

export function parseAxml(buf: Uint8Array): XmlEl | null {
  const r = new Reader(buf);
  if (buf.length < 8 || r.u16(0) !== RES_XML) return null;
  let strings: string[] = [];
  let resMap: number[] = [];
  const root: XmlEl = { tag: "#root", attrs: {}, children: [] };
  const stack: XmlEl[] = [root];

  let o = r.u16(2); // skip file header
  while (o + 8 <= buf.length) {
    const type = r.u16(o);
    const headerSize = r.u16(o + 2);
    const size = r.u32(o + 4);
    if (size < 8) break;

    if (type === RES_STRING_POOL) {
      strings = readStringPool(r, o);
    } else if (type === RES_XML_RESOURCE_MAP) {
      const n = (size - headerSize) / 4;
      resMap = [];
      for (let i = 0; i < n; i++) resMap.push(r.u32(o + headerSize + i * 4));
    } else if (type === RES_XML_START_ELEMENT) {
      const ext = o + headerSize;
      const nameIdx = r.u32(ext + 4);
      const attrStart = r.u16(ext + 8);
      const attrSize = r.u16(ext + 10);
      const attrCount = r.u16(ext + 12);
      const el: XmlEl = { tag: strings[nameIdx] ?? "", attrs: {}, children: [] };
      for (let i = 0; i < attrCount; i++) {
        const a = ext + attrStart + i * attrSize;
        const nIdx = r.u32(a + 4);
        const raw = r.u32(a + 8);
        const dataType = r.u8(a + 15);
        const data = r.u32(a + 16);
        let name = strings[nIdx] ?? "";
        if (!name && resMap[nIdx] !== undefined) name = ATTR_BY_RES_ID[resMap[nIdx]] ?? "";
        if (!name) continue;
        el.attrs[name] = raw !== 0xffffffff ? (strings[raw] ?? "") : typedValue(strings, dataType, data);
      }
      stack[stack.length - 1].children.push(el);
      stack.push(el);
    } else if (type === RES_XML_END_ELEMENT) {
      if (stack.length > 1) stack.pop();
    }
    o += size;
  }
  return root.children[0] ?? null;
}

/* ------------------------------------------------------------------ */
/* Protobuf XML — the format used inside AABs (aapt2 Resources.proto)   */
/* ------------------------------------------------------------------ */

type PbField = { no: number; wt: number; v: number; bytes?: Uint8Array };

function* pbFields(buf: Uint8Array): Generator<PbField> {
  let o = 0;
  const varint = (): number => {
    let res = 0;
    let mul = 1;
    let b: number;
    do {
      b = buf[o++];
      res += (b & 0x7f) * mul;
      mul *= 128;
    } while (b & 0x80 && o < buf.length);
    return res;
  };
  while (o < buf.length) {
    const key = varint();
    const no = Math.floor(key / 8);
    const wt = key & 7;
    if (wt === 0) yield { no, wt, v: varint() };
    else if (wt === 2) {
      const len = varint();
      yield { no, wt, v: len, bytes: buf.subarray(o, o + len) };
      o += len;
    } else if (wt === 5) {
      yield { no, wt, v: new DataView(buf.buffer, buf.byteOffset + o, 4).getUint32(0, true) };
      o += 4;
    } else if (wt === 1) {
      o += 8;
      yield { no, wt, v: 0 };
    } else return; // unsupported / corrupt
  }
}

function pbPrimitive(buf: Uint8Array): string | undefined {
  for (const f of pbFields(buf)) {
    if (f.no === 8) return f.v ? "true" : "false"; // boolean_value
    if (f.no === 6 || f.no === 7) return String(f.v); // int decimal / hex
  }
  return undefined;
}

function pbItemValue(buf: Uint8Array): string | undefined {
  for (const f of pbFields(buf)) {
    if (!f.bytes) continue;
    if (f.no === 2 || f.no === 3) {
      // String / RawString { value = 1 }
      for (const g of pbFields(f.bytes)) if (g.no === 1 && g.bytes) return decodeUtf8(g.bytes);
    }
    if (f.no === 7) return pbPrimitive(f.bytes);
  }
  return undefined;
}

function pbAttr(buf: Uint8Array): [string, string] | null {
  let name = "";
  let value = "";
  let resId = 0;
  let compiled: string | undefined;
  for (const f of pbFields(buf)) {
    if (f.no === 2 && f.bytes) name = decodeUtf8(f.bytes);
    else if (f.no === 3 && f.bytes) value = decodeUtf8(f.bytes);
    else if (f.no === 5) resId = f.v;
    else if (f.no === 6 && f.bytes) compiled = pbItemValue(f.bytes);
  }
  if (!name && resId) name = ATTR_BY_RES_ID[resId] ?? "";
  if (!name) return null;
  return [name, value || compiled || ""];
}

function pbElement(buf: Uint8Array): XmlEl {
  const el: XmlEl = { tag: "", attrs: {}, children: [] };
  for (const f of pbFields(buf)) {
    if (!f.bytes) continue;
    if (f.no === 3) el.tag = decodeUtf8(f.bytes);
    else if (f.no === 4) {
      const a = pbAttr(f.bytes);
      if (a) el.attrs[a[0]] = a[1];
    } else if (f.no === 5) {
      const child = pbNode(f.bytes);
      if (child) el.children.push(child);
    }
  }
  return el;
}

function pbNode(buf: Uint8Array): XmlEl | null {
  for (const f of pbFields(buf)) if (f.no === 1 && f.bytes) return pbElement(f.bytes);
  return null; // text node
}

export function parseProtoXml(buf: Uint8Array): XmlEl | null {
  try {
    return pbNode(buf);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */

export function findAll(el: XmlEl, tag: string, out: XmlEl[] = []): XmlEl[] {
  for (const c of el.children) {
    if (c.tag === tag) out.push(c);
    findAll(c, tag, out);
  }
  return out;
}
