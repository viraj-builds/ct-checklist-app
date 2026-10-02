import type { AndroidScanReport, ApiUsage } from "../analyzer/types";
import type { ApiFindings, EventSample } from "../clevertap/types";
import type { ItemResult, ItemStatus, ResultSource } from "../types";
import { itemsForPlatform } from "../checklist";
import { getFaq } from "../faq";

// ---------------------------------------------------------------------------
// Android rule engine: (static report, API findings) -> one result per
// checklist item. Pure and deterministic so it can run anywhere and be
// re-run whenever either input changes.
//
// Principles:
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
  latest?: LatestVersions | null;
  accountId?: string | null;
  region?: string | null;
  criticalEvents?: string[];
}

type Rule = (ctx: Ctx) => Omit<ItemResult, "itemId">;

interface Ctx extends EngineInput {
  s?: AndroidScanReport;
  a?: ApiFindings; // only when the API call succeeded
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

function usageEvidence(u: ApiUsage): string[] {
  return u.evidence.slice(0, 6);
}

/* ------------------------------------------------------------------ */

const RULES: Record<string, Rule> = {
  "app-t1-credentials": ({ s, a, api, accountId, region }) => {
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

  "app-t1-lifecycle": ({ s, a, ev }) => {
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
      return res("warn", "Can't verify", "The app is minified, so the call can't be matched by name.", "static", { remediation: fix });
    return res("fail", "Not registered", `${s.app.applicationClass ?? "The Application class"} doesn't register CleverTap's lifecycle callbacks.`, "static", { remediation: fix });
  },

  "app-t1-fcm-service": ({ s, a }) => {
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
      return res("warn", "Can't verify hand-off", `Custom service ${custom[0].name} found; the code is minified so the hand-off can't be confirmed.`, a ? "static+api" : "static", {
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
      return res("warn", "None in 30 days", "No App Installed events in the last 30 days although the app is launched. That's expected if there were no new installs.", "api", {
        remediation: "Install the app fresh on a test device and check the profile's activity for App Installed.",
        details,
      });
    return res("fail", "No events", "Neither App Installed nor App Launched events were found.", "api", { remediation: faqFix(1), details });
  },

  "app-t1-launched": ({ s, a, ev }) => {
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

  "app-t1-sdk-version": ({ s, latest }) => {
    if (!s) return res("manual", "Not checked", NO_SCAN, "none");
    const ct = s.clevertap;
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
      return res("warn", ct.minVersionEstimate ? `≥ ${ct.minVersionEstimate} (estimated)` : "Version unknown",
        "The version string was stripped by minification. Check the version in build.gradle / pubspec / package.json.", "static", {
          remediation: target ? `Latest core SDK is ${target}.` : undefined,
          details,
        });
    }
    if (!target) return res("pass", `SDK v${ct.coreVersion}`, "Couldn't fetch the latest version to compare.", "static", { details });
    const cmp = compareVersions(ct.coreVersion, target);
    if (cmp >= 0) return res("pass", `SDK v${ct.coreVersion} (latest)`, `Core SDK is up to date (latest ${target}).`, "static", { details });
    const [maj] = ct.coreVersion.split(".").map(Number);
    const [tmaj] = target.split(".").map(Number);
    const behind = `SDK v${ct.coreVersion} — latest is ${target}`;
    if (tmaj - maj >= 2)
      return res("fail", behind, `${tmaj - maj} major versions behind.`, "static", {
        remediation: `Upgrade to ${target} — see the changelog for breaking changes.`,
        details,
      });
    return res("warn", behind, tmaj > maj ? "One major version behind." : "Same major version, update recommended.", "static", {
      remediation: `Update to ${target}.`,
      details,
    });
  },

  "app-t1-channel": ({ s }) => {
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
      return res("warn", `Channel ${native.strings.length ? list(native.strings) : ""} created via Android API`.replace("  ", " "),
        "A channel is created with NotificationManager, not CleverTap's helper. That works if CleverTap pushes use the same ID (wzrk_cid).", "static", {
          remediation: remind,
          details,
        });
    }
    if (def) return res("pass", `Default channel '${def}'`, remind, "static", { details });
    if (u.found === null)
      return res("warn", "Can't verify", "The code is minified; the channel creation call can't be matched.", "static", { remediation: faqFix(2), details });
    return res("fail", "No channel created", "No notification channel is created — pushes are dropped on Android 8+.", "static", {
      remediation: faqFix(2),
      details,
    });
  },

  "app-t1-identity": ({ s, a }) => {
    const p = a?.profiles;
    const login = s?.apis.onUserLogin;
    const details = login?.found ? [`onUserLogin: ${login.evidence[0] ?? "found"}`] : [];
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

  "app-t1-onuserlogin": ({ s, a }) => {
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

  "app-t1-onuserlogin-update": ({ s }) => {
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

  "app-t1-custom-events": ({ s, a }) => {
    const staticNames = s?.eventNames ?? [];
    const details = staticNames.length ? [`Events in code: ${list(staticNames, 10)}`] : [];
    if (s?.apis.pushEvent.found) details.push(...usageEvidence(s.apis.pushEvent).slice(0, 3));
    if (a && a.customEvents.length) {
      const hits = a.customEvents.filter((n) => seen(a.events[n]));
      const misses = a.customEvents.filter((n) => !seen(a.events[n]));
      if (misses.length) details.push(`No data (30 days): ${list(misses, 10)}`);
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

  "app-t1-device-token": ({ s, a }) => {
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
    return res("manual", s?.firebase.googleServicesConfigured ? "FCM configured" : "Not checked", NO_API, s ? "static" : "none", { details });
  },

  "app-t2-gdpr-location": ({ s }) => {
    if (!s) return res("manual", "Not checked", NO_SCAN, "none");
    const u = s.apis.enableDeviceNetworkInfoReporting;
    if (u.found) return res("pass", "Enabled", "enableDeviceNetworkInfoReporting(true) is called.", "static", { details: usageEvidence(u) });
    if (u.found === null) return res("manual", "Can't verify", "Code is minified — confirm enableDeviceNetworkInfoReporting(true) is called.", "static", { remediation: faqFix(5) });
    return res("fail", "Not enabled", "enableDeviceNetworkInfoReporting isn't called, so city/region/country stay unknown.", "static", { remediation: faqFix(5) });
  },

  "app-t2-lat-long": ({ s }) => {
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

  "app-t2-phone-push": ({ a }) => {
    const p = a?.profiles;
    if (!a || !p) return res("manual", "Not checked", NO_API, "none");
    if (p.withPhone === 0) return res("manual", "No phone numbers", `None of ${p.sampled} sampled profiles carry a phone number.`, "api");
    const label = `${pct(p.phoneValid, p.withPhone)}% of ${p.withPhone} phone numbers are valid`;
    if (p.phoneValid === p.withPhone) return res("pass", label, 'All sampled numbers use "+" and a country code (E.164).', "api");
    return res(p.phoneValid > 0 ? "warn" : "fail", label, "Some numbers are missing the + prefix or country code.", "api", {
      remediation: 'Send phone numbers in E.164 format, e.g. "+919876543210".',
      details: p.phoneInvalidExamples.map((x) => `Example: ${x}`),
    });
  },

  "app-t3-test-push": ({ a, api }) => {
    const t = api?.testPush;
    const viewed = a?.events["Notification Viewed"];
    const details = seen(viewed) ? [`Notification Viewed: ${countLabel(viewed!)}`] : [];
    if (!t) return res("manual", "Not sent", "Use “Send test push” on this page to trigger and confirm a push to a test identity.", "none", { details });
    if (t.status === "confirmed") return res("pass", "Delivered & viewed", `Test push to ${t.identity} was received.`, "api", { details });
    if (t.status === "failed") return res("fail", "Send failed", t.message ?? "CleverTap rejected the push.", "api", { remediation: faqFix(2), details });
    return res("manual", t.status === "sent" ? "Sent — awaiting confirmation" : "Not confirmed", t.status === "sent"
      ? "Push queued. Press “Check delivery” after it arrives."
      : "No Notification Viewed event yet — either it wasn't delivered or impressions aren't tracked. Confirm on the device.", "api", { details });
  },

  "app-t3-killed": () => deviceCheck("Swipe the app away from recents, then send a test push."),
  "app-t3-background": () => deviceCheck("Press Home so the app is in the background, then send a test push."),
  "app-t3-foreground": () => deviceCheck("Keep the app open on screen, then send a test push."),

  "app-t3-impressions": ({ a, ev }) => {
    if (!a) return res("manual", "Not checked", NO_API, "none");
    const v = ev("Notification Viewed");
    const c = ev("Notification Clicked");
    if (seen(v)) return res("pass", `Notification Viewed: ${countLabel(v!)}`, "Push impressions are being recorded.", "api");
    if (seen(c))
      return res("fail", "Clicks but no impressions", "Notification Clicked events exist but no Notification Viewed — impression tracking is off.", "api", { remediation: faqFix(4) });
    return res("manual", "No push activity", "No Notification Viewed or Clicked events in 30 days. Send a test push, then re-run.", "api", { remediation: faqFix(4) });
  },

  "app-t3-deeplink-internal": ({ s, ev, a }) => {
    if (!s) return res("manual", "Not checked", NO_SCAN, "none");
    const own = appDeepLinks(s).filter((d) => !/^https?$/.test(d.scheme));
    const details = own.slice(0, 6).map((d) => `${d.scheme}://${d.host ?? ""}${d.path ?? ""} → ${short(d.activity)}`);
    if (a && seen(ev("Notification Clicked"))) details.push("Notification Clicked events are recorded.");
    if (own.length)
      return res("manual", `${own.length} deep-link scheme${own.length > 1 ? "s" : ""}`, "Send a push with one of these deep links and confirm it opens the right screen.", "static", { details });
    return res("warn", "No custom scheme", "No activity declares a custom-scheme deep link (VIEW + BROWSABLE). In-app routing won't work from push.", "static", {
      remediation: faqFix(9),
      details,
    });
  },

  "app-t3-deeplink-external": ({ s }) => {
    if (!s) return res("manual", "Not checked", NO_SCAN, "none");
    const web = appDeepLinks(s).filter((d) => /^https?$/.test(d.scheme));
    const details = web.slice(0, 6).map((d) => `${d.scheme}://${d.host ?? "*"}${d.path ?? ""}${d.autoVerify ? " (App Link, verified)" : ""} → ${short(d.activity)}`);
    return res("manual", web.length ? `${web.length} web link${web.length > 1 ? "s" : ""} handled in-app` : "Opens in browser",
      web.length
        ? "These https links open the app. Send a push with one and check where it lands."
        : "No https App Links are declared, so external URLs open in the browser — that's expected. Confirm the redirect on a device.",
      "static", { details, remediation: web.length ? undefined : faqFix(9) });
  },

  "app-t3-test-inapp": ({ s }) => {
    const ok = s?.manifest.ctComponents.some((c) => /InAppNotificationActivity/.test(c));
    return res("manual", ok ? "In-app activity registered" : "Not checked",
      "Create a test in-app campaign targeting your test profile and confirm it renders.", s ? "static" : "none", {
        details: ok ? ["com.clevertap.android.sdk.InAppNotificationActivity is in the manifest."] : [],
      });
  },

  "app-t3-inapp-exclude": ({ s }) => {
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
      return res("fail", `${short(splash)} not excluded`, "A splash/loading activity exists but CLEVERTAP_INAPP_EXCLUDE isn't set — in-apps can flash on the splash screen.", "static", {
        remediation: `Add <meta-data android:name="CLEVERTAP_INAPP_EXCLUDE" android:value="${short(splash)}"/> inside <application>.`,
      });
    if (s.framework.primary !== "native")
      return res("na", "Single-activity app", "The splash is drawn inside the main activity. If needed, suspend in-apps during the splash (suspendInAppNotifications).", "static");
    return res("pass", "No splash activity", "No dedicated splash activity found, so nothing needs excluding.", "static");
  },

  "app-t3-post-notifications": ({ s }) => {
    if (!s) return res("manual", "Not checked", NO_SCAN, "none");
    const target = s.app.targetSdk ?? 0;
    if (target && target < 33) return res("pass", `targetSdk ${target}`, "Runtime notification permission isn't required below API 33.", "static");
    const declared = s.manifest.permissions.includes("android.permission.POST_NOTIFICATIONS");
    if (!declared)
      return res("fail", "Permission missing", `targetSdk ${target} but POST_NOTIFICATIONS isn't declared — Android 13+ blocks every notification.`, "static", {
        remediation: "Declare android.permission.POST_NOTIFICATIONS and request it at runtime (CleverTap push primer).",
      });
    const u = s.apis.promptPushPermission;
    if (u.found) return res("pass", "Declared & requested", "The app asks for the permission via CleverTap's push primer.", "static", { details: usageEvidence(u) });
    return res("warn", "Declared — runtime request not seen", "The permission is declared, but no CleverTap push-primer call was found. Make sure the app asks for it at runtime (your own prompt is fine).", "static", {
      remediation: "Use promptForPushPermission(true) / promptPushPrimer(…), or request POST_NOTIFICATIONS yourself.",
    });
  },

  "app-t3-uninstall": ({ s }) =>
    res("manual", "Dashboard setting", "Uninstall tracking isn't exposed by the API. Check Settings → Engage → Uninstall tracking.", s ? "static" : "none", {
      details: s ? [`Requires FCM — ${s.firebase.messagingSdk ? "integrated" : "missing"}`] : [],
    }),

  "app-t3-session-analytics": () =>
    res("manual", "Dashboard setting", "Session analytics isn't exposed by the API. Check it's switched on in the dashboard.", "none"),

  "app-t4-formats": ({ a }) => {
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
    if (issues.length) return res("fail", `${issues.length} format issue${issues.length > 1 ? "s" : ""}`, "Some properties use the wrong data type.", "api", {
      remediation: faqFix(10),
      details: issues.slice(0, 12),
    });
    if (analysed === 0 && !a.profiles?.sampled) return res("manual", "Nothing sampled", "Add critical events to the audit so their properties can be checked.", "api");
    return res("pass", `${analysed} properties checked`, "No numbers-as-text or text dates found in the sample.", "api");
  },

  "app-t4-valid-values": ({ a }) => {
    if (!a) return res("manual", "Not checked", NO_API, "none");
    const issues: string[] = [];
    for (const n of a.customEvents)
      for (const [k, st] of Object.entries(a.events[n]?.props ?? {}))
        if (st.types.nullish) issues.push(`'${n}' → ${k}: ${st.types.nullish}× null/empty`);
    for (const f of a.profiles?.nullishFields ?? []) issues.push(`Profile field ${f} holds "null" / empty`);
    if (issues.length) return res("fail", `${issues.length} invalid value${issues.length > 1 ? "s" : ""}`, 'Properties are sent as "null" / empty strings instead of being omitted.', "api", {
      remediation: "Skip the property when there's no value — don't send \"null\", \"\" or \"undefined\".",
      details: issues.slice(0, 12),
    });
    if (!a.profiles?.sampled && a.customEvents.length === 0) return res("manual", "Nothing sampled", "No profiles or events to inspect.", "api");
    return res("pass", "No null/empty values", "Sampled profiles and events carry only real values.", "api");
  },

  "app-t4-critical-events": ({ a, criticalEvents }) => {
    const ce = (criticalEvents ?? []).filter(Boolean);
    if (ce.length === 0) return res("manual", "No events listed", "List 3–4 business-critical events when creating the audit to verify them automatically.", "none");
    if (!a) return res("manual", `${ce.length} events listed`, NO_API, "none", { details: ce });
    const details = ce.map((n) => {
      const e = a.events[n];
      if (!e) return `${n}: not checked`;
      if (!seen(e)) return `${n}: no data in 30 days`;
      const props = Object.entries(e.props ?? {}).map(([k, st]) => `${k}:${Object.keys(st.types).join("/")}`);
      return `${n}: ${countLabel(e)}${props.length ? ` — ${props.slice(0, 6).join(", ")}` : ""}`;
    });
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
    ev: (n) => (input.api?.ok ? input.api.events[n] : undefined),
  };
  const out: Record<string, ItemResult> = {};
  for (const item of itemsForPlatform("android")) {
    const rule = RULES[item.id];
    const r = rule ? rule(ctx) : res("manual", "Not automated yet", "Verify manually.", "none");
    out[item.id] = { itemId: item.id, ...r };
  }
  return out;
}

/* helpers ---------------------------------------------------------- */

function deviceCheck(how: string) {
  return res("manual", "Confirm on a device", `${how} No CleverTap event records the app state at delivery, so this one is visual.`, "none");
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
