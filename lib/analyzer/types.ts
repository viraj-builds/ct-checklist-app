// JSON-serialisable output of the Android static analyzer. Produced either in
// the browser (private scan — the binary never leaves the device) or on the
// server (upload scan). The rule engine only ever sees this report.

export type Framework =
  | "native"
  | "flutter"
  | "react-native"
  | "cordova"
  | "capacitor"
  | "unity"
  | "dotnet" // Xamarin / .NET MAUI
  | "unknown";

// Where a call was observed. "native" = app's own Java/Kotlin; "dart"/"js"/
// "dotnet"/"unity" = the cross-platform layer.
export type CodeLayer = "native" | "dart" | "js" | "dotnet" | "unity";

export type ApiKey =
  | "onUserLogin"
  | "pushProfile"
  | "pushEvent"
  | "pushChargedEvent"
  | "setLocation"
  | "enableDeviceNetworkInfoReporting"
  | "createNotificationChannel"
  | "androidChannel" // plain android.app.NotificationChannel(id, …)
  | "promptPushPermission"
  | "pushFcmToken"
  | "fcmHandoff"
  | "lifecycleRegister"
  | "getInstance"
  | "changeCredentials"
  | "setDebugLevel";

export interface ApiUsage {
  // true = call observed, false = searched and not found, null = can't tell
  // (e.g. code is obfuscated or the JS bundle is Hermes bytecode)
  found: boolean | null;
  layers: CodeLayer[];
  evidence: string[]; // human-readable, e.g. "Kotlin/Java: com.shop.LoginActivity.onLogin"
  strings: string[]; // captured literal args (event names, channel ids…)
  confidence: "high" | "medium" | "low";
}

export interface DeepLink {
  activity: string;
  scheme: string;
  host?: string;
  path?: string;
  autoVerify: boolean;
}

export interface CtModule {
  id: string; // maven artifact id or wrapper id
  label: string;
  version?: string;
}

export interface AndroidScanReport {
  schema: 1;
  analyzer: string;
  scannedAt: number;
  durationMs: number;
  scannedIn: "browser" | "server";
  file: { name: string; size: number; sha256: string; kind: "apk" | "aab" | "apks" | "xapk" };

  app: {
    packageName?: string;
    versionName?: string;
    versionCode?: string;
    minSdk?: number;
    targetSdk?: number;
    compileSdk?: number;
    applicationClass?: string;
    debuggable: boolean;
    launcherActivity?: string;
    activityCount: number;
    dexCount: number;
    abis: string[];
  };

  framework: {
    primary: Framework;
    signals: string[];
    hermes?: boolean;
    expo?: boolean;
  };

  // R8/ProGuard renamed the SDK's public API classes — call sites can't be
  // resolved by name, so native call checks become "unknown".
  obfuscated: boolean;

  clevertap: {
    present: boolean;
    coreVersion?: string;
    versionSource?: "marker" | "buildconfig" | "estimate";
    minVersionEstimate?: string; // when only feature-based estimation was possible
    modules: CtModule[];
    wrapper?: { framework: Framework; label: string; version?: string; detectedBy: string[] };
  };

  manifest: {
    found: boolean;
    metaData: Record<string, string>; // CLEVERTAP_* + relevant third-party keys
    permissions: string[];
    ctComponents: string[];
    messagingServices: { name: string; isCleverTap: boolean }[];
    deepLinks: DeepLink[];
    activities: string[]; // capped
  };

  firebase: {
    messagingSdk: boolean;
    googleServicesConfigured: boolean; // google-services plugin resources present
    installReferrer: boolean;
  };

  apis: Record<ApiKey, ApiUsage>;
  eventNames: string[]; // custom event names found in code
  channelIds: string[]; // notification channel ids created in code
  notes: string[];
}
