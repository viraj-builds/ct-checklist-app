import type { CheckMethod, ItemStatus, Platform, AuditMode } from "./types";

export const STATUS_META: Record<
  ItemStatus,
  { label: string; token: string; soft: string; dot: string }
> = {
  pass: { label: "Pass", token: "var(--pass)", soft: "var(--pass-soft)", dot: "●" },
  fail: { label: "Fail", token: "var(--fail)", soft: "var(--fail-soft)", dot: "●" },
  warn: { label: "Warning", token: "var(--warn)", soft: "var(--warn-soft)", dot: "●" },
  manual: {
    label: "Manual check",
    token: "var(--manual)",
    soft: "var(--manual-soft)",
    dot: "◐",
  },
  na: { label: "N/A", token: "var(--na)", soft: "var(--na-soft)", dot: "○" },
};

export const METHOD_META: Record<
  CheckMethod,
  { label: string; short: string; desc: string }
> = {
  "auto-static": {
    label: "Auto · Static",
    short: "Static",
    desc: "Detected from the binary, source, or live page.",
  },
  "auto-api": {
    label: "Auto · API (read)",
    short: "API",
    desc: "Verified by reading data from the CleverTap account.",
  },
  "auto-trigger": {
    label: "Auto · Trigger + Confirm",
    short: "Trigger",
    desc: "API triggers the action, then confirms via the result event.",
  },
  hybrid: {
    label: "Hybrid",
    short: "Hybrid",
    desc: "Partly automated; a human confirms the visual/UI outcome.",
  },
  manual: {
    label: "Manual",
    short: "Manual",
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
  { id: "eu1", label: "Europe (eu1)" },
  { id: "sg1", label: "Singapore (sg1)" },
  { id: "aps3", label: "India — Mumbai (aps3)" },
  { id: "mec1", label: "Middle East (mec1)" },
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
      "Enable Developer Options → USB debugging on the device.",
      "Connect the device by USB and allow the debugging prompt.",
      "Add the verbose log line above and run a debug build.",
      "Trigger the push/in-app; the tool reads adb logcat (tag: CleverTap) to confirm.",
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
