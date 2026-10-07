import type { AndroidScanReport, ApiUsage } from "../analyzer/types";
import type { ApiFindings, EventSample, TestUserRecord } from "../clevertap/types";
import type { AppState, DeviceFindings } from "../device/types";
import type { ItemResult, ItemStatus, ResultSource } from "../types";
import { itemsForPlatform } from "../checklist";
import { getFaq } from "../faq";

// ---------------------------------------------------------------------------
// Android rule engine: (static report, API findings, live-device findings)
// -> one result per checklist item. Pure and deterministic so it can run anywhere and be
// re-run whenever either input changes.
//
// Evidence policy: the audit judges THE BUILD BEING TESTED. Only fresh evidence
// decides an item — the APK scan, the live phone (SDK logs while the user does
// each action, push tests), and the test user's profile updated after the audit
// started. Account-wide history on the dashboard is never used: it may come from
// older builds or other apps. No fresh evidence yet → "manual" + the action to do.
//
// Status policy (keep every rule consistent with it):
//  fail   = proven broken, or a CleverTap-documented requirement is missing,
//           so users are affected (e.g. no POST_NOTIFICATIONS on targetSdk 33)
//  warn   = works, but outdated / risky / partly verified, or the problem is in
//           account data or phone settings rather than the code
//  manual = can't be decided automatically (no data yet, dashboard setting,
//           needs a step on a phone)
//  na     = doesn't apply to this app
//  - never auto-fail on silence from the API (no data ≠ broken) → "manual"
//  - "unknown" static findings (obfuscation, Hermes…) never fail on their own
//  - every fail/warn carries a concrete fix
// ---------------------------------------------------------------------------

export interface LatestVersions {
  android?: string;
  flutter?: string;
  reactNative?: string;
  cordova?: string;
}

export interface EngineInput {
  scan?: AndroidScanReport | null;
  api?: ApiFindings | null;
  device?: DeviceFindings | null;
  latest?: LatestVersions | null;
  accountId?: string | null;
  region?: string | null;
  criticalEvents?: string[];
  since?: number; // audit created (epoch ms): test-user data older than this is past data
}

type Rule = (ctx: Ctx) => Omit<ItemResult, "itemId">;

interface Ctx extends EngineInput {
  s?: AndroidScanReport;
  a?: ApiFindings; // only when the API call succeeded
  d?: DeviceFindings; // live-device checks (USB / Wi-Fi)
  tu?: TestUserRecord; // the test user's profile, when found
  fresh: (name: string) => boolean; // test user raised this event after the audit started
  ev: (name: string) => EventSample | undefined;
}

const NO_API = "Needs the CleverTap API (Account ID + Passcode) to verify automatically — or confirm on the dashboard.";
// "do this on the phone" guidance — every item without fresh proof points to one action
const DO = {
  start: "Live device testing → connect the phone; the app is restarted and checked automatically.",
  login: "Live device testing → step 4 “Log in again”: log out and log in on the phone.",
  phone: "Live device testing → step 4 “Log in again”: log in with a phone number.",
  use: "Live device testing → step 4 “Your key actions”: use the app (open a product, add to cart, buy…).",
  push: "Live device testing → step 3: press Test on any app state.",
  install: "Uninstall the app, install this build, open it once, then press “Check test user” (step 1).",
};
const NO_SCAN = "Scan an APK/AAB to check this automatically.";

function res(
  status: ItemStatus,
  detected: string,
  evidence: string,
  source: ResultSource,
  extra: { remediation?: string; details?: string[] } = {},
): Omit<ItemResult, "itemId"> {
  return { status, detected, evidence, source, ...extra };
}

const list = (a: string[], n = 5) => a.slice(0, n).map((x) => `'${x}'`).join(", ") + (a.length > n ? ` +${a.length - n} more` : "");
const faqFix = (n: number) => {
  const f = getFaq(n);
  return f ? `FAQ #${f.n}: ${f.solutions[0]}` : undefined;
};

// CleverTap Android SDK minimums tied to Android versions (developer.clevertap.com
// "Android 12 Updates" / "Android 13 Updates").
const OS_SDK_MIN: { target: number; sdk: string; why: string }[] = [
  { target: 33, sdk: "4.7.0", why: "Apps targeting Android 13 (API 33) need CleverTap SDK 4.7.0+ (runtime notification permission)." },
  { target: 31, sdk: "4.3.0", why: "Apps targeting Android 12 (API 31) need CleverTap SDK 4.3.0+ (notification trampoline restrictions — push clicks break on older SDKs)." },
];

function usageEvidence(u: ApiUsage): string[] {
  return u.evidence.slice(0, 6);
}

/* ------------------------------------------------------------------ */

const RULES: Record<string, Rule> = {
  "app-t1-credentials": ({ s, a, accountId, region, d }) => {
    const L = d?.logs;
    if (L?.accountId && accountId && L.accountId.toUpperCase() !== accountId.trim().toUpperCase())
      return res("fail", "Wrong account (live)", `The running app sends data to ${L.accountId}, but this audit is for ${accountId}.`, "device", {
        remediation: "Copy the Project ID and Token from Dashboard → Settings → Project into the app.",
      });
    const liveRegion = L?.region?.replace(/-spiky$/, ""); // eu1-spiky = eu1's push-impression host
    if (liveRegion && region && liveRegion !== region.toLowerCase())
      return res("fail", "Region mismatch (live)", `The running app talks to ${liveRegion}.clevertap-prod.com, but the account is in ${region}.`, "device", {
        remediation: `Set CLEVERTAP_REGION to "${region}".`,
      });
    if (L?.accountId && L.queueSent > 0)
      return res("pass", `Account ${L.accountId} · ${liveRegion ?? "region ?"}`, "Seen live: the app sends data to this account and region, and CleverTap accepts it.", "device");
    if (!s) {
      if (a) return res("pass", "API accepted the credentials", "Account ID + Passcode work for this region.", "api");
      return res("manual", "Not checked", NO_SCAN, "none");
    }
    const md = s.manifest.metaData;
    const creds = s.apis.changeCredentials;
    let acc = md.CLEVERTAP_ACCOUNT_ID?.trim();
    const tok = md.CLEVERTAP_TOKEN?.trim();
    const reg = md.CLEVERTAP_REGION?.trim();
    const details: string[] = [];
    if (acc) details.push(`CLEVERTAP_ACCOUNT_ID = ${acc}`);
    if (tok) details.push(`CLEVERTAP_TOKEN = ${tok.slice(0, 3)}•••`);
    if (reg) details.push(`CLEVERTAP_REGION = ${reg}`);
    if (!acc && creds.found) {
      acc = creds.strings[0];
      details.push(`Set in code: ${usageEvidence(creds)[0] ?? "changeCredentials / createInstance"}`);
    }
    const fix1 = faqFix(1);
    if (!acc) {
      if (creds.found === null)
        return res("warn", "Not in manifest", "No CLEVERTAP_ACCOUNT_ID in the manifest; it may be set in obfuscated code.", "static", { remediation: fix1, details });
      return res("fail", "Account ID missing", "No CLEVERTAP_ACCOUNT_ID in AndroidManifest.xml and no changeCredentials() call.", "static", { remediation: fix1, details });
    }
    if (/\$\{|^\\/.test(acc) || (tok && /\$\{|^\\/.test(tok)))
      return res("fail", "Placeholder not substituted", `The manifest contains an unresolved value ("${acc}").`, "static", {
        remediation: "Check manifestPlaceholders in build.gradle — the values were not substituted at build time.",
        details,
      });
    if (!tok && !creds.found)
      return res("fail", "Token missing", "CLEVERTAP_ACCOUNT_ID is set but CLEVERTAP_TOKEN is missing.", "static", { remediation: fix1, details });

    if (accountId && acc && acc.toUpperCase() !== accountId.trim().toUpperCase())
      return res("fail", "Wrong account", `The app sends data to account ${acc}, but this audit is for ${accountId}.`, "static", {
        remediation: "Copy the Project ID and Token from Dashboard → Settings → Project into the manifest.",
        details,
      });
    const norm = (r?: string | null) => (r ?? "").trim().toLowerCase().replace(/^eu1?$/, "") || "eu";
    if (region && norm(reg) !== norm(region))
      return res("fail", "Region mismatch", reg
        ? `The app is configured for region "${reg}" but the account is in "${region}".`
        : `CLEVERTAP_REGION is not set, so the SDK sends data to the default (EU) region — but the account is in "${region}".`, "static", {
        remediation: reg
          ? `Set CLEVERTAP_REGION to "${region}".`
          : `Add <meta-data android:name="CLEVERTAP_REGION" android:value="${region}"/> to the manifest.`,
        details,
      });
    return res("pass", `Account ${acc}${reg ? ` · ${reg}` : ""}`, "Credentials found in the app and they match this audit.", "static", { details });
  },

  "app-t1-lifecycle": ({ s, d }) => {
    if (d?.logs?.lifecycleRegistered)
      return res("pass", "Registered (live)", "The SDK confirmed lifecycle callbacks on app start.", "device");
    if (!s) return res("manual", "Not checked", NO_SCAN, "none");
    const u = s.apis.lifecycleRegister;
    if (u.found) return res("pass", "Registered", "Lifecycle callbacks are registered.", "static", { details: usageEvidence(u) });
    if (s.manifest.metaData.CLEVERTAP_DISABLE_APP_LAUNCHED === "1")
      return res("fail", "App Launched disabled", "CLEVERTAP_DISABLE_APP_LAUNCHED=1 is set in the manifest.", "static", {
        remediation: "Remove CLEVERTAP_DISABLE_APP_LAUNCHED unless this is intentional.",
      });
    const fix = `Call ActivityLifecycleCallback.register(this) before super.onCreate() in your Application class${
      s.clevertap.wrapper ? `, or set android:name to ${s.clevertap.wrapper.framework === "flutter" ? "com.clevertap.clevertap_plugin.CleverTapApplication" : "com.clevertap.android.sdk.Application"}` : ""
    }.`;
    if (u.found === null || (d?.logs?.appLaunchedFired && !d.logs.lifecycleRegistered))
      return res("manual", "Confirm on the phone", `The code can't be read (minified). ${DO.start}`, "static", { remediation: fix });
    return res("fail", "Not registered", `${s.app.applicationClass ?? "The Application class"} doesn't register CleverTap's lifecycle callbacks.`, "static", { remediation: fix });
  },

  "app-t1-fcm-service": ({ s, a, d, api }) => {
    if (d?.logs?.push?.received)
      return res("pass", "SDK received the push (live)", "The SDK logged “received notification from CleverTap”, so FCM messages reach it.", "device");
    const proved = Object.entries(d?.pushTests ?? {}).find(([, r]) => r?.status === "delivered");
    const confirmed = Object.values(api?.pushTests ?? {}).some((r) => r?.status === "confirmed");
    if (proved || confirmed)
      return res("pass", "Proven by a delivered push", `A CleverTap push reached the test device${proved ? ` (app ${proved[0]})` : ""}, so FCM messages are handed to CleverTap.`, proved ? "device" : "api", {
        details: s?.manifest.messagingServices.map((x) => `Service: ${x.name}${x.isCleverTap ? " (CleverTap)" : ""}`),
      });
    if (!s) return res("manual", "Not checked", NO_SCAN, "none");
    const services = s.manifest.messagingServices;
    const ctService = services.find((x) => x.isCleverTap);
    const generic = new Set(["com.google.firebase.messaging.FirebaseMessagingService"]);
    const custom = services.filter((x) => !x.isCleverTap && !generic.has(x.name));
    const hand = s.apis.fcmHandoff;
    const token = s.apis.pushFcmToken;
    const details = [
      ...services.map((x) => `Service: ${x.name}${x.isCleverTap ? " (CleverTap)" : ""}`),
      ...s.manifest.ctComponents.filter((c) => /CTFirebaseMessagingReceiver/.test(c)),
    ];
    if (!s.firebase.messagingSdk)
      return res("fail", "Firebase Messaging missing", "firebase-messaging isn't in the app, so CleverTap can't deliver push.", "static", {
        remediation: "Add com.google.firebase:firebase-messaging and your google-services.json, then follow the Android push guide.",
        details,
      });
    if (!s.firebase.googleServicesConfigured)
      details.push("google-services resources (gcm_defaultSenderId) not found — check that google-services.json is applied.");
    if (hand.found) {
      details.push(...usageEvidence(hand));
      if (token.found === false)
        return res("warn", "Token not forwarded", "Pushes are handed to CleverTap, but the custom service doesn't forward new FCM tokens.", "static", {
          remediation: "In onNewToken(), call CleverTapAPI.getDefaultInstance(ctx).pushFcmRegistrationId(token, true).",
          details,
        });
      return res("pass", "Custom service hands off to CleverTap", "CTFcmMessageHandler / createNotification is called from the app's messaging service.", "static", { details });
    }
    if (ctService && custom.length === 0)
      return res("pass", "CleverTap FCM service", `${ctService.name} receives FCM messages.`, "static", { details });
    if (custom.length === 0)
      return res("pass", "CleverTap receiver", "No custom FirebaseMessagingService competes with CleverTap's.", "static", { details });
    const fix =
      "In your FirebaseMessagingService.onMessageReceived(), call CTFcmMessageHandler().createNotification(applicationContext, message) for CleverTap pushes (check CleverTapAPI.getNotificationInfo(extras).fromCleverTap).";
    if (hand.found === null)
      return res("manual", "Can't verify hand-off", `Custom service ${custom[0].name} found; the code is minified so the hand-off can't be confirmed. A test push (step 3) confirms it automatically.`, a ? "static+api" : "static", {
        remediation: fix,
        details,
      });
    return res("fail", "Custom service ignores CleverTap", `${custom.map((c) => c.name).join(", ")} handles FCM messages but never passes them to CleverTap — CleverTap pushes won't render.`, "static", {
      remediation: fix + " " + (faqFix(12) ?? ""),
      details,
    });
  },

  "app-t1-installed": ({ s, tu, fresh, d }) => {
    const details = s?.firebase.installReferrer ? ["Install Referrer library present — install attribution (UTM) is captured."] : [];
    if (fresh("App Installed"))
      return res("pass", "Raised by this build", "The test user's phone recorded App Installed after this audit started.", "api", { details });
    if (d?.logs?.appLaunchedFired && d.logs.queueSent > 0 && !tu)
      return res("manual", "Confirm with a fresh install", `App Launched works on the phone. CleverTap records App Installed on a device's first launch — ${DO.install}`, "device", { details });
    return res("manual", "Fresh install needed", DO.install, "none", { details });
  },

  "app-t1-launched": ({ s, fresh, d }) => {
    if (s?.manifest.metaData.CLEVERTAP_DISABLE_APP_LAUNCHED === "1")
      return res("fail", "Disabled in manifest", "CLEVERTAP_DISABLE_APP_LAUNCHED=1 stops the SDK from raising App Launched.", "static", {
        remediation: "Remove the CLEVERTAP_DISABLE_APP_LAUNCHED meta-data.",
      });
    if (d?.logs?.appLaunchedFired && d.logs.queueSent > 0)
      return res("pass", "Fired and sent (live)", "The SDK raised App Launched on start and sent it to CleverTap.", "device");
    if (d?.logs?.appLaunchedFired && d.logs.queueFailed > 0)
      return res("fail", "Fired but not sent (live)", "App Launched was raised but the SDK couldn't send its queue to CleverTap.", "device", {
        remediation: "Check the phone's internet and the Account ID / Token / Region in the manifest.",
      });
    if (fresh("App Launched")) return res("pass", "Raised by this build", "The test user's phone sent App Launched after this audit started.", "api");
    return res("manual", "Not checked yet", DO.start, "none");
  },

  "app-t1-sdk-version": ({ s, latest, d }) => {
    if (!s) return res("manual", "Not checked", NO_SCAN, "none");
    const live = d?.logs;
    const ct = {
      ...s.clevertap,
      coreVersion: s.clevertap.coreVersion ?? live?.sdkVersion,
      present: s.clevertap.present || !!live?.sdkVersion,
      wrapper: s.clevertap.wrapper && { ...s.clevertap.wrapper, version: s.clevertap.wrapper.version ?? live?.wrapper?.version },
    };
    if (!ct.present)
      return res("fail", "CleverTap SDK not detected", "No CleverTap classes, components or manifest keys were found in the build.", "static", {
        remediation: "Add com.clevertap.android:clevertap-android-sdk to app/build.gradle — see the Android quick-start.",
      });
    const details = ct.modules.map((m) => `${m.label}${m.version ? ` ${m.version}` : ""}`);
    if (ct.wrapper) {
      const wl = latestFor(ct.wrapper.framework, latest);
      details.unshift(`${ct.wrapper.label}${ct.wrapper.version ? ` ${ct.wrapper.version}` : ""}${wl ? ` (latest ${wl})` : ""}`);
    }
    const target = latest?.android;
    if (!ct.coreVersion) {
      return res("manual", ct.minVersionEstimate ? `≥ ${ct.minVersionEstimate} (estimated)` : "Version unknown",
        "The version string was stripped by minification. The step 4 log session reads the exact version automatically, or check build.gradle / pubspec / package.json.", "static", {
          remediation: target ? `Latest core SDK is ${target}.` : undefined,
          details,
        });
    }
    const appTarget = s.app.targetSdk ?? 0;
    const osMin = OS_SDK_MIN.find((m) => appTarget >= m.target && compareVersions(ct.coreVersion!, m.sdk) < 0);
    if (osMin)
      return res("fail", `SDK v${ct.coreVersion} too old for targetSdk ${appTarget}`, osMin.why, "static", {
        remediation: `Upgrade the CleverTap SDK to ${target ?? osMin.sdk} (at least ${osMin.sdk}).`,
        details,
      });
    if (!target) return res("pass", `SDK v${ct.coreVersion}`, "Couldn't fetch the latest version to compare.", "static", { details });
    const cmp = compareVersions(ct.coreVersion, target);
    if (cmp >= 0) return res("pass", `SDK v${ct.coreVersion} (latest)`, `Core SDK is up to date (latest ${target}).`, "static", { details });
    const [maj] = ct.coreVersion.split(".").map(Number);
    const [tmaj] = target.split(".").map(Number);
    const behind = `SDK v${ct.coreVersion} — latest is ${target}`;
    if (tmaj - maj >= 2)
      return res("warn", behind, `${tmaj - maj} major versions behind — it meets this app's Android requirements, but misses fixes and features.`, "static", {
        remediation: `Upgrade to ${target} — see the changelog for breaking changes.`,
        details,
      });
    return res("warn", behind, tmaj > maj ? "One major version behind." : "Same major version, update recommended.", "static", {
      remediation: `Update to ${target}.`,
      details,
    });
  },

  "app-t1-channel": ({ s, d }) => {
    const lp = d?.logs?.push;
    if (lp?.fallbackChannel)
      return res("warn", "Push fell back to a default channel", `The push asked for a channel the app hasn't created, so CleverTap used “${lp.fallbackChannel}”.`, "device", {
        remediation: "Create the channel in code (createNotificationChannel) and send pushes with that same channel ID (dashboard → Settings → Channels → Android).",
      });
    if (lp?.channels.length)
      return res("pass", `Rendered on '${lp.channels[0]}'`, "Pushes render on a channel the app created.", "device", { details: lp.channels.map((c) => `Channel used: ${c}`) });
    if (d?.app.installed && d.channels.length) {
      const ids = d.channels.map((c) => c.id);
      const expected = [...(s?.channelIds ?? []), s?.manifest.metaData.CLEVERTAP_DEFAULT_CHANNEL_ID].filter(Boolean) as string[];
      const hit = expected.find((x) => ids.includes(x));
      const details = d.channels.map((c) => `On device: '${c.id}'${c.name ? ` (${c.name})` : ""}, importance ${c.importance ?? "?"}`);
      if (hit || !expected.length)
        return res("pass", `${d.channels.length} channel${d.channels.length > 1 ? "s" : ""} on the device`, "Notification channels exist on the test device. Make sure the CleverTap one is also added on the dashboard.", "device", {
          details,
        });
    }
    if (!s) return res("manual", "Not checked", NO_SCAN, "none");
    const u = s.apis.createNotificationChannel;
    const native = s.apis.androidChannel;
    const def = s.manifest.metaData.CLEVERTAP_DEFAULT_CHANNEL_ID;
    const details = [...usageEvidence(u)];
    if (def) details.push(`CLEVERTAP_DEFAULT_CHANNEL_ID = ${def}`);
    const remind = "Add the same channel ID on Dashboard → Settings → Channels → Mobile Push → Android.";
    if (u.found) {
      const ids = s.channelIds.length ? `Channel ${list(s.channelIds)} created` : "createNotificationChannel() is called";
      return res("pass", ids, remind, "static", { details });
    }
    if (native.found) {
      details.push(...usageEvidence(native));
      return res("pass", `Channel ${native.strings.length ? list(native.strings) : ""} created via Android API`.replace("  ", " "),
        "A channel is created with NotificationManager — that's fine for CleverTap as long as pushes are sent with the same channel ID.", "static", {
          remediation: remind,
          details,
        });
    }
    if (def) return res("pass", `Default channel '${def}'`, remind, "static", { details });
    if (u.found === null)
      return res("manual", "Can't verify", "The code is minified (or a debug Flutter build); the channel creation call can't be matched. A test push (step 3) shows the channel used.", "static", { remediation: faqFix(2), details });
    return res("warn", "No channel created", "No notification channel is created. On Android 8+ the SDK then shows pushes on a generic fallback channel, so users can't control them and channel-specific sound/importance from the dashboard is lost.", "static", {
      remediation: `${faqFix(2) ?? ""} Create it with CleverTapAPI.createNotificationChannel(...) and add the same ID on the dashboard.`.trim(),
      details,
    });
  },

  "app-t1-identity": ({ s, d }) => {
    const pp = d?.logs?.profilePushes.filter((x) => x.hasIdentity).at(-1);
    const login = s?.apis.onUserLogin;
    if (pp) {
      const has = (k: string) => pp.keys.includes(k);
      const sent = ["Identity", "Email", "Phone"].filter(has);
      if (!has("Email") && !has("Phone"))
        return res("warn", `Sent: ${sent.join(", ")}`, "Login sends an identity but no email or phone, so email/SMS/WhatsApp can't reach users.", "device", {
          remediation: "Include Email and Phone in the onUserLogin map.",
        });
      return res("pass", `Sent: ${sent.join(", ")}`, "Seen live in the profile the SDK sent at login.", "device");
    }
    return res("manual", "Not checked yet", DO.login, login?.found ? "static" : "none");
  },

  "app-t1-onuserlogin": ({ s, d }) => {
    const calls = d?.logs?.onUserLogin ?? [];
    if (calls.some((c) => c.kind === "same-user" || c.kind === "switch-user" || c.kind === "anonymous"))
      return res("pass", "onUserLogin called (live)", "The SDK ran onUserLogin when you logged in.", "device");
    if (calls.length && calls.every((c) => c.kind === "aborted" || c.kind === "failed"))
      return res("fail", "onUserLogin failed (live)", "The SDK aborted onUserLogin — usually a non-text value for Identity/Email.", "device", {
        remediation: "Pass Identity / Email / Phone as plain strings in the onUserLogin map.",
      });
    const u = s?.apis.onUserLogin;
    const profile = s?.apis.pushProfile;
    if (u?.found === false) {
      if (profile?.found)
        return res("fail", "Only profile push", "Profiles are updated with pushProfile/profileSet but onUserLogin is never called — multiple users on one device get merged.", "static", {
          remediation: faqFix(3),
        });
      return res("fail", "Not found", "onUserLogin isn't called anywhere in the app.", "static", { remediation: faqFix(3) });
    }
    if (u?.found) return res("pass", "onUserLogin called", "Found in the app's code. Log in on the phone (step 4) to see it run.", "static");
    return res("manual", "Not checked yet", DO.login, "none");
  },

  "app-t1-onuserlogin-update": ({ s, d }) => {
    const r = d?.logScenarios?.relaunch;
    if (r?.onUserLoginOnStart)
      return res("pass", "Called on app start (live)", "We restarted the app while logged in and onUserLogin ran on start.", "device");
    if (r && !r.onUserLoginOnStart)
      return res("warn", "Not called on app start (live)", "We restarted the app while logged in and onUserLogin did not run. Users who were logged in before an update won't be re-identified.", "device", {
        remediation: "When the app starts and a user is already logged in, call onUserLogin with their Identity/Email (e.g. in your startup / auth-restore code).",
      });
    if (!s) return res("manual", "Not checked", NO_SCAN, "none");
    const u = s.apis.onUserLogin;
    if (u.found === false)
      return res("fail", "onUserLogin not called", "onUserLogin isn't called at all, so returning users are never re-identified.", "static", { remediation: faqFix(3) });
    const startup = u.evidence.find((e) =>
      /Application\.onCreate|\.onCreate\(\)|Splash|Launcher|MainActivity/i.test(e) ||
      (s.app.applicationClass && e.includes(s.app.applicationClass)),
    );
    if (startup)
      return res("pass", "Called at app start", "onUserLogin runs during startup, so already-logged-in users are re-identified after an update.", "static", {
        details: [startup],
      });
    return res("manual", "Confirm on app update", "Make sure onUserLogin also runs when a logged-in user opens the updated app, not only at the login screen.", "static", {
      details: usageEvidence(u),
    });
  },

  "app-t1-custom-events": ({ s, d, tu, fresh }) => {
    const liveEvents = d?.logs?.events ?? [];
    if (liveEvents.length)
      return res("pass", `${liveEvents.length} custom event${liveEvents.length > 1 ? "s" : ""} seen live`, `Sent by this build while you used the app: ${list(liveEvents.map((e) => e.name), 8)}.`, "device");
    const recent = customEventNames(tu).filter(fresh);
    if (recent.length)
      return res("pass", `${recent.length} custom event${recent.length > 1 ? "s" : ""} from the test phone`, `Raised after this audit started: ${list(recent, 8)}.`, "api");
    if (s?.apis.pushEvent.found === false)
      return res("fail", "No custom events", "pushEvent / recordEvent isn't called anywhere.", "static", {
        remediation: "Track your key user actions with pushEvent(name, props) — see the event design sheet.",
      });
    return res("manual", "Not checked yet", DO.use, s?.apis.pushEvent.found ? "static" : "none");
  },

  "app-t1-device-token": ({ s, tu, d }) => {
    if (s && !s.firebase.messagingSdk)
      return res("fail", "No FCM", "Firebase Messaging isn't integrated, so no device token can be generated.", "static", {
        remediation: "Integrate FCM (firebase-messaging + google-services.json).",
      });
    if (d?.logs?.pushToken) return res("pass", "FCM token present (live)", "The SDK has an FCM token on the phone.", "device");
    if (Object.values(d?.pushTests ?? {}).some((r) => r?.status === "delivered"))
      return res("pass", "Proven by a delivered push", "A test push reached the phone, so its token is registered.", "device");
    if (tu?.android)
      return tu.android.hasPushToken
        ? res("pass", "Test phone has a push token", `${tu.android.model ?? "Android phone"} on app ${tu.android.appVersion ?? "?"} is registered for push.`, "api")
        : res("fail", "Test phone has no push token", "The test user's Android phone isn't registered for push.", "api", {
            remediation: "Check the FCM setup and, with a custom messaging service, forward tokens via pushFcmRegistrationId(token, true).",
          });
    return res("manual", "Not checked yet", DO.push, "none");
  },

  "app-t2-gdpr-location": ({ s, d }) => {
    if (d?.logs?.networkInfo)
      return res("pass", "Enabled (live)", "The SDK sends carrier/network info, so enableDeviceNetworkInfoReporting(true) is on.", "device");
    if (!s) return res("manual", "Not checked", NO_SCAN, "none");
    const u = s.apis.enableDeviceNetworkInfoReporting;
    if (u.found) return res("pass", "Enabled", "enableDeviceNetworkInfoReporting(true) is called.", "static", { details: usageEvidence(u) });
    if (u.found === null)
      return res("manual", "Confirm on the phone", `The code can't be read in this build (debug or minified). ${DO.start}`, "static", { remediation: faqFix(5) });
    return res("fail", "Not enabled", "enableDeviceNetworkInfoReporting isn't called, so city/region/country stay unknown.", "static", { remediation: faqFix(5) });
  },

  "app-t2-lat-long": ({ s, d }) => {
    if (d?.logs?.locationSent)
      return res("pass", "Lat/long sent (live)", "The SDK's request header carries Latitude and Longitude.", "device");
    if (!s) return res("manual", "Not checked", NO_SCAN, "none");
    const u = s.apis.setLocation;
    const perms = s.manifest.permissions.filter((p) => /LOCATION/.test(p)).map((p) => p.replace("android.permission.", ""));
    const geo = s.clevertap.modules.some((m) => m.id === "clevertap-geofence-sdk");
    const details = [...usageEvidence(u), perms.length ? `Permissions: ${perms.join(", ")}` : "No location permission declared"];
    if (u.found) return res("pass", "setLocation called", "Lat/long is passed to CleverTap.", "static", { details });
    if (geo) return res("pass", "Geofence SDK", "The CleverTap Geofence SDK updates the user's location.", "static", { details });
    if (u.found === null) return res("manual", "Can't verify", "Code is minified — confirm setLocation() is called.", "static", { details, remediation: faqFix(5) });
    return res("fail", "Not passed", "setLocation() isn't called, so profiles show unknown lat/long.", "static", { remediation: faqFix(5), details });
  },

  "app-t2-anon-profile": ({ d }) => {
    if (d?.logs?.appLaunchedFired && d.logs.queueSent > 0)
      return res("pass", "Device profile on app start (live)", "The SDK sent App Launched for this device before any login, so an anonymous profile exists until onUserLogin identifies it.", "device");
    return res("manual", "Not checked yet", `${DO.install} Open it without logging in.`, "none");
  },

  "app-t2-phone-push": ({ d }) => {
    const livePhone = d?.logs?.profilePushes.filter((x) => x.phoneValid !== undefined).at(-1);
    if (livePhone)
      return livePhone.phoneValid
        ? res("pass", "Phone format valid (live)", 'The phone sent at login uses "+" and a country code (E.164).', "device")
        : res("fail", "Phone format invalid (live)", "The phone sent at login is missing the + prefix or country code.", "device", {
            remediation: 'Send phone numbers in E.164 format, e.g. "+919876543210".',
          });
    return res("manual", "Not checked yet", DO.phone, "none");
  },

  "app-t3-test-push": ({ d }) => {
    if (d?.logs?.push?.errors.length)
      return res("fail", "Push not shown (live)", d.logs.push.errors[0], "device", { remediation: faqFix(2) });
    const onDevice = Object.entries(d?.pushTests ?? {}).find(([, r]) => r?.status === "delivered");
    if (onDevice)
      return res("pass", "Delivered to the test phone", `The push appeared ${Math.round((onDevice[1]!.deliveredAfterMs ?? 0) / 1000)} s after sending (app ${onDevice[0]}).`, "device");
    if (d?.logs?.push?.rendered) return res("pass", "Shown on the phone (live)", "The SDK rendered a CleverTap push on the phone.", "device");
    return res("manual", "Not sent yet", DO.push, "none");
  },

  "app-t3-killed": (c) => appStateCheck(c, "killed", "Swipe the app away from recents, then send a test push."),
  "app-t3-background": (c) => appStateCheck(c, "background", "Press Home so the app is in the background, then send a test push."),
  "app-t3-foreground": (c) => appStateCheck(c, "foreground", "Keep the app open on screen, then send a test push."),

  "app-t3-impressions": ({ d }) => {
    const p = d?.logs?.push;
    if (p?.impressions) return res("pass", "Impression recorded (live)", "After the push the SDK sent a “Notification Viewed” event.", "device");
    if (p && p.rendered > 0)
      return res("fail", "Shown but no impression", "A push was shown on the phone but no “Notification Viewed” was sent.", "device", { remediation: faqFix(4) });
    return res("manual", "Not checked yet", DO.push, "none");
  },

  "app-t3-deeplink-internal": ({ s, d: dev }) => {
    const tap = dev?.logScenarios?.linkTap;
    const a12 = android12ClickHook(s);
    if (tap && !/^https?:/i.test(tap.url) && tap.clicked && tap.landed) {
      if (tap.openedOutsideApp)
        return res("fail", "Opened outside the app", `Tapped a push with ${tap.url}; it opened ${tap.landed}.`, "device", { remediation: faqFix(9) });
      if (a12) return res("warn", `Opened ${short(tap.landed)} — click hook missing`, a12.evidence, "device", { remediation: a12.fix });
      return res("pass", `Opened ${short(tap.landed)}`, `Tapped a push with ${tap.url}; it opened inside the app. Check it's the intended screen.`, "device");
    }
    const tested = (dev?.deepLinks ?? []).filter((x) => !/^https?:/i.test(x.url));
    if (tested.length) {
      const bad = tested.filter((x) => !x.ok);
      const details = tested.map((x) => `${x.url} → ${x.ok ? x.activity : `failed: ${x.detail ?? "didn't open the app"}`}`);
      if (bad.length === 0)
        return res("pass", `${tested.length} deep link${tested.length > 1 ? "s" : ""} open the app`, "Opened on the test device. Check each lands on the intended screen.", "device", { details });
      return res("fail", `${bad.length} deep link${bad.length > 1 ? "s" : ""} failed`, "Some deep links don't open the app on the device.", "device", { remediation: faqFix(9), details });
    }
    if (!s) return res("manual", "Not checked", NO_SCAN, "none");
    const own = appDeepLinks(s).filter((d) => !/^https?$/.test(d.scheme));
    const details = own.slice(0, 6).map((d) => `${d.scheme}://${d.host ?? ""}${d.path ?? ""} → ${short(d.activity)}`);
    if (own.length && a12) return res("warn", "Android 12+ click hook missing", a12.evidence, "static", { remediation: a12.fix, details });
    if (own.length)
      return res("manual", `${own.length} deep-link scheme${own.length > 1 ? "s" : ""}`, "Send a push with one of these deep links and confirm it opens the right screen.", "static", { details });
    return res("warn", "No custom scheme", "No activity declares a custom-scheme deep link (VIEW + BROWSABLE). In-app routing won't work from push.", "static", {
      remediation: faqFix(9),
      details,
    });
  },

  "app-t3-deeplink-external": ({ s, d }) => {
    const t = d?.logScenarios?.linkTap;
    if (t && /^https?:/i.test(t.url)) {
      if (t.clicked && t.landed)
        return res("pass", `Opened ${short(t.landed.split("/")[0])}`, `Tapped a push with ${t.url}; it opened ${t.landed}${t.openedOutsideApp ? " (outside the app, as expected for an external URL)" : ""}.`, "device", {
          details: t.openedOutsideApp
            ? ["Android 12+: CleverTap can't record Notification Clicked when the link opens another app (browser) — that's an OS limit, not a bug."]
            : [],
        });
      if (t.clicked) return res("warn", "Clicked — landing unknown", "The click was recorded but we couldn't read which screen opened.", "device");
    }
    if (!s) return res("manual", "Not checked", NO_SCAN, "none");
    const web = appDeepLinks(s).filter((d) => /^https?$/.test(d.scheme));
    const details = web.slice(0, 6).map((d) => `${d.scheme}://${d.host ?? "*"}${d.path ?? ""}${d.autoVerify ? " (App Link, verified)" : ""} → ${short(d.activity)}`);
    return res("manual", web.length ? `${web.length} web link${web.length > 1 ? "s" : ""} handled in-app` : "Opens in browser",
      web.length
        ? "These https links open the app. Send a push with one and check where it lands."
        : "No https App Links are declared, so external URLs open in the browser — that's expected. Confirm the redirect on a device.",
      "static", { details, remediation: web.length ? undefined : faqFix(9) });
  },

  "app-t3-test-inapp": ({ s, d }) => {
    const li = d?.logs?.inApp;
    if (li?.errors.length)
      return res("fail", "In-app failed on the phone", li.errors[0], "device", {
        remediation: "On Flutter/React Native make MainActivity extend FlutterFragmentActivity / ReactActivity (FragmentActivity), and check the in-app media URL.",
      });
    if (li && li.shown > 0) return res("pass", "In-app shown on the phone", "The SDK displayed an in-app during the session.", "device");
    const host = s?.app.launcherHost;
    const fragmentless = s?.manifest.metaData.CLEVERTAP_INAPP_FRAGMENTLESS_BANNERS;
    if (host?.fragment === false && !fragmentless)
      return res("warn", `${short(s!.app.launcherActivity ?? "Main activity")} isn't a FragmentActivity`, `It extends ${short(host.chain[0])}. CleverTap renders header/footer in-apps and the App Inbox as fragments, so those won't show (full-screen in-apps still can).`, "static", {
        remediation:
          s!.framework.primary === "flutter"
            ? "Make MainActivity extend FlutterFragmentActivity."
            : s!.framework.primary === "unity"
              ? 'Game-engine host: add <meta-data android:name="CLEVERTAP_INAPP_FRAGMENTLESS_BANNERS" android:value="1"/>.'
              : "Make your activities extend FragmentActivity / AppCompatActivity.",
      });
    return res("manual", "Not checked yet", "On the CleverTap dashboard create a test in-app for your test user (trigger: App Launched), then Live device testing → step 4 “See an in-app”.", "none");
  },

  "app-t3-inapp-exclude": ({ s, d }) => {
    if (d?.logs?.inApp?.blockedOnExcludedScreen)
      return res("pass", "Excluded screen respected (live)", "The SDK skipped an in-app on an excluded activity.", "device");
    if (!s) return res("manual", "Not checked", NO_SCAN, "none");
    const ex = s.manifest.metaData.CLEVERTAP_INAPP_EXCLUDE;
    const acts = s.manifest.activities;
    if (ex) {
      const names = ex.split(",").map((x) => x.trim()).filter(Boolean);
      const unknown = names.filter((n) => !acts.some((a) => a === n || a.endsWith("." + n) || a.endsWith(n)));
      return res(unknown.length ? "warn" : "pass", `Excluded: ${names.join(", ")}`, unknown.length
        ? `${unknown.join(", ")} doesn't match any activity in the manifest.`
        : "In-apps won't show on these activities.", "static", {
          remediation: unknown.length ? "Use the activity's simple class name exactly as declared." : undefined,
        });
    }
    const splash = acts.find((a) => /splash|launch(er)?activity|loading|intro/i.test(a.split(".").pop() ?? ""));
    if (splash)
      return res("warn", `${short(splash)} not excluded`, "A splash/loading activity exists but CLEVERTAP_INAPP_EXCLUDE isn't set — in-apps can flash on the splash screen.", "static", {
        remediation: `Add <meta-data android:name="CLEVERTAP_INAPP_EXCLUDE" android:value="${short(splash)}"/> inside <application>.`,
      });
    if (s.framework.primary !== "native")
      return res("na", "Single-activity app", "The splash is drawn inside the main activity. If needed, suspend in-apps during the splash (suspendInAppNotifications).", "static");
    return res("pass", "No splash activity", "No dedicated splash activity found, so nothing needs excluding.", "static");
  },

  "app-t3-post-notifications": ({ s, d }) => {
    if (d?.notificationPermission === "granted")
      return res("pass", "Granted on the test device", "The app has notification permission on the connected phone.", "device");
    if (d?.notificationPermission === "denied")
      return res("warn", "Not granted on the test device", "Notification permission is off on the connected phone, so pushes won't show there.", "device", {
        remediation: "Make sure the app asks for POST_NOTIFICATIONS at runtime (CleverTap push primer), then allow it.",
      });
    if (!s) return res("manual", "Not checked", NO_SCAN, "none");
    const target = s.app.targetSdk ?? 0;
    if (target && target < 33) return res("pass", `targetSdk ${target}`, "Runtime notification permission isn't required below API 33.", "static");
    const declared = s.manifest.permissions.includes("android.permission.POST_NOTIFICATIONS");
    if (!declared)
      return res("fail", "Permission missing", `targetSdk ${target} but POST_NOTIFICATIONS isn't declared — Android 13+ blocks every notification.`, "static", {
        remediation: "Declare android.permission.POST_NOTIFICATIONS and request it at runtime (CleverTap push primer).",
      });
    const u = s.apis.promptPushPermission;
    if (u.found) return res("pass", "Declared & requested", "The app asks for notification permission at runtime.", "static", { details: usageEvidence(u) });
    if (u.found === null)
      return res("manual", "Declared — request can't be read", d?.notificationPermission === "not-required"
        ? "The permission is declared, but the code that asks for it can't be read in this build, and the test phone runs Android 12 (no permission prompt there). Scan the release APK, or test on an Android 13+ phone."
        : "The permission is declared; the code that asks for it can't be read in this build. Scan the release APK, or connect an Android 13+ phone — we read whether it's granted.", "static");
    return res("warn", "Declared — runtime request not seen", "The permission is declared, but no CleverTap push-primer call was found. Make sure the app asks for it at runtime (your own prompt is fine).", "static", {
      remediation: "Use promptForPushPermission(true) / promptPushPrimer(…), or request POST_NOTIFICATIONS yourself.",
    });
  },

  "app-t3-uninstall": ({ s }) => {
    if (s && !s.firebase.messagingSdk)
      return res("fail", "Needs FCM", "Uninstall tracking works through FCM, and FCM isn't integrated.", "static");
    if (s && s.firebase.analyticsSdk === false)
      return res("warn", "Real-time tracking not possible", "CleverTap recommends Real-Time Uninstall Tracking (Firebase Analytics). Firebase Analytics isn't in this build.", "static", {
        remediation: "Add Firebase Analytics and set up the app_remove Cloud Function (CleverTap docs: Uninstall Tracking using Firebase), then switch it on in Settings → Uninstall Tracking.",
      });
    return res("manual", "Dashboard setting", "Check Settings → Uninstall Tracking is switched on, then tick it.", s ? "static" : "none");
  },

  "app-t3-session-analytics": () =>
    res("manual", "Dashboard setting", "Session analytics isn't exposed by the API. Check it's switched on in the dashboard.", "none"),

  "app-t4-formats": ({ d }) => {
    const live = (d?.logs?.events ?? []).flatMap((e) => e.issues.filter((i) => /text/.test(i)).map((i) => `'${e.name}' → ${i}`));
    if (live.length)
      return res("fail", `${live.length} format issue${live.length > 1 ? "s" : ""} (live)`, "Some properties use the wrong data type.", "device", {
        remediation: faqFix(10),
        details: live.slice(0, 12),
      });
    if (d?.logs?.events.some((e) => Object.keys(e.props).length))
      return res("pass", "Types look right (live)", "No numbers-as-text or text dates in the events sent while you used the app.", "device");
    return res("manual", "Not checked yet", DO.use, "none");
  },

  "app-t4-valid-values": ({ d }) => {
    const L = d?.logs;
    const live = [
      ...(L?.events ?? []).flatMap((e) => e.issues.filter((i) => /null|empty/.test(i)).map((i) => `'${e.name}' → ${i}`)),
      ...(L?.profilePushes ?? []).flatMap((p) => p.nullish.map((k) => `Profile ${k} is null/empty`)),
    ];
    if (live.length)
      return res("fail", `${live.length} invalid value${live.length > 1 ? "s" : ""} (live)`, 'Properties are sent as null / "null" / empty strings.', "device", {
        remediation: "Skip the property when there's no value — don't send \"null\", \"\" or \"undefined\".",
        details: live.slice(0, 12),
      });
    if (L && (L.events.length || L.profilePushes.length))
      return res("pass", "No null/empty values (live)", "Events and profile updates sent while you used the app carry only real values.", "device");
    return res("manual", "Not checked yet", `${DO.login} Then use the app.`, "none");
  },

  "app-t4-critical-events": ({ criticalEvents, d }) => {
    const ce = (criticalEvents ?? []).filter(Boolean);
    if (ce.length === 0)
      return res("manual", "No events listed", "Add the 3–4 custom events to verify on this report, then trigger them on the phone (step 4).", "none");
    const liveEv = d?.logs?.events ?? [];
    const seenEv = liveEv.filter((e) => ce.includes(e.name));
    const missing = ce.filter((n) => !liveEv.some((e) => e.name === n));
    const details = seenEv.map((e) => `${e.name}: ${Object.entries(e.props).map(([k, t]) => `${k}:${t.join("/")}`).join(", ") || "no properties"}${e.issues.length ? ` ⚠ ${e.issues.join("; ")}` : ""}`);
    const bad = seenEv.filter((e) => e.issues.length);
    if (bad.length)
      return res("fail", `${bad.length} event${bad.length > 1 ? "s" : ""} with property issues`, "Seen live; fix the flagged properties.", "device", { remediation: faqFix(10), details });
    if (missing.length === 0)
      return res("pass", `All ${ce.length} custom events verified live`, "Every listed event fired with correctly typed properties.", "device", { details });
    return res("manual", `${seenEv.length} of ${ce.length} seen`, `Not seen yet: ${list(missing)}. ${DO.use} Do the actions that raise them.`, seenEv.length ? "device" : "none", { details });
  },

};

/* ------------------------------------------------------------------ */

export function evaluateAndroid(input: EngineInput): Record<string, ItemResult> {
  const ctx: Ctx = {
    ...input,
    s: input.scan ?? undefined,
    a: input.api?.ok ? input.api : undefined,
    d: input.device ?? undefined,
    tu: input.api?.testUser?.found ? input.api.testUser : undefined,
    ev: (n) => (input.api?.ok ? input.api.events[n] : undefined),
    fresh: (n) => {
      const t = input.api?.testUser?.found ? input.api.testUser.events[n]?.lastSeen : undefined;
      return !!t && t >= (input.since ?? 0);
    },
  };
  const apiFailed = input.api && !input.api.ok && input.api.error !== "Not verified yet" ? input.api.error : undefined;
  const out: Record<string, ItemResult> = {};
  for (const item of itemsForPlatform("android")) {
    const rule = RULES[item.id];
    const r = rule ? rule(ctx) : res("manual", "Not automated yet", "Verify manually.", "none");
    if (apiFailed && r.evidence === NO_API) {
      r.detected = "API check failed";
      r.evidence = `The CleverTap API call failed: ${apiFailed}. Check the passcode in Live device testing → step 1.`;
    }
    out[item.id] = { itemId: item.id, ...r };
  }
  return out;
}

/* helpers ---------------------------------------------------------- */

function appStateCheck({ d, api }: Ctx, state: AppState, how: string) {
  const dt = d?.pushTests[state];
  if (dt?.status === "delivered" && dt.verifiedState)
    return res("pass", `Delivered in ${Math.round((dt.deliveredAfterMs ?? 0) / 1000)} s`, `We put the app in the ${state} state on the phone (${dt.stateDetail}), sent a push and it appeared.`, "device");
  if (dt?.status === "not-delivered" && dt.verifiedState) {
    // the phone itself blocks background work → not proof of a broken integration
    if (d?.notificationPermission === "denied")
      return res("warn", `Not delivered (${state}) — notifications off on the phone`, "Notification permission is off for the app on the test phone (Android 13+), so nothing can be shown.", "device", {
        remediation: "Allow notifications for the app (App info → Notifications), then test again.",
      });
    const phone = dt.background && (dt.background.restrictedBucket || dt.background.backgroundRestricted || dt.background.autoStart === "denied");
    if (phone)
      return res("warn", `Not delivered (${state}) — phone restricts the app`, `The app was ${state} and no notification appeared, but this phone restricts the app in the background, which blocks pushes regardless of the integration.`, "device", {
        remediation: `${dt.background!.hints.join(" ")} Then test again.`,
        details: dt.background!.hints,
      });
    return res("fail", `Not delivered (${state})`, `The app was ${state} (${dt.stateDetail}) and no notification appeared within 60 s.`, "device", {
      remediation:
        state === "killed"
          ? `Pushes in killed state need CleverTap's FCM service (or your FirebaseMessagingService hand-off). ${dt.background?.hints.join(" ") ?? "Also check the phone's battery / autostart settings for the app."}`
          : faqFix(2),
      details: dt.background?.hints,
    });
  }
  const at = api?.pushTests?.[state];
  if (at?.status === "confirmed")
    return res("pass", "Delivered & viewed", `You set the app to ${state} and the test user's Notification Viewed arrived after the push.`, "api");
  if (dt?.status === "delivered")
    return res("manual", "Delivered — state not confirmed", `A push arrived, but the app state couldn't be confirmed as ${state} (${dt.stateDetail}).`, "device");
  if (at?.status === "not-confirmed" || at?.status === "sent")
    return res("manual", "Sent — not confirmed yet", "No Notification Viewed yet. Check the phone, then press “Check delivery” or tick it.", "api");
  return res("manual", "Confirm on a device", `${how} Use the live-device panel to run this automatically.`, "none");
}

// Android 12+: when the target activity is already open, the app must forward
// the tap with pushNotificationClickedEvent() from onNewIntent(), or the
// Notification Clicked event and the push-click callback are lost.
function android12ClickHook(s?: AndroidScanReport) {
  if (!s || (s.app.targetSdk ?? 0) < 31) return undefined;
  const u = s.apis.pushClickedEvent;
  if (!u || u.found !== false) return undefined; // found, or can't tell (minified / old scan)
  if (!appDeepLinks(s).some((d) => !/^https?$/.test(d.scheme))) return undefined;
  return {
    evidence: `targetSdk ${s.app.targetSdk}: on Android 12+ a push tapped while the app is open reaches onNewIntent(), and the app never calls pushNotificationClickedEvent() — Notification Clicked isn't recorded and push-click callbacks (deep-link routing) don't fire.`,
    fix: "In the launcher activity add: override fun onNewIntent(intent: Intent) { super.onNewIntent(intent); if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) CleverTapAPI.getDefaultInstance(applicationContext)?.pushNotificationClickedEvent(intent.extras) } — see developer.clevertap.com/docs/android-12-updates.",
  };
}

// System / notification events CleverTap raises itself — everything else on the profile is custom.
const SYSTEM_EVENT = /^(App Launched|App Installed|App Uninstalled|App Version Changed|Notification (Viewed|Clicked|Sent|Delivered)|Push Impressions|UTM Visited|Charged|Stayed|Reachable By|Session Concluded|Identity Set|Geocluster (Entered|Exited))$|^Notification |^App Inbox |^In-App /i;

export function customEventNames(tu?: TestUserRecord): string[] {
  return Object.keys(tu?.events ?? {}).filter((n) => !SYSTEM_EVENT.test(n));
}


const THIRD_PARTY_ACTIVITY = /^(com\.google\.|com\.facebook\.|com\.clevertap\.|io\.flutter\.|androidx\.|com\.android\.)/;
function appDeepLinks(s: AndroidScanReport) {
  return s.manifest.deepLinks.filter((d) => !THIRD_PARTY_ACTIVITY.test(d.activity));
}
const short = (cls: string) => cls.split(".").pop() ?? cls;

function latestFor(fw: string, l?: LatestVersions | null) {
  if (!l) return undefined;
  return fw === "flutter" ? l.flutter : fw === "react-native" ? l.reactNative : fw === "cordova" ? l.cordova : undefined;
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = b.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

