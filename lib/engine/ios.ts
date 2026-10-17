import type { ApiUsage } from "../analyzer/types";
import type { IosScanReport } from "../analyzer/ios/types";
import type { ApiFindings, TestUserRecord } from "../clevertap/types";
import type { AppState } from "../device/types";
import type { IosDeviceFindings } from "../device/ios/types";
import type { ItemResult, ItemStatus, ResultSource } from "../types";
import { itemsForPlatform } from "../checklist";
import { getFaq } from "../faq";
import { compareVersions, customEventNames } from "./android";

// ---------------------------------------------------------------------------
// iOS rule engine: (IPA scan, API findings, iPhone / Simulator findings) -> one result
// per checklist item. Pure and deterministic, like the Android engine, and it
// follows the same evidence and status policy (see lib/engine/android.ts):
//  - only fresh evidence decides an item (this build's scan, the live
//    iPhone / Simulator session, the test user's profile updated after the audit began)
//  - fail = proven broken or a documented requirement missing; warn = works
//    but risky / partly verified; manual = can't decide yet; na = doesn't apply
//  - silence from the API never fails; "can't tell" static findings never fail
// ---------------------------------------------------------------------------

export interface IosLatestVersions {
  ios?: string;
  flutter?: string;
  reactNative?: string;
  cordova?: string;
}

export interface IosEngineInput {
  scan?: IosScanReport | null;
  api?: ApiFindings | null;
  device?: IosDeviceFindings | null;
  latest?: IosLatestVersions | null;
  accountId?: string | null;
  region?: string | null;
  criticalEvents?: string[];
  since?: number;
}

type Rule = (ctx: Ctx) => Omit<ItemResult, "itemId">;

interface Ctx extends IosEngineInput {
  s?: IosScanReport;
  a?: ApiFindings;
  d?: IosDeviceFindings;
  tu?: TestUserRecord;
  fresh: (name: string) => boolean;
}

const DO = {
  start: "Live testing → connect your iPhone (or the Simulator); we restart the app and read its CleverTap logs.",
  login: "Guided checks → “Log in”: log out and log in again in the app.",
  phone: "Guided checks → “Log in”: log in with a user that has a phone number.",
  use: "Guided checks → “Your custom events”: use the app (open a product, add to cart, buy…).",
  push: "Push tests: press Test on any app state.",
  install: "Delete the app from the iPhone (or Simulator), install this build again, open it once, then press “Check test user”.",
};
const NO_SCAN = "Scan an .ipa (or the zipped .app from the Simulator) to check this automatically.";

function res(status: ItemStatus, detected: string, evidence: string, source: ResultSource, extra: { remediation?: string; details?: string[] } = {}): Omit<ItemResult, "itemId"> {
  return { status, detected, evidence, source, ...extra };
}
const list = (a: string[], n = 5) => a.slice(0, n).map((x) => `'${x}'`).join(", ") + (a.length > n ? ` +${a.length - n} more` : "");
const faqFix = (n: number) => {
  const f = getFaq(n);
  return f ? `FAQ #${f.n}: ${f.solutions[0]}` : undefined;
};
const ev = (u?: ApiUsage) => (u?.evidence ?? []).slice(0, 6);
const where = (d?: IosDeviceFindings) => (d?.target === "device" ? "iPhone" : "Simulator");
const deliveredReal = (d?: IosDeviceFindings) => Object.entries(d?.pushTests ?? {}).find(([, r]) => r?.status === "delivered" && r.via === "clevertap");
const deliveredAny = (d?: IosDeviceFindings) => Object.entries(d?.pushTests ?? {}).find(([, r]) => r?.status === "delivered");

const CAPABILITY_FIX =
  "In Xcode: target → Signing & Capabilities → + Capability → Push Notifications (and Background Modes → Remote notifications). Then upload your APNs .p8 key on the CleverTap dashboard (Settings → Channels → Mobile Push → iOS).";

/* ------------------------------------------------------------------ */

const RULES: Record<string, Rule> = {
  "app-t1-credentials": ({ s, a, accountId, region, d }) => {
    const L = d?.logs;
    if (L?.accountId && accountId && L.accountId.toUpperCase() !== accountId.trim().toUpperCase())
      return res("fail", "Wrong account (live)", `The running app sends data to ${L.accountId}, but this audit is for ${accountId}.`, "device", {
        remediation: "Copy the Project ID and Token from Dashboard → Settings → Project into CleverTapAccountID / CleverTapToken in Info.plist.",
      });
    const liveRegion = L?.region?.replace(/-spiky$/, "");
    if (liveRegion && region && liveRegion !== region.toLowerCase())
      return res("fail", "Region mismatch (live)", `The running app talks to ${liveRegion}.clevertap-prod.com, but the account is in ${region}.`, "device", {
        remediation: `Set CleverTapRegion to "${region}" in Info.plist.`,
      });
    if (L?.accountId && L.queueSent > 0)
      return res("pass", `Account ${L.accountId} · ${liveRegion ?? "region ?"}`, "Seen live: the app sends data to this account and region, and CleverTap accepts it.", "device");
    if (!s) {
      if (a) return res("pass", "API accepted the credentials", "Account ID + Passcode work for this region.", "api");
      return res("manual", "Not checked", NO_SCAN, "none");
    }
    const p = s.plist;
    const inCode = s.apis.setCredentials;
    const details: string[] = [];
    if (p.accountId) details.push(`CleverTapAccountID = ${p.accountId}`);
    if (p.token) details.push(`CleverTapToken = ${p.token.slice(0, 3)}•••`);
    if (p.region) details.push(`CleverTapRegion = ${p.region}`);
    if (inCode.found) details.push(...ev(inCode));
    const fix1 = faqFix(1);
    if (!p.accountId) {
      if (inCode.found)
        return res("manual", "Set in code", "Credentials are set in code (setCredentialsWithAccountID), so the values can't be read from the build. Connect your iPhone or the Simulator — the SDK prints the account and region on start.", "static", { details });
      if (inCode.found === null)
        return res("warn", "Not in Info.plist", "No CleverTapAccountID in Info.plist; it may be set in code this scan can't read.", "static", { remediation: fix1, details });
      return res("fail", "Account ID missing", "No CleverTapAccountID in Info.plist and no setCredentials call in code.", "static", {
        remediation: "Add CleverTapAccountID, CleverTapToken and CleverTapRegion to Info.plist (Dashboard → Settings → Project).",
        details,
      });
    }
    if (/\$\(|\$\{/.test(p.accountId) || (p.token && /\$\(|\$\{/.test(p.token)))
      return res("fail", "Build setting not substituted", `Info.plist contains an unresolved value ("${p.accountId}").`, "static", {
        remediation: "Define the build setting used in Info.plist for every configuration (Debug and Release).",
        details,
      });
    if (!p.token && !inCode.found)
      return res("fail", "Token missing", "CleverTapAccountID is set but CleverTapToken is missing.", "static", { remediation: fix1, details });
    if (accountId && p.accountId.toUpperCase() !== accountId.trim().toUpperCase())
      return res("fail", "Wrong account", `The app sends data to account ${p.accountId}, but this audit is for ${accountId}.`, "static", {
        remediation: "Copy the Project ID and Token from Dashboard → Settings → Project into Info.plist.",
        details,
      });
    const norm = (r?: string | null) => (r ?? "").trim().toLowerCase().replace(/^eu1?$/, "") || "eu";
    if (region && norm(p.region) !== norm(region))
      return res("fail", "Region mismatch", p.region
        ? `The app is configured for region "${p.region}" but the account is in "${region}".`
        : `CleverTapRegion is not set, so the SDK sends data to the default (EU) region — but the account is in "${region}".`, "static", {
        remediation: `Set CleverTapRegion to "${region}" in Info.plist.`,
        details,
      });
    return res("pass", `Account ${p.accountId}${p.region ? ` · ${p.region}` : ""}`, "Credentials found in Info.plist and they match this audit.", "static", { details });
  },

  "app-t1-sdk-version": ({ s, latest, d }) => {
    if (!s) return res("manual", "Not checked", NO_SCAN, "none");
    const ct = s.clevertap;
    const version = ct.version ?? d?.logs?.sdkVersion;
    if (!ct.present && !d?.logs?.sdkVersion)
      return res("fail", "CleverTap SDK not detected", "No CleverTap framework, classes or symbols were found in the build.", "static", {
        remediation: "Add CleverTap-iOS-SDK with CocoaPods (pod 'CleverTap-iOS-SDK') or Swift Package Manager — see the iOS quick-start.",
      });
    const details = ct.modules.map((m) => `${m.label}${m.version ? ` ${m.version}` : ""}`);
    details.push(`Linked ${ct.linkage === "dynamic" ? "as a framework" : "into the app binary"}`);
    if (ct.wrapper) details.unshift(`${ct.wrapper.label}${ct.wrapper.version ? ` ${ct.wrapper.version}` : ""}`);
    const target = latest?.ios;
    if (!version)
      return res("manual", "Version unknown", "The version couldn't be read from this build. The guided log session reads it from the SDK's own logs, or check your Podfile.lock / Package.resolved.", "static", {
        remediation: target ? `Latest iOS SDK is ${target}.` : undefined,
        details,
      });
    if (!target) return res("pass", `SDK v${version}`, "Couldn't fetch the latest version to compare.", "static", { details });
    const cmp = compareVersions(version, target);
    if (cmp >= 0) return res("pass", `SDK v${version} (latest)`, `The iOS SDK is up to date (latest ${target}).`, ct.version ? "static" : "device", { details });
    const [maj] = version.split(".").map(Number);
    const [tmaj] = target.split(".").map(Number);
    const behind = `SDK v${version} — latest is ${target}`;
    if (tmaj - maj >= 2)
      return res("warn", behind, `${tmaj - maj} major versions behind — it misses fixes, iOS updates and features.`, "static", {
        remediation: `Upgrade to ${target} (pod update CleverTap-iOS-SDK / bump the SPM version) — check the changelog for breaking changes.`,
        details,
      });
    return res("warn", behind, tmaj > maj ? "One major version behind." : "Same major version, update recommended.", "static", {
      remediation: `Update to ${target}.`,
      details,
    });
  },

  "app-ios-push-capability": ({ s, d }) => {
    const L = d?.logs;
    if (deliveredReal(d)) return res("pass", "Proven by a delivered push", "A push sent through CleverTap and APNs reached the test device.", "device");
    if (!s) {
      if (L?.pushToken) return res("pass", "APNs token registered (live)", "The SDK received an APNs device token, so the capability is on.", "device");
      return res("manual", "Not checked", NO_SCAN, "none");
    }
    const aps = s.signing.apsEnvironment;
    const prov = s.signing.provision;
    const details = [aps ? `aps-environment = ${aps}` : "No aps-environment entitlement", ...(prov ? [`Provisioning: ${prov.type}${prov.name ? ` (${prov.name})` : ""}`] : [])];
    if (s.plist.backgroundModes.length) details.push(`Background modes: ${s.plist.backgroundModes.join(", ")}`);
    const regErr = L?.push.errors.find((e) => /APNs registration failed/.test(e));
    if (!aps)
      return res("fail", "Push capability missing", `The build isn't signed with the Push Notifications capability, so iOS never gives it an APNs token and no CleverTap push can reach it.${regErr ? ` Live: ${regErr}` : L && L.lines && !L.pushToken ? " Live: the SDK logged “APNS Push Token not found”." : ""}`, "static", {
        remediation: CAPABILITY_FIX,
        details,
      });
    if (aps === "development" && prov && prov.type !== "development")
      return res("fail", "Development APNs in a distribution build", `This ${prov.type} build is signed with aps-environment = development, so production pushes fail.`, "static", {
        remediation: "Re-sign / export the build for distribution so aps-environment is production.",
        details,
      });
    const bgRemote = s.plist.backgroundModes.includes("remote-notification");
    if (aps === "development")
      return res(bgRemote ? "pass" : "warn", "Push capability on (sandbox)", `Signed for APNs development (sandbox).${s.app.simulatorBuild ? " Simulator builds always use sandbox." : ""} Pushes to this build need the dashboard's APNs setting to send to development${bgRemote ? "" : ", and Background Modes → Remote notifications isn't on (silent pushes and uninstall tracking need it)"}.`, "static", {
        remediation: bgRemote ? undefined : "Xcode → Signing & Capabilities → Background Modes → tick Remote notifications.",
        details,
      });
    return res(bgRemote ? "pass" : "warn", "Push capability on (production)", bgRemote ? "Signed for production APNs with remote-notification background mode." : "Signed for production APNs. Background Modes → Remote notifications isn't on — silent pushes and uninstall tracking need it.", "static", {
      remediation: bgRemote ? undefined : "Xcode → Signing & Capabilities → Background Modes → tick Remote notifications.",
      details,
    });
  },

  "app-ios-push-registration": ({ s, d }) => {
    const L = d?.logs;
    if (L?.pushToken) return res("pass", "Token passed to CleverTap (live)", "The SDK logged that it registered the APNs device token.", "device");
    if (deliveredReal(d)) return res("pass", "Proven by a delivered push", "A CleverTap push reached the device, so its token is registered.", "device");
    if (!s) return res("manual", "Not checked", NO_SCAN, "none");
    const auto = s.apis.autoIntegrate;
    const manual = s.apis.setPushToken;
    const reg = s.apis.registerForRemote;
    const primer = s.apis.pushPrimer;
    const details = [...ev(auto), ...ev(manual), ...ev(reg), ...ev(primer)];
    if (!auto.found && manual.found === false)
      return res("fail", "Token never given to CleverTap", "Neither CleverTap.autoIntegrate() nor setPushToken() is called, so CleverTap never gets the APNs token.", "static", {
        remediation: "Call CleverTap.autoIntegrate() in application(_:didFinishLaunchingWithOptions:), or pass the token yourself: CleverTap.sharedInstance()?.setPushToken(deviceToken) in didRegisterForRemoteNotificationsWithDeviceToken.",
        details,
      });
    if (reg.found === false && !primer.found)
      return res("fail", "Never registers with APNs", "The app doesn't call registerForRemoteNotifications(), so iOS never issues a device token.", "static", {
        remediation: "Call UIApplication.shared.registerForRemoteNotifications() on every launch (after asking for permission), or use CleverTap's push primer.",
        details,
      });
    const liveMissing = L && L.lines > 0 && !L.pushToken;
    if (liveMissing)
      return res(s.signing.apsEnvironment ? "warn" : "fail", `No token on the ${where(d)} (live)`, s.signing.apsEnvironment
        ? "The code passes the token to CleverTap, but no APNs token arrived during the session. Allow notifications, then relaunch the app."
        : "The code is in place, but the build has no Push Notifications capability, so iOS never issues a token (“APNS Push Token not found”).", "device", {
        remediation: s.signing.apsEnvironment ? "Make sure registerForRemoteNotifications() runs on every launch." : CAPABILITY_FIX,
        details,
      });
    return res("pass", auto.found ? "autoIntegrate passes the token" : "setPushToken called", auto.found
      ? "CleverTap.autoIntegrate() hooks didRegisterForRemoteNotifications and sends the token."
      : "The app forwards the device token with setPushToken().", "static", { details });
  },

  "app-t1-device-token": ({ s, tu, d }) => {
    if (d?.logs?.pushToken) return res("pass", "APNs token present (live)", "The SDK registered an APNs token on the device.", "device");
    if (deliveredReal(d)) return res("pass", "Proven by a delivered push", "A CleverTap push reached the device, so its token is registered.", "device");
    if (tu?.android)
      return tu.android.hasPushToken
        ? res("pass", "Test device has a push token", `${tu.android.model ?? "iOS device"} on app ${tu.android.appVersion ?? "?"} is registered for push.`, "api")
        : res("fail", "Test device has no push token", "The test user's iOS device isn't registered for push.", "api", {
            remediation: s && !s.signing.apsEnvironment ? CAPABILITY_FIX : "Check the APNs setup and that the token reaches CleverTap (autoIntegrate or setPushToken).",
          });
    const L = d?.logs;
    if (L && L.lines > 0 && !L.pushToken)
      return res("fail", "No APNs token (live)", `The SDK logged “APNS Push Token not found”.${s && !s.signing.apsEnvironment ? " The build has no Push Notifications capability." : ""}`, "device", {
        remediation: s && !s.signing.apsEnvironment ? CAPABILITY_FIX : "Allow notifications in the app and make sure registerForRemoteNotifications() runs on launch.",
      });
    return res("manual", "Not checked yet", DO.start, "none");
  },

  "app-ios-notification-permission": ({ s, d }) => {
    const p = d?.notificationPermission;
    if (p === "granted" || p === "provisional") return res("pass", `${p === "granted" ? "Allowed" : "Provisional"} on the ${where(d)}`, "The app has notification permission on the test device.", "device");
    if (p === "denied")
      return res("warn", `Denied on the ${where(d)}`, "Notifications are turned off for the app on the test device, so pushes won't show there.", "device", {
        remediation: "Allow them in Settings → Notifications → your app, then test again.",
      });
    const u = s ? [s.apis.requestAuthorization, s.apis.pushPrimer] : [];
    const asked = u.some((x) => x.found);
    const unknown = u.some((x) => x.found === null);
    if (p === "not-determined" && !asked)
      return res("fail", "Never asked (live)", `The app ran on the ${where(d)} without asking for notification permission, so iOS won't show any push.`, "device", {
        remediation: "Ask with UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) or CleverTap's push primer (promptPushPrimer / promptForPushPermission).",
      });
    if (!s) return res("manual", "Not checked", NO_SCAN, "none");
    const details = u.flatMap(ev);
    if (asked) return res("pass", "Permission requested", "The app asks for notification permission.", "static", { details });
    if (unknown) return res("manual", "Can't tell from the build", "The permission request can't be read in this build. Connect the Simulator — we read whether it was granted (on an iPhone, check Settings → Notifications).", "static", { details });
    return res("fail", "Never asked", "No requestAuthorization or CleverTap push-primer call was found, so iOS never shows the app's pushes.", "static", {
      remediation: "Ask with UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) or CleverTap's push primer.",
    });
  },

  "app-ios-push-click": ({ s, d }) => {
    const clicks = d?.logs?.clicks ?? [];
    if (clicks.length) return res("pass", "Push tap reached CleverTap (live)", "Notification Clicked was recorded when you tapped the push.", "device");
    if (!s) return res("manual", "Not checked", NO_SCAN, "none");
    const a = s.apis;
    const details = [...ev(a.autoIntegrate), ...ev(a.notificationDelegate), ...ev(a.handleNotification)];
    if (a.autoIntegrate.found)
      return res("pass", "autoIntegrate handles taps", "CleverTap.autoIntegrate() hooks the notification delegate, so taps and deep links reach CleverTap. Tap a push in Guided checks to see it live.", "static", { details });
    if (a.handleNotification.found) return res("pass", "handleNotificationWithData called", "The app forwards push taps to CleverTap.", "static", { details });
    if (a.handleNotification.found === null || a.notificationDelegate.found === null)
      return res("manual", "Can't tell from the build", "Tap a push in Guided checks — we see whether CleverTap records the click.", "static", { details });
    return res("fail", "Taps not handed to CleverTap", a.notificationDelegate.found
      ? "The app handles notification taps itself (UNUserNotificationCenterDelegate) but never calls handleNotificationWithData, so Notification Clicked and deep links from CleverTap are lost."
      : "No autoIntegrate and no notification delegate hand-off — Notification Clicked isn't recorded and CleverTap deep links don't open.", "static", {
      remediation: "Call CleverTap.autoIntegrate(), or in userNotificationCenter(_:didReceive:withCompletionHandler:) call CleverTap.sharedInstance()?.handleNotification(withData: response.notification.request.content.userInfo).",
      details,
    });
  },

  "app-ios-nse": ({ s }) => {
    if (!s) return res("manual", "Not checked", NO_SCAN, "none");
    const svc = s.extensions.filter((e) => e.kind === "service");
    const content = s.extensions.filter((e) => e.kind === "content");
    const details = [...svc, ...content].map((e) => `${e.name} (${e.kind === "service" ? "Service" : "Content"} extension${e.usesCleverTap ? ", CleverTap" : ""}${e.recordsImpressions ? ", records impressions" : ""})`);
    const ct = svc.find((e) => e.usesCleverTap);
    if (ct?.richMedia) return res("pass", `${ct.name}`, "A Notification Service Extension built on CTNotificationServiceExtension downloads images / media for CleverTap pushes.", "static", { details });
    if (ct) return res("pass", `${ct.name} (CleverTap)`, "A Notification Service Extension using CleverTap is included.", "static", { details });
    if (svc.length)
      return res("warn", "Service extension without CleverTap", `${svc[0].name} exists but doesn't use CleverTap, so images in CleverTap pushes won't render and impressions aren't recorded from it.`, "static", {
        remediation: "Subclass CTNotificationServiceExtension (pod 'CTNotificationService') in the extension, or call CleverTap's rich-media handling from it.",
        details,
      });
    return res("warn", "No Notification Service Extension", "Pushes still arrive, but images / GIFs / video in CleverTap pushes won't show, and push impressions can't be recorded on iOS.", "static", {
      remediation: "Add a Notification Service Extension target, add pod 'CTNotificationService', make NotificationService extend CTNotificationServiceExtension, and record impressions with recordNotificationViewedEvent(withData:).",
      details,
    });
  },

  "app-t3-impressions": ({ s, d }) => {
    const p = d?.logs?.push;
    if (p?.impressions) return res("pass", "Impression recorded (live)", "After the push, CleverTap recorded a Notification Viewed for it.", "device");
    if (!s) return res("manual", "Not checked yet", DO.push, "none");
    const svc = s.extensions.filter((e) => e.kind === "service");
    const rec = svc.find((e) => e.recordsImpressions);
    if (rec)
      return res("manual", "Recorded by the extension", `${rec.name} records Notification Viewed. Also switch on Push Impressions in Dashboard → Settings → Schema, then send a test push to confirm.`, "static");
    if (!svc.length)
      return res("fail", "Needs a Notification Service Extension", "iOS only lets an app record push impressions from a Notification Service Extension, and this build has none.", "static", {
        remediation: "Add a Notification Service Extension and call CleverTap.sharedInstance()?.recordNotificationViewedEvent(withData: request.content.userInfo) in didReceive(_:withContentHandler:). " + (faqFix(4) ?? ""),
      });
    if (svc.some((e) => e.recordsImpressions === null))
      return res("manual", "Can't read the extension", "Send a test push and check Notification Viewed arrives.", "static");
    return res("fail", "Extension doesn't record impressions", `${svc[0].name} never calls recordNotificationViewedEvent(withData:), so impressions aren't captured.`, "static", {
      remediation: "In the extension's didReceive(_:withContentHandler:) call CleverTap.sharedInstance()?.recordNotificationViewedEvent(withData: request.content.userInfo). " + (faqFix(4) ?? ""),
    });
  },

  "app-t1-installed": ({ fresh, d, tu }) => {
    if (fresh("App Installed")) return res("pass", "Raised by this build", "The test user's device recorded App Installed after this audit started.", "api");
    if (d?.logs?.appLaunchedFired && d.logs.queueSent > 0 && !tu)
      return res("manual", "Confirm with a fresh install", `App Launched works on the ${where(d)}. CleverTap records App Installed on a device's first launch — ${DO.install}`, "device");
    return res("manual", "Fresh install needed", DO.install, "none");
  },

  "app-t1-launched": ({ fresh, d }) => {
    if (d?.logs?.appLaunchedFired && d.logs.queueSent > 0) return res("pass", "Fired and sent (live)", "The SDK raised App Launched on start and sent it to CleverTap.", "device");
    if (d?.logs?.appLaunchedFired && d.logs.queueFailed > 0)
      return res("fail", "Fired but not sent (live)", "App Launched was raised but the SDK couldn't send its queue to CleverTap.", "device", {
        remediation: "Check the Mac's internet and the Account ID / Token / Region in Info.plist.",
      });
    if (fresh("App Launched")) return res("pass", "Raised by this build", "The test user's device sent App Launched after this audit started.", "api");
    return res("manual", "Not checked yet", DO.start, "none");
  },

  "app-t1-identity": ({ d }) => {
    const pp = d?.logs?.profilePushes.filter((x) => x.hasIdentity).at(-1);
    if (pp) {
      const sent = ["Identity", "Email", "Phone"].filter((k) => pp.keys.includes(k));
      if (!pp.keys.includes("Email") && !pp.keys.includes("Phone"))
        return res("warn", `Sent: ${sent.join(", ")}`, "Login sends an identity but no email or phone, so email/SMS/WhatsApp can't reach users.", "device", {
          remediation: "Include Email and Phone in the onUserLogin profile.",
        });
      return res("pass", `Sent: ${sent.join(", ")}`, "Seen live in the profile the SDK sent at login.", "device");
    }
    return res("manual", "Not checked yet", DO.login, "none");
  },

  "app-t1-onuserlogin": ({ s, d }) => {
    const calls = d?.logs?.onUserLogin ?? [];
    if (calls.some((c) => c.kind === "same-user" || c.kind === "switch-user" || c.kind === "anonymous"))
      return res("pass", "onUserLogin called (live)", "The SDK ran onUserLogin in the session.", "device");
    const u = s?.apis.onUserLogin;
    if (u?.found === false) {
      if (s?.apis.profilePush.found)
        return res("fail", "Only profilePush", "Profiles are updated with profilePush but onUserLogin is never called — several users on one device get merged.", "static", { remediation: faqFix(3) });
      return res("fail", "Not found", "onUserLogin isn't called anywhere in the app.", "static", { remediation: faqFix(3) });
    }
    if (u?.found) return res("pass", "onUserLogin called", "Found in the app's code. Log in on the iPhone or Simulator (Guided checks) to see it run.", "static", { details: ev(u) });
    return res("manual", "Not checked yet", DO.login, "none");
  },

  "app-t1-onuserlogin-update": ({ s, d }) => {
    const r = d?.logScenarios?.relaunch;
    if (r?.onUserLoginOnStart) return res("pass", "Called on app start (live)", "We restarted the app while logged in and onUserLogin ran on start.", "device");
    if (r && !r.onUserLoginOnStart)
      return res("warn", "Not called on app start (live)", "We restarted the app while logged in and onUserLogin did not run. Users who were logged in before an update won't be re-identified.", "device", {
        remediation: "When the app starts and a user is already logged in, call onUserLogin with their Identity/Email (e.g. where you restore the session).",
      });
    if (s?.apis.onUserLogin.found === false)
      return res("fail", "onUserLogin not called", "onUserLogin isn't called at all, so returning users are never re-identified.", "static", { remediation: faqFix(3) });
    return res("manual", "Not checked yet", "Guided checks → “Reopen while logged in”: stay logged in; we restart the app and check onUserLogin runs.", "none");
  },

  "app-t1-custom-events": ({ s, d, tu, fresh }) => {
    const live = d?.logs?.events ?? [];
    if (live.length)
      return res("pass", `${live.length} custom event${live.length > 1 ? "s" : ""} seen live`, `Sent by this build while you used the app: ${list(live.map((e) => e.name), 8)}.`, "device");
    const recent = customEventNames(tu).filter(fresh);
    if (recent.length) return res("pass", `${recent.length} custom event${recent.length > 1 ? "s" : ""} from the test device`, `Raised after this audit started: ${list(recent, 8)}.`, "api");
    if (s?.apis.recordEvent.found === false)
      return res("fail", "No custom events", "recordEvent isn't called anywhere.", "static", { remediation: "Track your key user actions with CleverTap.sharedInstance()?.recordEvent(name, withProps: [...])." });
    return res("manual", "Not checked yet", DO.use, s?.apis.recordEvent.found ? "static" : "none");
  },

  "app-t2-gdpr-location": ({ s, d }) => {
    if (d?.logs?.networkInfo) return res("pass", "Enabled (live)", "The SDK reports device network info.", "device");
    if (!s) return res("manual", "Not checked", NO_SCAN, "none");
    const u = s.apis.enableDeviceNetworkInfo;
    if (u.found) return res("pass", "Enabled", "enableDeviceNetworkInfoReporting(true) is called.", "static", { details: ev(u) });
    if (u.found === null) return res("manual", "Confirm in the session", `The call can't be read in this build. ${DO.start}`, "static", { remediation: faqFix(5) });
    return res("fail", "Not enabled", "enableDeviceNetworkInfoReporting isn't called, so city/region/country stay unknown.", "static", {
      remediation: `CleverTap.sharedInstance()?.enableDeviceNetworkInfoReporting(true). ${faqFix(5) ?? ""}`.trim(),
    });
  },

  "app-t2-lat-long": ({ s, d }) => {
    if (d?.logs?.locationSent) return res("pass", "Lat/long sent (live)", "The SDK's request carries Latitude and Longitude.", "device");
    if (!s) return res("manual", "Not checked", NO_SCAN, "none");
    const u = s.apis.setLocation;
    const perm = s.plist.usage.NSLocationWhenInUseUsageDescription || s.plist.usage.NSLocationAlwaysAndWhenInUseUsageDescription;
    const geo = s.clevertap.modules.some((m) => m.id === "CleverTapLocation" || m.id === "CleverTapGeofence");
    const details = [...ev(u), perm ? "Location usage description present" : "No NSLocationWhenInUseUsageDescription in Info.plist"];
    if (u.found) return res("pass", "setLocation called", "Lat/long is passed to CleverTap.", "static", { details });
    if (geo) return res("pass", "CleverTap location module", "CleverTapLocation / Geofence updates the user's location.", "static", { details });
    if (u.found === null) return res("manual", "Can't verify", "Confirm CleverTap.setLocation(…) is called with the user's coordinates.", "static", { details, remediation: faqFix(5) });
    return res("fail", "Not passed", "setLocation isn't called, so profiles show unknown lat/long.", "static", {
      remediation: `Get the location with CLLocationManager (needs NSLocationWhenInUseUsageDescription), then CleverTap.setLocation(location.coordinate). ${faqFix(5) ?? ""}`.trim(),
      details,
    });
  },

  "app-t2-anon-profile": ({ d }) => {
    if (d?.logs?.appLaunchedFired && d.logs.queueSent > 0)
      return res("pass", "Device profile on app start (live)", "The SDK sent App Launched for this device before any login, so an anonymous profile exists until onUserLogin identifies it.", "device");
    return res("manual", "Not checked yet", `${DO.install} Open it without logging in.`, "none");
  },

  "app-t2-phone-push": ({ d }) => {
    const p = d?.logs?.profilePushes.filter((x) => x.phoneValid !== undefined).at(-1);
    if (p)
      return p.phoneValid
        ? res("pass", "Phone format valid (live)", 'The phone sent at login uses "+" and a country code (E.164).', "device")
        : res("fail", "Phone format invalid (live)", "The phone sent at login is missing the + prefix or country code.", "device", { remediation: 'Send phone numbers in E.164 format, e.g. "+919876543210".' });
    return res("manual", "Not checked yet", DO.phone, "none");
  },

  "app-t3-test-push": ({ d }) => {
    const real = deliveredReal(d);
    if (real) return res("pass", "Delivered through CleverTap", `A CleverTap push appeared ${Math.round((real[1]!.deliveredAfterMs ?? 0) / 1000)} s after sending (app ${real[0]}).`, "device");
    const sim = deliveredAny(d);
    if (sim)
      return res("manual", "Shown with a simulated push", "The app shows CleverTap-shaped pushes on the Simulator. Send one through CleverTap (needs the APNs token) to confirm delivery end to end.", "device");
    return res("manual", "Not sent yet", DO.push, "none");
  },

  "app-t3-killed": (c) => appStateCheck(c, "killed"),
  "app-t3-background": (c) => appStateCheck(c, "background"),
  "app-t3-foreground": (c) => appStateCheck(c, "foreground"),

  "app-t3-deeplink-internal": ({ s, d }) => {
    const tap = d?.logScenarios?.linkTaps?.internal ?? d?.logScenarios?.linkTap;
    if (tap && !/^https?:/i.test(tap.url) && tap.clicked)
      return res("pass", "Opened from the push", `Tapped a push with ${tap.url}; CleverTap fired the deep link${tap.landed ? ` (${tap.landed})` : ""}. Check it's the intended screen.`, "device");
    const tested = d?.deepLinks.filter((x) => !/^https?:/i.test(x.url)) ?? [];
    if (tested.length) {
      const bad = tested.filter((x) => !x.ok);
      const details = tested.map((x) => `${x.url} → ${x.ok ? "opens the app" : `failed: ${x.detail ?? "didn't open"}`}`);
      if (!bad.length) return res("pass", `${tested.length} link${tested.length > 1 ? "s" : ""} open the app`, `Opened on the ${where(d)}. Check each lands on the intended screen.`, "device", { details });
      return res("fail", `${bad.length} link${bad.length > 1 ? "s" : ""} failed`, `Some deep links don't open the app on the ${where(d)}.`, "device", { remediation: faqFix(9), details });
    }
    if (!s) return res("manual", "Not checked", NO_SCAN, "none");
    const schemes = s.plist.urlSchemes.filter((x) => !/^(fb\d+|com\.googleusercontent\.apps\..*|app-\d+.*)$/i.test(x));
    const details = schemes.slice(0, 6).map((x) => `${x}://`);
    if (schemes.length) return res("manual", `${schemes.length} URL scheme${schemes.length > 1 ? "s" : ""}`, "Send a push with one of these links (Guided checks) and confirm it opens the right screen.", "static", { details });
    return res("warn", "No custom URL scheme", "Info.plist declares no URL scheme (CFBundleURLTypes), so in-app deep links from push can't open specific screens.", "static", {
      remediation: `Add a URL type (Target → Info → URL Types) and route it in scene(_:openURLContexts:) / onOpenURL, or handle CleverTap links with CleverTapURLDelegate. ${faqFix(9) ?? ""}`.trim(),
    });
  },

  "app-t3-deeplink-external": ({ s, d }) => {
    const t = d?.logScenarios?.linkTaps?.external ?? d?.logScenarios?.linkTap;
    if (t && /^https?:/i.test(t.url) && t.clicked)
      return res("pass", "Opened from the push", `Tapped a push with ${t.url}; CleverTap opened it${t.openedOutsideApp ? " in Safari" : ""}.`, "device");
    if (!s) return res("manual", "Not checked", NO_SCAN, "none");
    const domains = s.signing.associatedDomains.filter((x) => x.startsWith("applinks:"));
    return res("manual", domains.length ? `${domains.length} universal link domain${domains.length > 1 ? "s" : ""}` : "Opens in Safari",
      domains.length
        ? "These https links can open the app (universal links). Send a push with one and check where it lands."
        : "No universal links (applinks:) are configured, so https links open in Safari — that's expected. Confirm with a push in Guided checks.",
      "static", { details: domains.slice(0, 6) });
  },

  "app-t3-test-inapp": ({ d }) => {
    const li = d?.logs?.inApp;
    if (li?.errors.length) return res("fail", "In-app failed on the device", li.errors[0], "device", { remediation: "Check the in-app's media URL and that the app's window is ready when the in-app triggers." });
    if (li && li.shown > 0) return res("pass", "In-app shown (live)", "The SDK displayed an in-app during the session.", "device");
    return res("manual", "Not checked yet", "On the dashboard create a test in-app for your test user (trigger: App Launched), then Guided checks → “See an in-app”.", "none");
  },

  "app-t3-inapp-exclude": ({ s, d }) => {
    if (d?.logs?.inApp.blockedOnExcludedScreen) return res("pass", "In-apps suspended (live)", "The SDK held back an in-app while they were suspended.", "device");
    if (!s) return res("manual", "Not checked", NO_SCAN, "none");
    if (s.apis.suspendInApps.found) return res("pass", "suspendInAppNotifications used", "The app suspends in-apps (e.g. during its splash) and resumes them later.", "static", { details: ev(s.apis.suspendInApps) });
    return res("na", "Launch screen can't show in-apps", "iOS shows the launch screen before CleverTap starts, so in-apps can't appear on it. If you draw your own splash / loading screen in code, call suspendInAppNotifications() while it's visible.", "static");
  },

  "app-t3-uninstall": ({ s }) => {
    if (s && !s.signing.apsEnvironment && !s.app.simulatorBuild)
      return res("fail", "Needs push (APNs)", "iOS uninstall tracking uses silent pushes, and this build has no Push Notifications capability.", "static", { remediation: CAPABILITY_FIX });
    return res("manual", "Dashboard setting", "Check Settings → Uninstall Tracking is switched on, then tick it.", s ? "static" : "none");
  },

  "app-t3-session-analytics": () => res("manual", "Dashboard setting", "Session analytics isn't exposed by the API. Check it's switched on in the dashboard.", "none"),

  "app-t4-formats": ({ d }) => {
    const live = (d?.logs?.events ?? []).flatMap((e) => e.issues.filter((i) => /text/.test(i)).map((i) => `'${e.name}' → ${i}`));
    if (live.length) return res("fail", `${live.length} format issue${live.length > 1 ? "s" : ""} (live)`, "Some properties use the wrong data type.", "device", { remediation: faqFix(10), details: live.slice(0, 12) });
    if (d?.logs?.events.some((e) => Object.keys(e.props).length)) return res("pass", "Types look right (live)", "No numbers-as-text or text dates in the events sent while you used the app.", "device");
    return res("manual", "Not checked yet", DO.use, "none");
  },

  "app-t4-valid-values": ({ d }) => {
    const L = d?.logs;
    const live = [
      ...(L?.events ?? []).flatMap((e) => e.issues.filter((i) => /null|empty/.test(i)).map((i) => `'${e.name}' → ${i}`)),
      ...(L?.profilePushes ?? []).flatMap((p) => p.nullish.map((k) => `Profile ${k} is null/empty`)),
    ];
    if (live.length)
      return res("fail", `${live.length} invalid value${live.length > 1 ? "s" : ""} (live)`, 'Properties are sent as nil / "null" / empty strings.', "device", {
        remediation: "Skip the property when there's no value — don't send \"null\", \"\" or \"(null)\".",
        details: live.slice(0, 12),
      });
    if (L && (L.events.length || L.profilePushes.length)) return res("pass", "No null/empty values (live)", "Events and profile updates sent while you used the app carry only real values.", "device");
    return res("manual", "Not checked yet", `${DO.login} Then use the app.`, "none");
  },

  "app-t4-critical-events": ({ criticalEvents, d }) => {
    const ce = (criticalEvents ?? []).filter(Boolean);
    if (!ce.length) return res("manual", "No events listed", "Add the 3–4 custom events to verify on this report, then trigger them in the app (Guided checks).", "none");
    const liveEv = d?.logs?.events ?? [];
    const seen = liveEv.filter((e) => ce.includes(e.name));
    const missing = ce.filter((n) => !liveEv.some((e) => e.name === n));
    const details = seen.map((e) => `${e.name}: ${Object.entries(e.props).map(([k, t]) => `${k}:${t.join("/")}`).join(", ") || "no properties"}${e.issues.length ? ` ⚠ ${e.issues.join("; ")}` : ""}`);
    const bad = seen.filter((e) => e.issues.length);
    if (bad.length) return res("fail", `${bad.length} event${bad.length > 1 ? "s" : ""} with property issues`, "Seen live; fix the flagged properties.", "device", { remediation: faqFix(10), details });
    if (!missing.length) return res("pass", `All ${ce.length} custom events verified live`, "Every listed event fired with correctly typed properties.", "device", { details });
    return res("manual", `${seen.length} of ${ce.length} seen`, `Not seen yet: ${list(missing)}. ${DO.use}`, seen.length ? "device" : "none", { details });
  },
};

/* ------------------------------------------------------------------ */

export function evaluateIos(input: IosEngineInput): Record<string, ItemResult> {
  const ctx: Ctx = {
    ...input,
    s: input.scan ?? undefined,
    a: input.api?.ok ? input.api : undefined,
    d: input.device ?? undefined,
    tu: input.api?.testUser?.found ? input.api.testUser : undefined,
    fresh: (n) => {
      const t = input.api?.testUser?.found ? input.api.testUser.events[n]?.lastSeen : undefined;
      return !!t && t >= (input.since ?? 0);
    },
  };
  const out: Record<string, ItemResult> = {};
  for (const item of itemsForPlatform("ios")) {
    const rule = RULES[item.id];
    const r = rule ? rule(ctx) : res("manual", "Not automated yet", "Verify manually.", "none");
    out[item.id] = { itemId: item.id, ...r };
  }
  return out;
}

function appStateCheck({ d, api, s }: Ctx, state: AppState) {
  const how = state === "killed" ? "Close the app" : state === "background" ? "Send the app to the background" : "Keep the app open";
  const dt = d?.pushTests[state];
  if (dt?.status === "delivered" && dt.verifiedState) {
    if (dt.via === "clevertap")
      return res("pass", `Delivered in ${Math.round((dt.deliveredAfterMs ?? 0) / 1000)} s`, `We put the app in the ${state} state on the ${where(d)} (${dt.stateDetail}), sent a CleverTap push and it appeared${dt.seenIn === "user" ? " — you confirmed it on screen" : ""}.`, "device");
    return res("manual", "Shown (simulated push)", `With the app ${state} (${dt.stateDetail}) a simulated CleverTap push was shown. Send one through CleverTap to confirm APNs delivery.`, "device");
  }
  if (dt?.status === "not-delivered" && dt.verifiedState) {
    // another state showed pushes, so permission / token / APNs are fine — it's this state
    const shownElsewhere = Object.entries(d?.pushTests ?? {}).some(([k, r]) => k !== state && r?.status === "delivered");
    if (state === "foreground" && shownElsewhere)
      return res("fail", "Not shown while the app is open", `Pushes show with the app in the background or closed, but not while it's on screen.${s?.apis.willPresent.found === false ? " The app has no userNotificationCenter(_:willPresent:) handler, so iOS hides them." : ""}`, "device", {
        remediation: "Set UNUserNotificationCenter.current().delegate (e.g. in didFinishLaunching, before CleverTap.autoIntegrate()) and return [.banner, .list, .sound] from userNotificationCenter(_:willPresent:withCompletionHandler:).",
      });
    if (!shownElsewhere && d?.notificationPermission && d.notificationPermission !== "granted" && d.notificationPermission !== "provisional")
      return res("warn", `Not shown (${state}) — notifications not allowed`, `Notification permission is ${d.notificationPermission === "denied" ? "off" : "not granted yet"} for the app on the Simulator, so iOS shows nothing.`, "device", {
        remediation: "Make the app ask for notification permission, allow it, then test again.",
      });
    if (dt.via === "simulated")
      return res("fail", `Not shown (${state})`, `A simulated push wasn't shown with the app ${state}, although notifications are allowed.`, "device", {
        remediation: "Check the app's UNUserNotificationCenter delegate doesn't suppress CleverTap pushes (willPresent should return .banner/.sound).",
      });
    return res("fail", `Not delivered (${state})`, `The app was ${state} (${dt.stateDetail}) and no CleverTap push appeared within 60 s.`, "device", {
      remediation: "Check the APNs key on the dashboard (development vs production), the Push capability, and that the token reaches CleverTap.",
    });
  }
  const at = api?.pushTests?.[state];
  if (at?.status === "confirmed") return res("pass", "Delivered & viewed", `You set the app to ${state} and the test user's Notification Viewed arrived after the push.`, "api");
  if (dt?.status === "delivered") return res("manual", "Delivered — state not confirmed", `A push arrived, but the app state couldn't be confirmed as ${state} (${dt.stateDetail}).`, "device");
  return res("manual", "Confirm on a device", `${how}, then send a test push — Push tests does this for you on the iPhone or Simulator.`, "none");
}
