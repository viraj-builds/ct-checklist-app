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
}

type Rule = (ctx: Ctx) => Omit<ItemResult, "itemId">;

interface Ctx extends EngineInput {
  s?: AndroidScanReport;
  a?: ApiFindings; // only when the API call succeeded
  d?: DeviceFindings; // live-device checks (USB / Wi-Fi)
  tu?: TestUserRecord; // the test user's profile, when found
  ev: (name: string) => EventSample | undefined;
}

const NO_API = "Needs the CleverTap API (Account ID + Passcode) to verify automatically — or confirm on the dashboard.";
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

const pct = (n: number, d: number) => (d === 0 ? 0 : Math.round((n / d) * 100));
const list = (a: string[], n = 5) => a.slice(0, n).map((x) => `'${x}'`).join(", ") + (a.length > n ? ` +${a.length - n} more` : "");
const faqFix = (n: number) => {
  const f = getFaq(n);
  return f ? `FAQ #${f.n}: ${f.solutions[0]}` : undefined;
};
const seen = (e?: EventSample) => !!e && !e.error && e.androidSampled > 0;
const countLabel = (e: EventSample) =>
  `${e.capped ? "≥" : ""}${e.androidSampled} sampled in the last ${e.windowDays} days`;

// Event names we know come from THIS build (seen live, on the test user, listed
// as critical, or found in code). Account-wide samples can include events from
// other apps/websites sharing the project — those mustn't fail this app.
function appEventNames({ s, d, tu, criticalEvents }: Ctx): Set<string> {
  return new Set([
    ...(d?.logs?.events ?? []).map((e) => e.name),
    ...customEventNames(tu),
    ...(criticalEvents ?? []),
    ...(s?.eventNames ?? []),
  ]);
}

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
  "app-t1-credentials": ({ s, a, api, accountId, region, d }) => {
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
    if (api && !api.ok && api.errorKind === "auth") details.push("Note: the API passcode was rejected — API checks were skipped.");
    return res("pass", `Account ${acc}${reg ? ` · ${reg}` : ""}`, "Credentials found in the app and they match this audit.", "static", { details });
  },

  "app-t1-lifecycle": ({ s, a, ev, d }) => {
    if (d?.logs?.lifecycleRegistered)
      return res("pass", "Registered (live)", "The SDK logged “Activity Lifecycle Callback successfully registered” on app start.", "device");
    if (!s) return res("manual", "Not checked", NO_SCAN, "none");
    const u = s.apis.lifecycleRegister;
    const launched = ev("App Launched");
    if (u.found) return res("pass", "Registered", "Lifecycle callbacks are registered.", "static", { details: usageEvidence(u) });
    if (s.manifest.metaData.CLEVERTAP_DISABLE_APP_LAUNCHED === "1")
      return res("fail", "App Launched disabled", "CLEVERTAP_DISABLE_APP_LAUNCHED=1 is set in the manifest.", "static", {
        remediation: "Remove CLEVERTAP_DISABLE_APP_LAUNCHED unless this is intentional.",
      });
    if (a && seen(launched))
      return res("pass", "App Launched is arriving", "Not found statically, but App Launched events are reaching CleverTap, so lifecycle tracking works.", "static+api", {
        details: u.found === null ? ["Code is obfuscated — the static check was inconclusive."] : [],
      });
    const fix = `Call ActivityLifecycleCallback.register(this) before super.onCreate() in your Application class${
      s.clevertap.wrapper ? `, or set android:name to ${s.clevertap.wrapper.framework === "flutter" ? "com.clevertap.clevertap_plugin.CleverTapApplication" : "com.clevertap.android.sdk.Application"}` : ""
    }.`;
    if (u.found === null)
      return res("manual", "Can't verify statically", "The app is minified, so the call can't be matched by name. The live log session (step 4) or App Launched data confirms it automatically.", "static", { remediation: fix });
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

  "app-t1-installed": ({ s, a, ev }) => {
    const details = s?.firebase.installReferrer ? ["Install Referrer library present — install attribution (UTM) is captured."] : [];
    if (!a) return res("manual", "Not checked", NO_API, "none", { details });
    const e = ev("App Installed");
    if (seen(e)) return res("pass", countLabel(e!), "App Installed events are reaching CleverTap.", "api", { details });
    if (e?.error) return res("manual", "API error", e.error, "api", { details });
    if (seen(ev("App Launched")))
      return res("manual", "None in 30 days", "No App Installed events in the last 30 days although the app is launched. That's expected if there were no new installs.", "api", {
        remediation: "Install the app fresh on a test device and check the profile's activity for App Installed.",
        details,
      });
    return res("fail", "No events", "Neither App Installed nor App Launched events were found.", "api", { remediation: faqFix(1), details });
  },

  "app-t1-launched": ({ s, a, ev, tu, d }) => {
    if (!a && d?.logs?.appLaunchedFired && d.logs.queueSent > 0)
      return res("pass", "Fired and sent (live)", "The SDK fired App Launched and the queue was sent to CleverTap.", "device");
    if (!a && tu?.lastLaunchedAt)
      return res("pass", `Test user launched ${ago(tu.lastLaunchedAt)}`, "App Launched is reaching CleverTap from the test device.", "api");
    if (s?.manifest.metaData.CLEVERTAP_DISABLE_APP_LAUNCHED === "1")
      return res("fail", "Disabled in manifest", "CLEVERTAP_DISABLE_APP_LAUNCHED=1 stops the SDK from raising App Launched.", "static", {
        remediation: "Remove the CLEVERTAP_DISABLE_APP_LAUNCHED meta-data.",
      });
    if (!a) return res("manual", "Not checked", NO_API, "none");
    const e = ev("App Launched");
    if (seen(e)) return res("pass", countLabel(e!), "App Launched events are reaching CleverTap.", "api", {
      details: e!.lastSeen ? [`Most recent sampled: ${fmtTs(e!.lastSeen)}`] : [],
    });
    if (e && e.sampled > 0) return res("warn", "Only other platforms", `${e.sampled} App Launched events, none from Android.`, "api");
    return res("fail", "No App Launched in 7 days", "No App Launched events from Android in the last 7 days.", "api", { remediation: faqFix(1) });
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

  "app-t1-identity": ({ s, a, tu, d }) => {
    const pp = d?.logs?.profilePushes.filter((x) => x.hasIdentity).at(-1);
    if (!a?.profiles?.sampled && !tu && pp)
      return res("pass", `Sent: ${pp.keys.filter((k) => ["Identity", "Email", "Phone"].includes(k)).join(", ")}`, "Seen live in the profile the SDK queued after login.", "device", {
        details: [`Profile keys: ${pp.keys.join(", ")}`],
      });
    const p = a?.profiles;
    const login = s?.apis.onUserLogin;
    const details = login?.found ? [`onUserLogin: ${login.evidence[0] ?? "found"}`] : [];
    if ((!a || !p || p.sampled === 0) && tu)
      return res(tu.hasEmail || tu.hasPhone ? "pass" : "warn", `Test user: identity ✓ · email ${tu.hasEmail ? "✓" : "✗"} · phone ${tu.hasPhone ? "✓" : "✗"}`,
        tu.hasEmail || tu.hasPhone ? "The test user's profile is identified with contact details." : "The test user has an identity but no email or phone.", "api", {
          details,
          remediation: tu.hasEmail || tu.hasPhone ? undefined : "Include Email and Phone in the onUserLogin map.",
        });
    if (!a || !p) return res("manual", "Not checked", NO_API, "none", { details });
    if (p.sampled === 0) return res("manual", "No profiles sampled", "No profiles launched the app in the last 7 days.", "api", { details });
    const idd = p.sampled - p.anonymous;
    const label = `Identity ${pct(p.withIdentity, p.sampled)}% · Email ${pct(p.withEmail, p.sampled)}% · Phone ${pct(p.withPhone, p.sampled)}% of ${p.sampled} sampled`;
    if (idd === 0 && p.sampled >= 10)
      return res("fail", label, "Every sampled profile is anonymous — users are never identified.", "api", { remediation: faqFix(3), details });
    if (p.withIdentity === 0)
      return res("warn", label, "Profiles carry email/phone but no Identity.", "api", {
        remediation: "Pass a stable user ID as Identity in onUserLogin.",
        details,
      });
    if (p.withEmail === 0 && p.withPhone === 0)
      return res("warn", label, "Identity is passed but no email or phone, so email/SMS/WhatsApp can't reach users.", "api", {
        remediation: "Include Email and Phone in the onUserLogin / profile push map.",
        details,
      });
    return res("pass", label, "Users are identified with identity and contact details.", "api", { details });
  },

  "app-t1-onuserlogin": ({ s, a, d }) => {
    const calls = d?.logs?.onUserLogin ?? [];
    if (calls.some((c) => c.kind === "same-user" || c.kind === "switch-user" || c.kind === "anonymous"))
      return res("pass", "onUserLogin called (live)", `Seen in the SDK logs: ${[...new Set(calls.map((c) => c.kind))].join(", ")}.`, "device");
    if (calls.length && calls.every((c) => c.kind === "aborted" || c.kind === "failed"))
      return res("fail", "onUserLogin failed (live)", "The SDK aborted onUserLogin — usually a non-text value for Identity/Email.", "device", {
        remediation: "Pass Identity / Email / Phone as plain strings in the onUserLogin map.",
      });
    const u = s?.apis.onUserLogin;
    const profile = s?.apis.pushProfile;
    const p = a?.profiles;
    const identified = p ? p.sampled - p.anonymous : 0;
    if (u?.found) {
      return res("pass", "onUserLogin called", u.confidence === "high" ? "Call site found in the app." : "Found in the app's code layer.", p && identified > 0 ? "static+api" : "static", {
        details: usageEvidence(u),
      });
    }
    if (u?.found === false) {
      if (profile?.found)
        return res("fail", "Only profile push", "Profiles are updated with pushProfile/profileSet but onUserLogin is never called — multiple users on one device get merged.", "static", {
          remediation: faqFix(3),
          details: usageEvidence(profile),
        });
      return res("fail", "Not found", "onUserLogin isn't called anywhere in the app.", "static", { remediation: faqFix(3) });
    }
    if (p && identified > 0)
      return res("pass", "Profiles are identified", `${identified} of ${p.sampled} sampled profiles are identified, so login identification works.`, "api", {
        details: u?.found === null ? ["Static check inconclusive (minified / bytecode)."] : [],
      });
    return res("manual", "Can't verify", s ? "The code layer can't be read and there's no API data." : NO_SCAN, "none");
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

  "app-t1-custom-events": (ctx) => {
    const { s, a, tu, d } = ctx;
    const liveEvents = d?.logs?.events ?? [];
    if (liveEvents.length && !(a && a.customEvents.some((n) => seen(a.events[n]))))
      return res("pass", `${liveEvents.length} custom event${liveEvents.length > 1 ? "s" : ""} seen live`, `Queued by the SDK while you used the app: ${list(liveEvents.map((e) => e.name), 8)}.`, "device", {
        details: liveEvents.slice(0, 20).map((e) => `${e.name} ×${e.count}: ${Object.entries(e.props).map(([k, t]) => `${k}:${t.join("/")}`).join(", ") || "no properties"}`),
      });
    const userEvents = customEventNames(tu);
    if (userEvents.length && !(a && a.customEvents.some((n) => seen(a.events[n]))))
      return res("pass", `${userEvents.length} custom event${userEvents.length > 1 ? "s" : ""} from the test device`, `The test user's profile has: ${list(userEvents, 8)}.`, "api", {
        details: userEvents.slice(0, 20).map((n) => `${n}: ${tu!.events[n].count ?? "?"}×${tu!.events[n].lastSeen ? `, last ${new Date(tu!.events[n].lastSeen!).toLocaleString()}` : ""}`),
      });
    const staticNames = s?.eventNames ?? [];
    const details = staticNames.length ? [`Events in code: ${list(staticNames, 10)}`] : [];
    if (s?.apis.pushEvent.found) details.push(...usageEvidence(s.apis.pushEvent).slice(0, 3));
    if (a && a.customEvents.length) {
      const hits = a.customEvents.filter((n) => seen(a.events[n]));
      const allMisses = a.customEvents.filter((n) => !seen(a.events[n]));
      if (allMisses.length) details.push(`No data (30 days): ${list(allMisses, 10)}`);
      // events the account knows but this build never raises aren't this app's problem
      const mine = appEventNames(ctx);
      const misses = mine.size ? allMisses.filter((n) => mine.has(n)) : allMisses;
      if (hits.length && misses.length === 0 && allMisses.length)
        return res("pass", `${hits.length} custom event${hits.length > 1 ? "s" : ""} flowing`, `Verified: ${list(hits, 8)}. Events without data (${list(allMisses, 3)}) aren't raised by this build.`, "static+api", { details });
      if (hits.length === a.customEvents.length)
        return res("pass", `${hits.length} custom event${hits.length > 1 ? "s" : ""} flowing`, `Verified: ${list(hits, 8)}.`, "static+api", { details });
      if (hits.length)
        return res("warn", `${hits.length}/${a.customEvents.length} events flowing`, `Arriving: ${list(hits)}. Missing: ${list(misses)}.`, "static+api", {
          remediation: "Check the missing events are raised with exactly the same name (names are case-sensitive).",
          details,
        });
      return res("fail", "No custom events arriving", `None of ${list(a.customEvents)} were recorded in the last 30 days.`, "static+api", {
        remediation: faqFix(1),
        details,
      });
    }
    if (s?.apis.pushEvent.found)
      return res(a ? "warn" : "manual", "Events tracked in code", a
        ? "Custom events are raised in code, but no event names were available to verify via API. Add your critical events to the audit."
        : NO_API, "static", { details });
    if (s?.apis.pushEvent.found === false)
      return res("fail", "No custom events", "pushEvent / recordEvent isn't called anywhere.", "static", {
        remediation: "Track your key user actions with pushEvent(name, props) — see the event design sheet.",
      });
    return res("manual", "Not checked", s ? NO_API : NO_SCAN, "none", { details });
  },

  "app-t1-device-token": ({ s, a, tu, d }) => {
    if (!tu?.android && d?.logs?.pushToken)
      return res("pass", "FCM token present (live)", "The SDK logged a cached FCM token on the device.", "device");
    const p = a?.profiles;
    const details: string[] = [];
    if (s) details.push(`Firebase Messaging: ${s.firebase.messagingSdk ? "yes" : "no"} · google-services: ${s.firebase.googleServicesConfigured ? "yes" : "no"}`);
    if (s && !s.firebase.messagingSdk)
      return res("fail", "No FCM", "Firebase Messaging isn't integrated, so no device token can be generated.", "static", {
        remediation: "Integrate FCM (firebase-messaging + google-services.json).",
        details,
      });
    if (p?.pushTokenSampled) {
      const n = p.withPushToken ?? 0;
      const label = `${pct(n, p.pushTokenSampled)}% of ${p.pushTokenSampled} sampled profiles have a push token`;
      if (n > 0) return res("pass", label, "FCM tokens are reaching CleverTap.", "static+api", { details });
      return res("fail", label, "No sampled Android profile has an FCM token.", "static+api", {
        remediation: "Check the FCM setup and, with a custom messaging service, forward tokens via pushFcmRegistrationId(token, true).",
        details,
      });
    }
    if (tu?.android)
      return tu.android.hasPushToken
        ? res("pass", "Test device has a push token", `${tu.android.model ?? "Android device"} on app ${tu.android.appVersion ?? "?"} is registered for push.`, "api", { details })
        : res("fail", "Test device has no push token", "The test user's Android device isn't registered for push.", "api", {
            remediation: "Check the FCM setup and, with a custom messaging service, forward tokens via pushFcmRegistrationId(token, true).",
            details,
          });
    return res("manual", s?.firebase.googleServicesConfigured ? "FCM configured" : "Not checked", NO_API, s ? "static" : "none", { details });
  },

  "app-t2-gdpr-location": ({ s }) => {
    if (!s) return res("manual", "Not checked", NO_SCAN, "none");
    const u = s.apis.enableDeviceNetworkInfoReporting;
    if (u.found) return res("pass", "Enabled", "enableDeviceNetworkInfoReporting(true) is called.", "static", { details: usageEvidence(u) });
    if (u.found === null) return res("manual", "Can't verify", "Code is minified — confirm enableDeviceNetworkInfoReporting(true) is called.", "static", { remediation: faqFix(5) });
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

  "app-t2-anon-profile": ({ a }) => {
    const p = a?.profiles;
    if (!a || !p) return res("manual", "Not checked", NO_API, "none");
    if (p.sampled === 0) return res("manual", "No profiles sampled", "No profiles launched the app in the last 7 days.", "api");
    if (p.anonymous > 0)
      return res("pass", `${p.anonymous} of ${p.sampled} sampled are anonymous`, "Anonymous profiles exist before login, as expected.", "api");
    return res("warn", "No anonymous profiles", "Every sampled profile is identified. Fine if users must log in first; otherwise check the SDK initialises before login.", "api");
  },

  "app-t2-phone-push": ({ a, tu, d }) => {
    const p = a?.profiles;
    const livePhone = d?.logs?.profilePushes.filter((x) => x.phoneValid !== undefined).at(-1);
    if (livePhone && (!p || p.withPhone === 0) && !tu?.hasPhone)
      return livePhone.phoneValid
        ? res("pass", "Phone format valid (live)", 'The phone sent at login uses "+" and a country code.', "device")
        : res("fail", "Phone format invalid (live)", "The phone sent at login is missing the + prefix or country code.", "device", {
            remediation: 'Send phone numbers in E.164 format, e.g. "+919876543210".',
          });
    if ((!p || p.withPhone === 0) && tu?.hasPhone)
      return tu.phoneValid
        ? res("pass", "Test user's phone is valid", 'Uses "+" and a country code (E.164).', "api")
        : res("fail", "Test user's phone is invalid", "The number is missing the + prefix or country code.", "api", {
            remediation: 'Send phone numbers in E.164 format, e.g. "+919876543210".',
          });
    if (!a || !p) return res("manual", "Not checked", NO_API, "none");
    if (p.withPhone === 0) return res("manual", "No phone numbers", `None of ${p.sampled} sampled profiles carry a phone number.`, "api");
    if (livePhone?.phoneValid && p.phoneValid < p.withPhone)
      return res("warn", "App sends valid numbers — old profiles don't", `The build sends E.164 numbers (seen live), but ${p.withPhone - p.phoneValid} of ${p.withPhone} sampled profiles in the account still hold old, invalid numbers.`, "device", {
        remediation: "No code change needed. Fix or delete those old profiles (Upload API with the +country-code number), then re-run the API checks.",
        details: p.phoneInvalidExamples.map((x) => `Example: ${x}`),
      });
    const label = `${pct(p.phoneValid, p.withPhone)}% of ${p.withPhone} phone numbers are valid`;
    if (p.phoneValid === p.withPhone) return res("pass", label, 'All sampled numbers use "+" and a country code (E.164).', "api");
    return res(p.phoneValid > 0 ? "warn" : "fail", label, "Some numbers are missing the + prefix or country code.", "api", {
      remediation: 'Send phone numbers in E.164 format, e.g. "+919876543210".',
      details: p.phoneInvalidExamples.map((x) => `Example: ${x}`),
    });
  },

  "app-t3-test-push": ({ a, api, d }) => {
    if (d?.logs?.push?.errors.length)
      return res("fail", "Push not shown (live)", d.logs.push.errors[0], "device", { remediation: faqFix(2), details: d.logs.push.errors });
    const t = api?.testPush;
    const viewed = a?.events["Notification Viewed"];
    const details = seen(viewed) ? [`Notification Viewed: ${countLabel(viewed!)}`] : [];
    const onDevice = Object.entries(d?.pushTests ?? {}).find(([, r]) => r?.status === "delivered");
    if (onDevice)
      return res("pass", "Delivered to the test device", `The push appeared on the phone ${Math.round((onDevice[1]!.deliveredAfterMs ?? 0) / 1000)} s after sending (app ${onDevice[0]}).`, "device", { details });
    const confirmed = Object.values(api?.pushTests ?? {}).find((r) => r?.status === "confirmed");
    if (confirmed) return res("pass", "Delivered & viewed", `Test push to ${confirmed.identity} was received.`, "api", { details });
    if (!t) return res("manual", "Not sent", "Use “Send test push” on this page to trigger and confirm a push to a test identity.", "none", { details });
    if (t.status === "confirmed") return res("pass", "Delivered & viewed", `Test push to ${t.identity} was received.`, "api", { details });
    if (t.status === "failed") return res("fail", "Send failed", t.message ?? "CleverTap rejected the push.", "api", { remediation: faqFix(2), details });
    return res("manual", t.status === "sent" ? "Sent — awaiting confirmation" : "Not confirmed", t.status === "sent"
      ? "Push queued. Press “Check delivery” after it arrives."
      : "No Notification Viewed event yet — either it wasn't delivered or impressions aren't tracked. Confirm on the device.", "api", { details });
  },

  "app-t3-killed": (c) => appStateCheck(c, "killed", "Swipe the app away from recents, then send a test push."),
  "app-t3-background": (c) => appStateCheck(c, "background", "Press Home so the app is in the background, then send a test push."),
  "app-t3-foreground": (c) => appStateCheck(c, "foreground", "Keep the app open on screen, then send a test push."),

  "app-t3-impressions": ({ a, ev, d }) => {
    if (d?.logs?.push?.impressions)
      return res("pass", "Impression recorded (live)", "After the test push the SDK queued a “Notification Viewed” event — impressions are tracked.", "device");
    if (!a) return res("manual", "Not checked", NO_API, "none");
    const v = ev("Notification Viewed");
    const c = ev("Notification Clicked");
    const m = a.messages?.push;
    const details = m && !m.error ? [`Push campaigns (30 days): ${m.campaigns} · sent ${m.sent} · viewed ${m.viewed} · clicked ${m.clicked}`] : [];
    if (m && !m.error && m.sent >= 20 && m.viewed === 0)
      return res("fail", `${m.sent} pushes sent, 0 viewed`, "Campaigns are delivering but no impressions are recorded — impression tracking is off.", "api", {
        remediation: faqFix(4),
        details: [...details, ...m.sentNeverViewed.map((n) => `No views: ${n}`)],
      });
    if (seen(v) || (m && m.viewed > 0))
      return res("pass", m && m.sent ? `${pct(m.viewed, m.sent)}% of ${m.sent} pushes viewed` : `Notification Viewed: ${countLabel(v!)}`, "Push impressions are being recorded.", "api", { details });
    if (seen(c))
      return res("fail", "Clicks but no impressions", "Notification Clicked events exist but no Notification Viewed — impression tracking is off.", "api", { remediation: faqFix(4) });
    return res("manual", "No push activity", "No Notification Viewed or Clicked events in 30 days. Send a test push, then re-run.", "api", { remediation: faqFix(4) });
  },

  "app-t3-deeplink-internal": ({ s, ev, a, d: dev }) => {
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
    if (a && seen(ev("Notification Clicked"))) details.push("Notification Clicked events are recorded.");
    if (a?.messages?.push?.clicked) details.push(`${a.messages.push.clicked} push clicks in the last 30 days.`);
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

  "app-t3-test-inapp": ({ s, a, d }) => {
    const li = d?.logs?.inApp;
    if (li?.errors.length)
      return res("fail", "In-app failed on the phone", li.errors[0], "device", {
        remediation: "On Flutter/React Native make MainActivity extend FlutterFragmentActivity / ReactActivity (FragmentActivity), and check the in-app media URL.",
        details: li.errors,
      });
    if (li && li.shown > 0)
      return res("pass", "In-app shown on the phone", "The SDK displayed an in-app during the log session.", "device");
    const ok = s?.manifest.ctComponents.some((c) => /InAppNotificationActivity/.test(c));
    const host = s?.app.launcherHost;
    const fragmentless = s?.manifest.metaData.CLEVERTAP_INAPP_FRAGMENTLESS_BANNERS;
    if (host?.fragment === false && !fragmentless && !(li && li.shown > 0))
      return res("warn", `${short(s!.app.launcherActivity ?? "Main activity")} isn't a FragmentActivity`, `It extends ${short(host.chain[0])}. CleverTap renders header/footer in-apps and the App Inbox as fragments, so those won't show (full-screen in-apps still can).`, "static", {
        remediation:
          s!.framework.primary === "flutter"
            ? "Make MainActivity extend FlutterFragmentActivity."
            : s!.framework.primary === "unity"
              ? 'Game-engine host: add <meta-data android:name="CLEVERTAP_INAPP_FRAGMENTLESS_BANNERS" android:value="1"/>.'
              : "Make your activities extend FragmentActivity / AppCompatActivity.",
        details: [`Launcher activity chain: ${[s!.app.launcherActivity, ...host.chain].join(" → ")}`],
      });
    const m = a?.messages?.inapp;
    if (m && m.viewed > 0)
      return res("pass", `${m.viewed} in-app views in 30 days`, `${m.campaigns} in-app campaign${m.campaigns > 1 ? "s" : ""} rendered on devices — in-apps work.`, "api");
    if (m && m.campaigns > 0 && m.viewed === 0)
      return res("warn", "In-apps never shown", `${m.campaigns} in-app campaign${m.campaigns > 1 ? "s" : ""} ran but none were viewed.`, "api", {
        remediation: "Check the in-app trigger event fires and the screen isn't excluded; on Flutter/RN the host activity must be a FragmentActivity.",
      });
    return res("manual", ok ? "In-app activity registered" : "Not checked",
      "Create a test in-app campaign targeting your test profile and confirm it renders.", s ? "static" : "none", {
        details: ok ? ["com.clevertap.android.sdk.InAppNotificationActivity is in the manifest."] : [],
      });
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
      return res("manual", "Declared — request can't be read", "The permission is declared; the code that asks for it can't be read (minified or a debug Flutter build). Connect a phone: we read whether it's granted.", "static");
    return res("warn", "Declared — runtime request not seen", "The permission is declared, but no CleverTap push-primer call was found. Make sure the app asks for it at runtime (your own prompt is fine).", "static", {
      remediation: "Use promptForPushPermission(true) / promptPushPrimer(…), or request POST_NOTIFICATIONS yourself.",
    });
  },

  "app-t3-uninstall": ({ s, ev }) => {
    const details = s ? [`Requires FCM — ${s.firebase.messagingSdk ? "integrated" : "missing"}`] : [];
    const u = ev("App Uninstalled");
    if (seen(u))
      return res("pass", `App Uninstalled: ${countLabel(u!)}`, "CleverTap is recording uninstalls, so uninstall tracking is switched on.", "api", { details });
    if (s && !s.firebase.messagingSdk)
      return res("fail", "Needs FCM", "Uninstall tracking works through silent FCM pushes, and FCM isn't integrated.", "static", { details });
    if (s && s.firebase.analyticsSdk === false)
      return res("warn", "Real-time tracking not possible", "CleverTap now recommends Real-Time Uninstall Tracking (Firebase Analytics app_remove → Cloud Function); silent-push tracking misses devices with stale FCM tokens. Firebase Analytics isn't in this app.", "static", {
        remediation: "Add Firebase Analytics and set up the app_remove Cloud Function (developer.clevertap.com → Uninstall Tracking using Firebase / Google Analytics), then turn it on in Settings → Uninstall Tracking.",
        details,
      });
    return res("manual", "Dashboard setting", "No uninstalls recorded in 30 days (normal for a new app). Check Settings → Engage → Uninstall tracking is on.", s ? "static" : "none", {
      details,
    });
  },

  "app-t3-session-analytics": () =>
    res("manual", "Dashboard setting", "Session analytics isn't exposed by the API. Check it's switched on in the dashboard.", "none"),

  "app-t4-formats": (ctx) => {
    const { a, d } = ctx;
    const live = (d?.logs?.events ?? []).flatMap((e) => e.issues.filter((i) => /text/.test(i)).map((i) => `'${e.name}' → ${i}`));
    if (live.length)
      return res("fail", `${live.length} format issue${live.length > 1 ? "s" : ""} (live)`, "Some properties use the wrong data type.", "device", {
        remediation: faqFix(10),
        details: live.slice(0, 12),
      });
    if (!a && d?.logs?.events.some((e) => Object.keys(e.props).length))
      return res("pass", "Types look right (live)", "No numbers-as-text or text dates in the events seen live.", "device");
    if (!a) return res("manual", "Not checked", NO_API, "none");
    const issues: string[] = [];
    let analysed = 0;
    for (const n of a.customEvents) {
      const e = a.events[n];
      for (const [k, st] of Object.entries(e?.props ?? {})) {
        analysed++;
        if (st.numericStrings) issues.push(`'${n}' → ${k} sent as a string (e.g. "${st.examples[0]}") — send a number`);
        if (st.dateLikeStrings) issues.push(`'${n}' → ${k} looks like a date string (e.g. "${st.examples[0]}") — send epoch ($D_)`);
      }
    }
    for (const f of a.profiles?.dateLikeStringFields ?? []) issues.push(`Profile field ${f} is a date stored as text — send epoch`);
    if (issues.length) {
      const mine = appEventNames(ctx);
      const own = issues.filter((i) => !i.startsWith("'") || mine.has(i.slice(1, i.indexOf("'", 1))));
      if (mine.size && own.length === 0)
        return res("warn", `${issues.length} format issue${issues.length > 1 ? "s" : ""} — not from this build`, "The wrongly typed properties are on events not seen from this build (not in its code or the live session) — another app, website or backend may share this project.", "api", {
          remediation: "If this app does raise those events, trigger them during the step 4 log session to check them. Otherwise fix the source that sends them.",
          details: issues.slice(0, 12),
        });
      return res("fail", `${issues.length} format issue${issues.length > 1 ? "s" : ""}`, "Some properties use the wrong data type.", "api", {
        remediation: faqFix(10),
        details: issues.slice(0, 12),
      });
    }
    if (analysed === 0 && !a.profiles?.sampled) return res("manual", "Nothing sampled", "Add critical events to the audit so their properties can be checked.", "api");
    return res("pass", `${analysed} properties checked`, "No numbers-as-text or text dates found in the sample.", "api");
  },

  "app-t4-valid-values": (ctx) => {
    const { a, d } = ctx;
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
    if (!a && L && (L.events.length || L.profilePushes.length))
      return res("pass", "No null/empty values (live)", "Events and profile updates seen live carry only real values.", "device");
    if (!a) return res("manual", "Not checked", NO_API, "none");
    const issues: string[] = [];
    for (const n of a.customEvents)
      for (const [k, st] of Object.entries(a.events[n]?.props ?? {}))
        if (st.types.nullish) issues.push(`'${n}' → ${k}: ${st.types.nullish}× null/empty`);
    for (const f of a.profiles?.nullishFields ?? []) issues.push(`Profile field ${f} holds "null" / empty`);
    if (issues.length) {
      const mine = appEventNames(ctx);
      const ownIssues = issues.filter((i) => !i.startsWith("'") || mine.has(i.slice(1, i.indexOf("'", 1))));
      const liveClean = !!L && (L.events.length > 0 || L.profilePushes.length > 0);
      if (mine.size && (ownIssues.length === 0 || (liveClean && ownIssues.every((i) => i.startsWith("Profile")))))
        return res("warn", `${issues.length} invalid value${issues.length > 1 ? "s" : ""} — not from this build`, "Everything seen from this build is clean. The \"null\"/empty values are on events not seen from it (not in its code or the live session) or on old profiles — another app, website or backend may share this project.", "api", {
          remediation: "If this app does raise those events, trigger them during the step 4 log session to check them. Otherwise fix the source that sends them, or clean up the old profiles.",
          details: issues.slice(0, 12),
        });
      return res("fail", `${issues.length} invalid value${issues.length > 1 ? "s" : ""}`, 'Properties are sent as "null" / empty strings instead of being omitted.', "api", {
        remediation: "Skip the property when there's no value — don't send \"null\", \"\" or \"undefined\".",
        details: issues.slice(0, 12),
      });
    }
    if (!a.profiles?.sampled && a.customEvents.length === 0) return res("manual", "Nothing sampled", "No profiles or events to inspect.", "api");
    return res("pass", "No null/empty values", "Sampled profiles and events carry only real values.", "api");
  },

  "app-t4-critical-events": ({ a, criticalEvents, d }) => {
    const ce = (criticalEvents ?? []).filter(Boolean);
    const liveEv = d?.logs?.events ?? [];
    if (liveEv.length && (!ce.length || ce.every((n) => liveEv.some((e) => e.name === n)))) {
      const checked = ce.length ? liveEv.filter((e) => ce.includes(e.name)) : liveEv;
      const bad = checked.filter((e) => e.issues.length);
      const details = checked.map((e) => `${e.name}: ${Object.entries(e.props).map(([k, t]) => `${k}:${t.join("/")}`).join(", ") || "no properties"}${e.issues.length ? ` ⚠ ${e.issues.join("; ")}` : ""}`);
      if (bad.length)
        return res("fail", `${bad.length} event${bad.length > 1 ? "s" : ""} with property issues`, "Seen live; fix the flagged properties.", "device", { remediation: faqFix(10), details });
      if (ce.length || checked.length >= 2)
        return res("pass", `${checked.length} key event${checked.length > 1 ? "s" : ""} verified live`, ce.length ? "Every listed critical event fired with correctly typed properties." : "Compare these with your event design sheet.", "device", { details });
    }
    if (ce.length === 0) return res("manual", "No events listed", "List 3–4 business-critical events when creating the audit to verify them automatically.", "none");
    if (!a) return res("manual", `${ce.length} events listed`, NO_API, "none", { details: ce });
    const details = ce.map((n) => {
      const e = a.events[n];
      if (!e) return `${n}: not checked`;
      if (!seen(e)) return `${n}: no data in 30 days`;
      const props = Object.entries(e.props ?? {}).map(([k, st]) => `${k}:${Object.keys(st.types).join("/")}`);
      return `${n}: ${countLabel(e)}${props.length ? ` — ${props.slice(0, 6).join(", ")}` : ""}`;
    });
    const unchecked = ce.filter((n) => !a.events[n]);
    if (unchecked.length)
      return res("manual", `${unchecked.length} not checked yet`, `${list(unchecked)} ${unchecked.length > 1 ? "were" : "was"} added after the last CleverTap check. Press “Re-run API checks” (passcode needed) or fire ${unchecked.length > 1 ? "them" : "it"} during the log session.`, "api", { details });
    const missing = ce.filter((n) => !seen(a.events[n]));
    if (missing.length === 0) return res("pass", `All ${ce.length} critical events flowing`, "Check the property list below matches your event design sheet.", "api", { details });
    return res("fail", `${missing.length} of ${ce.length} missing`, `No data for ${list(missing)}.`, "api", {
      remediation: "Confirm the event names match exactly and that the code path runs in this build.",
      details,
    });
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
  };
  const apiFailed = input.api && !input.api.ok && input.api.error !== "Not verified yet" ? input.api.error : undefined;
  const out: Record<string, ItemResult> = {};
  for (const item of itemsForPlatform("android")) {
    const rule = RULES[item.id];
    const r = rule ? rule(ctx) : res("manual", "Not automated yet", "Verify manually.", "none");
    if (apiFailed && r.evidence === NO_API) {
      r.detected = "API check failed";
      r.evidence = `The CleverTap API call failed: ${apiFailed}. Fix it and press “Re-run API checks”.`;
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

function ago(ms: number) {
  const m = Math.round((Date.now() - ms) / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
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

function fmtTs(ts: string) {
  // yyyyMMddHHmmss
  return ts.length >= 12 ? `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)} ${ts.slice(8, 10)}:${ts.slice(10, 12)}` : ts;
}
