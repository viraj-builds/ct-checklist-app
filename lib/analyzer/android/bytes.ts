// Small binary-reading helpers shared by the AXML, protobuf and DEX parsers.
// Everything here works on a plain Uint8Array so it runs in the browser
// (Web Worker) and in Node (API routes) unchanged.

export class Reader {
  readonly view: DataView;
  constructor(readonly buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  u8(o: number) {
    return this.buf[o];
  }
  u16(o: number) {
    return this.view.getUint16(o, true);
  }
  u32(o: number) {
    return this.view.getUint32(o, true);
  }
  i32(o: number) {
    return this.view.getInt32(o, true);
  }
  /** Unsigned LEB128. Returns [value, nextOffset]. */
  uleb(o: number): [number, number] {
    let result = 0;
    let shift = 0;
    let b: number;
    do {
      b = this.buf[o++];
      result |= (b & 0x7f) << shift;
      shift += 7;
    } while (b & 0x80 && shift < 35);
    return [result >>> 0, o];
  }
}

const utf8 = new TextDecoder("utf-8", { fatal: false });
export function decodeUtf8(b: Uint8Array): string {
  return utf8.decode(b);
}

/** Find every occurrence of an ASCII needle in a byte buffer. */
export function indexOfAll(hay: Uint8Array, needle: string, limit = 50): number[] {
  const n = new TextEncoder().encode(needle);
  const out: number[] = [];
  if (n.length === 0) return out;
  const first = n[0];
  const end = hay.length - n.length;
  outer: for (let i = 0; i <= end; i++) {
    if (hay[i] !== first) continue;
    for (let j = 1; j < n.length; j++) if (hay[i + j] !== n[j]) continue outer;
    out.push(i);
    if (out.length >= limit) break;
  }
  return out;
}

export function containsAscii(hay: Uint8Array, needle: string): boolean {
  return indexOfAll(hay, needle, 1).length > 0;
}

/** Read printable ASCII starting at `o` until a non-printable byte. */
export function readAsciiRun(hay: Uint8Array, o: number, max = 200): string {
  let s = "";
  for (let i = o; i < hay.length && i < o + max; i++) {
    const c = hay[i];
    if (c < 0x20 || c > 0x7e) break;
    s += String.fromCharCode(c);
  }
  return s;
}
