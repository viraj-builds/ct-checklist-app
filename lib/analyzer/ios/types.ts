// JSON-serialisable output of the iOS static analyzer (IPA / zipped .app /
// zipped .xcarchive). Produced in the user's browser — the build never leaves
// the device. The iOS rule engine only ever sees this report.

import type { ApiUsage, Framework } from "../types";

export type IosApiKey =
  | "onUserLogin"
  | "profilePush"
  | "recordEvent"
  | "recordChargedEvent"
  | "setLocation"
  | "enableDeviceNetworkInfo"
  | "autoIntegrate"
  | "setPushToken" // manual token hand-off (no autoIntegrate)
  | "registerForRemote" // UIApplication.registerForRemoteNotifications
  | "requestAuthorization" // UNUserNotificationCenter.requestAuthorization
  | "pushPrimer" // CleverTap promptPushPrimer / promptForPushPermission
  | "handleNotification" // manual click hand-off: handleNotificationWithData
  | "notificationDelegate" // app implements userNotificationCenter:didReceive…
  | "willPresent" // app implements userNotificationCenter:willPresent… (foreground pushes)
  | "setCredentials" // credentials set in code instead of Info.plist
  | "setDebugLevel"
  | "urlDelegate" // CleverTapURLDelegate — custom deep-link routing
  | "openUrl" // application:openURL:options: / scene openURLContexts
  | "suspendInApps"
  | "inAppDelegate"
  | "recordScreen";

export interface IosExtension {
  name: string; // bundle folder, e.g. NotificationService.appex
  bundleId?: string;
  point: string; // NSExtensionPointIdentifier
  kind: "service" | "content" | "other";
  principalClass?: string;
  usesCleverTap: boolean; // links CleverTap (CTNotificationService / CleverTapSDK) or records impressions
  recordsImpressions: boolean | null; // calls recordNotificationViewedEventWithData
  richMedia: boolean | null; // CTNotificationServiceExtension (downloads images/video)
  appGroups: string[];
}

export interface IosScanReport {
  schema: 1;
  platform: "ios";
  analyzer: string;
  scannedAt: number;
  durationMs: number;
  scannedIn: "browser" | "server";
  file: { name: string; size: number; sha256: string; kind: "ipa" | "app-zip" | "xcarchive" };

  app: {
    bundleId?: string;
    displayName?: string;
    executable?: string;
    versionName?: string; // CFBundleShortVersionString
    buildNumber?: string; // CFBundleVersion
    minOs?: string;
    sdkName?: string; // iphoneos26.5 / iphonesimulator26.5
    simulatorBuild: boolean;
    debugBuild: boolean; // *.debug.dylib or get-task-allow
    archs: string[];
    swiftUi: boolean;
    sceneDelegate: boolean;
    binaryBytes: number;
  };

  framework: { primary: Framework; signals: string[] };

  clevertap: {
    present: boolean;
    version?: string;
    versionSource?: "framework-plist" | "binary" | "pod-plist";
    linkage: "dynamic" | "static" | "none";
    modules: { id: string; label: string; version?: string }[];
    wrapper?: { framework: Framework; label: string; version?: string; detectedBy: string[] };
  };

  // Keys read from Info.plist (CleverTap* + push/location/background settings)
  plist: {
    accountId?: string;
    token?: string; // masked on the server
    region?: string;
    proxyDomain?: string;
    disableIdfv?: boolean;
    encryptionLevel?: string;
    backgroundModes: string[];
    urlSchemes: string[];
    queriesSchemes: string[];
    usage: Record<string, boolean>; // NS*UsageDescription keys present
    firebaseProxy?: boolean; // FirebaseAppDelegateProxyEnabled
    other: Record<string, string>; // other CleverTap* keys
  };

  signing: {
    apsEnvironment?: string; // development | production
    associatedDomains: string[];
    appGroups: string[];
    teamId?: string;
    provision?: { name?: string; type: "development" | "ad-hoc" | "app-store" | "enterprise" | "unknown"; expires?: string; devices?: number };
    getTaskAllow?: boolean;
  };

  extensions: IosExtension[];
  firebase: { messaging: boolean; googleServicePlist: boolean };

  apis: Record<IosApiKey, ApiUsage>;
  eventNames: string[];
  notes: string[];
}
