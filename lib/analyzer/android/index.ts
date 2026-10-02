import type { AndroidScanReport, ApiKey, ApiUsage, CodeLayer, DeepLink, Framework } from "../types";
import { loadArchive, type LoadedArchive } from "./archive";
import { scanDex, type CallSite, type DexScanResult } from "./dex";
import { findAll, type XmlEl } from "./xml";
import { containsAscii, decodeUtf8, indexOfAll, readAsciiRun } from "./bytes";
import {
  CROSS_PLATFORM_APIS,
  CT_APPLICATION_CLASSES,
  CT_COMPONENT_PREFIX,
  CT_FCM_SERVICES,
  CT_MODULES,
  DEX_TARGETS,
  LIBRARY_PREFIXES,
  META_KEYS_OF_INTEREST,
  SDK_INTERNAL_PREFIXES,
  VERSION_FEATURES,
  WRAPPERS,
} from "./signatures";

export const ANALYZER_VERSION = "android-static@1.0.0";

const API_KEYS = Object.keys(CROSS_PLATFORM_APIS) as ApiKey[];
const CORE_API_CLASS = "Lcom/clevertap/android/sdk/CleverTapAPI;";

export type ProgressFn = (stage: string, pct: number) => void;

export async function analyzeAndroid(
  data: Uint8Array,
  fileName: string,
  scannedIn: "browser" | "server",
  onProgress: ProgressFn = () => {},
): Promise<AndroidScanReport> {
  const t0 = Date.now();
  onProgress("Hashing file", 2);
  const sha256 = await sha256Hex(data);

  onProgress("Unpacking archive", 8);
  const ar = loadArchive(data, fileName);
  const notes: string[] = [];
  if (!ar.manifest) notes.push("AndroidManifest.xml could not be read — manifest checks are skipped.");

  onProgress("Reading AndroidManifest.xml", 15);
  const mf = readManifest(ar.manifest);

  // ---- DEX ----------------------------------------------------------
  const wrapperPrefixes = WRAPPERS.flatMap((w) => w.classPrefixes);
  const staticClasses = [
    "Lcom/clevertap/android/sdk/BuildConfig;",
    ...wrapperPrefixes.map((p) => `${p}BuildConfig;`),
  ];
  const merged: DexScanResult = {
    classes: new Set(),
    calls: {},
    staticStrings: {},
    methodRefs: new Set(),
    ctSubclasses: {},
  };
  const markers = new Map<string, string>(); // artifact -> version
  for (let i = 0; i < ar.dex.length; i++) {
    onProgress(`Scanning bytecode (${i + 1}/${ar.dex.length})`, 20 + Math.round((i / Math.max(1, ar.dex.length)) * 55));
    const res = scanDex(ar.dex[i], DEX_TARGETS, {
      skipCallerPrefixes: [...SDK_INTERNAL_PREFIXES, ...LIBRARY_PREFIXES],
      staticClasses,
    });
    res.classes.forEach((c) => merged.classes.add(c));
    res.methodRefs.forEach((m) => merged.methodRefs.add(m));
    Object.assign(merged.staticStrings, res.staticStrings);
    Object.assign(merged.ctSubclasses, res.ctSubclasses);
    for (const [k, v] of Object.entries(res.calls)) (merged.calls[k] ??= []).push(...v);
    for (const [a, v] of readVersionMarkers(ar.dex[i])) markers.set(a, v);
    await yieldToEventLoop();
  }

  onProgress("Detecting framework", 80);
  const hasPrefix = (p: string) => {
    for (const c of merged.classes) if (c.startsWith(p)) return true;
    return false;
  };
  const fw = detectFramework(ar, hasPrefix);

  // ---- CleverTap presence / version ---------------------------------
  const ctInManifest = mf.ctComponents.length > 0 || Object.keys(mf.metaData).some((k) => k.startsWith("CLEVERTAP_"));
  const ctClasses = hasPrefix("Lcom/clevertap/android/sdk/");
  const present = ctInManifest || ctClasses || markers.has("clevertap-android-sdk");
  const obfuscated = present && !merged.classes.has(CORE_API_CLASS);

  const modules = CT_MODULES.filter((m) => hasPrefix(m.prefix) || (m.id === "clevertap-android-sdk" && present)).map(
    (m) => ({ id: m.id, label: m.label, version: markers.get(m.id) }),
  );

  let coreVersion = markers.get("clevertap-android-sdk");
  let versionSource: AndroidScanReport["clevertap"]["versionSource"] = coreVersion ? "marker" : undefined;
  const bc = merged.staticStrings["Lcom/clevertap/android/sdk/BuildConfig;"];
  if (!coreVersion && bc?.VERSION_NAME) {
    coreVersion = bc.VERSION_NAME;
    versionSource = "buildconfig";
  }
  let minVersionEstimate: string | undefined;
  if (!coreVersion && present) {
    const hit = VERSION_FEATURES.find((f) => hasPrefix(f.prefix));
    if (hit) {
      minVersionEstimate = hit.min;
      versionSource = "estimate";
      notes.push(
        `SDK version string was stripped by R8 — estimated ≥ ${hit.min} because "${hit.feature}" classes are present.`,
      );
    }
  }
  const coreModule = modules.find((m) => m.id === "clevertap-android-sdk");
  if (coreModule && coreVersion) coreModule.version = coreVersion;

  // ---- Cross-platform wrapper ---------------------------------------
  const wrapper = detectWrapper(ar, hasPrefix, merged, fw.primary);

  // ---- API usage ----------------------------------------------------
  onProgress("Matching CleverTap API calls", 88);
  const layerScan = scanCrossPlatformLayer(ar, fw.primary, fw.hermes, notes);
  const apis = buildApiUsage(merged, layerScan, obfuscated, wrapper !== undefined, fw.primary);

  // Application subclassing com.clevertap...Application registers lifecycle callbacks.
  const appDesc = mf.applicationClass ? "L" + mf.applicationClass.replace(/\./g, "/") + ";" : "";
  const appSuper = merged.ctSubclasses[appDesc];
  if (mf.applicationClass && CT_APPLICATION_CLASSES.includes(mf.applicationClass)) {
    markFound(apis.lifecycleRegister, "native", `Manifest application is ${mf.applicationClass}`, "high");
  } else if (appSuper) {
    markFound(apis.lifecycleRegister, "native", `${mf.applicationClass} extends ${dotted(appSuper)}`, "high");
  }
  if (obfuscated) {
    notes.push(
      "The app is minified with R8/ProGuard: CleverTap classes were renamed, so native (Java/Kotlin) call sites can't be matched by name. These checks fall back to the cross-platform layer and to the CleverTap API.",
    );
  }

  const eventNames = uniq([...apis.pushEvent.strings]).filter(isPlausibleEventName).slice(0, 100);
  const channelIds = uniq(apis.createNotificationChannel.strings).slice(0, 20);

  // ---- Firebase -----------------------------------------------------
  const arsc = ar.files.get("resources.arsc") ?? ar.files.get("resources.pb");
  const firebase = {
    messagingSdk:
      merged.classes.has("Lcom/google/firebase/messaging/FirebaseMessagingService;") ||
      ar.names.some((n) => /firebase-messaging/.test(n)),
    googleServicesConfigured: !!arsc && (containsAscii(arsc, "gcm_defaultSenderId") || containsAscii(arsc, "google_app_id")),
    installReferrer: hasPrefix("Lcom/android/installreferrer/"),
  };

  onProgress("Done", 100);
  return {
    schema: 1,
    analyzer: ANALYZER_VERSION,
    scannedAt: Date.now(),
    durationMs: Date.now() - t0,
    scannedIn,
    file: { name: fileName, size: data.byteLength, sha256, kind: ar.kind },
    app: {
      packageName: mf.packageName,
      versionName: mf.versionName,
      versionCode: mf.versionCode,
      minSdk: mf.minSdk,
      targetSdk: mf.targetSdk,
      compileSdk: mf.compileSdk,
      applicationClass: mf.applicationClass,
      debuggable: mf.debuggable,
      launcherActivity: mf.launcherActivity,
      activityCount: mf.activities.length,
      dexCount: ar.dex.length,
      abis: uniq(ar.names.map((n) => n.match(/^lib\/([^/]+)\//)?.[1]).filter(Boolean) as string[]),
    },
    framework: fw,
    obfuscated,
    clevertap: {
      present,
      coreVersion,
      versionSource,
      minVersionEstimate,
      modules,
      wrapper,
    },
    manifest: {
      found: !!ar.manifest,
      metaData: mf.metaData,
      permissions: mf.permissions,
      ctComponents: mf.ctComponents,
      messagingServices: mf.messagingServices,
      deepLinks: mf.deepLinks,
      activities: mf.activities.slice(0, 200),
    },
    firebase,
    apis,
    eventNames,
    channelIds,
    notes,
  };
}

/* ------------------------------------------------------------------ */
/* Manifest                                                            */
/* ------------------------------------------------------------------ */

interface ManifestInfo {
  packageName?: string;
  versionName?: string;
  versionCode?: string;
  minSdk?: number;
  targetSdk?: number;
  compileSdk?: number;
  applicationClass?: string;
  debuggable: boolean;
  launcherActivity?: string;
  metaData: Record<string, string>;
  permissions: string[];
  ctComponents: string[];
  messagingServices: { name: string; isCleverTap: boolean }[];
  deepLinks: DeepLink[];
  activities: string[];
}

function readManifest(root: XmlEl | null): ManifestInfo {
  const info: ManifestInfo = {
    debuggable: false,
    metaData: {},
    permissions: [],
    ctComponents: [],
    messagingServices: [],
    deepLinks: [],
    activities: [],
  };
  if (!root) return info;
  const pkg = root.attrs.package;
  info.packageName = pkg;
  info.versionName = root.attrs.versionName;
  info.versionCode = root.attrs.versionCode;
  info.compileSdk = num(root.attrs.compileSdkVersion ?? root.attrs.platformBuildVersionCode);
  const sdk = findAll(root, "uses-sdk")[0];
  info.minSdk = num(sdk?.attrs.minSdkVersion);
  info.targetSdk = num(sdk?.attrs.targetSdkVersion);
  info.permissions = uniq(findAll(root, "uses-permission").map((p) => p.attrs.name).filter(Boolean));

  const app = findAll(root, "application")[0];
  if (!app) return info;
  const fq = (n?: string) => (!n ? n : n.startsWith(".") ? pkg + n : !n.includes(".") ? `${pkg}.${n}` : n);
  info.applicationClass = fq(app.attrs.name);
  info.debuggable = app.attrs.debuggable === "true";

  for (const md of app.children.filter((c) => c.tag === "meta-data")) {
    const k = md.attrs.name;
    if (k && META_KEYS_OF_INTEREST.some((re) => re.test(k))) info.metaData[k] = md.attrs.value ?? md.attrs.resource ?? "";
  }

  for (const comp of app.children) {
    const name = fq(comp.attrs.name ?? comp.attrs.targetActivity);
    if (!name) continue;
    if (name.startsWith(CT_COMPONENT_PREFIX)) info.ctComponents.push(`${comp.tag}: ${name}`);

    const filters = comp.children.filter((c) => c.tag === "intent-filter");
    if (comp.tag === "activity" || comp.tag === "activity-alias") {
      info.activities.push(name);
      for (const f of filters) {
        const actions = f.children.filter((c) => c.tag === "action").map((c) => c.attrs.name);
        const cats = f.children.filter((c) => c.tag === "category").map((c) => c.attrs.name);
        if (actions.includes("android.intent.action.MAIN") && cats.includes("android.intent.category.LAUNCHER"))
          info.launcherActivity ??= name;
        if (actions.includes("android.intent.action.VIEW") && cats.includes("android.intent.category.BROWSABLE")) {
          const data = f.children.filter((c) => c.tag === "data");
          const schemes = uniq(data.map((d) => d.attrs.scheme).filter(Boolean));
          const hosts = uniq(data.map((d) => d.attrs.host).filter(Boolean));
          const path = data.map((d) => d.attrs.path ?? d.attrs.pathPrefix ?? d.attrs.pathPattern).find(Boolean);
          for (const scheme of schemes)
            for (const host of hosts.length ? hosts : [undefined])
              info.deepLinks.push({ activity: name, scheme, host, path, autoVerify: f.attrs.autoVerify === "true" });
        }
      }
    }
    if (comp.tag === "service") {
      const isMsg = filters.some((f) =>
        f.children.some((c) => c.tag === "action" && c.attrs.name === "com.google.firebase.MESSAGING_EVENT"),
      );
      if (isMsg) info.messagingServices.push({ name, isCleverTap: CT_FCM_SERVICES.includes(name) || name.startsWith("com.clevertap.") });
    }
  }
  return info;
}

/* ------------------------------------------------------------------ */
/* Framework + wrapper                                                 */
/* ------------------------------------------------------------------ */

function detectFramework(ar: LoadedArchive, hasPrefix: (p: string) => boolean): AndroidScanReport["framework"] {
  const n = ar.names;
  const has = (re: RegExp) => n.some((x) => re.test(x));
  const signals: string[] = [];
  let primary: Framework = "native";
  let hermes: boolean | undefined;
  let expo: boolean | undefined;

  if (has(/^lib\/[^/]+\/libflutter\.so$/) || has(/^assets\/flutter_assets\//)) {
    primary = "flutter";
    if (has(/libflutter\.so$/)) signals.push("libflutter.so");
    if (has(/^assets\/flutter_assets\//)) signals.push("assets/flutter_assets/");
  } else if (
    has(/^assets\/index\.android\.bundle$/) ||
    has(/^lib\/[^/]+\/(libreactnativejni|libreactnative|libhermes)\.so$/)
  ) {
    primary = "react-native";
    if (has(/^assets\/index\.android\.bundle$/)) signals.push("assets/index.android.bundle");
    if (has(/libhermes\.so$/)) signals.push("libhermes.so");
    const bundle = ar.files.get("assets/index.android.bundle");
    hermes = !!bundle && bundle[0] === 0xc6 && bundle[1] === 0x1f && bundle[2] === 0xbc && bundle[3] === 0x03;
    expo = hasPrefix("Lexpo/modules/");
    if (expo) signals.push("Expo modules");
  } else if (has(/^assets\/capacitor\.config\.json$/)) {
    primary = "capacitor";
    signals.push("assets/capacitor.config.json");
  } else if (has(/^assets\/www\/cordova\.js$/)) {
    primary = "cordova";
    signals.push("assets/www/cordova.js");
  } else if (has(/^lib\/[^/]+\/libunity\.so$/)) {
    primary = "unity";
    signals.push("libunity.so");
  } else if (has(/^lib\/[^/]+\/libmonodroid\.so$/) || has(/^assemblies\//) || has(/libassemblies\..*\.blob\.so$/)) {
    primary = "dotnet";
    signals.push("Mono / .NET runtime");
  } else {
    signals.push(hasPrefix("Lkotlin/") ? "Kotlin / Java (native)" : "Java (native)");
  }
  return { primary, signals, hermes, expo };
}

function detectWrapper(
  ar: LoadedArchive,
  hasPrefix: (p: string) => boolean,
  dex: DexScanResult,
  primary: Framework,
): AndroidScanReport["clevertap"]["wrapper"] {
  for (const w of WRAPPERS) {
    const by: string[] = [];
    for (const p of w.classPrefixes) if (hasPrefix(p)) by.push(`classes ${dotted(p)}*`);
    if (w.framework === primary || w.framework === "unity" || w.framework === "dotnet") {
      for (const re of w.assetHints) {
        const hit = ar.names.find((x) => re.test(x));
        if (hit && (w.framework !== "unity" || /^assets\/bin\//.test(hit))) by.push(hit);
      }
    }
    if (w.framework === "flutter" && primary === "flutter") {
      const so = libAppSo(ar);
      if (so && containsAscii(so, "package:clevertap_plugin/")) by.push("Dart: package:clevertap_plugin");
    }
    if (w.framework === "react-native" && primary === "react-native") {
      const b = ar.files.get("assets/index.android.bundle");
      if (b && containsAscii(b, "CleverTapReact")) by.push("JS bundle: CleverTapReact");
    }
    if (by.length) {
      const bc = w.classPrefixes.map((p) => dex.staticStrings[`${p}BuildConfig;`]).find(Boolean);
      return { framework: w.framework, label: w.label, version: bc?.VERSION_NAME, detectedBy: uniq(by).slice(0, 4) };
    }
  }
  return undefined;
}

function libAppSo(ar: LoadedArchive): Uint8Array | undefined {
  for (const abi of ["arm64-v8a", "armeabi-v7a", "x86_64"]) {
    const f = ar.files.get(`lib/${abi}/libapp.so`);
    if (f) return f;
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/* Cross-platform code layer                                           */
/* ------------------------------------------------------------------ */

interface LayerScan {
  layer?: CodeLayer;
  inspectable: boolean; // false = we know there's a layer but can't read it (Hermes, IL2CPP…)
  found: Partial<Record<ApiKey, { evidence: string; strings: string[]; confidence: ApiUsage["confidence"] }>>;
}

function scanCrossPlatformLayer(ar: LoadedArchive, primary: Framework, hermes: boolean | undefined, notes: string[]): LayerScan {
  if (primary === "flutter") {
    const so = libAppSo(ar);
    if (!so) {
      notes.push(
        "This is a debug (JIT) Flutter build — there's no AOT snapshot, so Dart call sites can't be checked. Scan a release build for full coverage.",
      );
      return { layer: "dart", inspectable: false, found: {} };
    }
    const found: LayerScan["found"] = {};
    for (const key of API_KEYS) {
      for (const name of CROSS_PLATFORM_APIS[key]) {
        // method-channel literal survives AOT tree-shaking only if called
        if (containsAscii(so, name)) {
          found[key] = { evidence: `Dart: '${name}' present in AOT snapshot`, strings: [], confidence: "medium" };
          break;
        }
      }
    }
    return { layer: "dart", inspectable: true, found };
  }

  if (primary === "react-native") {
    const bundle = ar.files.get("assets/index.android.bundle");
    if (!bundle) return { layer: "js", inspectable: false, found: {} };
    if (hermes) {
      notes.push(
        "The JS bundle is Hermes bytecode — JavaScript call sites can't be inspected statically. Those checks rely on the CleverTap API.",
      );
      return { layer: "js", inspectable: false, found: {} };
    }
    return { layer: "js", inspectable: true, found: scanJs(decodeUtf8(bundle), "JS bundle", true) };
  }

  if (primary === "cordova" || primary === "capacitor") {
    let src = "";
    for (const [name, bytes] of ar.files) {
      if (!/^assets\/(www|public)\/.*\.js$/.test(name)) continue;
      if (/clevertap-cordova|cordova_plugins\.js$/.test(name)) continue; // the plugin's own definitions
      src += "\n" + decodeUtf8(bytes);
    }
    return { layer: "js", inspectable: src.length > 0, found: scanJs(src, "Web layer", false) };
  }

  if (primary === "unity" || primary === "dotnet") {
    notes.push(
      `${primary === "unity" ? "Unity (C#)" : ".NET"} code isn't decompiled — C# call sites are verified through the CleverTap API instead.`,
    );
    return { layer: primary === "unity" ? "unity" : "dotnet", inspectable: false, found: {} };
  }
  return { inspectable: true, found: {} };
}

// For RN the library itself is inside the bundle and calls each method once on
// the native module, so we need >= 2 member calls (or a literal first arg).
function scanJs(src: string, label: string, libraryInBundle: boolean): LayerScan["found"] {
  const found: LayerScan["found"] = {};
  if (!src) return found;
  for (const key of API_KEYS) {
    for (const name of CROSS_PLATFORM_APIS[key]) {
      const callRe = new RegExp(`\\.${name}\\(`, "g");
      const count = (src.match(callRe) ?? []).length;
      const litRe = new RegExp(`\\.${name}\\(\\s*(["'\`])([^"'\`\\n]{1,100})\\1`, "g");
      const strings = [...src.matchAll(litRe)].map((m) => m[2]);
      const threshold = libraryInBundle ? 2 : 1;
      if (strings.length > 0 || count >= threshold) {
        found[key] = {
          evidence: `${label}: ${count} call${count === 1 ? "" : "s"} to .${name}()`,
          strings,
          confidence: strings.length > 0 ? "high" : libraryInBundle ? "low" : "medium",
        };
        break;
      }
    }
  }
  return found;
}

/* ------------------------------------------------------------------ */
/* Merge                                                               */
/* ------------------------------------------------------------------ */

function buildApiUsage(
  dex: DexScanResult,
  layer: LayerScan,
  obfuscated: boolean,
  hasWrapper: boolean,
  primary: Framework,
): Record<ApiKey, ApiUsage> {
  const out = {} as Record<ApiKey, ApiUsage>;
  const wrapperPrefixes = WRAPPERS.flatMap((w) => w.classPrefixes).map(dotted);
  for (const key of API_KEYS) {
    const u: ApiUsage = { found: false, layers: [], evidence: [], strings: [], confidence: "high" };
    const sites: CallSite[] = (dex.calls[key] ?? []).filter((s) => !wrapperPrefixes.some((p) => s.caller.startsWith(p)));
    if (sites.length) {
      u.found = true;
      u.layers.push("native");
      for (const s of sites.slice(0, 5)) u.evidence.push(`Java/Kotlin: ${s.caller}.${s.method}()`);
      if (sites.length > 5) u.evidence.push(`…and ${sites.length - 5} more call sites`);
      u.strings.push(...sites.flatMap((s) => s.strings));
    }
    const l = layer.found[key];
    if (l && layer.layer) {
      u.found = true;
      u.layers.push(layer.layer);
      u.evidence.push(l.evidence);
      u.strings.push(...l.strings);
      if (!sites.length) u.confidence = l.confidence;
    }
    // android.* framework classes are never renamed by R8, so absence is real.
    if (!u.found && key !== "androidChannel") {
      const readableLayer = hasWrapper && primary !== "native" && layer.inspectable;
      const isLayerApi = CROSS_PLATFORM_APIS[key].length > 0;
      if (obfuscated) {
        // Native code is unreadable. If the API is normally called from the
        // (readable) cross-platform layer, its absence there is still a signal.
        if (readableLayer && isLayerApi) u.confidence = "medium";
        else u.found = null;
      } else if (hasWrapper && primary !== "native" && !layer.inspectable && isLayerApi) {
        u.found = null;
      }
      if (u.found === null) u.confidence = "low";
    }
    u.strings = uniq(u.strings);
    out[key] = u;
  }
  return out;
}

function markFound(u: ApiUsage, layer: CodeLayer, evidence: string, confidence: ApiUsage["confidence"]) {
  u.found = true;
  if (!u.layers.includes(layer)) u.layers.push(layer);
  u.evidence.unshift(evidence);
  u.confidence = confidence;
}

/* ------------------------------------------------------------------ */

function readVersionMarkers(dexBuf: Uint8Array): [string, string][] {
  // e.g. "!SDK-VERSION-STRING!:com.clevertap.android:clevertap-android-sdk:7.8.0.0"
  const out: [string, string][] = [];
  for (const off of indexOfAll(dexBuf, "!SDK-VERSION-STRING!:", 20)) {
    const s = readAsciiRun(dexBuf, off, 160);
    const m = s.match(/^!SDK-VERSION-STRING!:([^:]+):([^:]+):(\d+(?:\.\d+)*)/);
    if (m) out.push([m[2], normaliseVersion(m[3])]);
  }
  return out;
}

function normaliseVersion(v: string) {
  // marker uses 4 parts (7.8.0.0) — the published version has 3
  const parts = v.split(".");
  if (parts.length === 4 && parts[3] === "0") parts.pop();
  return parts.join(".");
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", data as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const yieldToEventLoop = () => new Promise((r) => setTimeout(r, 0));
const num = (v?: string) => (v && /^-?\d+$/.test(v) ? Number(v) : undefined);
const uniq = <T,>(a: T[]) => [...new Set(a)];
const dotted = (desc: string) => desc.replace(/^L/, "").replace(/;$/, "").replace(/\//g, ".");
const isPlausibleEventName = (s: string) => s.length > 0 && s.length <= 120 && !/[\n\r\t]/.test(s);
