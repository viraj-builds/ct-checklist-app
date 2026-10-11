// iOS static analyzer: IPA, zipped .app (e.g. the Simulator build from Xcode)
// or zipped .xcarchive -> IosScanReport. Runs in a Web Worker (private scan)
// and in Node (scripts). Reads only what the checks need: plists, the
// provisioning profile, the app/extension/CleverTap binaries and a few
// cross-platform markers.

import { unzipSync, type UnzipFileInfo } from "fflate";
import type { ApiUsage, Framework } from "../types";
import type { IosApiKey, IosExtension, IosScanReport } from "./types";
import { asArray, asDict, asString, findXmlPlist, parsePlist, type PlistDict } from "./plist";
import { parseMachO, sdkVersionFromStrings, type MachO } from "./macho";

export const IOS_ANALYZER_VERSION = "ios-analyzer/1.0";

type Progress = (stage: string, pct: number) => void;

// Decompression-bomb guard (sizes declared in the zip directory)
const MAX_ENTRY = 600 * 1024 * 1024;
const MAX_TOTAL = 1536 * 1024 * 1024;
const MAX_ENTRIES = 300_000;

// Selectors that identify each API. "sdk" = the CleverTap SDK itself also
// references it, so in a statically linked build its presence proves nothing.
const SELECTORS: Record<IosApiKey, { sel: RegExp; label: string; sdk?: boolean }> = {
  onUserLogin: { sel: /^onUserLogin:(withCleverTapID:)?$/, label: "onUserLogin" },
  profilePush: { sel: /^profilePush:$/, label: "profilePush" },
  recordEvent: { sel: /^recordEvent:(withProps:)?$/, label: "recordEvent" },
  recordChargedEvent: { sel: /^recordChargedEventWithDetails:andItems:$/, label: "recordChargedEvent" },
  setLocation: { sel: /^setLocation:$|^setLocationForGeofences:withPluginVersion:$/, label: "setLocation" },
  enableDeviceNetworkInfo: { sel: /^enableDeviceNetworkInfoReporting:$/, label: "enableDeviceNetworkInfoReporting" },
  autoIntegrate: { sel: /^autoIntegrate(WithCleverTapID:)?$/, label: "CleverTap.autoIntegrate()" },
  setPushToken: { sel: /^setPushToken:$|^setPushTokenAsString:$/, label: "setPushToken", sdk: true },
  registerForRemote: { sel: /^registerForRemoteNotifications$/, label: "registerForRemoteNotifications", sdk: true },
  requestAuthorization: { sel: /^requestAuthorizationWithOptions:completionHandler:$/, label: "UNUserNotificationCenter.requestAuthorization", sdk: true },
  pushPrimer: { sel: /^promptPushPrimer:$|^promptForPushPermission:$/, label: "CleverTap push primer" },
  handleNotification: { sel: /^handleNotificationWithData:(openDeepLinksInForeground:)?$/, label: "handleNotificationWithData", sdk: true },
  notificationDelegate: { sel: /^userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:$/, label: "userNotificationCenter(_:didReceive:)", sdk: true },
  willPresent: { sel: /^userNotificationCenter:willPresentNotification:withCompletionHandler:$/, label: "userNotificationCenter(_:willPresent:)", sdk: true },
  setCredentials: { sel: /^setCredentialsWithAccountID:(andToken:|token:)/, label: "setCredentialsWithAccountID" },
  setDebugLevel: { sel: /^setDebugLevel:$/, label: "CleverTap.setDebugLevel" },
  urlDelegate: { sel: /^setUrlDelegate:$|^shouldHandleCleverTapURL:forChannel:$/, label: "CleverTapURLDelegate" },
  openUrl: { sel: /^application:openURL:options:$|^scene:openURLContexts:$|^application:continueUserActivity:restorationHandler:$/, label: "openURL handler", sdk: true },
  suspendInApps: { sel: /^suspendInAppNotifications$|^discardInAppNotifications$/, label: "suspendInAppNotifications" },
  inAppDelegate: { sel: /^setInAppNotificationDelegate:$/, label: "setInAppNotificationDelegate" },
  recordScreen: { sel: /^recordScreenView:$/, label: "recordScreenView" },
};

/* ------------------------------------------------------------------ */

export async function analyzeIos(data: Uint8Array, fileName: string, where: "browser" | "server", onProgress: Progress = () => {}): Promise<IosScanReport> {
  const t0 = Date.now();
  onProgress("Fingerprinting the build", 3);
  const sha256 = await sha256Hex(data);

  // pass 1: entry names only
  onProgress("Reading the archive", 8);
  const names: { name: string; size: number }[] = [];
  let total = 0;
  unzipSync(data, {
    filter: (f: UnzipFileInfo) => {
      if (names.length >= MAX_ENTRIES) throw new Error("Archive has too many entries.");
      names.push({ name: f.name, size: f.originalSize });
      return false;
    },
  });
  const root = findAppRoot(names.map((n) => n.name));
  if (!root) throw new Error("No .app bundle found. Upload an .ipa, a zipped .app or a zipped .xcarchive.");
  const kind: IosScanReport["file"]["kind"] = /\.ipa$/i.test(fileName) || root.startsWith("Payload/") ? "ipa" : /Products\/Applications\//.test(root) ? "xcarchive" : "app-zip";
  const inApp = names.filter((n) => n.name.startsWith(root)).map((n) => ({ ...n, rel: n.name.slice(root.length) }));
  const rels = new Set(inApp.map((n) => n.rel));

  // pass 2: plists + provisioning profile
  onProgress("Reading Info.plist", 15);
  const isPlistWanted = (rel: string) =>
    rel === "Info.plist" ||
    rel === "embedded.mobileprovision" ||
    rel === "GoogleService-Info.plist" ||
    /^PlugIns\/[^/]+\.appex\/Info\.plist$/.test(rel) ||
    /^Frameworks\/[^/]+\.framework\/Info\.plist$/.test(rel);
  const meta = unzipPick(data, root, (rel, size) => isPlistWanted(rel) && size < 8 * 1024 * 1024);

  const infoRaw = meta.get("Info.plist");
  if (!infoRaw) throw new Error("The app's Info.plist is missing.");
  const info = asDict(parsePlist(infoRaw)) ?? {};
  const exe = asString(info.CFBundleExecutable) ?? root.replace(/\.app\/$/, "").split("/").pop()!;

  const extDirs = [...new Set(inApp.map((n) => n.rel.match(/^PlugIns\/([^/]+\.appex)\//)?.[1]).filter(Boolean) as string[])];
  const extInfo = new Map<string, PlistDict>();
  for (const d of extDirs) {
    const raw = meta.get(`PlugIns/${d}/Info.plist`);
    if (raw) extInfo.set(d, asDict(parsePlist(raw)) ?? {});
  }
  const fwDirs = [...new Set(inApp.map((n) => n.rel.match(/^Frameworks\/([^/]+)\.framework\//)?.[1]).filter(Boolean) as string[])];
  const fwVersion = (fw: string) => {
    const raw = meta.get(`Frameworks/${fw}.framework/Info.plist`);
    if (!raw) return undefined;
    const d = asDict(parsePlist(raw));
    const v = asString(d?.CFBundleShortVersionString);
    return v && v !== "1.0" && /^\d+\.\d+(\.\d+)?$/.test(v) ? v : undefined;
  };

  // pass 3: binaries
  onProgress("Reading the app binary", 30);
  const ctFw = fwDirs.find((f) => /^CleverTapSDK$/i.test(f)) ?? fwDirs.find((f) => /^CleverTap/i.test(f) && !/Location|Geofence/i.test(f));
  const nseExes = new Map<string, string>(); // appex dir -> executable name
  for (const d of extDirs) nseExes.set(d, asString(extInfo.get(d)?.CFBundleExecutable) ?? d.replace(/\.appex$/, ""));
  const binWanted = (rel: string, size: number) => {
    if (size > MAX_ENTRY) return false;
    if (rel === exe || rel === `${exe}.debug.dylib`) return true;
    if (ctFw && rel === `Frameworks/${ctFw}.framework/${ctFw}`) return true;
    if (/^Frameworks\/(clevertap_plugin|CleverTapReact|clevertap_react_native|CleverTapPlugin)[^/]*\.framework\/[^/.]+$/i.test(rel)) return true;
    for (const [d, e] of nseExes) if (rel === `PlugIns/${d}/${e}` || rel === `PlugIns/${d}/${e}.debug.dylib`) return true;
    if (rel === "main.jsbundle") return size < 80 * 1024 * 1024;
    if (/^www\/(cordova_plugins|plugins\/[^/]*clevertap[^/]*\/.*)\.js$/i.test(rel)) return true;
    if (rel === "capacitor.config.json" || rel === "public/cordova_plugins.js") return true;
    return false;
  };
  let budget = 0;
  const bins = unzipPick(data, root, (rel, size) => {
    if (!binWanted(rel, size)) return false;
    budget += size;
    if (budget > MAX_TOTAL) throw new Error("The build expands to more than 1.5 GB — refusing to unpack it.");
    return true;
  });
  total = budget;

  onProgress("Parsing the code", 55);
  const main = bins.get(exe) ? parseMachO(bins.get(exe)!) : null;
  if (!main) throw new Error(`Couldn't read the app binary (${exe}).`);
  const debugDylib = bins.get(`${exe}.debug.dylib`) ? parseMachO(bins.get(`${exe}.debug.dylib`)!) : null;
  const appBins = [main, debugDylib].filter(Boolean) as MachO[];
  const ctBinRaw = ctFw ? bins.get(`Frameworks/${ctFw}.framework/${ctFw}`) : undefined;
  const ctBin = ctBinRaw ? parseMachO(ctBinRaw) : null;

  /* ---- CleverTap presence / linkage / version ---- */
  onProgress("Looking for the CleverTap SDK", 65);
  const anyClass = (re: RegExp) => appBins.some((b) => [...b.classnames].some((c) => re.test(c)));
  const importsCt = appBins.some((b) => b.undefinedSymbols.some((s) => /_OBJC_CLASS_\$_CleverTap$/.test(s))) || appBins.some((b) => b.dylibs.some((d) => /CleverTapSDK/.test(d)));
  const staticCt = anyClass(/^CleverTap$/) || anyClass(/^CTInAppDisplayManager$|^CTSessionManager$/);
  const linkage: IosScanReport["clevertap"]["linkage"] = ctFw || importsCt ? "dynamic" : staticCt ? "static" : "none";
  let version: string | undefined;
  let versionSource: IosScanReport["clevertap"]["versionSource"];
  if (ctFw && fwVersion(ctFw)) {
    version = fwVersion(ctFw);
    versionSource = "framework-plist";
  }
  if (!version && ctBin) {
    version = sdkVersionFromStrings(ctBin.cstrings, true);
    if (version) versionSource = "binary";
  }
  if (!version && linkage === "static") {
    version = sdkVersionFromStrings(appBins.flatMap((b) => b.cstrings), false);
    if (version) versionSource = "binary";
  }

  const modules: IosScanReport["clevertap"]["modules"] = [];
  const addMod = (id: string, label: string, present: boolean, v?: string) => present && modules.push({ id, label, version: v });
  addMod("CleverTapSDK", "CleverTap iOS SDK", linkage !== "none", version);
  addMod("CleverTapLocation", "CleverTap Location", fwDirs.some((f) => /CleverTapLocation/i.test(f)) || anyClass(/^CTLocationManager$/), fwVersion("CleverTapLocation"));
  addMod("CleverTapGeofence", "CleverTap Geofence", fwDirs.some((f) => /CleverTapGeofence/i.test(f)) || anyClass(/^CleverTapGeofence/), fwVersion("CleverTapGeofence"));
  addMod("SDWebImage", "SDWebImage (in-app / inbox images)", fwDirs.includes("SDWebImage") || anyClass(/^SDWebImageManager$/), fwVersion("SDWebImage"));

  /* ---- framework (cross-platform layer) ---- */
  const fw = detectFramework(rels, fwDirs, appBins);
  const wrapper = detectWrapper(fw.primary, rels, fwDirs, appBins, bins);

  /* ---- API usage ---- */
  onProgress("Checking CleverTap calls", 75);
  const wrapped = fw.primary !== "native" && fw.primary !== "unknown";
  const apis = {} as Record<IosApiKey, ApiUsage>;
  const js = wrapperJs(bins);
  for (const key of Object.keys(SELECTORS) as IosApiKey[]) {
    const spec = SELECTORS[key];
    const hit = appBins.flatMap((b) => [...b.selrefs].filter((s) => spec.sel.test(s)));
    const implemented = appBins.flatMap((b) => [...b.methnames].filter((s) => spec.sel.test(s)));
    const found = hit.length > 0 || ((key === "notificationDelegate" || key === "willPresent" || key === "openUrl") && implemented.length > 0);
    const u: ApiUsage = { found, layers: found ? ["native"] : [], evidence: [], strings: [], confidence: "high" };
    if (found) u.evidence.push(`Swift/Obj-C: ${spec.label} (${[...new Set([...hit, ...implemented])].slice(0, 2).join(", ")})`);
    if (linkage === "static" && spec.sdk && found) {
      u.found = null; // the SDK compiled into the app references it itself
      u.confidence = "low";
      u.evidence = [`${spec.label} is referenced, but the CleverTap SDK is compiled into the app binary, so it may be the SDK's own call.`];
    } else if (linkage === "static" && found) u.confidence = "medium";
    if (wrapped && !found) {
      // calls from Dart / JS go through the plugin's native code
      const jsHit = js && jsCall(js, key);
      if (jsHit) {
        u.found = true;
        u.layers = [fw.primary === "flutter" ? "dart" : "js"];
        u.evidence.push(`${fw.primary === "flutter" ? "Dart" : "JS"}: ${jsHit}`);
        u.confidence = "medium";
      } else if (!["registerForRemote", "requestAuthorization", "notificationDelegate", "willPresent", "openUrl", "autoIntegrate", "setPushToken", "handleNotification"].includes(key)) {
        u.found = null;
        u.confidence = "low";
        u.evidence.push(`Called from the ${FRAMEWORK_NAME[fw.primary]} layer, which this scan can't read — the live log session confirms it.`);
      }
    }
    apis[key] = u;
  }

  /* ---- Info.plist ---- */
  const str = (k: string) => asString(info[k])?.trim() || undefined;
  const urlSchemes = asArray(info.CFBundleURLTypes).flatMap((t) => asArray(asDict(t)?.CFBundleURLSchemes).map((s) => asString(s) ?? "")).filter(Boolean);
  const usageKeys = ["NSLocationWhenInUseUsageDescription", "NSLocationAlwaysAndWhenInUseUsageDescription", "NSLocationAlwaysUsageDescription", "NSUserTrackingUsageDescription", "NSCameraUsageDescription", "NSPhotoLibraryUsageDescription"];
  const other: Record<string, string> = {};
  for (const [k, v] of Object.entries(info)) {
    if (/^CleverTap/.test(k) && !["CleverTapAccountID", "CleverTapToken", "CleverTapRegion"].includes(k)) {
      const s = asString(v);
      if (s !== undefined) other[k] = s.slice(0, 200);
    }
  }
  const plist: IosScanReport["plist"] = {
    accountId: str("CleverTapAccountID"),
    token: str("CleverTapToken"),
    region: str("CleverTapRegion"),
    proxyDomain: str("CleverTapProxyDomain"),
    disableIdfv: info.CleverTapDisableIDFV === true || info.CleverTapDisableIDFV === "YES" ? true : undefined,
    encryptionLevel: str("CleverTapEncryptionLevel"),
    backgroundModes: asArray(info.UIBackgroundModes).map((m) => asString(m) ?? "").filter(Boolean),
    urlSchemes: [...new Set(urlSchemes)].slice(0, 30),
    queriesSchemes: asArray(info.LSApplicationQueriesSchemes).map((m) => asString(m) ?? "").filter(Boolean).slice(0, 30),
    usage: Object.fromEntries(usageKeys.map((k) => [k, typeof info[k] === "string" && !!(info[k] as string).trim()])),
    firebaseProxy: info.FirebaseAppDelegateProxyEnabled === undefined ? undefined : info.FirebaseAppDelegateProxyEnabled === true || info.FirebaseAppDelegateProxyEnabled === "YES",
    other,
  };

  /* ---- signing ---- */
  onProgress("Reading entitlements", 85);
  const ent = main.entitlements ?? debugDylib?.entitlements;
  const prov = meta.get("embedded.mobileprovision") ? findXmlPlist(meta.get("embedded.mobileprovision")!) : undefined;
  const provEnt = asDict(prov?.Entitlements);
  const aps = asString(ent?.["aps-environment"]) ?? asString(provEnt?.["aps-environment"]);
  const getTaskAllow = (ent?.["get-task-allow"] ?? provEnt?.["get-task-allow"]) === true;
  const provType = (): NonNullable<IosScanReport["signing"]["provision"]>["type"] => {
    if (!prov) return "unknown";
    if (prov.ProvisionsAllDevices === true) return "enterprise";
    if (asArray(prov.ProvisionedDevices).length) return getTaskAllow ? "development" : "ad-hoc";
    return "app-store";
  };
  const signing: IosScanReport["signing"] = {
    apsEnvironment: aps,
    associatedDomains: asArray(ent?.["com.apple.developer.associated-domains"] ?? provEnt?.["com.apple.developer.associated-domains"]).map((d) => asString(d) ?? "").filter(Boolean),
    appGroups: asArray(ent?.["com.apple.security.application-groups"]).map((d) => asString(d) ?? "").filter(Boolean),
    teamId: asString(asArray(prov?.TeamIdentifier)[0]) ?? asString(ent?.["com.apple.developer.team-identifier"]),
    provision: prov
      ? {
          name: asString(prov.Name),
          type: provType(),
          expires: prov.ExpirationDate instanceof Date ? prov.ExpirationDate.toISOString() : undefined,
          devices: asArray(prov.ProvisionedDevices).length || undefined,
        }
      : undefined,
    getTaskAllow,
  };

  /* ---- extensions ---- */
  onProgress("Checking app extensions", 90);
  const extensions: IosExtension[] = [];
  for (const d of extDirs) {
    const pinfo = extInfo.get(d) ?? {};
    const ext = asDict(pinfo.NSExtension);
    const point = asString(ext?.NSExtensionPointIdentifier) ?? "unknown";
    const exeName = nseExes.get(d)!;
    const binA = bins.get(`PlugIns/${d}/${exeName}`);
    const binB = bins.get(`PlugIns/${d}/${exeName}.debug.dylib`);
    const mos = [binA, binB].map((b) => (b ? parseMachO(b) : null)).filter(Boolean) as MachO[];
    const has = (re: RegExp) => mos.some((m) => [...m.classnames, ...m.undefinedSymbols, ...m.definedSymbols, ...m.dylibs].some((x) => re.test(x)));
    const rich = has(/CTNotificationServiceExtension|CTNotificationService/);
    const records = mos.length ? mos.some((m) => [...m.selrefs, ...m.methnames].some((s) => /^recordNotificationViewedEventWithData:$/.test(s))) : null;
    const usesCt = rich || has(/CleverTap|CTNotificationContent/) || !!records;
    const entExt = mos.map((m) => m.entitlements).find(Boolean);
    extensions.push({
      name: d,
      bundleId: asString(pinfo.CFBundleIdentifier),
      point,
      kind: point === "com.apple.usernotifications.service" ? "service" : point === "com.apple.usernotifications.content-extension" ? "content" : "other",
      principalClass: asString(ext?.NSExtensionPrincipalClass),
      usesCleverTap: usesCt,
      recordsImpressions: mos.length ? !!records : null,
      richMedia: mos.length ? rich : null,
      appGroups: asArray(entExt?.["com.apple.security.application-groups"]).map((g) => asString(g) ?? "").filter(Boolean),
    });
  }

  /* ---- notes ---- */
  const notes: string[] = [];
  const simulatorBuild = main.platform === "ios-simulator" || /simulator/i.test(asString(info.DTPlatformName) ?? "");
  const debugBuild = !!debugDylib || getTaskAllow;
  if (simulatorBuild) notes.push("Simulator build — signing, provisioning and APNs production settings can't be judged from it. Scan the IPA you ship for those.");
  if (debugDylib) notes.push(`Debug build: the app's code lives in ${exe}.debug.dylib.`);
  if (linkage === "static") notes.push("The CleverTap SDK is compiled into the app binary (static linking) — some call checks are less certain.");
  if (wrapped) notes.push(`${FRAMEWORK_NAME[fw.primary]} app — CleverTap is called from the ${fw.primary === "flutter" ? "Dart" : "JavaScript"} layer through the native plugin.`);

  const swiftUi = appBins.some((b) => b.dylibs.some((d) => /SwiftUI\.framework/.test(d)));
  const sceneDelegate = !!asDict(info.UIApplicationSceneManifest) && appBins.some((b) => [...b.methnames].some((m) => m === "scene:willConnectToSession:options:"));

  onProgress("Done", 100);
  return {
    schema: 1,
    platform: "ios",
    analyzer: IOS_ANALYZER_VERSION,
    scannedAt: Date.now(),
    durationMs: Date.now() - t0,
    scannedIn: where,
    file: { name: fileName, size: data.byteLength, sha256, kind },
    app: {
      bundleId: str("CFBundleIdentifier"),
      displayName: str("CFBundleDisplayName") ?? str("CFBundleName"),
      executable: exe,
      versionName: str("CFBundleShortVersionString"),
      buildNumber: str("CFBundleVersion"),
      minOs: str("MinimumOSVersion") ?? main.minOs,
      sdkName: str("DTSDKName"),
      simulatorBuild,
      debugBuild,
      archs: main.archs,
      swiftUi,
      sceneDelegate,
      binaryBytes: total,
    },
    framework: fw,
    clevertap: { present: linkage !== "none", version, versionSource, linkage, modules, wrapper },
    plist,
    signing,
    extensions,
    firebase: {
      messaging: fwDirs.some((f) => /FirebaseMessaging/.test(f)) || anyClass(/^FIRMessaging$/),
      googleServicePlist: rels.has("GoogleService-Info.plist"),
    },
    apis,
    eventNames: [],
    notes,
  };
}

/* ------------------------------------------------------------------ */

const FRAMEWORK_NAME: Record<Framework, string> = {
  native: "Native",
  flutter: "Flutter",
  "react-native": "React Native",
  cordova: "Cordova",
  capacitor: "Ionic Capacitor",
  unity: "Unity",
  dotnet: ".NET MAUI / Xamarin",
  unknown: "Unknown",
};

/** Path of the .app folder inside the zip, with trailing slash. */
function findAppRoot(names: string[]): string | null {
  const roots = new Map<string, number>();
  for (const n of names) {
    const m = n.match(/^(.*?[^/]+\.app\/)Info\.plist$/);
    if (m && !/\.app\/.+\.app\//.test(m[1]) && !/\/(PlugIns|Frameworks|Watch)\//.test(m[1])) roots.set(m[1], m[1].split("/").length);
  }
  if (!roots.size) return null;
  // prefer Payload/ (IPA), then Products/Applications (xcarchive), then the shallowest
  const list = [...roots.keys()];
  return list.find((r) => r.startsWith("Payload/")) ?? list.find((r) => r.includes("Products/Applications/")) ?? list.sort((a, b) => roots.get(a)! - roots.get(b)!)[0];
}

function unzipPick(data: Uint8Array, root: string, want: (rel: string, size: number) => boolean): Map<string, Uint8Array> {
  const out = unzipSync(data, {
    filter: (f: UnzipFileInfo) => f.name.startsWith(root) && want(f.name.slice(root.length), f.originalSize),
  });
  const map = new Map<string, Uint8Array>();
  for (const [k, v] of Object.entries(out)) map.set(k.slice(root.length), v);
  return map;
}

function detectFramework(rels: Set<string>, fwDirs: string[], bins: MachO[]): IosScanReport["framework"] {
  const signals: string[] = [];
  const has = (re: RegExp) => [...rels].some((r) => re.test(r));
  let primary: Framework = "native";
  if (fwDirs.includes("Flutter")) {
    primary = "flutter";
    signals.push("Frameworks/Flutter.framework");
  } else if (rels.has("main.jsbundle") || bins.some((b) => b.classnames.has("RCTBridge") || [...b.classnames].some((c) => c === "RCTRootView" || c === "RCTHost"))) {
    primary = "react-native";
    signals.push(rels.has("main.jsbundle") ? "main.jsbundle" : "React Native classes");
  } else if (fwDirs.includes("Capacitor") || rels.has("capacitor.config.json")) {
    primary = "capacitor";
    signals.push("Capacitor.framework");
  } else if (has(/^www\/cordova\.js$/)) {
    primary = "cordova";
    signals.push("www/cordova.js");
  } else if (fwDirs.includes("UnityFramework")) {
    primary = "unity";
    signals.push("UnityFramework.framework");
  } else if (has(/\.dll$/) || bins.some((b) => b.dylibs.some((d) => /libmonosgen|Microsoft\.Maui|libxamarin/i.test(d)))) {
    primary = "dotnet";
    signals.push(".NET runtime");
  }
  if (primary === "native") signals.push(bins.some((b) => b.dylibs.some((d) => /libswiftCore|SwiftUI/.test(d))) ? "Swift" : "Objective-C");
  return { primary, signals };
}

function detectWrapper(fw: Framework, rels: Set<string>, fwDirs: string[], bins: MachO[], files: Map<string, Uint8Array>): IosScanReport["clevertap"]["wrapper"] {
  const cls = (re: RegExp) => bins.some((b) => [...b.classnames].some((c) => re.test(c)));
  if (fw === "flutter" && (fwDirs.some((f) => /^clevertap_plugin$/i.test(f)) || cls(/^CleverTapPlugin$/)))
    return { framework: "flutter", label: "clevertap_plugin (Flutter)", detectedBy: [fwDirs.some((f) => /^clevertap_plugin$/i.test(f)) ? "Frameworks/clevertap_plugin.framework" : "CleverTapPlugin class"] };
  if (fw === "react-native" && (cls(/^CleverTapReact$/) || fwDirs.some((f) => /clevertap.react/i.test(f))))
    return { framework: "react-native", label: "clevertap-react-native", version: jsVersion(files.get("main.jsbundle")), detectedBy: ["CleverTapReact native module"] };
  if ((fw === "cordova" || fw === "capacitor") && (cls(/^CleverTapPlugin$/) || [...rels].some((r) => /clevertap/i.test(r) && /plugins\//.test(r))))
    return { framework: fw, label: fw === "cordova" ? "clevertap-cordova" : "clevertap-cordova (Capacitor)", detectedBy: ["CleverTapPlugin"] };
  return undefined;
}

const latin1 = new TextDecoder("latin1");
function wrapperJs(files: Map<string, Uint8Array>): string | undefined {
  const b = files.get("main.jsbundle");
  if (b && !(b[0] === 0xc6 && b[1] === 0x1f && b[2] === 0xbc && b[3] === 0x03)) return latin1.decode(b); // not Hermes bytecode
  const cordova = [...files.entries()].filter(([k]) => /\.js$/.test(k) && /^www\//.test(k)).map(([, v]) => latin1.decode(v));
  return cordova.length ? cordova.join("\n") : undefined;
}

const JS_CALL: Partial<Record<IosApiKey, RegExp>> = {
  onUserLogin: /\bonUserLogin\s*\(/,
  profilePush: /\bprofileSet\s*\(|\bprofilePush\s*\(/,
  recordEvent: /\brecordEvent\s*\(/,
  recordChargedEvent: /\brecordChargedEvent\s*\(/,
  setLocation: /\bsetLocation\s*\(/,
  enableDeviceNetworkInfo: /\benableDeviceNetworkInfoReporting\s*\(/,
  setDebugLevel: /\bsetDebugLevel\s*\(/,
  pushPrimer: /\bpromptPushPrimer\s*\(|\bpromptForPushPermission\s*\(/,
};
function jsCall(js: string, key: IosApiKey): string | undefined {
  const re = JS_CALL[key];
  if (!re || !/CleverTap/i.test(js)) return undefined;
  const m = js.match(re);
  return m ? `${m[0].replace(/\s*\($/, "")}()` : undefined;
}
function jsVersion(b?: Uint8Array) {
  if (!b) return undefined;
  return latin1.decode(b).match(/clevertap-react-native[^0-9]{0,40}(\d+\.\d+\.\d+)/)?.[1];
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", data as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
