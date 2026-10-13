import "server-only";
import type { Browser, BrowserContext, HTTPRequest, HTTPResponse, Page } from "puppeteer-core";
import { launchBrowser } from "./browser";
import { decodeCtPayload } from "./lz";
import { isPublicHost } from "./safe-url";
import { analyzeProps, CT_HOST, pathOf, profilePush, siteOf, str, SYSTEM_EVENT, type Phase } from "./analyze";
import type { CodeUsage, WebEvent, WebProfilePush, WebScanReport } from "./types";

// ---------------------------------------------------------------------------
// Website crawler. Opens the site in headless Chromium the way a first-time
// visitor would and records exactly what the CleverTap Web SDK sends:
//
//  1. landing     — the URL with test UTM parameters, CleverTap debug logs on
//  2. login       — optional: signs in with a test account the user gave us
//  3. revisit     — opens the site again while logged in (returning user)
//  4. browse      — a few same-site pages, to see custom events fire
//  5. web push    — service worker file, VAPID key from CleverTap, prompt call
//
// Every request to *.clevertap-prod.com is decoded (LZ-compressed `d=` param),
// and an init script wraps clevertap.onUserLogin / profile / event /
// notifications / privacy .push so we know which API produced each payload.
// The JS the site loads is also searched for those calls (lazy chunks included,
// because the browser fetched them). Only links are followed — the crawler
// never clicks buttons other than the login form's submit.
// ---------------------------------------------------------------------------

export interface CrawlInput {
  url: URL;
  login?: { url?: string; username: string; password: string };
  maxPages?: number;
  budgetMs?: number;
}

export interface CrawlResult {
  report: WebScanReport;
  identity?: string; // raw Identity / Email the site sent on login — in memory only, for the API lookup
}

const ANALYZER = "ct-web-crawler/1";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const CT_SCRIPT = /clevertap(\.min)?\.js|d2r1yp2w7bby2u\.cloudfront\.net|static\.clevertap\.com\/js|wizrocket\.com\/js/i;
const SKIP_LINK = /log-?out|sign-?out|logoff|delete|remove|unsubscribe|deactivate|cancel|clear|reset|checkout|pay|order\/|admin|\.(pdf|zip|png|jpe?g|gif|svg|mp4|webp)$/i;

type HookCall = { api: "onUserLogin" | "profile" | "event" | "notifications" | "privacy"; args: unknown[]; at: number; url: string };

// Runs before any page script. Turns on the SDK's debug logs and wraps the
// public push APIs so each call is reported (with Dates as $D_ like the SDK).
// (__name: some bundlers wrap functions passed to page.evaluate with it.)
const HOOK = `(() => {
  if (!window.__name) window.__name = function (f) { return f; };
  try { sessionStorage.setItem("WZRK_D", ""); } catch (e) {}
  const report = (api, args) => {
    try {
      const json = JSON.stringify(args, function (k, v) { const raw = this[k]; return raw instanceof Date ? "$D_" + Math.floor(raw.getTime() / 1000) : v; });
      window.__ctAuditReport && window.__ctAuditReport(api, json ? json.slice(0, 20000) : "[]", location.href);
    } catch (e) {}
  };
  const APIS = ["onUserLogin", "profile", "event", "notifications", "privacy"];
  const wrap = (ct) => {
    if (!ct || typeof ct !== "object") return;
    for (const api of APIS) {
      const t = ct[api];
      if (!t || typeof t.push !== "function" || t.push.__ctAudit) continue;
      const orig = t.push;
      const w = function () { report(api, Array.prototype.slice.call(arguments)); return orig.apply(this, arguments); };
      w.__ctAudit = 1;
      try { t.push = w; } catch (e) {}
    }
  };
  let cur;
  try {
    Object.defineProperty(window, "clevertap", { configurable: true, enumerable: true, get() { return cur; }, set(v) { cur = v; wrap(v); } });
  } catch (e) {}
  setInterval(() => { wrap(cur); wrap(window.wizrocket); }, 200);
})();`;

export async function crawlSite(input: CrawlInput): Promise<CrawlResult> {
  const t0 = Date.now();
  const deadline = t0 + (input.budgetMs ?? 170_000);
  const left = () => deadline - Date.now();
  const origin = input.url.origin;
  const utm = { source: "ct_audit", medium: "integration_check", campaign: `audit_${t0.toString(36)}` };

  const report: WebScanReport = {
    schema: 1,
    platform: "web",
    analyzer: ANALYZER,
    url: input.url.href,
    finalUrl: input.url.href,
    scannedAt: t0,
    durationMs: 0,
    page: { https: input.url.protocol === "https:" },
    sdk: { present: false, loading: "none", debugLogs: false },
    network: { requests: 0, accepted: 0, failed: 0, errors: [], webPushConfigured: false },
    privacy: { called: false, getLocation: false },
    utm: { tested: true, params: utm, sent: false },
    webPush: { promptCalled: false, serviceWorkerPath: "/clevertap_sw.js", serviceWorker: { reachable: false, clevertap: false }, vapidKey: false },
    code: {
      scannedFiles: 0,
      scannedBytes: 0,
      onUserLogin: usage(),
      profilePush: usage(),
      eventPush: usage(),
      privacy: usage(),
      notifications: usage(),
      getLocation: usage(),
      setLogLevel: usage(),
    },
    calls: [],
    eventNames: [],
    events: [],
    systemEvents: [],
    profiles: [],
    login: { attempted: !!input.login },
    pages: [],
    notes: [],
  };

  let phase: Phase = "anonymous";
  let navStart = Date.now();
  let rawIdentity: string | undefined;
  const hookCalls: (HookCall & { phase: Phase })[] = [];
  const netProfiles: { profile: Record<string, unknown>; phase: Phase }[] = [];
  const events = new Map<string, WebEvent>();
  const scripts = new Map<string, string>();
  let scriptBytes = 0;
  let firstHtml = "";
  let swPathFromCall: string | undefined;

  const browser: Browser = await launchBrowser();
  try {
    // The default context, not a new one: the serverless Chromium (single-process)
    // crashes with "Target closed" when asked for a second context. Each check
    // launches and closes its own browser, so this is still isolated per run.
    const ctx: BrowserContext = browser.defaultBrowserContext();

    const setupPage = async (page: Page) => {
      await page.setUserAgent(UA);
      await page.setViewport({ width: 1366, height: 900 });
      await page.exposeFunction("__ctAuditReport", (api: HookCall["api"], json: string, url: string) => {
        let args: unknown[] = [];
        try {
          args = JSON.parse(json) as unknown[];
        } catch {
          /* ignore */
        }
        hookCalls.push({ api, args, at: Date.now(), url, phase });
      });
      await page.evaluateOnNewDocument(HOOK);
      await page.setRequestInterception(true);
      page.on("request", (req) => void onRequest(req));
      page.on("response", (res) => void onResponse(res));
      page.on("requestfailed", (req) => {
        if (isCt(req.url())) {
          report.network.failed++;
          pushOnce(report.network.errors, `Request failed: ${req.failure()?.errorText ?? "unknown"}`);
        }
      });
      page.on("console", (m) => {
        const t = m.text();
        if (/^CleverTap\b/.test(t)) report.sdk.debugLogs = true;
        // headless Chromium has no push service, so subscribing always fails here — not a site problem
        if (/Error subscribing|Registration failed|push service/i.test(t)) return;
        if (m.type() === "error" && /clevertap|wzrk/i.test(t)) pushOnce(report.network.errors, `Console: ${t.slice(0, 200)}`);
      });
    };

    const onRequest = async (req: HTTPRequest) => {
      const url = req.url();
      if (!/^https?:/i.test(url)) return req.continue().catch(() => {});
      let host = "";
      try {
        host = new URL(url).hostname;
      } catch {
        return req.abort().catch(() => {});
      }
      if (CT_HOST.test(host)) {
        recordCtRequest(url);
        return req.continue().catch(() => {});
      }
      const type = req.resourceType();
      if (type === "image" || type === "media" || type === "font") return req.abort().catch(() => {});
      if (!(await isPublicHost(host))) return req.abort("blockedbyclient").catch(() => {});
      return req.continue().catch(() => {});
    };

    const recordCtRequest = (url: string) => {
      report.network.requests++;
      const u = new URL(url);
      if (!report.sdk.firstRequestMs) report.sdk.firstRequestMs = Date.now() - navStart;
      report.sdk.present = true;
      report.sdk.host ??= u.hostname;
      const m = u.hostname.match(/^([a-z]+\d*)\.(clevertap-prod|wzrkt)\.com$/i);
      if (m && !report.sdk.region) report.sdk.region = m[1].toLowerCase().replace(/-spiky$/, "");
      const useIP = u.searchParams.get("useIP");
      if (useIP !== null && report.privacy.useIP === undefined) report.privacy.useIP = useIP === "true";
      const p = decodeCtPayload(url);
      if (!p) return;
      if (typeof p.id === "string") report.sdk.accountId ??= p.id;
      const lib = (p.af as { lib?: string } | undefined)?.lib;
      const v = lib?.match(/(\d+\.\d+\.\d+)/)?.[1];
      if (v) report.sdk.version ??= v;
      if (p.us || p.um || p.uc) {
        if (p.us === utm.source || p.uc === utm.campaign) report.utm.sent = true;
      }
      if (p.type === "event" && typeof p.evtName === "string") {
        const name = p.evtName;
        if (SYSTEM_EVENT.test(name)) {
          pushOnce(report.systemEvents, name);
          return;
        }
        const data = (p.evtData && typeof p.evtData === "object" ? p.evtData : {}) as Record<string, unknown>;
        const { props, issues } = analyzeProps(data);
        const prev = events.get(name);
        if (prev) {
          prev.count++;
          for (const [k, pr] of Object.entries(props)) prev.props[k] ??= pr;
          for (const i of issues) pushOnce(prev.issues, i);
        } else if (events.size < 40) {
          events.set(name, { name, count: 1, page: pathOf(typeof p.cpg === "string" ? p.cpg : "") || pathOf(url), props, issues });
        }
      } else if (p.type === "profile" && p.profile && typeof p.profile === "object") {
        const prof = p.profile as Record<string, unknown>;
        const keys = Object.keys(prof).filter((k) => k !== "ct_optout");
        if (keys.length) netProfiles.push({ profile: prof, phase });
      }
    };

    const onResponse = async (res: HTTPResponse) => {
      const url = res.url();
      let host = "";
      try {
        host = new URL(url).hostname;
      } catch {
        return;
      }
      const req = res.request();
      if (CT_HOST.test(host)) {
        if (res.status() >= 200 && res.status() < 300) report.network.accepted++;
        else {
          report.network.failed++;
          pushOnce(report.network.errors, `CleverTap answered HTTP ${res.status()}`);
        }
        const text = await res.text().catch(() => "");
        if (/enableWebPush\(\s*true/.test(text)) report.network.webPushConfigured = report.webPush.vapidKey = true;
        const g = text.match(/\$WZRK_WR\.s\(\s*'([^']+)'/)?.[1];
        if (g) {
          if (phase === "anonymous") report.ctId ??= g;
          else if (phase === "login") report.ctIdAfterLogin = g;
        }
        if (/account (is )?blocked|invalid account|account not found/i.test(text)) pushOnce(report.network.errors, text.slice(0, 160));
        return;
      }
      if (req.resourceType() === "document" && req.isNavigationRequest() && !firstHtml && res.status() < 400) {
        report.page.status = res.status();
        firstHtml = await res.text().catch(() => "");
      }
      if (CT_SCRIPT.test(url)) report.sdk.scriptUrl ??= url.split("?")[0];
      if (req.resourceType() === "script" && res.status() === 200 && scriptBytes < 25_000_000) {
        const text = await res.text().catch(() => "");
        if (text && text.length < 6_000_000 && !scripts.has(url)) {
          scripts.set(url, text);
          scriptBytes += text.length;
        }
      }
    };

    const settle = async (page: Page, ms: number) => {
      await page.waitForNetworkIdle({ idleTime: 800, timeout: Math.min(ms, Math.max(1000, left() - 5000)) }).catch(() => {});
      await sleep(Math.min(ms, Math.max(0, left() - 5000)));
    };

    const goto = async (page: Page, url: string, wait = 5000) => {
      navStart = Date.now();
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: Math.min(30_000, Math.max(5000, left() - 5000)) });
      } catch (e) {
        report.notes.push(`Couldn't open ${pathOf(url) || url}: ${(e as Error).message.split("\n")[0]}`);
        return false;
      }
      await settle(page, wait);
      pushOnce(report.pages, pathOf(page.url()));
      return true;
    };

    /* ---------------- 1. landing with UTM ---------------- */
    const page = await ctx.newPage();
    await setupPage(page);
    const landing = new URL(input.url.href);
    landing.searchParams.set("utm_source", utm.source);
    landing.searchParams.set("utm_medium", utm.medium);
    landing.searchParams.set("utm_campaign", utm.campaign);
    const opened = await goto(page, landing.href, 7000);
    if (!opened) throw new Error(`The website didn't open: ${report.notes.at(-1) ?? "unknown error"}`);
    report.finalUrl = page.url();
    report.utm.landedOn = pathOf(page.url());
    report.page.title = (await page.title().catch(() => "")) || undefined;
    const head = await page
      .evaluate(() => ({
        manifest: document.querySelector<HTMLLinkElement>('link[rel="manifest"]')?.getAttribute("href") ?? undefined,
        inline: Array.from(document.querySelectorAll("script:not([src])"))
          .map((s) => s.textContent ?? "")
          .filter((t) => /clevertap|wizrocket/i.test(t))
          .slice(0, 10),
      }))
      .catch(() => ({ manifest: undefined, inline: [] as string[] }));
    report.page.manifest = head.manifest;
    head.inline.forEach((t, i) => scripts.set(`inline:${i}`, t));
    report.ctId ??= (await readCtId(page)) ?? undefined;

    /* ---------------- 2. login ---------------- */
    if (input.login && left() > 40_000) {
      phase = "login";
      const before = report.ctId;
      const r = await login(page, input.login, origin, goto, left, () =>
        hookCalls.some((c) => c.phase === "login" && (c.api === "onUserLogin" || c.api === "profile") && !!(str(siteOf(c.args[0])?.Identity) || str(siteOf(c.args[0])?.Email))),
      );
      report.login = { attempted: true, ok: r.ok, url: r.url ? pathOf(r.url) : undefined, message: r.message };
      await settle(page, 4000);
      const after = await readCtId(page);
      if (after) report.ctIdAfterLogin = after;
      report.login.identityChanged = !!(before && after && before !== after);
      // the raw identity the site sent — used for the API lookup, never stored
      const oul = [...hookCalls].reverse().find((c) => (c.api === "onUserLogin" || c.api === "profile") && c.phase === "login");
      const site = siteOf(oul?.args[0]);
      const np = [...netProfiles].reverse().find((p) => p.phase === "login")?.profile;
      const id = str(site?.Identity) || str(site?.Email) || str(np?.Identity) || str(np?.Email);
      if (id) rawIdentity = id;
    }

    /* ---------------- 3. returning visitor ---------------- */
    // Allow notifications from here on so the SDK registers its service worker.
    await ctx.overridePermissions(origin, ["notifications"]).catch(() => {});
    if (left() > 25_000) {
      phase = "revisit";
      // Same tab (one tab keeps single-process Chromium stable). A new tab has an
      // empty sessionStorage but keeps cookies / localStorage — clear it to match.
      const p2 = page;
      await p2.evaluate(() => sessionStorage.clear()).catch(() => {});
      const callsBefore = hookCalls.length;
      const netBefore = netProfiles.length;
      await goto(p2, input.url.href, 6000);
      const revisitCalls = hookCalls.slice(callsBefore);
      const oulAgain =
        revisitCalls.some((c) => c.api === "onUserLogin") ||
        netProfiles.slice(netBefore).some((p) => !!(str(p.profile.Identity) || str(p.profile.Email)));
      const identified = await p2
        .evaluate(() => {
          try {
            const k = localStorage.getItem("WZRK_K");
            return !!k && k !== "{}" && k.length > 4;
          } catch {
            return false;
          }
        })
        .catch(() => false);
      if (report.login.attempted) report.login.revisit = { onUserLogin: oulAgain, identified, checked: true };
      report.webPush.registered = await p2
        .evaluate(async () => {
          try {
            await new Promise((r) => setTimeout(r, 1500));
            const regs = await navigator.serviceWorker.getRegistrations();
            return regs.map((r) => (r.active ?? r.installing ?? r.waiting)?.scriptURL).filter(Boolean)[0] ?? undefined;
          } catch {
            return undefined;
          }
        })
        .catch(() => undefined);

      /* ---------------- 4. browse a few pages ---------------- */
      phase = "browse";
      const links = await sameSiteLinks(p2, origin);
      const seen = new Set(report.pages);
      let visited = 0;
      for (const href of links) {
        if (visited >= (input.maxPages ?? 4) || left() < 20_000) break;
        const path = pathOf(href);
        if (seen.has(path)) continue;
        seen.add(path);
        visited++;
        await goto(p2, href, 3500);
      }

      /* ---------------- 5. web push files ---------------- */
      const swCall = hookCalls.find((c) => c.api === "notifications");
      const swArg = swCall && (swCall.args[0] as Record<string, unknown> | undefined);
      swPathFromCall = typeof swArg?.serviceWorkerPath === "string" ? swArg.serviceWorkerPath : undefined;
      report.webPush.serviceWorkerPath = swPathFromCall ?? "/clevertap_sw.js";
      const sw = await p2
        .evaluate(async (path: string) => {
          try {
            const r = await fetch(path, { cache: "no-store" });
            const t = r.ok ? await r.text() : "";
            return { status: r.status, text: t.slice(0, 4000), type: r.headers.get("content-type") ?? "" };
          } catch (e) {
            return { status: 0, text: "", type: String(e) };
          }
        }, report.webPush.serviceWorkerPath)
        .catch(() => ({ status: 0, text: "", type: "" }));
      const looksJs = !/text\/html/i.test(sw.type) && !/^\s*</.test(sw.text);
      report.webPush.serviceWorker = {
        status: sw.status || undefined,
        reachable: sw.status === 200 && looksJs,
        clevertap: sw.status === 200 && looksJs && /sw_webpush|clevertap|wzrk|wizrocket/i.test(sw.text),
        imports: sw.text.match(/importScripts\(\s*['"]([^'"]+)['"]/)?.[1],
      };
    }

    /* ---------------- results ---------------- */
    report.durationMs = Date.now() - t0;
    finishCalls(report, hookCalls);
    report.profiles = buildProfiles(hookCalls, netProfiles);
    // Requests are the source of truth; when none could be decoded, fall back to the hooked calls.
    if (!events.size)
      for (const c of hookCalls) {
        const [name, data] = c.args as [unknown, unknown];
        if (c.api !== "event" || typeof name !== "string" || SYSTEM_EVENT.test(name) || events.size >= 40) continue;
        const { props, issues } = analyzeProps(data && typeof data === "object" ? (data as Record<string, unknown>) : {});
        const prev = events.get(name);
        if (prev) prev.count++;
        else events.set(name, { name, count: 1, page: pathOf(c.url), props, issues });
      }
    report.events = [...events.values()].sort((a, b) => b.count - a.count);
    report.sdk.loading = sdkLoading(firstHtml, report.sdk.present || !!report.sdk.scriptUrl);
    report.sdk.present ||= report.sdk.loading !== "none";
    scanCode(report, scripts);
    if (!report.sdk.present) report.notes.push("No CleverTap requests were sent while the site was open, and no CleverTap code was found.");
    if (report.login.attempted && !report.login.ok) report.notes.push(`Test login: ${report.login.message ?? "didn't work"}`);
    return { report, identity: rawIdentity };
  } finally {
    await browser.close().catch(() => {});
  }
}

/* ------------------------------------------------------------------ */
/* login                                                               */
/* ------------------------------------------------------------------ */

type Goto = (page: Page, url: string, wait?: number) => Promise<boolean>;

async function login(
  page: Page,
  creds: { url?: string; username: string; password: string },
  origin: string,
  goto: Goto,
  left: () => number,
  identified: () => boolean,
): Promise<{ ok: boolean; url?: string; message: string }> {
  if (creds.url) {
    const target = new URL(creds.url, origin);
    if (target.origin !== origin) return { ok: false, message: "The login page must be on the same website." };
    await goto(page, target.href, 3000);
  }
  let fields = await tagLoginFields(page);
  if (!fields.user && !fields.pass) {
    // find a "Log in" link or button on the page
    const opened = await page
      .evaluate(() => {
        const re = /^\s*(log ?in|sign ?in|login|my account|account)\s*$/i;
        const els = Array.from(document.querySelectorAll<HTMLElement>("a[href], button"));
        const el = els.find((e) => re.test(e.innerText || e.getAttribute("aria-label") || ""));
        if (!el) return null;
        if (el instanceof HTMLAnchorElement) return el.href;
        el.setAttribute("data-ctaudit", "open-login");
        return "click";
      })
      .catch(() => null);
    if (opened === "click") {
      await page.click('[data-ctaudit="open-login"]').catch(() => {});
      await sleep(2000);
    } else if (opened && new URL(opened).origin === origin) {
      await goto(page, opened, 3000);
    }
    fields = await tagLoginFields(page);
  }
  if (!fields.user && !fields.pass) {
    const h = await loginHints(page);
    if (h.form === "social") return { ok: false, url: page.url(), message: `This site signs in with ${h.social.join(" / ")} only, which can't be automated. Use Website tests → Live session in your Chrome: you finish that step yourself and everything else is still checked automatically.` };
    return { ok: false, url: page.url(), message: "Couldn't find a login form. Add the login page URL (e.g. /login)." };
  }
  {
    const h = await loginHints(page);
    if (h.captcha) return { ok: false, url: page.url(), message: `The login page has a captcha, which can't be automated. Use Website tests → Live session in your Chrome: you finish that step yourself and everything else is still checked automatically.` };
  }

  const startUrl = page.url();
  if (fields.user) await typeInto(page, '[data-ctaudit="user"]', creds.username);
  if (!fields.pass) {
    // two-step login: email first, then the password page
    await submit(page, fields.submit);
    await sleep(3000);
    fields = await tagLoginFields(page);
    if (!fields.pass) {
      const h = await loginHints(page);
      return {
        ok: false,
        url: page.url(),
        message: h.form === "otp"
          ? `The site sent a one-time code (OTP) — the automatic check can't receive it. Use Website tests → Live session in your Chrome: you finish that step yourself and everything else is still checked automatically.`
          : h.captcha
            ? `A captcha appeared after the first step. Use Website tests → Live session in your Chrome: you finish that step yourself and everything else is still checked automatically.`
            : "No password field appeared after the email / phone step (magic-link logins can't be automated). Use Website tests → Live session in your Chrome: you finish that step yourself and everything else is still checked automatically.",
      };
    }
  }
  if (!creds.password) return { ok: false, url: page.url(), message: "The login form wants a password — add it to the test login." };
  await typeInto(page, '[data-ctaudit="pass"]', creds.password);
  await submit(page, fields.submit);

  // Logins are often client-side (Firebase / SPA router): no page load to wait
  // for. Poll until the site identifies the user, leaves the form or shows an error.
  const deadline = Date.now() + Math.min(20_000, Math.max(5000, left() - 25_000));
  let last = { pass: true, error: undefined as string | undefined };
  while (Date.now() < deadline) {
    await sleep(1000);
    if (identified()) return { ok: true, url: startUrl, message: "Logged in with the test account." };
    last = await page
      .evaluate(() => {
        const visible = (e: Element) => {
          const r = (e as HTMLElement).getBoundingClientRect();
          return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== "hidden";
        };
        const pass = Array.from(document.querySelectorAll('input[type="password"]')).some(visible);
        // any short visible message near the form that reads like an error (sites style these freely)
        const error = Array.from(document.querySelectorAll<HTMLElement>('[role="alert"], [aria-live], form p, form span, form div, p, span'))
          .filter(visible)
          .map((e) => e.innerText.trim())
          .find((t) => t && t.length < 200 && !t.includes("\n") && /invalid|incorrect|wrong|failed|not found|no account|too many|disabled|denied|captcha|auth\//i.test(t));
        return { pass, error };
      })
      .catch(() => ({ pass: false, error: undefined }));
    if (last.error) return { ok: false, url: startUrl, message: `The site said: “${last.error}”` };
    const h = await loginHints(page);
    if (h.form === "otp") return { ok: false, url: startUrl, message: `The site asked for a one-time code (OTP) after the password. Use Website tests → Live session in your Chrome: you finish that step yourself and everything else is still checked automatically.` };
    if (h.captcha) return { ok: false, url: startUrl, message: `The site showed a captcha after submitting. Use Website tests → Live session in your Chrome: you finish that step yourself and everything else is still checked automatically.` };
    if (!last.pass || page.url() !== startUrl) {
      await page.waitForNetworkIdle({ idleTime: 800, timeout: 6000 }).catch(() => {});
      return { ok: true, url: startUrl, message: "Logged in with the test account." };
    }
  }
  return {
    ok: false,
    url: startUrl,
    message: "Submitted the login form, but the site didn't log in or show an error within 20 s. Check the test account works in a normal browser; logins with a code (OTP) or captcha need the live session instead.",
  };
}

/** What kind of login UI is on the page (same rules as the live helper). */
async function loginHints(page: Page): Promise<{ form: "otp" | "password" | "phone" | "email-first" | "social" | "none"; captcha: boolean; social: string[] }> {
  return page
    .evaluate(() => {
      const visible = (e: Element) => {
        const r = (e as HTMLElement).getBoundingClientRect();
        const st = getComputedStyle(e);
        return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none";
      };
      const meta = (i: HTMLInputElement) => `${i.name} ${i.id} ${i.autocomplete} ${i.placeholder} ${i.getAttribute("aria-label") ?? ""}`.toLowerCase();
      const inputs = Array.from(document.querySelectorAll("input")).filter(visible);
      const password = inputs.some((i) => i.type === "password");
      const boxes = inputs.filter((i) => i.maxLength === 1 && /text|tel|number|^$/.test(i.type));
      const otp = inputs.some((i) => i.autocomplete === "one-time-code" || /otp|one.?time|verification|verify|passcode|\bcode\b|\bpin\b/.test(meta(i))) || boxes.length >= 4;
      const email = inputs.some((i) => i.type === "email" || /email|user|login|account/.test(meta(i)));
      const phone = inputs.some((i) => i.type === "tel" || /phone|mobile|msisdn/.test(meta(i)));
      const captcha = !!document.querySelector('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="turnstile"], iframe[src*="captcha"], .g-recaptcha, .h-captcha, .cf-turnstile, [data-sitekey]');
      const social = Array.from(document.querySelectorAll<HTMLElement>('button, a, [role="button"]'))
        .filter(visible)
        .map((e) => (e.innerText || e.getAttribute("aria-label") || "").trim())
        .filter((t) => t.length < 40 && /\b(google|apple|facebook|microsoft|github|linkedin)\b/i.test(t) && /(continue|sign|log|with|^google$|^apple$)/i.test(t))
        .map((t) => t.replace(/^(continue|sign ?in|log ?in|sign ?up) with /i, ""))
        .slice(0, 3);
      const form = otp ? "otp" : password ? "password" : phone ? "phone" : email ? "email-first" : social.length ? "social" : "none";
      return { form: form as "otp" | "password" | "phone" | "email-first" | "social" | "none", captcha, social };
    })
    .catch(() => ({ form: "none" as const, captcha: false, social: [] as string[] }));
}

async function tagLoginFields(page: Page): Promise<{ user: boolean; pass: boolean; submit: boolean }> {
  return page
    .evaluate(() => {
      document.querySelectorAll("[data-ctaudit]").forEach((e) => e.removeAttribute("data-ctaudit"));
      const visible = (e: Element) => {
        const r = (e as HTMLElement).getBoundingClientRect();
        const s = getComputedStyle(e);
        return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && !(e as HTMLInputElement).disabled;
      };
      const inputs = Array.from(document.querySelectorAll<HTMLInputElement>("input")).filter(visible);
      const pass = inputs.find((i) => i.type === "password");
      const scope: ParentNode = pass?.form ?? pass?.closest("form, [role=dialog], main, section, div") ?? document;
      const candidates = inputs.filter((i) => i !== pass && (scope === document || scope.contains(i)));
      const user =
        candidates.find((i) => i.type === "email") ??
        candidates.find((i) => /user|email|login|phone|mobile|account/i.test(`${i.name} ${i.id} ${i.autocomplete} ${i.placeholder}`) && /text|tel|email|^$/.test(i.type)) ??
        (pass ? candidates.find((i) => ["text", "tel", ""].includes(i.type)) : undefined);
      if (user) user.setAttribute("data-ctaudit", "user");
      if (pass) pass.setAttribute("data-ctaudit", "pass");
      const form = (pass ?? user)?.form ?? (pass ?? user)?.closest("form, [role=dialog]");
      const buttons = Array.from((form ?? document).querySelectorAll<HTMLElement>('button, input[type="submit"], [role="button"]')).filter(visible);
      const btn =
        buttons.find((b) => (b as HTMLButtonElement).type === "submit" && /log|sign|continue|next|submit|go/i.test(b.innerText || (b as HTMLInputElement).value || "")) ??
        buttons.find((b) => /^\s*(log ?in|sign ?in|continue|next|submit)\s*$/i.test(b.innerText || (b as HTMLInputElement).value || "")) ??
        (form ? buttons.find((b) => (b as HTMLButtonElement).type === "submit") : undefined);
      if (btn) btn.setAttribute("data-ctaudit", "submit");
      return { user: !!user, pass: !!pass, submit: !!btn };
    })
    .catch(() => ({ user: false, pass: false, submit: false }));
}

async function typeInto(page: Page, selector: string, value: string) {
  await page.click(selector, { count: 3 }).catch(() => {});
  await page.type(selector, value, { delay: 15 }).catch(() => {});
}

async function submit(page: Page, hasButton: boolean) {
  if (hasButton) await page.click('[data-ctaudit="submit"]').catch(() => page.keyboard.press("Enter"));
  else await page.keyboard.press("Enter").catch(() => {});
}

async function sameSiteLinks(page: Page, origin: string): Promise<string[]> {
  const hrefs = await page
    .evaluate(() => Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]")).map((a) => a.href))
    .catch(() => [] as string[]);
  const out: string[] = [];
  const paths = new Set<string>();
  for (const h of hrefs) {
    try {
      const u = new URL(h);
      if (u.origin !== origin || SKIP_LINK.test(u.pathname) || paths.has(u.pathname)) continue;
      paths.add(u.pathname);
      u.hash = "";
      out.push(u.href);
    } catch {
      /* ignore */
    }
  }
  // prefer different kinds of pages (product / category / cart …) over siblings
  const byFirstSegment = new Map<string, string>();
  for (const u of out) {
    const seg = new URL(u).pathname.split("/")[1] ?? "";
    if (!byFirstSegment.has(seg)) byFirstSegment.set(seg, u);
  }
  return [...byFirstSegment.values(), ...out].slice(0, 12);
}

async function readCtId(page: Page): Promise<string | null> {
  return page
    .evaluate(() => {
      try {
        const w = window as unknown as { clevertap?: { getCleverTapID?: () => string } };
        const id = w.clevertap?.getCleverTapID?.();
        if (id) return id;
        const g = localStorage.getItem("WZRK_G");
        return g ? decodeURIComponent(g).replace(/^"|"$/g, "") : null;
      } catch {
        return null;
      }
    })
    .catch(() => null);
}

/* ------------------------------------------------------------------ */
/* analysis                                                            */
/* ------------------------------------------------------------------ */

function finishCalls(report: WebScanReport, calls: (HookCall & { phase: Phase })[]) {
  report.calls = calls.slice(0, 200).map((c) => ({ api: c.api, phase: c.phase, at: c.at }));
  for (const c of calls) {
    const a = c.args[0] as Record<string, unknown> | undefined;
    if (c.api === "privacy" && a && typeof a === "object") {
      report.privacy.called = true;
      if (typeof a.optOut === "boolean") report.privacy.optOut = a.optOut;
      if (typeof a.useIP === "boolean") report.privacy.useIP = a.useIP;
    }
    if (c.api === "notifications") {
      report.webPush.promptCalled = true;
      if (a && typeof a === "object" && !a.skipDialog) report.webPush.softPrompt = true;
    }
  }
}

function buildProfiles(calls: (HookCall & { phase: Phase })[], net: { profile: Record<string, unknown>; phase: Phase }[]): WebProfilePush[] {
  const fromHook = calls.filter((c) => c.api === "onUserLogin" || c.api === "profile");
  const src = fromHook.length
    ? fromHook.map((c) => ({ via: c.api as "onUserLogin" | "profile", phase: c.phase, site: siteOf(c.args[0]) ?? {} }))
    : net.map((n) => ({ via: "unknown" as const, phase: n.phase, site: n.profile }));
  return src.slice(0, 20).map(({ via, phase, site }) => profilePush(via, phase, site));
}

function sdkLoading(html: string, present: boolean): WebScanReport["sdk"]["loading"] {
  const lower = html.toLowerCase();
  const headEnd = lower.indexOf("</head>");
  const re = /clevertap(\.min)?\.js|d2r1yp2w7bby2u\.cloudfront\.net|clevertap\.account\.push|wizrocket/;
  const idx = lower.search(re);
  if (idx >= 0) return headEnd < 0 || idx < headEnd ? "head" : "body";
  return present ? "bundle" : "none";
}

const PATTERNS: [keyof Omit<WebScanReport["code"], "scannedFiles" | "scannedBytes">, RegExp][] = [
  ["onUserLogin", /\bonUserLogin\s*\.\s*push\s*\(/g],
  ["profilePush", /\.\s*profile\s*\.\s*push\s*\(/g],
  ["eventPush", /\.\s*event\s*\.\s*push\s*\(/g],
  ["privacy", /\.\s*privacy\s*\.\s*push\s*\(/g],
  ["notifications", /\.\s*notifications\s*\.\s*push\s*\(/g],
  ["getLocation", /\.\s*getLocation\s*\(/g],
  ["setLogLevel", /\.\s*setLogLevel\s*\(/g],
];
const WRAPPER_CALL = /\b([\w$]*(?:track|Track|Event)[\w$]*)\)?\(\s*["']([A-Z][^"'\\\n]{1,60})["']\s*[,)]/g;
const NOT_WRAPPER = /^(add|remove)EventListener$|^dispatchEvent$|^(Custom)?Event$|^createEvent$|^initEvent$/;

function scanCode(report: WebScanReport, scripts: Map<string, string>) {
  const names = new Set<string>();
  for (const [url, text] of scripts) {
    if (!/clevertap|wizrocket|wzrk/i.test(text)) continue;
    // the SDK's own file defines these APIs — only count the site's calls
    const isSdk = /web-sdk-v\d|WZRK_EV/.test(text) && (text.match(/WZRK_/g)?.length ?? 0) > 15;
    report.code.scannedFiles++;
    report.code.scannedBytes += text.length;
    if (isSdk && !url.startsWith("inline:")) continue;
    for (const [key, re] of PATTERNS) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      const u = report.code[key];
      while ((m = re.exec(text)) && u.count < 50) {
        u.found = true;
        u.count++;
        if (u.evidence.length < 4) u.evidence.push(snippet(text, m.index));
      }
    }
    for (const m of text.matchAll(/\.\s*event\s*\.\s*push\s*\(\s*["'`]([^"'`\n]{2,80})["'`]/g)) names.add(m[1]);
    for (const m of text.matchAll(WRAPPER_CALL)) if (!NOT_WRAPPER.test(m[1])) names.add(m[2].trim());
    if (/\.spa\s*=\s*(!0|true)\b|spa\s*:\s*(!0|true)\b/.test(text)) report.sdk.spa = true;
  }
  if (report.code.getLocation.found) report.privacy.getLocation = true;
  if (report.code.privacy.found) report.privacy.called = true;
  if (report.code.notifications.found) report.webPush.promptCalled ||= report.calls.some((c) => c.api === "notifications");
  report.eventNames = [...names].filter((n) => !SYSTEM_EVENT.test(n) && !/[{}<>]/.test(n)).slice(0, 60);
}

/* ------------------------------------------------------------------ */

function usage(): CodeUsage {
  return { found: false, count: 0, evidence: [] };
}

function snippet(text: string, at: number) {
  const s = text.slice(Math.max(0, at - 50), at + 90).replace(/\s+/g, " ");
  return s.length > 140 ? s.slice(0, 140) + "…" : s;
}


function isCt(url: string) {
  try {
    return CT_HOST.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

function pushOnce(list: string[], v: string) {
  if (list.length < 12 && !list.includes(v)) list.push(v);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
