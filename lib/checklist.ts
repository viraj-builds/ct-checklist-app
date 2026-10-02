import type { CheckMethod, ChecklistItem, Platform } from "./types";

// ---------------------------------------------------------------------------
// Full C4S Integration Audit checklist, transcribed from the CleverTap
// "C4S FAQs & Integration Audit Guide" document.
// method classification:
//   auto-static  -> from binary / source / live page
//   auto-api     -> read from CleverTap account via API
//   auto-trigger -> API triggers + confirms via a result event
//   hybrid       -> partly auto, partly manual
//   manual       -> visual / device-state only
// ---------------------------------------------------------------------------

export const CHECKLIST: ChecklistItem[] = [
  // ===================== APP — TIER 1 =====================
  {
    id: "app-t1-installed",
    scope: "app",
    platforms: ["android", "ios"],
    tier: 1,
    title: "App Installed event",
    expected:
      "Raised when the user installs your app and launches it for the first time.",
    method: "auto-api",
    critical: true,
  },
  {
    id: "app-t1-launched",
    scope: "app",
    platforms: ["android", "ios"],
    tier: 1,
    title: "App Launched event triggered",
    expected: "Recorded every time a user launches your application.",
    method: "auto-api",
    critical: true,
  },
  {
    id: "app-t1-sdk-version",
    scope: "app",
    platforms: ["android", "ios"],
    tier: 1,
    title: "Latest SDK version",
    expected: "The integrated SDK should be on (or near) the latest release.",
    method: "auto-static",
    docUrl: "https://developer.clevertap.com/docs/changelog",
  },
  {
    id: "app-t1-credentials",
    scope: "app",
    platforms: ["android", "ios"],
    tier: 1,
    title: "Account ID, Token & Region configured",
    expected:
      "CLEVERTAP_ACCOUNT_ID, CLEVERTAP_TOKEN (and CLEVERTAP_REGION) are set and match the project on the dashboard.",
    method: "auto-static",
    origin: "sdk",
    critical: true,
    faqRef: 1,
    docUrl: "https://developer.clevertap.com/docs/android-quickstart-guide",
  },
  {
    id: "app-t1-lifecycle",
    scope: "app",
    platforms: ["android"],
    tier: 1,
    title: "Activity lifecycle callback registered",
    expected:
      "ActivityLifecycleCallback.register(this) is called in Application.onCreate (or the app extends CleverTap's Application) — required for App Launched and sessions.",
    method: "auto-static",
    origin: "sdk",
    critical: true,
    docUrl: "https://developer.clevertap.com/docs/android-quickstart-guide",
  },
  {
    id: "app-t1-fcm-service",
    scope: "app",
    platforms: ["android"],
    tier: 1,
    title: "FCM messages handed off to CleverTap",
    expected:
      "CleverTap's FCM service is registered, or a custom FirebaseMessagingService forwards CleverTap pushes (CTFcmMessageHandler) and new tokens.",
    method: "auto-static",
    origin: "sdk",
    faqRef: 12,
    docUrl: "https://developer.clevertap.com/docs/android-push#custom-android-push-notification-handling",
  },
  {
    id: "app-t1-channel",
    scope: "app",
    platforms: ["android"],
    tier: 1,
    title: "Android push notification channel created",
    expected:
      "Create the notification channel in code, then add the same channel ID on the dashboard.",
    method: "auto-static",
    faqRef: 2,
  },
  {
    id: "app-t1-identity",
    scope: "app",
    platforms: ["android", "ios"],
    tier: 1,
    title: "Identity, Email and phone number passed to CleverTap",
    expected: "To identify each user uniquely on the dashboard.",
    method: "auto-api",
    critical: true,
    faqRef: 3,
  },
  {
    id: "app-t1-onuserlogin",
    scope: "app",
    platforms: ["android", "ios"],
    tier: 1,
    title: "onUserLogin implemented in Registration / Signup / Login",
    expected: "To identify the individual users on the device.",
    method: "hybrid",
    faqRef: 3,
  },
  {
    id: "app-t1-onuserlogin-update",
    scope: "app",
    platforms: ["android", "ios"],
    tier: 1,
    title: "onUserLogin implemented on app update for already-logged-in users",
    expected:
      "Ensure previously logged-in users are re-identified after an app update.",
    method: "hybrid",
  },
  {
    id: "app-t1-custom-events",
    scope: "app",
    platforms: ["android", "ios"],
    tier: 1,
    title: "Custom events passed",
    expected:
      "Events you define and track with the SDK or API are flowing to the dashboard.",
    method: "auto-api",
    docUrl: "https://developer.clevertap.com/docs/events",
    critical: true,
  },
  {
    id: "app-t1-device-token",
    scope: "app",
    platforms: ["android", "ios"],
    tier: 1,
    title: "Device token generated",
    expected: "Register the app with FCM / APNs to establish a token-based connection.",
    method: "auto-api",
  },

  // ===================== APP — TIER 2 =====================
  {
    id: "app-t2-gdpr-location",
    scope: "app",
    platforms: ["android", "ios"],
    tier: 2,
    title: "GDPR location",
    expected: "Device Network Information Reporting enabled for location capture.",
    method: "hybrid",
    docUrl:
      "https://developer.clevertap.com/docs/sdk-changes-for-gdpr-compliance#device-network-information-reporting-in-android",
    faqRef: 5,
  },
  {
    id: "app-t2-lat-long",
    scope: "app",
    platforms: ["android", "ios"],
    tier: 2,
    title: "Check lat & long",
    expected: "setLocation implemented so lat/long is captured on profiles.",
    method: "auto-api",
    docUrl:
      "https://developer.clevertap.com/docs/concepts-user-profiles#user-location-handling",
    faqRef: 5,
  },
  {
    id: "app-t2-anon-profile",
    scope: "app",
    platforms: ["android", "ios"],
    tier: 2,
    title: "Anonymous profile created before registration",
    expected:
      "On SDK init, an anonymous profile appears on the dashboard prior to login/registration.",
    method: "auto-api",
  },
  {
    id: "app-t2-phone-push",
    scope: "app",
    platforms: ["android", "ios"],
    tier: 2,
    title: "Phone number format",
    expected: 'Phone pushed with correct country code and "+" prefix (e.g. +91).',
    method: "auto-api",
  },

  // ===================== APP — TIER 3 =====================
  {
    id: "app-t3-test-push",
    scope: "app",
    platforms: ["android", "ios"],
    tier: 3,
    title: "Test push notification received",
    expected: "Trigger a test push (green bell icon) and confirm it is received.",
    method: "auto-trigger",
    faqRef: 2,
  },
  {
    id: "app-t3-killed",
    scope: "app",
    platforms: ["android", "ios"],
    tier: 3,
    title: "Notification received in killed state",
    expected: "Push arrives even when the app is killed.",
    method: "manual",
    docUrl: "https://developer.clevertap.com/docs/android-push",
  },
  {
    id: "app-t3-background",
    scope: "app",
    platforms: ["android", "ios"],
    tier: 3,
    title: "Notification received in background state",
    expected: "Push arrives when the app is in the background.",
    method: "manual",
    docUrl: "https://developer.clevertap.com/docs/android-push",
  },
  {
    id: "app-t3-foreground",
    scope: "app",
    platforms: ["android", "ios"],
    tier: 3,
    title: "Notification received in foreground state",
    expected: "Push arrives when the app is open/foreground.",
    method: "manual",
    docUrl: "https://developer.clevertap.com/docs/android-push",
  },
  {
    id: "app-t3-impressions",
    scope: "app",
    platforms: ["android", "ios"],
    tier: 3,
    title: "Push impressions are captured",
    expected:
      'Enable the "push impression" system event (Settings → Schema). iOS needs the Notification Service Extension.',
    method: "auto-api",
    docUrl: "https://developer.clevertap.com/docs/push-notifications-ios#push-impressions",
    faqRef: 4,
  },
  {
    id: "app-t3-deeplink-internal",
    scope: "app",
    platforms: ["android", "ios"],
    tier: 3,
    title: "Deep link — internal app",
    expected: "Push with an internal deep link redirects correctly within the app.",
    method: "hybrid",
    faqRef: 9,
  },
  {
    id: "app-t3-deeplink-external",
    scope: "app",
    platforms: ["android", "ios"],
    tier: 3,
    title: "Deep link — external URL",
    expected: "Push with an external deep link redirects correctly.",
    method: "hybrid",
    docUrl: "https://developer.clevertap.com/docs/android-push#deeplinkexternal-url",
    faqRef: 9,
  },
  {
    id: "app-t3-test-inapp",
    scope: "app",
    platforms: ["android", "ios"],
    tier: 3,
    title: "Send test in-app",
    expected: "Trigger an in-app notification campaign and confirm it displays.",
    method: "hybrid",
  },
  {
    id: "app-t3-inapp-exclude",
    scope: "app",
    platforms: ["android", "ios"],
    tier: 3,
    title: "In-app screen exclude (splash)",
    expected: "Splash / loading screens are excluded from in-app display.",
    method: "manual",
    methodByPlatform: { android: "auto-static" },
    docUrl: "https://developer.clevertap.com/docs/android-in-app#exclude-activities",
  },
  {
    id: "app-t3-post-notifications",
    scope: "app",
    platforms: ["android"],
    tier: 3,
    title: "Android 13+ notification permission",
    expected:
      "Apps targeting API 33+ declare POST_NOTIFICATIONS and ask for it at runtime (e.g. CleverTap's push primer), or pushes are silently blocked.",
    method: "auto-static",
    origin: "sdk",
    docUrl: "https://developer.clevertap.com/docs/push-primer",
  },
  {
    id: "app-t3-uninstall",
    scope: "app",
    platforms: ["android", "ios"],
    tier: 3,
    title: "App uninstall tracking switched on",
    expected: "Uninstall tracking is enabled.",
    method: "auto-api",
    docUrl: "https://developer.clevertap.com/docs/uninstall-tracking",
  },
  {
    id: "app-t3-session-analytics",
    scope: "app",
    platforms: ["android", "ios"],
    tier: 3,
    title: "Session analytics switched on",
    expected: "Session analytics is enabled.",
    method: "auto-api",
    docUrl: "https://docs.clevertap.com/docs/session-analytics",
  },

  // ===================== APP — TIER 4 (data quality) =====================
  {
    id: "app-t4-formats",
    scope: "app",
    platforms: ["android", "ios"],
    tier: 4,
    title: "Properties passed in the correct format",
    expected:
      "Dates (DOB, subscription) in epoch; amount/price/quantity as integers; etc.",
    method: "auto-api",
    docUrl: "https://docs.clevertap.com/docs/events#event-data-types",
    critical: true,
    faqRef: 10,
  },
  {
    id: "app-t4-valid-values",
    scope: "app",
    platforms: ["android", "ios"],
    tier: 4,
    title: "Only valid values passed",
    expected: '"null" / empty strings must not be sent for user or event properties.',
    method: "auto-api",
    docUrl:
      "https://developer.clevertap.com/docs/concepts-user-profiles#user-profile-consideration",
    critical: true,
  },
  {
    id: "app-t4-critical-events",
    scope: "app",
    platforms: ["android", "ios"],
    tier: 4,
    title: "Business-critical events & properties verified",
    expected:
      "3–4 critical events/properties from the event design sheet fire in the right format.",
    method: "hybrid",
    docUrl: "https://docs.clevertap.com/docs/sample-events-by-business-verticals",
  },

  // ===================== WEB — TIER 1 =====================
  {
    id: "web-t1-sdk-head",
    scope: "web",
    platforms: ["web"],
    tier: 1,
    title: "SDK in <head> tag",
    expected: "The CleverTap JS library is added manually to the site's <head>.",
    method: "auto-static",
    critical: true,
  },
  {
    id: "web-t1-gdpr",
    scope: "web",
    platforms: ["web"],
    tier: 1,
    title: "GDPR location",
    expected: "GDPR advanced configuration set for location capture.",
    method: "auto-static",
    docUrl:
      "https://developer.clevertap.com/docs/advanced-configurations#gdpr",
  },
  {
    id: "web-t1-utm",
    scope: "web",
    platforms: ["web"],
    tier: 1,
    title: "Install referral tracking (UTM)",
    expected:
      "UTM Visited event triggers when UTM parameters are present in the URL.",
    method: "auto-trigger",
  },

  // ===================== WEB — TIER 2 =====================
  {
    id: "web-t2-identity",
    scope: "web",
    platforms: ["web"],
    tier: 2,
    title: "Identity / Email passed to CleverTap",
    expected: "To identify each user uniquely on the dashboard.",
    method: "auto-api",
    critical: true,
  },
  {
    id: "web-t2-onuserlogin",
    scope: "web",
    platforms: ["web"],
    tier: 2,
    title: "onUserLogin implemented in Registration / Login",
    expected: "Create a user profile when the user logs in.",
    method: "hybrid",
    docUrl:
      "https://developer.clevertap.com/docs/web-user-profiles#create-a-user-profile-when-user-logs-in-on-user-login",
  },
  {
    id: "web-t2-profile-push",
    scope: "web",
    platforms: ["web"],
    tier: 2,
    title: "Profile push in profile update (non-login)",
    expected: "profileSet used to update profile outside login/registration.",
    method: "hybrid",
    docUrl:
      "https://developer.clevertap.com/docs/web-user-profiles#update-the-user-profile",
  },
  {
    id: "web-t2-anon",
    scope: "web",
    platforms: ["web"],
    tier: 2,
    title: "Anonymous profile created before registration",
    expected: "On SDK init, an anonymous profile appears before login/registration.",
    method: "auto-api",
  },
  {
    id: "web-t2-onuserlogin-existing",
    scope: "web",
    platforms: ["web"],
    tier: 2,
    title: "onUserLogin for already-logged-in users",
    expected: "Previously logged-in users are re-identified.",
    method: "hybrid",
  },
  {
    id: "web-t2-phone",
    scope: "web",
    platforms: ["web"],
    tier: 2,
    title: "Phone number format",
    expected: 'Phone pushed with correct country code and "+" prefix (e.g. +91).',
    method: "auto-api",
  },

  // ===================== WEB — TIER 3 =====================
  {
    id: "web-t3-custom-events",
    scope: "web",
    platforms: ["web"],
    tier: 3,
    title: "Custom events / properties passed",
    expected: "Custom events are tracked from the site.",
    method: "auto-api",
    docUrl:
      "https://developer.clevertap.com/docs/web-quickstart-guide#track-user-events",
  },
  {
    id: "web-t3-web-push",
    scope: "web",
    platforms: ["web"],
    tier: 3,
    title: "Send test web push",
    expected:
      "Web push channel configured, permission requested, and service worker hosted.",
    method: "auto-trigger",
    faqRef: 7,
  },
  {
    id: "web-t3-deeplink",
    scope: "web",
    platforms: ["web"],
    tier: 3,
    title: "Deep link redirection",
    expected:
      "An https URL in the notification redirects the user to the correct page on click.",
    method: "hybrid",
  },
];

// ---------- helpers ----------

export function itemsForPlatform(platform: Platform): ChecklistItem[] {
  const scope = platform === "web" ? "web" : "app";
  return CHECKLIST.filter(
    (i) => i.scope === scope && i.platforms.includes(platform),
  );
}

export function tiersForPlatform(platform: Platform): (1 | 2 | 3 | 4)[] {
  const tiers = new Set<number>();
  itemsForPlatform(platform).forEach((i) => tiers.add(i.tier));
  return Array.from(tiers).sort() as (1 | 2 | 3 | 4)[];
}

export function methodFor(item: ChecklistItem, platform: Platform): CheckMethod {
  return item.methodByPlatform?.[platform] ?? item.method;
}

export function getItem(id: string): ChecklistItem | undefined {
  return CHECKLIST.find((i) => i.id === id);
}

export const TIER_LABELS: Record<number, string> = {
  1: "Tier 1 · Core integration",
  2: "Tier 2 · Profiles & location",
  3: "Tier 3 · Push, in-app & deep links",
  4: "Tier 4 · Data quality",
};
