import type { FaqEntry } from "./types";

// Transcribed from the C4S "Frequently Asked Queries" section.
export const FAQS: FaqEntry[] = [
  {
    n: 1,
    question:
      "Integration is complete, but user/event data isn't flowing to the dashboard.",
    reasons: [
      "Account ID / Token not added or added incorrectly.",
      "The region code entered is incorrect.",
    ],
    solutions: [
      "In the dashboard go to Settings → Project and add the Project ID and token to your code (AndroidManifest).",
      "If a region code was added, remove it — the default region for CleverTap Essentials is EU.",
    ],
    tags: ["setup", "data-flow"],
  },
  {
    n: 2,
    question:
      "FCM credentials added to dashboard, but Android push isn't received.",
    reasons: [
      "Notification channel ID not created in the codebase.",
      "Channel ID created but not added to the dashboard.",
    ],
    solutions: [
      "Create a notification channel in code (see the Push section of your framework's guide).",
      "Add the channel ID to the dashboard and ensure it matches the code exactly.",
    ],
    tags: ["android", "push", "channel"],
  },
  {
    n: 3,
    question: "Multiple user profiles merged into a single profile.",
    reasons: [
      "User identity settings not configured on the dashboard.",
      "Login functions not implemented correctly.",
    ],
    solutions: [
      'Use "onUserLogin" to identify users and keep each profile unique.',
      'Use "profileSet" to add/update user properties on identified profiles.',
    ],
    tags: ["identity", "profiles"],
  },
  {
    n: 4,
    question: "Push sent but campaigns show 0% push impressions.",
    reasons: [
      "Push impression event not enabled in the schema.",
      "Notification Service Extension not implemented (iOS).",
    ],
    solutions: [
      "Android: Settings → Schema → Events → System events → search 'push impressions' → toggle on.",
      "iOS: implement the Notification Service Extension to raise Push Impressions.",
    ],
    links: [
      {
        label: "iOS push impressions",
        url: "https://developer.clevertap.com/docs/push-notifications-ios#push-impressions",
      },
    ],
    tags: ["push", "impressions", "ios", "android"],
  },
  {
    n: 5,
    question: "Profiles not capturing location / lat-long (shown as unknown).",
    reasons: [
      "GDPR not set to capture personal information.",
      "lat-long not passed from the SDK.",
    ],
    solutions: [
      "Android: call Device Network Information Reporting to capture location.",
      "Implement the setLocation function to capture latitude/longitude.",
    ],
    links: [
      {
        label: "GDPR device network info",
        url: "https://developer.clevertap.com/docs/sdk-changes-for-gdpr-compliance#device-network-information-reporting-in-android",
      },
      {
        label: "User location handling",
        url: "https://developer.clevertap.com/docs/concepts-user-profiles#user-location-handling",
      },
    ],
    tags: ["location", "gdpr"],
  },
  {
    n: 6,
    question: "iOS push warnings: 'APNSInvalidAuth' or 'APNSBadDeviceToken'.",
    reasons: [
      "APNs push mode mismatch (development vs production).",
      "Auth key or certificate uploaded incorrectly / expired.",
    ],
    solutions: [
      "Ensure the app's APNs push mode matches the CleverTap dashboard mode.",
      "Use a valid, non-expired certificate/auth key; after updating, wait ~15 min before retrying.",
    ],
    links: [
      {
        label: "Push troubleshooting",
        url: "https://docs.clevertap.com/docs/troubleshooting-faqs-push-notifications",
      },
    ],
    tags: ["ios", "apns", "push"],
  },
  {
    n: 7,
    question:
      "Web push channel set up but web push notifications still can't be sent.",
    reasons: [
      "User permission request not implemented.",
      "Service worker file missing on the website.",
    ],
    solutions: [
      "Request permissions; the user must allow both the CleverTap and browser prompts.",
      "Host CleverTap's service worker in the document root (import it at the start of any custom SW).",
    ],
    links: [
      {
        label: "Requesting user permissions",
        url: "https://developer.clevertap.com/docs/web-push#requesting-user-permissions",
      },
      {
        label: "Add the service worker file",
        url: "https://developer.clevertap.com/docs/web-push#add-the-service-worker-file",
      },
    ],
    tags: ["web", "push", "service-worker"],
  },
  {
    n: 8,
    question: "Can't trigger notifications from our backend / third-party system.",
    reasons: ["Not using CleverTap APIs.", "Not familiar with the campaign APIs."],
    solutions: [
      "Use the CleverTap API to send user and event data to the dashboard.",
      "Use the Campaign API to send notifications/messages from the backend.",
    ],
    links: [
      {
        label: "User Profile object",
        url: "https://developer.clevertap.com/docs/user-profile-object",
      },
      { label: "Events object", url: "https://developer.clevertap.com/docs/events-object" },
      { label: "Campaign object", url: "https://developer.clevertap.com/docs/campaign_object" },
    ],
    tags: ["api", "backend", "campaign"],
  },
  {
    n: 9,
    question:
      "Deep link redirects to browser / app store instead of opening the app.",
    reasons: [
      "The deep link URL used must be external.",
      "Internal deep links not configured at the app level.",
    ],
    solutions: [
      "Android: manage deep links and add schemas in the AndroidManifest; handle HTTP/HTTPS links inside the app.",
      "Extract custom key-value pairs from the push payload and render redirection yourself.",
      "Create an internal deep link (e.g. app://open.my.app) with your app developer for in-app navigation.",
    ],
    links: [
      {
        label: "Deep link external URL",
        url: "https://developer.clevertap.com/docs/android-push#deeplinkexternal-url",
      },
      {
        label: "Action buttons",
        url: "https://developer.clevertap.com/docs/android-push#action-buttons",
      },
    ],
    tags: ["deeplink", "android", "ios"],
  },
  {
    n: 10,
    question:
      "Datetime event properties show as strings; no date-range filter available.",
    reasons: ["Incorrect data type used when passing values."],
    solutions: [
      'Pass datetime in epoch format (e.g. "$D_epochValueInSeconds"); otherwise it is stored as a string.',
    ],
    links: [
      {
        label: "CSV date format",
        url: "https://docs.clevertap.com/docs/csv-upload#date-format",
      },
    ],
    tags: ["data-types", "dates"],
  },
  {
    n: 11,
    question: "Image included in iOS push content doesn't appear.",
    reasons: ["Rich Push Notifications not implemented."],
    solutions: [
      "Implement rich push support on iOS via the Notification Service Extension (iOS 10+).",
    ],
    links: [
      {
        label: "Rich push notifications",
        url: "https://developer.clevertap.com/docs/rich-push-notifications",
      },
    ],
    tags: ["ios", "push", "rich-push"],
  },
  {
    n: 12,
    question:
      "Want to send push via both Firebase plugin and CleverTap — how to handle?",
    reasons: ["Custom handling not implemented."],
    solutions: [
      "CTNotificationIntentService renders notifications by default and supersedes other plugins.",
      "Remove CTNotificationIntentService from the manifest to hand push handling back to native code.",
    ],
    links: [
      {
        label: "Custom Android push handling",
        url: "https://developer.clevertap.com/docs/android-push#custom-android-push-notification-handling",
      },
    ],
    tags: ["android", "push", "firebase"],
  },
];

export function getFaq(n?: number): FaqEntry | undefined {
  if (!n) return undefined;
  return FAQS.find((f) => f.n === n);
}
