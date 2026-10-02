import type { ApiKey, Framework } from "../types";
import type { DexTarget } from "./dex";

// ---------------------------------------------------------------------------
// Everything the analyzer "knows" about CleverTap lives here so it can be
// updated as the SDKs evolve without touching parsing code.
// ---------------------------------------------------------------------------

const API = "Lcom/clevertap/android/sdk/CleverTapAPI;";
const FCM_HANDLER = "Lcom/clevertap/android/sdk/pushnotification/fcm/CTFcmMessageHandler;";
const LIFECYCLE = "Lcom/clevertap/android/sdk/ActivityLifecycleCallback;";
const INSTANCE_CONFIG = "Lcom/clevertap/android/sdk/CleverTapInstanceConfig;";

// Native (Java/Kotlin) call targets. strArgs are register positions:
// for instance methods position 0 is `this`.
export const DEX_TARGETS: (DexTarget & { key: ApiKey })[] = [
  { key: "onUserLogin", cls: API, names: ["onUserLogin"] },
  { key: "pushProfile", cls: API, names: ["pushProfile"] },
  { key: "pushEvent", cls: API, names: ["pushEvent"], strArgs: [1] },
  { key: "pushChargedEvent", cls: API, names: ["pushChargedEvent"] },
  { key: "setLocation", cls: API, names: ["setLocation"] },
  { key: "enableDeviceNetworkInfoReporting", cls: API, names: ["enableDeviceNetworkInfoReporting"] },
  // static createNotificationChannel(Context, String channelId, ...)
  { key: "createNotificationChannel", cls: API, names: ["createNotificationChannel"], strArgs: [1] },
  // new NotificationChannel(String id, CharSequence name, int importance) — `this` is position 0
  { key: "androidChannel", cls: "Landroid/app/NotificationChannel;", names: ["<init>"], strArgs: [1] },
  { key: "promptPushPermission", cls: API, names: ["promptForPushPermission", "promptPushPrimer"] },
  { key: "pushFcmToken", cls: API, names: ["pushFcmRegistrationId", "pushRegistrationToken"] },
  { key: "pushFcmToken", cls: FCM_HANDLER, names: ["onNewToken"] },
  { key: "fcmHandoff", cls: FCM_HANDLER, names: ["createNotification"] },
  { key: "fcmHandoff", cls: API, names: ["createNotification", "processPushNotification"] },
  { key: "lifecycleRegister", cls: LIFECYCLE, names: ["register"] },
  { key: "getInstance", cls: API, names: ["getDefaultInstance", "instanceWithConfig", "getGlobalInstance"] },
  // static changeCredentials(accountId, token[, region])
  { key: "changeCredentials", cls: API, names: ["changeCredentials"], strArgs: [0, 2] },
  // static CleverTapInstanceConfig.createInstance(Context, accountId, token[, region])
  { key: "changeCredentials", cls: INSTANCE_CONFIG, names: ["createInstance"], strArgs: [1, 3] },
  { key: "setDebugLevel", cls: API, names: ["setDebugLevel"] },
];

// Callers under these prefixes are SDK / framework internals — a call from
// there doesn't prove the app uses the API.
export const SDK_INTERNAL_PREFIXES = ["Lcom/clevertap/android/"];
// Libraries that never call CleverTap; skipped for speed.
export const LIBRARY_PREFIXES = [
  "Landroidx/",
  "Landroid/support/",
  "Lkotlin/",
  "Lkotlinx/",
  "Lcom/google/",
  "Lokhttp3/",
  "Lokio/",
  "Lio/flutter/embedding/",
  "Lcom/facebook/react/",
  "Lcom/facebook/hermes/",
  "Lorg/apache/",
  "Lj$/",
];

// Cross-platform plugin bridges (their native code calls every API, so their
// calls only prove the bridge exists, not that the app uses it).
export const WRAPPERS: {
  framework: Framework;
  label: string;
  classPrefixes: string[];
  assetHints: RegExp[];
}[] = [
  {
    framework: "flutter",
    label: "CleverTap Flutter plugin (clevertap_plugin)",
    classPrefixes: ["Lcom/clevertap/clevertap_plugin/"],
    assetHints: [/^assets\/flutter_assets\/packages\/clevertap_plugin\//],
  },
  {
    framework: "react-native",
    label: "CleverTap React Native (clevertap-react-native)",
    classPrefixes: ["Lcom/clevertap/react/"],
    assetHints: [],
  },
  {
    framework: "cordova",
    label: "CleverTap Cordova / Ionic plugin (clevertap-cordova)",
    classPrefixes: ["Lcom/clevertap/cordova/"],
    assetHints: [/^assets\/(www|public)\/plugins\/clevertap-cordova\//],
  },
  {
    framework: "unity",
    label: "CleverTap Unity SDK",
    classPrefixes: ["Lcom/clevertap/unity/"],
    assetHints: [/clevertap/i],
  },
  {
    framework: "dotnet",
    label: "CleverTap Xamarin / .NET MAUI binding",
    classPrefixes: [],
    assetHints: [/^assemblies\/.*clevertap.*\.dll$/i],
  },
];

// Cross-platform method names (Dart / JS / C#) mapped to the API they reach.
// Dart AOT is tree-shaken, so a surviving method-channel literal means the
// method is actually called somewhere.
export const CROSS_PLATFORM_APIS: Record<ApiKey, string[]> = {
  onUserLogin: ["onUserLogin"],
  pushProfile: ["profileSet", "profilePush"],
  pushEvent: ["recordEvent", "recordEventWithNameAndProps", "recordEventWithName"],
  pushChargedEvent: ["recordChargedEvent", "recordChargedEventWithDetailsAndItems"],
  setLocation: ["setLocation"],
  enableDeviceNetworkInfoReporting: ["enableDeviceNetworkInfoReporting"],
  createNotificationChannel: ["createNotificationChannel", "createNotificationChannelWithSound", "createNotificationChannelWithGroupId"],
  androidChannel: [],
  promptPushPermission: ["promptForPushPermission", "promptPushPrimer"],
  pushFcmToken: ["setPushToken", "setFCMPushToken", "setPushTokenAsString", "pushRegistrationToken"],
  fcmHandoff: [],
  lifecycleRegister: [],
  getInstance: [],
  changeCredentials: [],
  setDebugLevel: ["setDebugLevel"],
};

// Manifest components that the SDK merges in — their presence proves the SDK
// is linked even when the code is fully obfuscated.
export const CT_COMPONENT_PREFIX = "com.clevertap.";
export const CT_FCM_SERVICES = [
  "com.clevertap.android.sdk.pushnotification.fcm.FcmMessageListenerService",
  "com.clevertap.android.sdk.FcmMessageListenerService", // 3.x
  "com.clevertap.android.sdk.FcmTokenListenerService", // 3.x
  "com.clevertap.android.sdk.pushnotification.fcm.CTFirebaseMessagingReceiver",
];
export const CT_APPLICATION_CLASSES = [
  "com.clevertap.android.sdk.Application",
  "com.clevertap.clevertap_plugin.CleverTapApplication",
];

// Optional CleverTap modules: class prefix -> maven artifact.
export const CT_MODULES: { id: string; label: string; prefix: string }[] = [
  { id: "clevertap-android-sdk", label: "Core SDK", prefix: "Lcom/clevertap/android/sdk/" },
  { id: "push-templates", label: "Push Templates (rich push)", prefix: "Lcom/clevertap/android/pushtemplates/" },
  { id: "clevertap-geofence-sdk", label: "Geofence", prefix: "Lcom/clevertap/android/geofence/" },
  { id: "clevertap-hms-sdk", label: "Huawei push (HMS)", prefix: "Lcom/clevertap/android/hms/" },
  { id: "clevertap-xiaomi-sdk", label: "Xiaomi push (discontinued)", prefix: "Lcom/clevertap/android/xps/" },
  { id: "clevertap-signedcall-sdk", label: "Signed Call", prefix: "Lcom/clevertap/android/signedcall/" },
];

// Feature packages that only exist from a given core version (from the
// SDK changelog, docs/CTCORECHANGELOG.md). Used to
// estimate a minimum version when the version string has been stripped.
// Ordered newest first.
export const VERSION_FEATURES: { min: string; prefix: string; feature: string }[] = [
  { min: "7.0.0", prefix: "Lcom/clevertap/android/sdk/inapp/customtemplates/", feature: "custom in-app templates" },
  { min: "6.0.0", prefix: "Lcom/clevertap/android/sdk/inapp/evaluation/", feature: "client-side in-app evaluation" },
  { min: "6.0.0", prefix: "Lcom/clevertap/android/sdk/inapp/store/", feature: "client-side in-app store" },
  { min: "5.0.0", prefix: "Lcom/clevertap/android/sdk/variables/", feature: "Product Experiences variables" },
  { min: "4.4.0", prefix: "Lcom/clevertap/android/sdk/pushnotification/fcm/CTFcmMessageHandler", feature: "CTFcmMessageHandler" },
  { min: "4.0.0", prefix: "Lcom/clevertap/android/sdk/pushnotification/", feature: "modular push" },
];

// Meta-data keys worth surfacing from the manifest.
export const META_KEYS_OF_INTEREST = [/^CLEVERTAP_/, /^FCM_SENDER_ID$/, /^com\.google\.firebase\.messaging\.default_notification_channel_id$/];
