import type { CheckMethod, ItemStatus, Platform, AuditMode } from "./types";

export const STATUS_META: Record<
  ItemStatus,
  { label: string; token: string; soft: string; dot: string }
> = {
  pass: { label: "Passed", token: "var(--pass)", soft: "var(--pass-soft)", dot: "●" },
  fail: { label: "Needs fix", token: "var(--fail)", soft: "var(--fail-soft)", dot: "●" },
  warn: { label: "Check this", token: "var(--warn)", soft: "var(--warn-soft)", dot: "●" },
  manual: {
    label: "To check",
    token: "var(--manual)",
    soft: "var(--manual-soft)",
    dot: "◐",
  },
  na: { label: "Not needed", token: "var(--na)", soft: "var(--na-soft)", dot: "○" },
};

export const METHOD_META: Record<
  CheckMethod,
  { label: string; short: string; desc: string }
> = {
  "auto-static": {
    label: "Auto · Static",
    short: "Automatic",
    desc: "Detected from the binary, source, or live page.",
  },
  "auto-api": {
    label: "Auto · API (read)",
    short: "Automatic",
    desc: "Verified by reading data from the CleverTap account.",
  },
  "auto-trigger": {
    label: "Auto · Trigger + Confirm",
    short: "Automatic",
    desc: "API triggers the action, then confirms via the result event.",
  },
  hybrid: {
    label: "Hybrid",
    short: "On your phone",
    desc: "Partly automated; a human confirms the visual/UI outcome.",
  },
  manual: {
    label: "Manual",
    short: "You confirm",
    desc: "Visual or device-state check — no account signal exists.",
  },
};

export const PLATFORM_META: Record<
  Platform,
  { label: string; icon: string; accept: string; targetLabel: string }
> = {
  android: {
    label: "Android",
    icon: "android",
    accept: ".apk,.aab",
    targetLabel: "APK / AAB",
  },
  ios: {
    label: "iOS",
    icon: "apple",
    accept: ".ipa,.zip,.xcarchive",
    targetLabel: "IPA / .xcarchive",
  },
  web: {
    label: "Web",
    icon: "globe",
    accept: ".zip",
    targetLabel: "URL or source zip",
  },
};

export const MODE_META: Record<
  AuditMode,
  { label: string; desc: string; icon: string; needsSource: boolean }
> = {
  full: {
    label: "Full analysis",
    desc: "Account credentials + binary/URL. Runs all engines for maximum coverage.",
    icon: "zap",
    needsSource: true,
  },
  api: {
    label: "CleverTap API",
    desc: "Read-only Account ID + Passcode. No source code needed. Highest coverage.",
    icon: "key",
    needsSource: false,
  },
  url: {
    label: "Website URL",
    desc: "Live crawl of the page — nothing is uploaded. Web only.",
    icon: "link",
    needsSource: false,
  },
  upload: {
    label: "Upload binary / source",
    desc: "APK / IPA / source zip. Auto-deleted after analysis.",
    icon: "upload",
    needsSource: true,
  },
  cli: {
    label: "Local CLI scanner",
    desc: "Run the scanner locally; the binary never leaves your machine. Upload only the JSON report.",
    icon: "terminal",
    needsSource: false,
  },
};

export const REGIONS = [
  { id: "in1", label: "India (in1)" },
  { id: "us1", label: "United States (us1)" },
  { id: "eu1", label: "Europe (eu1 · default)" },
  { id: "sg1", label: "Singapore (sg1)" },
  { id: "aps3", label: "Indonesia (aps3)" },
  { id: "mec1", label: "Middle East — UAE (mec1)" },
];

// Guided live-device (USB debugging) instructions for the items no engine can see.
// YouTube links are search URLs (always valid) so newcomers can find a walkthrough.
export const LIVE_GUIDE: Record<
  Platform,
  { verbose: string; steps: string[]; helpVideo: string; reads: string }
> = {
  android: {
    verbose: "CleverTapAPI.setDebugLevel(CleverTapAPI.LogLevel.VERBOSE);",
    steps: [
      "Run the Push tests and Guided checks stages with your phone connected — most items tick themselves.",
      "Install a test build with CleverTap debug mode on (the line below) so we can confirm each action.",
      "For anything left, check it yourself and choose It works or Not working.",
    ],
    helpVideo:
      "https://www.youtube.com/results?search_query=how+to+enable+usb+debugging+android",
    reads: "adb logcat (tag: CleverTap)",
  },
  ios: {
    verbose: "CleverTap.setDebugLevel(CleverTapLogLevel.debug.rawValue)",
    steps: [
      "Connect the iPhone by USB and trust the computer.",
      "Set the SDK debug level above in a development build.",
      "Stream device console (Xcode Console or libimobiledevice / idevicesyslog).",
      "Trigger the push/in-app; the tool parses the console output to confirm.",
    ],
    helpVideo:
      "https://www.youtube.com/results?search_query=view+iphone+console+logs+xcode+device",
    reads: "device console (idevicesyslog)",
  },
  web: {
    verbose: "clevertap.setLogLevel(3)  //  or  sessionStorage['WZRK_D']=''",
    steps: [
      "Open the site in the crawler with verbose logging on.",
      "The crawler reads the browser console + network calls to CleverTap.",
      "Trigger the web push / event to confirm the outcome.",
    ],
    helpVideo:
      "https://www.youtube.com/results?search_query=chrome+devtools+console+network+basics",
    reads: "browser console + network",
  },
};

export const DOCS_HELP = "https://developer.clevertap.com/docs/getting-started";

// How each item that isn't decided by the scan/API gets checked. `auto` = it
// ticks itself once that step has run on a connected phone.
export const HOW_TO_CHECK: Record<string, { auto: boolean; how: string }> = {
  "app-t3-test-push": { auto: true, how: "In Push tests, press Test on any app state. We send a push and spot it on the phone." },
  "app-t3-foreground": { auto: true, how: "In Push tests, press Test on App open. We open the app, send a push and look for it." },
  "app-t3-background": { auto: true, how: "In Push tests, press Test on In the background. We open the app, press Home, then send a push." },
  "app-t3-killed": {
    auto: true,
    how: "In Push tests, press Test on App closed. We close the app the way swiping it away does, then send a push. Works over USB and Wi-Fi.",
  },
  "app-t1-onuserlogin-update": {
    auto: true,
    how: "In Guided checks, use “Reopen while logged in”. Stay logged in; we restart the app and check onUserLogin runs on start (what happens after an update).",
  },
  "app-t3-deeplink-internal": {
    auto: true,
    how: "In Guided checks, use “Tap a push with a link”: enter your app link (e.g. myapp://product/1), send it and tap the push on the phone. We see which screen opens.",
  },
  "app-t3-deeplink-external": {
    auto: true,
    how: "In Guided checks, use “Tap a push with a link”: enter an https link, send it and tap the push. We see whether it opens in the browser or the app.",
  },
  "app-t3-test-inapp": {
    auto: true,
    how: "Create one in-app campaign on the dashboard triggered by an event (e.g. App Launched), then use “See an in-app” in Guided checks. We spot it in the SDK logs.",
  },
  "app-t1-fcm-service": { auto: true, how: "Ticks itself when a test push from Push tests shows up in the SDK logs as received." },
  "app-t1-sdk-version": { auto: true, how: "Guided checks read the exact SDK version from the SDK's own logs, even when the build is minified." },
  "app-t4-critical-events": {
    auto: true,
    how: "In Guided checks, “Your key actions”: do the actions that raise each listed event — we check it fires with the right property types.",
  },
  "app-t3-uninstall": { auto: false, how: "Dashboard → Settings → Engage → Uninstall tracking ON. Ticks itself once an App Uninstalled event arrives." },
  "app-t3-session-analytics": { auto: false, how: "Dashboard → Settings → Session analytics ON. CleverTap has no API for this, so tick it after checking." },
};

// Android-version limits and requirements CleverTap documents, shown on each
// item so users know what's an OS rule vs. an integration problem.
const D = "https://developer.clevertap.com/docs/";
export const ANDROID_NOTES: Record<string, { text: string; url: string }> = {
  "app-t1-sdk-version": {
    text: "Targeting Android 12 (API 31) needs CleverTap SDK 4.3.0+; targeting Android 13 (API 33) needs 4.7.0+. Older is a failure, merely behind latest is a warning.",
    url: D + "android-13-updates",
  },
  "app-t1-channel": {
    text: "Android 8+ shows pushes only on a notification channel; importance/sound come from the channel, not the push. Send pushes with the channel ID the app created.",
    url: D + "advanced-android-push-notification-options",
  },
  "app-t1-device-token": {
    text: "Token registration is asynchronous and can lag on poor networks. With your own FirebaseMessagingService, forward tokens with pushFcmRegistrationId(token, true).",
    url: D + "troubleshooting-push-notifications",
  },
  "app-t3-post-notifications": {
    text: "Android 13+: apps targeting API 33 must ask for notification permission at runtime — and usually get one chance. A push primer lets you ask again; Channel Subscribed is raised on grant (SDK 5.1.0+).",
    url: D + "android-13-updates",
  },
  "app-t3-killed": {
    text: "Android never delivers FCM to a force-stopped app (Settings → Force stop). Some phones (Xiaomi, vivo, Oppo, Huawei) treat swiping from recents like that unless Autostart / battery is unrestricted. Normal-priority pushes can wait for Doze to end.",
    url: D + "advanced-android-push-notification-options",
  },
  "app-t3-background": {
    text: "Normal-priority pushes may be delayed while the phone dozes; high priority wakes it, but FCM lowers it if pushes are rarely opened.",
    url: D + "advanced-android-push-notification-options",
  },
  "app-t3-deeplink-internal": {
    text: "Android 12+: a push tapped while its target activity is already open arrives in onNewIntent() — call pushNotificationClickedEvent(intent.extras) there, or the click and push-click callback are lost.",
    url: D + "android-12-updates",
  },
  "app-t3-deeplink-external": {
    text: "Android 12+ (notification trampoline rules): CleverTap can't record Notification Clicked when the link opens another app such as the browser. The link still opens.",
    url: D + "android-12-updates",
  },
  "app-t3-test-inapp": {
    text: "Header/footer in-apps and App Inbox render as fragments, so the host activity must be a FragmentActivity (Flutter: FlutterFragmentActivity). Game-engine hosts use CLEVERTAP_INAPP_FRAGMENTLESS_BANNERS.",
    url: D + "android-in-app-notifications",
  },
  "app-t3-inapp-exclude": {
    text: "Exclude splash activities with CLEVERTAP_INAPP_EXCLUDE. Single-activity apps (Flutter, React Native) use suspendInAppNotifications() during the splash instead.",
    url: D + "android-in-app-notifications",
  },
  "app-t3-uninstall": {
    text: "Silent-push uninstall tracking misses devices with stale FCM tokens (270 days, since May 2024); CleverTap recommends Real-Time Uninstall Tracking via Firebase Analytics.",
    url: D + "uninstall-tracking-using-firebase",
  },
};

// What each status means — shown as a legend on the report.
export const STATUS_LEGEND: { status: "fail" | "warn" | "manual" | "na"; text: string }[] = [
  { status: "fail", text: "Something is broken or missing, so users are affected. Fix it in the app code or settings." },
  { status: "warn", text: "Works, but is outdated or risky — or the cause is account data or phone settings, not this build." },
  { status: "manual", text: "We can't decide this on our own yet. Run the step shown, or check your dashboard." },
  { status: "na", text: "Doesn't apply to this app." },
];
