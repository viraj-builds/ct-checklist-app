import { unzipSync, type UnzipFileInfo } from "fflate";
import { parseAxml, parseProtoXml, type XmlEl } from "./xml";

export type ArchiveKind = "apk" | "aab" | "apks" | "xapk";

// The parts of an Android package the analyzer actually reads. Large native
// libraries are only decompressed when they matter (Flutter's libapp.so etc.).
export interface LoadedArchive {
  kind: ArchiveKind;
  manifest: XmlEl | null;
  dex: Uint8Array[];
  names: string[]; // every entry path (normalised, module prefix stripped)
  files: Map<string, Uint8Array>; // selected decompressed entries
}

const MAX_TEXT_ASSET = 40 * 1024 * 1024;

// Decompression-bomb guard: limits on what we're willing to inflate. Checked
// against the sizes declared in the zip directory *before* decompressing.
const MAX_ENTRY = 400 * 1024 * 1024;
const MAX_TOTAL = 1536 * 1024 * 1024;
const MAX_ENTRIES = 200_000;

class Budget {
  total = 0;
  entries = 0;
  take(name: string, size: number) {
    if (++this.entries > MAX_ENTRIES) throw new Error("Archive has too many entries.");
    if (size > MAX_ENTRY) throw new Error(`"${name}" is too large to analyse safely.`);
    this.total += size;
    if (this.total > MAX_TOTAL) throw new Error("Archive expands to more than 1.5 GB — refusing to unpack it.");
  }
}

// Which entries to decompress (paths are normalised to APK layout).
function wanted(path: string, size: number): boolean {
  if (path === "AndroidManifest.xml" || path === "manifest/AndroidManifest.xml") return true;
  if (/^(dex\/)?classes\d*\.dex$/.test(path)) return true;
  if (path === "resources.arsc" || path === "resources.pb") return true;
  // Flutter AOT snapshot — one ABI is enough
  if (/^lib\/(arm64-v8a|armeabi-v7a|x86_64)\/libapp\.so$/.test(path)) return true;
  // React Native bundle
  if (/^assets\/index\.android\.bundle$/.test(path)) return size < MAX_TEXT_ASSET * 2;
  // Cordova / Capacitor web layer
  if (/^assets\/(www|public)\/.*\.js$/.test(path)) return size < MAX_TEXT_ASSET;
  if (path === "assets/capacitor.config.json") return true;
  // Unity (IL2CPP metadata or Mono assemblies with CleverTap in the name)
  if (path.endsWith("global-metadata.dat")) return true;
  if (/^assets\/bin\/Data\/Managed\/.*clevertap.*\.dll$/i.test(path)) return true;
  // .NET (Xamarin / MAUI)
  if (/^assemblies\/.*clevertap.*\.dll$/i.test(path)) return true;
  return false;
}

function normalise(path: string, kind: ArchiveKind): string {
  if (kind !== "aab") return path;
  // base/manifest/AndroidManifest.xml -> manifest/AndroidManifest.xml
  // base/dex/classes.dex -> dex/classes.dex, base/lib/... -> lib/..., base/assets -> assets
  const m = path.match(/^[^/]+\/(.*)$/);
  return m ? m[1] : path;
}

function detectKind(entries: string[], fileName: string): ArchiveKind {
  if (entries.includes("BundleConfig.pb") || entries.some((e) => e === "base/manifest/AndroidManifest.xml"))
    return "aab";
  if (entries.includes("AndroidManifest.xml")) return "apk";
  if (entries.some((e) => e.endsWith(".apk"))) return /\.xapk$/i.test(fileName) ? "xapk" : "apks";
  return "apk";
}

export function loadArchive(data: Uint8Array, fileName: string): LoadedArchive {
  // First pass: names only (cheap) to decide the kind.
  const names: string[] = [];
  unzipSync(data, {
    filter: (f: UnzipFileInfo) => {
      if (names.length >= MAX_ENTRIES) throw new Error("Archive has too many entries.");
      names.push(f.name);
      return false;
    },
  });
  const budget = new Budget();
  const kind = detectKind(names, fileName);

  if (kind === "apks" || kind === "xapk") return loadSplitBundle(data, kind, budget);

  const files = new Map<string, Uint8Array>();
  const raw = unzipSync(data, {
    filter: (f) => {
      const ok = wanted(normalise(f.name, kind), f.originalSize);
      if (ok) budget.take(f.name, f.originalSize);
      return ok;
    },
  });
  for (const [name, bytes] of Object.entries(raw)) files.set(normalise(name, kind), bytes);

  return finish(kind, names.map((n) => normalise(n, kind)), files);
}

function loadSplitBundle(data: Uint8Array, kind: ArchiveKind, budget: Budget): LoadedArchive {
  const apks = unzipSync(data, {
    filter: (f) => {
      if (!f.name.endsWith(".apk")) return false;
      budget.take(f.name, f.originalSize);
      return true;
    },
  });
  // base.apk first so its manifest wins
  const order = Object.keys(apks).sort((a, b) => score(b) - score(a));
  const files = new Map<string, Uint8Array>();
  const names: string[] = [];
  for (const name of order) {
    const inner = unzipSync(apks[name], {
      filter: (f) => {
        if (names.length >= MAX_ENTRIES) throw new Error("Archive has too many entries.");
        names.push(f.name);
        const ok = wanted(f.name, f.originalSize) && !files.has(f.name);
        if (ok) budget.take(f.name, f.originalSize);
        return ok;
      },
    });
    for (const [n, b] of Object.entries(inner)) if (!files.has(n)) files.set(n, b);
  }
  return finish(kind, names, files);

  function score(n: string) {
    if (/(^|\/)base\.apk$/.test(n)) return 3;
    if (!/split|config\./.test(n)) return 2;
    return 1;
  }
}

function finish(kind: ArchiveKind, names: string[], files: Map<string, Uint8Array>): LoadedArchive {
  let manifest: XmlEl | null = null;
  const axml = files.get("AndroidManifest.xml");
  const proto = files.get("manifest/AndroidManifest.xml");
  if (axml) manifest = parseAxml(axml);
  else if (proto) manifest = parseProtoXml(proto);

  const dex = [...files.entries()]
    .filter(([n]) => /^(dex\/)?classes\d*\.dex$/.test(n))
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
    .map(([, b]) => b);

  return { kind, manifest, dex, names, files };
}
