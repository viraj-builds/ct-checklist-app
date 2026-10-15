import type { ApiFindings, EventSample, WebApiFindings } from "../clevertap/types";
import type { ItemResult, ItemStatus, ResultSource } from "../types";
import type { LivePushTest, WebEvent, WebLiveFindings, WebScanReport } from "../web/types";
import { itemsForPlatform } from "../checklist";
import { getFaq } from "../faq";
import { compareVersions } from "./android";

// ---------------------------------------------------------------------------
// Website rule engine: (crawl report, API findings) -> one result per web
// checklist item. Pure and deterministic, with the same policy as the app
// engines:
//  - fail = proven broken or a documented requirement missing
//  - warn = works but risky / partly verified
//  - manual = can't decide yet (say exactly what to do next)
//  - silence from the CleverTap API never fails an item
// ---------------------------------------------------------------------------

export interface WebEngineInput {
  scan?: WebScanReport | null;
  live?: WebLiveFindings | null; // live session in the user's own Chrome
  api?: ApiFindings | null;
  latest?: string | null; // latest clevertap-web-sdk version
  accountId?: string | null;
  region?: string | null;
  criticalEvents?: string[];
}

type Rule = (ctx: Ctx) => Omit<ItemResult, "itemId">;

interface Ctx extends WebEngineInput {
  s?: WebScanReport;
  a?: ApiFindings;
  w?: WebApiFindings;
  lv?: WebLiveFindings;
}

const NO_SCAN = "Run the website check (Website tests → Check my website) to verify this automatically.";
const LOGIN = "Add a test login under Website tests → Check my website, so we can sign in and watch what the site sends.";

function res(status: ItemStatus, detected: string, evidence: string, source: ResultSource, extra: { remediation?: string; details?: string[] } = {}): Omit<ItemResult, "itemId"> {
  return { status, detected, evidence, source, ...extra };
}
const list = (a: string[], n = 5) => a.slice(0, n).map((x) => `'${x}'`).join(", ") + (a.length > n ? ` +${a.length - n} more` : "");
const pct = (n: number, d: number) => (d ? Math.round((n / d) * 100) : 0);
const faqFix = (n: number) => {
  const f = getFaq(n);
  return f ? `FAQ #${f.n}: ${f.solutions.join(" ")}` : undefined;
};
const normRegion = (r?: string | null) => (r ?? "").trim().toLowerCase().replace(/^eu$/, "eu1") || "eu1";
const loginPushes = (s?: WebScanReport) => (s?.profiles ?? []).filter((p) => p.phase === "login");
const ago = (t?: number) => (t ? new Date(t).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "");

/* ------------------------------------------------------------------ */

const RULES: Record<string, Rule> = {
  "web-t1-sdk-head": ({ s, accountId, region, latest }) => {
    if (!s) return res("manual", "Not checked", NO_SCAN, "none");
    const sdk = s.sdk;
    if (!sdk.present)
      return res("fail", "CleverTap SDK not found", `We opened ${s.finalUrl} and no CleverTap code ran and no data was sent to CleverTap.`, "static", {
        remediation: "Add the CleverTap snippet inside <head> on every page (or install clevertap-web-sdk from npm and call clevertap.init() on startup) — see the Web quick-start.",
      });
    const details: string[] = [];
    if (sdk.version) details.push(`Web SDK v${sdk.version}${latest ? ` (latest ${latest})` : ""}`);
    if (sdk.accountId) details.push(`Account ${sdk.accountId}`);
    if (sdk.host) details.push(`Sends to ${sdk.host}`);
    if (sdk.scriptUrl) details.push(`Script: ${sdk.scriptUrl}`);
    if (sdk.firstRequestMs !== undefined) details.push(`First request ${(sdk.firstRequestMs / 1000).toFixed(1)} s after the page started loading`);

    if (accountId && sdk.accountId && sdk.accountId.toUpperCase() !== accountId.trim().toUpperCase())
      return res("fail", "Wrong account", `The site sends data to ${sdk.accountId}, but this audit is for ${accountId}.`, "static", {
        remediation: "Use the Project ID from Dashboard → Settings → Project in clevertap.account.push / clevertap.init().",
        details,
      });
    if (region && sdk.region && normRegion(sdk.region) !== normRegion(region))
      return res("fail", "Region mismatch", `The site sends data to ${sdk.host}, but the account is in ${region}.`, "static", {
        remediation: `Pass the region "${region}" (clevertap.region = '${region}' in the snippet, or clevertap.init(id, '${region}')).`,
        details,
      });
    if (s.network.requests > 0 && s.network.accepted === 0)
      return res("fail", "CleverTap didn't accept the data", s.network.errors[0] ?? "Every request to CleverTap failed.", "static", { remediation: faqFix(1), details: [...details, ...s.network.errors] });

    let behind: string | undefined;
    if (sdk.version && latest && compareVersions(sdk.version, latest) < 0) {
      const [maj] = sdk.version.split(".").map(Number);
      const [lmaj] = latest.split(".").map(Number);
      behind = lmaj > maj ? `v${sdk.version} is a major version behind (latest ${latest}).` : undefined;
    }
    const late = sdk.firstRequestMs !== undefined && sdk.firstRequestMs > 8000;
    const where =
      sdk.loading === "head"
        ? "The CleverTap snippet is in <head>"
        : sdk.loading === "bundle"
          ? "CleverTap is installed from npm (clevertap-web-sdk) inside the site's JavaScript — a supported alternative to the <head> snippet"
          : "The CleverTap script is added outside <head>";
    if (sdk.loading === "body" || late || behind)
      return res("warn", `${sdk.loading === "body" ? "Loaded outside <head>" : late ? "Starts late" : "SDK out of date"}${sdk.version ? ` · v${sdk.version}` : ""}`,
        `${where}.${late ? ` It sent its first request only after ${(sdk.firstRequestMs! / 1000).toFixed(1)} s, so short visits and early events can be missed.` : ""}${behind ? ` ${behind}` : ""}`,
        "static", {
          remediation: sdk.loading === "body" || late ? "Move the CleverTap snippet into <head> (or init the npm SDK as early as possible on every page)." : `Update clevertap-web-sdk / the snippet to ${latest}.`,
          details,
        });
    return res("pass", `${sdk.loading === "head" ? "In <head>" : sdk.loading === "bundle" ? "Installed via npm" : "Loaded"}${sdk.version ? ` · v${sdk.version}` : ""}`,
      `${where}, it starts on page load and CleverTap accepted ${s.network.accepted} request${s.network.accepted === 1 ? "" : "s"}.`, "static", { details });
  },

  "web-t1-gdpr": ({ s }) => {
    if (!s) return res("manual", "Not checked", NO_SCAN, "none");
    if (!s.sdk.present) return res("fail", "SDK not found", "The CleverTap SDK isn't on the site.", "static");
    const p = s.privacy;
    const details = [
      ...(p.optOut !== undefined ? [`optOut: ${p.optOut}`] : []),
      ...(p.useIP !== undefined ? [`useIP: ${p.useIP}`] : []),
      `clevertap.getLocation(): ${p.getLocation ? "used" : "not used"}`,
      ...s.code.privacy.evidence.slice(0, 2),
    ];
    if (!p.called)
      return res("warn", "No privacy settings", "clevertap.privacy.push isn't called, so the defaults apply: data is collected (optOut false) and the visitor's IP isn't, so CleverTap has no location for web users.", "static", {
        remediation: "Before the SDK starts, set the GDPR flags explicitly: clevertap.privacy.push({optOut: false}); clevertap.privacy.push({useIP: true}) — useIP true lets CleverTap derive the location from the IP. Set optOut true for visitors who decline tracking.",
        details,
      });
    const loc = p.useIP ? "IP-based location is on" : p.getLocation ? "location comes from clevertap.getLocation()" : "IP collection is off and getLocation() isn't used, so web profiles get no location";
    return res(p.useIP || p.getLocation ? "pass" : "warn", `privacy.push set${p.useIP !== undefined ? ` · useIP ${p.useIP}` : ""}`,
      `The site sets the GDPR flags (clevertap.privacy.push); ${loc}.`, "static", {
        remediation: p.useIP || p.getLocation ? undefined : "If you need user location on web, set clevertap.privacy.push({useIP: true}) (with consent) or call clevertap.getLocation().",
        details,
      });
  },

  "web-t1-utm": ({ s, w }) => {
    const v = w?.visitor;
    if (v?.found && v.events["UTM Visited"])
      return res("pass", "UTM Visited recorded", `We opened the site with test UTM parameters and CleverTap recorded UTM Visited on that visitor's profile (${v.key}).`, "api", { details: s ? [`utm_source=${s.utm.params.source}`, `utm_campaign=${s.utm.params.campaign}`] : undefined });
    if (!s) return res("manual", "Not checked", NO_SCAN, "none");
    if (!s.sdk.present) return res("fail", "SDK not found", "Without the SDK no referral is tracked.", "static");
    const details = [`Opened: ?utm_source=${s.utm.params.source}&utm_medium=${s.utm.params.medium}&utm_campaign=${s.utm.params.campaign}`, `Landed on: ${s.utm.landedOn ?? "?"}`];
    if (s.utm.sent) {
      if (v?.found && Object.keys(v.events).length > 1 && !v.events["UTM Visited"])
        return res("warn", "Sent, not recorded yet", "The page view carried the UTM parameters, but UTM Visited isn't on the visitor's profile yet. Press “Check CleverTap again” in a few minutes.", "static+api", { details });
      return res("pass", "UTM parameters sent", "We opened the site with test UTM parameters and the SDK sent them with the page view (CleverTap turns these into UTM Visited).", "static", { details });
    }
    const redirected = s.utm.landedOn && s.utm.landedOn !== new URL(s.url).pathname;
    return res("warn", redirected ? "Lost on redirect" : "UTM parameters not sent", redirected
      ? `The site redirected to ${s.utm.landedOn} and dropped the query string before CleverTap read it, so campaign visits to this page aren't attributed.`
      : "The SDK's page view didn't include the UTM parameters of the URL we opened.", "static", {
      remediation: redirected ? "Keep the query string (utm_*) when redirecting, or start CleverTap before the redirect so it reads the landing URL." : "Make sure CleverTap starts on the landing page itself (not only after a client-side route change).",
      details,
    });
  },

  "web-t2-identity": ({ s, w, a }) => {
    const lp = loginPushes(s).filter((p) => p.hasIdentity || p.hasEmail);
    if (lp.length) {
      const p = lp[0];
      return res("pass", `${[p.hasIdentity && "Identity", p.hasEmail && "Email"].filter(Boolean).join(" + ")} sent on login`, `Logging in with the test account sent ${p.keys.join(", ")} to CleverTap (via ${p.via === "unknown" ? "a profile update" : p.via}).`, "static", {
        details: lp.slice(0, 3).map((x) => `${x.via}: ${x.keys.join(", ")}`),
      });
    }
    if (w?.user?.found && w.user.identified)
      return res("pass", "Test user identified", `The test user's profile has ${w.user.hasEmail ? "an Email" : "an Identity"} in CleverTap.`, "api");
    if (s?.login.ok) return res("fail", "Not sent on login", "We logged in with the test account, but no Identity or Email was sent to CleverTap.", "static", {
      remediation: "Right after a successful login / sign-up call clevertap.onUserLogin.push({Site: {Identity: <your user id>, Email: <email>}}).",
    });
    const pr = a?.profiles;
    if (pr && pr.sampled > 0)
      return res(pr.withIdentity || pr.withEmail ? "pass" : "warn", `${pct(pr.withIdentity, pr.sampled)}% with Identity, ${pct(pr.withEmail, pr.sampled)}% with Email`,
        `Sampled ${pr.sampled} recent web profiles from your account.`, "api", { remediation: pr.withIdentity || pr.withEmail ? undefined : "Call onUserLogin with Identity / Email when users log in." });
    return res("manual", "Not checked yet", s ? LOGIN : NO_SCAN, "none");
  },

  "web-t2-onuserlogin": ({ s }) => {
    if (!s) return res("manual", "Not checked", NO_SCAN, "none");
    const calls = s.calls.filter((c) => c.phase === "login");
    if (calls.some((c) => c.api === "onUserLogin"))
      return res("pass", "onUserLogin called on login", "We logged in with the test account and the site called clevertap.onUserLogin.push.", "static", { details: s.code.onUserLogin.evidence.slice(0, 2) });
    const profOnly = loginPushes(s).some((p) => p.via === "profile" && (p.hasIdentity || p.hasEmail));
    if (profOnly)
      return res("warn", "profile.push used instead", "On login the site sends the identity with profile.push. On a shared browser that merges different users into one profile.", "static", {
        remediation: "Use clevertap.onUserLogin.push({Site: {...}}) on login / sign-up; keep profile.push for later profile updates.",
      });
    if (s.login.ok)
      return res("fail", "Not called on login", "We logged in with the test account and onUserLogin wasn't called.", "static", { remediation: "Call clevertap.onUserLogin.push({Site: {Identity, Email}}) right after login and sign-up succeed." });
    if (s.code.onUserLogin.found)
      return res("manual", "In the code — not seen live", `onUserLogin is in the site's code (${s.code.onUserLogin.count}×). ${s.login.attempted ? `The test login didn't work: ${s.login.message ?? ""}` : LOGIN}`, "static", { details: s.code.onUserLogin.evidence });
    return res(s.sdk.present ? "warn" : "fail", "Not found", `onUserLogin isn't in the JavaScript the site loaded${s.login.attempted ? "" : " (login pages may load more code — add a test login to check live)"}.`, "static", {
      remediation: "Call clevertap.onUserLogin.push({Site: {Identity, Email}}) right after login and sign-up succeed.",
    });
  },

  "web-t2-profile-push": ({ s }) => {
    if (!s) return res("manual", "Not checked", NO_SCAN, "none");
    const live = s.calls.filter((c) => c.api === "profile");
    if (live.length) return res("pass", "profile.push used (live)", `The site called clevertap.profile.push ${live.length}× while we used it.`, "static", { details: s.code.profilePush.evidence.slice(0, 3) });
    if (s.code.profilePush.found)
      return res("pass", "profile.push in the code", `clevertap.profile.push is used in the site's code (${s.code.profilePush.count}×) to update profiles outside login.`, "static", { details: s.code.profilePush.evidence.slice(0, 3) });
    return res("manual", "Not seen", "profile.push isn't in the code we loaded. If users can edit their profile (name, phone, preferences), call clevertap.profile.push({Site: {...}}) when they save.", "static");
  },

  "web-t2-anon": ({ s, w }) => {
    const v = w?.visitor;
    if (v?.found && !v.identified)
      return res("pass", "Anonymous profile created", `Our test visit created an anonymous profile in CleverTap (${v.key}) before any login.`, "api");
    if (!s) return res("manual", "Not checked", NO_SCAN, "none");
    if (!s.sdk.present) return res("fail", "SDK not found", "No SDK, so no anonymous profile is created.", "static");
    if (s.ctId && s.network.accepted > 0)
      return res("pass", "Visitor tracked before login", `The SDK started for a logged-out visitor, got a CleverTap ID (${s.ctId.slice(0, 6)}…) and CleverTap accepted its data — the anonymous profile is created before registration.`, "static");
    return res("warn", "No CleverTap ID yet", "The SDK didn't get a CleverTap ID for the anonymous visitor.", "static", { remediation: faqFix(1) });
  },

  "web-t2-onuserlogin-existing": ({ s }) => {
    if (!s) return res("manual", "Not checked", NO_SCAN, "none");
    const r = s.login.revisit;
    if (!s.login.ok || !r?.checked) return res("manual", "Not checked yet", s.login.attempted ? `The test login didn't work: ${s.login.message ?? ""}` : LOGIN, "none");
    if (r.onUserLogin)
      return res("pass", "Re-identified on return", "We reopened the site while logged in and it called onUserLogin again, so users who were logged in before CleverTap was added are identified too.", "static");
    if (r.identified)
      return res("warn", "Not re-sent on return", "On a returning visit while logged in, onUserLogin isn't called. This browser stays identified, but users who were already logged in before CleverTap was added (or whose session is restored) stay anonymous.", "static", {
        remediation: "When the site restores a logged-in session (e.g. your auth state listener / app start), call clevertap.onUserLogin.push with the user's Identity and Email.",
      });
    return res("fail", "Returning user not identified", "We reopened the site while logged in and the visitor wasn't identified to CleverTap.", "static", {
      remediation: "Call clevertap.onUserLogin.push with the user's Identity / Email whenever a logged-in session is restored.",
    });
  },

  "web-t2-phone": ({ s, w, a }) => {
    const phones = (s?.profiles ?? []).filter((p) => p.phone);
    const bad = phones.filter((p) => p.phoneValid === false);
    if (bad.length)
      return res("fail", `Phone not in +country format (${bad[0].phone})`, "The site sends the phone number without the + and country code, so SMS / WhatsApp can't reach it.", "static", {
        remediation: 'Send Phone in E.164 format, e.g. "+919876543210".',
      });
    if (phones.length) return res("pass", `Phone in E.164 format (${phones[0].phone})`, "The phone number sent on login has the + and country code.", "static");
    if (w?.user?.hasPhone) return res(w.user.phoneValid ? "pass" : "fail", w.user.phoneValid ? "Test user's phone is valid" : "Test user's phone is invalid", "From the test user's profile in CleverTap.", "api", { remediation: w.user.phoneValid ? undefined : 'Send Phone as "+<country code><number>".' });
    const pr = a?.profiles;
    if (pr && pr.withPhone > 0) {
      const okP = pct(pr.phoneValid, pr.withPhone);
      return res(okP === 100 ? "pass" : okP >= 90 ? "warn" : "fail", `${okP}% of phones valid`, `Sampled ${pr.withPhone} web profiles with a phone.`, "api", {
        remediation: okP === 100 ? undefined : 'Send Phone as "+<country code><number>".',
        details: pr.phoneInvalidExamples,
      });
    }
    if (s?.login.ok) return res("manual", "No phone sent", "Logging in didn't send a phone number. If you collect phone numbers, send them as Phone: \"+91…\" in onUserLogin / profile.push.", "static");
    return res("manual", "Not checked yet", s ? LOGIN : NO_SCAN, "none");
  },

  "web-t3-custom-events": ({ s, a, criticalEvents }) => {
    const live = s?.events ?? [];
    const ce = (criticalEvents ?? []).filter(Boolean);
    const apiEv = Object.values(a?.events ?? {}).filter((e) => a?.customEvents.includes(e.name));
    const apiIssues = apiEv.flatMap((e) => propIssues(e).map((i) => `${e.name} → ${i}`));
    const liveIssues = live.flatMap((e) => e.issues.map((i) => `${e.name} → ${i}`));
    const profIssues = (s?.profiles ?? []).flatMap((p) => p.issues.map((i) => `Profile (${p.via}) → ${i}`));
    const issues = [...new Set([...liveIssues, ...profIssues, ...apiIssues])];
    const details = [
      ...live.slice(0, 8).map(fmtEvent),
      ...apiEv.filter((e) => e.androidSampled > 0).slice(0, 5).map((e) => `${e.name}: ${e.capped ? "≥" : ""}${e.androidSampled} in ${e.windowDays} days (API)`),
    ];
    const missing = ce.filter((n) => !live.some((e) => e.name === n) && !((a?.events[n]?.androidSampled ?? 0) > 0));
    if (issues.length)
      return res("fail", `${issues.length} property issue${issues.length > 1 ? "s" : ""}`, 'Some event / user properties are sent with empty or "null" values, numbers as text or dates as text.', live.length ? "static" : "api", {
        remediation: `${faqFix(10) ?? ""} Leave a property out when it has no value — never send "", " " or "null".`.trim(),
        details: [...issues.slice(0, 10), ...details.slice(0, 4)],
      });
    if (live.length || apiEv.some((e) => e.androidSampled > 0)) {
      if (missing.length)
        return res("warn", `${ce.length - missing.length} of ${ce.length} listed custom events seen`, `Custom events arrive, but not seen yet: ${list(missing)}. Do those actions on the site, then press “Check CleverTap again”.`, live.length ? "static+api" : "api", { details });
      return res("pass", `${live.length || apiEv.filter((e) => e.androidSampled > 0).length} custom event${live.length === 1 ? "" : "s"} with valid properties`,
        live.length ? `While we browsed the site it sent ${list(live.map((e) => e.name))} with correctly typed properties.` : "Your custom events arrive in CleverTap with correctly typed properties.", live.length ? "static" : "api", { details });
    }
    if (s?.code.eventPush.found || s?.eventNames.length)
      return res("manual", "In the code — not fired yet", `The site's code sends custom events${s.eventNames.length ? ` (${list(s.eventNames, 6)})` : ""}, but none fired on the pages we opened (we only follow links, we don't click buttons). List your custom events and press “Check CleverTap again” after using the site.`, "static", { details: s.code.eventPush.evidence.slice(0, 3) });
    if (!s) return res("manual", "Not checked", NO_SCAN, "none");
    return res("warn", "No custom events found", "No clevertap.event.push calls in the site's code and none fired while we browsed.", "static", {
      remediation: 'Track your custom events with clevertap.event.push("Product Viewed", {"Product Name": "…", "Price": 59.99}).',
    });
  },

  "web-t3-web-push": ({ s, w, lv }) => {
    const lt = [lv?.push.tests.push, lv?.push.tests.deeplink].find((x) => x?.receivedAt || x?.viewedAt || x?.shownAt);
    if (lt)
      return res("pass", `Delivered to ${lv!.device === "android" ? "Chrome on the phone" : "Chrome"} in ${secs(lt, lt.receivedAt ?? lt.viewedAt ?? lt.shownAt!)}`,
        `A test web push sent at ${ago(lt.sentAt)} reached CleverTap's service worker in the live session${lt.viewedAt ? ", which reported Notification Viewed" : ""}${lt.clickedAt ? ", and you clicked it" : ""}.`, "device");
    const t = w?.tests?.push ?? w?.tests?.deeplink;
    if (t?.status === "confirmed")
      return res("pass", "Test web push delivered", `A test web push sent at ${ago(t.sentAt)} was ${t.clicked ? "clicked" : "shown"} — CleverTap recorded Notification ${t.clicked ? "Clicked" : "Viewed"} for the test user.`, "api");
    if (t?.status === "failed") return res("fail", "Test web push not sent", t.message ?? "CleverTap rejected the push.", "api", { remediation: faqFix(7) });
    if (!s) return res("manual", "Not checked", NO_SCAN, "none");
    const wp = s.webPush;
    const swOk = wp.serviceWorker.clevertap || (!!wp.registered && /clevertap|sw/i.test(wp.registered));
    const details = [
      `Service worker ${wp.serviceWorkerPath}: ${wp.serviceWorker.status ? `HTTP ${wp.serviceWorker.status}` : "not reachable"}${wp.serviceWorker.clevertap ? " · imports CleverTap" : ""}`,
      ...(wp.serviceWorker.imports ? [`importScripts: ${wp.serviceWorker.imports}`] : []),
      ...(wp.registered ? [`Registered: ${wp.registered}`] : []),
      `Web push config from CleverTap (VAPID): ${wp.vapidKey ? "received" : "not received"}`,
      `Permission prompt (notifications.push): ${wp.promptCalled ? "called" : s.code.notifications.found ? "in the code" : "not found"}`,
      ...(s.page.manifest ? [`manifest.json linked (${s.page.manifest})`] : ["No <link rel=manifest> — needed for web push on iPhone / iPad Safari"]),
    ];
    if (!s.page.https) return res("fail", "Site isn't HTTPS", "Browsers only allow web push on HTTPS sites.", "static", { remediation: "Serve the site over HTTPS.", details });
    if (!s.sdk.present) return res("fail", "SDK not found", "Web push needs the CleverTap SDK on the site.", "static", { details });
    if (!swOk)
      return res("fail", wp.serviceWorker.reachable ? "Service worker doesn't load CleverTap" : "Service worker file missing", wp.serviceWorker.reachable
        ? `${wp.serviceWorkerPath} exists but doesn't import CleverTap's push worker.`
        : `${wp.serviceWorkerPath} isn't served by the site${wp.serviceWorker.status ? ` (HTTP ${wp.serviceWorker.status})` : ""}, so no browser can subscribe to web push.`, "static", {
        remediation: faqFix(7) ?? "Host clevertap_sw.js at the site root, or add importScripts('https://s3-eu-west-1.amazonaws.com/static.wizrocket.com/js/sw_webpush.js') at the top of your own service worker.",
        details,
      });
    if (!wp.promptCalled && !s.code.notifications.found)
      return res("fail", "Visitors are never asked", "clevertap.notifications.push isn't called, so visitors never get the web push permission prompt and no token is created.", "static", {
        remediation: faqFix(7) ?? "Call clevertap.notifications.push({titleText, bodyText, okButtonText, rejectButtonText, serviceWorkerPath: '/clevertap_sw.js'}).",
        details,
      });
    if (!wp.vapidKey)
      return res("warn", "Web push channel not confirmed", "CleverTap didn't send the web push configuration to the site — the web push channel may not be set up on the dashboard.", "static", {
        remediation: "Dashboard → Settings → Channels → Web Push: add the browser keys (VAPID) and turn the channel on.",
        details,
      });
    if (lv?.push.permission === "denied")
      return res("manual", "Notifications blocked in the test Chrome", "In the live session's Chrome, notifications are blocked for the site. Click the lock icon in the address bar → Notifications → Allow, then reload.", "device", { details });
    const pending = [lv?.push.tests.push, lv?.push.tests.deeplink].find((x) => x && !x.receivedAt);
    if (pending && Date.now() - pending.sentAt > 120_000)
      return res(lv?.push.subscribed ? "fail" : "manual", lv?.push.subscribed ? "Not delivered to Chrome" : "Not subscribed in the test Chrome",
        lv?.push.subscribed
          ? "The test Chrome is subscribed, but CleverTap's service worker never received the test push (2+ minutes). Check the web push keys on the dashboard and that the token belongs to this user (log in, then allow notifications)."
          : "The test push wasn't received because the live session's Chrome has no push subscription. Click Allow on the site's prompt, then send again.",
        "device", { remediation: lv?.push.subscribed ? faqFix(7) : undefined, details });
    if (w?.user?.found && !w.user.webPushToken && !lv?.push.subscribed)
      return res("manual", "Test user not subscribed", "The site is set up, but the test user has no web push token yet. Open the site in Chrome, log in as the test user, click Allow on the prompt, then send the test push.", "api", { details });
    if (t?.status === "not-confirmed" || t?.status === "sent")
      return res("manual", "Sent — not confirmed yet", "The test web push was sent. When it shows, press “Check delivery”; tick it yourself if you saw it.", "api", { details });
    return res("manual", "Ready — send a test web push", "Service worker, permission prompt and CleverTap's web push config are all in place. Website tests → Send test web push confirms delivery.", "static", { details });
  },

  "web-t3-deeplink": ({ w, lv }) => {
    const lt = lv?.push.tests.deeplink;
    if (lt?.clickedAt) {
      if (lt.landedUrl && lt.deepLink && sameTarget(lt.landedUrl, lt.deepLink))
        return res("pass", "Opened the right page", `You clicked the test push and Chrome opened ${lt.landedUrl} — the link in the push.`, "device");
      if (lt.landedUrl)
        return res("fail", "Opened a different page", `The push linked to ${lt.deepLink}, but clicking it opened ${lt.landedUrl}.`, "device", {
          remediation: "Check redirects on that page (e.g. a login redirect that drops the original path), and that the service worker is CleverTap's (it opens the push's deep link).",
        });
      return res("manual", "Clicked — landing page not seen", "The click reached CleverTap's service worker, but no page opened in the test Chrome. Check the page that should open, then tick it.", "device");
    }
    if (lt?.receivedAt) return res("manual", "Delivered — click it", "The push with the link reached Chrome. Click the notification; we'll see which page opens.", "device");
    const t = w?.tests?.deeplink;
    if (t?.status === "confirmed" && t.clicked)
      return res("pass", "Clicked — Notification Clicked recorded", `The web push with ${t.deepLink} was clicked and CleverTap recorded it. Make sure the page that opened was ${t.deepLink}.`, "api");
    if (t?.status === "confirmed") return res("manual", "Shown, not clicked yet", "The push with the link was shown. Click it, check the right page opens, then press “Check delivery”.", "api");
    if (t?.status === "failed") return res("fail", "Not sent", t.message ?? "CleverTap rejected the push.", "api");
    return res("manual", "Not checked yet", "Website tests → Send test web push with a link (any https page of your site), click it and check where it lands.", "none");
  },
};

function secs(t: LivePushTest, at: number) {
  return `${Math.max(1, Math.round((at - t.sentAt) / 1000))} s`;
}

function sameTarget(a: string, b: string) {
  try {
    const x = new URL(a);
    const y = new URL(b);
    return x.origin === y.origin && x.pathname.replace(/\/$/, "") === y.pathname.replace(/\/$/, "");
  } catch {
    return a === b;
  }
}

/**
 * The live session (user's own Chrome) and the server crawl see the same kinds
 * of things; merge them so every rule uses the strongest evidence. Live wins.
 */
export function withLive(scan?: WebScanReport | null, live?: WebLiveFindings | null): WebScanReport | undefined {
  if (!live) return scan ?? undefined;
  const base: WebScanReport = scan
    ? structuredClone(scan)
    : {
        schema: 1,
        platform: "web",
        analyzer: "live-session",
        url: live.url,
        finalUrl: live.url,
        scannedAt: live.startedAt,
        durationMs: live.updatedAt - live.startedAt,
        page: { https: /^https:/.test(live.url) },
        sdk: { present: false, loading: "none", debugLogs: false },
        network: { requests: 0, accepted: 0, failed: 0, errors: [], webPushConfigured: false },
        privacy: { called: false, getLocation: false },
        utm: { tested: false, params: { source: "", medium: "", campaign: "" }, sent: false },
        webPush: { promptCalled: false, serviceWorkerPath: "/clevertap_sw.js", serviceWorker: { reachable: false, clevertap: false }, vapidKey: false },
        code: {
          scannedFiles: 0,
          scannedBytes: 0,
          ...Object.fromEntries(["onUserLogin", "profilePush", "eventPush", "privacy", "notifications", "getLocation", "setLogLevel"].map((k) => [k, { found: false, count: 0, evidence: [] }])),
        } as WebScanReport["code"],
        calls: [],
        eventNames: [],
        events: [],
        systemEvents: [],
        profiles: [],
        login: { attempted: false },
        pages: [],
        notes: [],
      };
  const sdk = base.sdk;
  sdk.present ||= live.sdk.present;
  if (sdk.loading === "none" && live.sdk.present) sdk.loading = "bundle";
  sdk.version ??= live.sdk.version;
  sdk.accountId ??= live.sdk.accountId;
  sdk.region ??= live.sdk.region;
  sdk.host ??= live.sdk.host;
  sdk.debugLogs ||= live.sdk.debugLogs;
  base.network.requests += live.network.requests;
  base.network.accepted += live.network.accepted;
  base.network.webPushConfigured ||= live.network.webPushConfigured;
  base.webPush.vapidKey ||= live.network.webPushConfigured;
  base.webPush.registered ??= live.push.serviceWorker;
  if (live.push.serviceWorker && /clevertap|sw_webpush/i.test(live.push.serviceWorker)) base.webPush.serviceWorker.clevertap = true;
  base.webPush.promptCalled ||= live.calls.some((c) => c.api === "notifications");
  base.privacy.called ||= live.calls.some((c) => c.api === "privacy");
  base.ctId ??= live.ctId;
  if (live.utm.tested && live.utm.sent) base.utm.sent = true;
  base.profiles = [...live.profiles, ...base.profiles].slice(0, 30);
  const names = new Set(live.events.map((e) => e.name));
  base.events = [...live.events, ...base.events.filter((e) => !names.has(e.name))];
  base.calls = [...base.calls, ...live.calls].slice(-300);
  base.pages = [...new Set([...base.pages, ...live.pages])].slice(0, 40);
  if (live.login.seen)
    base.login = {
      attempted: true,
      ok: true,
      message: "You logged in yourself in the live Chrome session.",
      revisit: live.revisit ? { onUserLogin: live.revisit.onUserLogin, identified: live.revisit.identified, checked: true } : base.login.revisit,
    };
  else if (live.revisit && base.login.ok) base.login.revisit = { onUserLogin: live.revisit.onUserLogin, identified: live.revisit.identified, checked: true };
  return base;
}

const LIVE_LOGIN_ITEMS = ["web-t2-identity", "web-t2-onuserlogin", "web-t2-phone", "web-t2-onuserlogin-existing"];

function propIssues(e: EventSample): string[] {
  const out: string[] = [];
  for (const [k, p] of Object.entries(e.props ?? {})) {
    if (p.types.nullish) out.push(`${k}: empty / "null" value`);
    if (p.numericStrings) out.push(`${k}: number sent as text`);
    if (p.dateLikeStrings) out.push(`${k}: date sent as text`);
  }
  return out;
}

function fmtEvent(e: WebEvent) {
  const props = Object.entries(e.props).map(([k, p]) => `${k}:${p.type}`).join(", ");
  return `${e.name} ×${e.count} on ${e.page}${props ? ` — ${props}` : ""}`;
}

/* ------------------------------------------------------------------ */

export function evaluateWeb(input: WebEngineInput): Record<string, ItemResult> {
  const ctx: Ctx = {
    ...input,
    s: withLive(input.scan, input.live),
    a: input.api?.ok ? input.api : undefined,
    w: input.api?.web,
    lv: input.live ?? undefined,
  };
  const lv = ctx.lv;
  const out: Record<string, ItemResult> = {};
  for (const item of itemsForPlatform("web")) {
    const rule = RULES[item.id];
    const r = rule ? rule(ctx) : res("manual", "Not automated yet", "Verify manually.", "none");
    // evidence that came from the live session is credited to it
    if (r.source === "static" && lv) {
      if (lv.login.seen && LIVE_LOGIN_ITEMS.includes(item.id)) r.source = "device";
      if (item.id === "web-t2-profile-push" && lv.calls.some((c) => c.api === "profile")) r.source = "device";
      if (item.id === "web-t3-custom-events" && lv.events.length) r.source = "device";
    }
    out[item.id] = { itemId: item.id, ...r };
  }
  return out;
}

/** Custom event names worth sampling through the API for a website audit. */
export function webEventNames(scan?: WebScanReport | null): string[] {
  return [...(scan?.events.map((e) => e.name) ?? []), ...(scan?.eventNames ?? [])];
}
