// LZ-String decompressFromBase64 (pieroxy/lz-string, MIT). The CleverTap Web
// SDK compresses every request payload with it before putting it in the `d=`
// query parameter, so the crawler can read what was sent even when the SDK's
// debug logs are off.

const KEY = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";
const REVERSE: Record<string, number> = Object.fromEntries([...KEY].map((c, i) => [c, i]));

export function decompressFromBase64(input: string): string | null {
  if (!input) return "";
  return decompress(input.length, 32, (i) => REVERSE[input.charAt(i)] ?? 0);
}

function decompress(length: number, resetValue: number, getNextValue: (i: number) => number): string | null {
  const dictionary: string[] = [];
  let enlargeIn = 4;
  let dictSize = 4;
  let numBits = 3;
  let entry = "";
  const result: string[] = [];
  let w: string;
  let c: string | number;
  const data = { val: getNextValue(0), position: resetValue, index: 1 };

  const readBits = (n: number) => {
    let bits = 0;
    let power = 1;
    const max = Math.pow(2, n);
    while (power !== max) {
      const resb = data.val & data.position;
      data.position >>= 1;
      if (data.position === 0) {
        data.position = resetValue;
        data.val = getNextValue(data.index++);
      }
      bits |= (resb > 0 ? 1 : 0) * power;
      power <<= 1;
    }
    return bits;
  };

  for (let i = 0; i < 3; i++) dictionary[i] = String(i);
  switch (readBits(2)) {
    case 0:
      c = String.fromCharCode(readBits(8));
      break;
    case 1:
      c = String.fromCharCode(readBits(16));
      break;
    case 2:
      return "";
    default:
      return null;
  }
  dictionary[3] = c;
  w = c;
  result.push(c);

  // Hard cap so a hostile payload can't spin forever.
  for (let guard = 0; guard < 1_000_000; guard++) {
    if (data.index > length) return "";
    let cc = readBits(numBits);
    switch (cc) {
      case 0:
        dictionary[dictSize++] = String.fromCharCode(readBits(8));
        cc = dictSize - 1;
        enlargeIn--;
        break;
      case 1:
        dictionary[dictSize++] = String.fromCharCode(readBits(16));
        cc = dictSize - 1;
        enlargeIn--;
        break;
      case 2:
        return result.join("");
    }
    if (enlargeIn === 0) {
      enlargeIn = Math.pow(2, numBits);
      numBits++;
    }
    if (dictionary[cc]) entry = dictionary[cc];
    else if (cc === dictSize) entry = w + w.charAt(0);
    else return null;
    result.push(entry);
    dictionary[dictSize++] = w + entry.charAt(0);
    enlargeIn--;
    w = entry;
    if (enlargeIn === 0) {
      enlargeIn = Math.pow(2, numBits);
      numBits++;
    }
  }
  return null;
}

/** Decode the `d=` parameter of a CleverTap request URL into its JSON payload. */
export function decodeCtPayload(url: string): Record<string, unknown> | null {
  try {
    const d = new URL(url).searchParams.get("d");
    if (!d) return null;
    const json = decompressFromBase64(d);
    if (!json) return null;
    const v = JSON.parse(json);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
