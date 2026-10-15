// iOS wording for the report: how each item gets checked on the Simulator, and
// the iOS rules CleverTap documents. The Android equivalents live in meta.ts.

const D = "https://developer.clevertap.com/docs/";

export const IOS_HOW_TO_CHECK: Record<string, { auto: boolean; how: string }> = {
  "app-t3-test-push": { auto: true, how: "In Push tests, press Test on any app state. We send a push and spot it on the iPhone." },
  "app-t3-foreground": { auto: true, how: "In Push tests, press Test on App open. We open the app, send a push and look for it." },
  "app-t3-background": { auto: true, how: "In Push tests, press Test on In the background. We open the app, bring Settings to the front, then send a push." },
  "app-t3-killed": { auto: true, how: "In Push tests, press Test on App closed. We close the app (like swiping it away), then send a push." },
  "app-t1-onuserlogin-update": {
    auto: true,
    how: "In Guided checks, use “Reopen while logged in”. Stay logged in; we restart the app and check onUserLogin runs on start (what happens after an update).",
  },
  "app-t3-deeplink-internal": {
    auto: true,
    how: "In Guided checks, use “Tap a push with a link”: enter your app link (e.g. myapp://product/1), send it and tap the notification on the iPhone.",
  },
  "app-t3-deeplink-external": { auto: true, how: "In Guided checks, use “Tap a push with a link” with an https link, then tap the notification on the iPhone." },
  "app-t3-test-inapp": {
    auto: true,
    how: "Create one in-app campaign on the dashboard triggered by App Launched, then use “See an in-app” in Guided checks. We spot it in the SDK logs.",
  },
  "app-ios-push-click": { auto: true, how: "In Guided checks, send a push with a link and tap it on the iPhone — we see CleverTap record the click." },
  "app-t1-device-token": { auto: true, how: "Connect your iPhone — the SDK logs whether it got an APNs token." },
  "app-ios-notification-permission": { auto: true, how: "Connect your iPhone — the SDK logs the permission it gets; on the Simulator we read it directly." },
  "app-t1-sdk-version": { auto: true, how: "Guided checks read the exact SDK version from the SDK's own logs." },
  "app-t4-critical-events": { auto: true, how: "In Guided checks, “Your custom events”: do the actions that raise each listed event — we check it fires with the right property types." },
  "app-t3-uninstall": { auto: false, how: "Dashboard → Settings → Engage → Uninstall tracking ON. Ticks itself once an App Uninstalled event arrives." },
  "app-t3-session-analytics": { auto: false, how: "Dashboard → Settings → Session analytics ON. CleverTap has no API for this, so tick it after checking." },
};

export const IOS_NOTES: Record<string, { text: string; url: string }> = {
  "app-ios-push-capability": {
    text: "Development builds (Xcode Run, Simulator) use the APNs sandbox; App Store and TestFlight builds use production. The APNs .p8 key on the dashboard works for both, but the dashboard's mode must match the build you test.",
    url: D + "push-notifications-ios#step-2-enable-the-push-notifications-capability",
  },
  "app-t1-device-token": {
    text: "iOS issues a token only to builds with the Push Notifications capability. The Simulator gets real APNs tokens on Apple-silicon Macs (Xcode 14+, macOS 13+).",
    url: D + "push-notifications-ios#step-3-registering-for-push-notifications",
  },
  "app-ios-notification-permission": {
    text: "iOS asks once. After a “Don't Allow”, only the user can turn notifications on again in Settings — CleverTap's push primer explains the value first and can deep-link to Settings.",
    url: D + "push-notifications-ios#ios-push-primer",
  },
  "app-t3-impressions": {
    text: "On iOS the app's own code doesn't run when a push arrives in the background, so impressions can only be recorded from a Notification Service Extension (mutable-content pushes).",
    url: D + "push-notifications-ios#push-impressions",
  },
  "app-ios-nse": {
    text: "The extension runs for pushes sent with mutable-content (CleverTap sets it for rich pushes). It has about 30 seconds to download media.",
    url: D + "rich-push-notifications",
  },
  "app-t3-foreground": {
    text: "With the app open, iOS shows a push only if the app sets a UNUserNotificationCenter delegate whose willPresent returns banner/sound options. Without a delegate, foreground pushes are silently hidden.",
    url: D + "push-notifications-ios#setting-the-behaviour-of-push-notifications",
  },
  "app-t3-killed": {
    text: "iOS displays pushes for a closed app by itself — no app code runs. If they don't show, it's permission, the token or the APNs setup, not the app's state.",
    url: D + "push-notifications-ios",
  },
  "app-t3-deeplink-internal": {
    text: "CleverTap opens push deep links through UIApplication.open, which lands in your scene/app delegate's openURL handler. Use CleverTapURLDelegate to route links yourself.",
    url: D + "push-notifications-ios#custom-handling-deeplinkexternal-url",
  },
};

export const IOS_LIVE_HELP = "https://developer.apple.com/documentation/xcode/running-your-app-in-simulator-or-on-a-device";
