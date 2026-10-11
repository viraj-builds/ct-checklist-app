#!/usr/bin/env node
// CleverTap Integration Audit — local website helper.
//
// Opens your website in a real, visible Chrome window (on this computer, or in
// Chrome on an Android phone over USB) and reports what the CleverTap Web SDK
// does while YOU use the site: log in any way you like (OTP, Google, captcha —
// all fine), allow notifications, edit your profile, shop around. It also
// watches CleverTap's service worker, so a test web push is detected the moment
// it arrives and when you click it — no "check delivery" needed.
//
//   node ct-web-bridge.mjs [--origin https://your-audit-site] [--port 47813] [--profile <dir>]
//
// Safety:
//   - listens on 127.0.0.1 only; only the audit site's origin may call it, and
//     the audit page picks up the one-time token by itself
//   - uses its OWN Chrome profile (~/.ct-audit-chrome), never your normal one
//   - only opens http(s) pages you ask for; never types or clicks for you
//   - what it sees stays on this computer and the audit page in your browser;
//     the page masks emails / phones before saving the results
//   - no dependencies; needs Node 22+ and Google Chrome (Android: adb + USB debugging)

import http from "node:http";
import { spawn, execFile } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const PORT = Number(flag("--port", "47813"));
const ORIGINS = new Set(["http://localhost:3000", ...flag("--origin", "").split(",").filter(Boolean)].map((o) => o.replace(/\/$/, "")));
const TOKEN = randomBytes(12).toString("hex");
const HELPER_VERSION = 3; // lib/web/live.ts WEB_HELPER_MIN_VERSION
const PROFILE_DIR = flag("--profile", join(homedir() || tmpdir(), ".ct-audit-chrome"));
const ANDROID_PORT = 9333;
const CT_HOST = /(^|\.)(clevertap-prod\.com|wzrkt\.com)$/i;

if (typeof WebSocket === "undefined") {
  console.error("\n  This helper needs Node.js 22 or newer (it uses the built-in WebSocket). You have " + process.version + ".\n");
  process.exit(1);
}

/* ------------------------------------------------------------------ */
/* the hook every page gets before its own scripts run                */
/* ------------------------------------------------------------------ */

const HOOK = `(() => {
  if (window.__ctAuditHooked) return; window.__ctAuditHooked = 1;
  try { sessionStorage.setItem("WZRK_D", ""); } catch (e) {}
  const report = (api, args) => {
    try {
      const json = JSON.stringify(args, function (k, v) { const raw = this[k]; return raw instanceof Date ? "$D_" + Math.floor(raw.getTime() / 1000) : v; });
      window.__ctAuditReport && window.__ctAuditReport(JSON.stringify({ api, json: (json || "[]").slice(0, 20000), url: location.href }));
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
  try { Object.defineProperty(window, "clevertap", { configurable: true, enumerable: true, get() { return cur; }, set(v) { cur = v; wrap(v); } }); } catch (e) {}
  setInterval(() => { wrap(cur); wrap(window.wizrocket); }, 200);
})();`;

// Looks at whatever login UI is on the page, so the audit page can tell the user
// exactly what's needed: we can fill it, or they must type a code / solve a
// captcha / use Google sign-in themselves. Shared by STATE and FILL.
const HINTS = `const visible = (e) => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && !e.disabled; };
  const meta = (i) => (i.name + " " + i.id + " " + i.autocomplete + " " + i.placeholder + " " + (i.getAttribute("aria-label") || "")).toLowerCase();
  const loginHints = () => {
    const inputs = Array.from(document.querySelectorAll("input")).filter(visible);
    const password = inputs.some((i) => i.type === "password");
    const boxes = inputs.filter((i) => i.maxLength === 1 && /text|tel|number|^$/.test(i.type));
    const otp = inputs.some((i) => i.autocomplete === "one-time-code" || /otp|one.?time|verification|verify|passcode|\\bcode\\b|\\bpin\\b/.test(meta(i))) || boxes.length >= 4;
    const email = inputs.some((i) => i.type === "email" || /email|user|login|account/.test(meta(i)));
    const phone = inputs.some((i) => i.type === "tel" || /phone|mobile|msisdn/.test(meta(i)));
    const captcha = !!document.querySelector('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="turnstile"], iframe[src*="captcha"], .g-recaptcha, .h-captcha, .cf-turnstile, [data-sitekey]');
    const social = Array.from(document.querySelectorAll('button, a, [role="button"]')).filter(visible)
      .map((e) => (e.innerText || e.getAttribute("aria-label") || "").trim())
      .filter((t) => t.length < 40 && /\\b(google|apple|facebook|microsoft|github|linkedin)\\b/i.test(t) && /(continue|sign|log|with|^google$|^apple$)/i.test(t))
      .map((t) => t.replace(/^(continue|sign ?in|log ?in|sign ?up) with /i, ""))
      .slice(0, 3);
    const form = otp ? "otp" : password ? "password" : phone ? "phone" : email ? "email-first" : social.length ? "social" : "none";
    return { form, captcha, social };
  };`;

// Read in the open page every few seconds.
const STATE = `(async () => {
  ${HINTS}
  const out = { url: location.href, permission: typeof Notification === "undefined" ? undefined : Notification.permission, subscribed: false, sw: undefined, ctId: undefined, identified: false, shown: [], login: undefined };
  try { out.ctId = window.clevertap && window.clevertap.getCleverTapID ? window.clevertap.getCleverTapID() : undefined; } catch (e) {}
  try { const k = localStorage.getItem("WZRK_K"); out.identified = !!k && k !== "{}" && k.length > 4; } catch (e) {}
  try { out.login = loginHints(); } catch (e) {}
  try {
    const regs = navigator.serviceWorker ? await navigator.serviceWorker.getRegistrations() : [];
    for (const r of regs) {
      const w = r.active || r.waiting || r.installing;
      if (w && !out.sw) out.sw = w.scriptURL;
      try { if (await r.pushManager.getSubscription()) out.subscribed = true; } catch (e) {}
      try { for (const n of await r.getNotifications()) out.shown.push({ title: n.title, body: n.body, tag: n.tag, id: n.data && n.data.wzrk_id }); } catch (e) {}
    }
  } catch (e) {}
  return out;
})()`;

// Fills the site's login form in the open tab (values set the way React / Vue
// notice them) and submits it. Works through email-first and phone-first forms;
// stops and says what the user must do for codes (OTP), captchas or Google /
// Apple sign-in. `needs` tells the audit page that the user has to act.
const FILL = (username, password) => `(async () => {
  const U = ${JSON.stringify(String(username))}, P = ${JSON.stringify(String(password || ""))};
  ${HINTS}
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const set = (el, v) => {
    el.focus();
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.blur();
  };
  const isPhone = /^\\+?[\\d\\s()-]{7,}$/.test(U);
  const find = () => {
    const inputs = Array.from(document.querySelectorAll("input")).filter(visible);
    const pass = inputs.find((i) => i.type === "password");
    const scope = (pass && (pass.form || pass.closest("form, [role=dialog], main, section, div"))) || document;
    const cand = inputs.filter((i) => i !== pass && !["checkbox", "radio", "hidden", "submit", "button", "search"].includes(i.type) && (scope === document || scope.contains(i)));
    const phoneField = cand.find((i) => i.type === "tel" || /phone|mobile|msisdn/.test(meta(i)));
    const emailField = cand.find((i) => i.type === "email") || cand.find((i) => /user|email|login|account/.test(meta(i)));
    const user = (isPhone ? phoneField || emailField : emailField || phoneField) || (pass ? cand.find((i) => ["text", "tel", ""].includes(i.type)) : undefined);
    const anchor = pass || user;
    const form = anchor && (anchor.form || anchor.closest("form, [role=dialog]"));
    const btns = Array.from((form || document).querySelectorAll('button, input[type="submit"], [role="button"]')).filter(visible);
    const label = (b) => (b.innerText || b.value || b.getAttribute("aria-label") || "").trim();
    const btn = btns.find((b) => b.type === "submit" && /log|sign|continue|next|submit|go|otp|code/i.test(label(b)))
      || btns.find((b) => /^(log ?in|sign ?in|continue|next|submit|get otp|send otp|send code)$/i.test(label(b)))
      || (form ? btns.find((b) => b.type === "submit") : undefined);
    return { user, pass, form, btn };
  };
  const submit = (f) => {
    if (f.btn) f.btn.click();
    else if (f.form && f.form.requestSubmit) f.form.requestSubmit();
  };
  const siteError = () => Array.from(document.querySelectorAll('[role="alert"], [aria-live], p, span, div'))
    .filter(visible).map((e) => (e.innerText || "").trim())
    .find((t) => t && t.length < 160 && !t.includes("\\n") && /invalid|incorrect|wrong|failed|not found|no account|too many|disabled|blocked|auth\\//i.test(t));
  // after each step: is there something only the user can do?
  const needs = () => {
    const h = loginHints();
    if (h.form === "otp") return { ok: true, needs: "otp", message: "Enter the code (OTP) the site sent you in the test Chrome window — we'll see the login when it goes through." };
    if (h.captcha) return { ok: true, needs: "captcha", message: "The site shows a captcha. Solve it in the test Chrome window and press the login button there." };
    return null;
  };

  let f = find();
  let h = loginHints();
  if (!f.user && !f.pass) {
    if (h.form === "social") return { ok: false, needs: "social", message: "This page only offers " + h.social.join(" / ") + " sign-in. Log in yourself in the test Chrome window — we can't type into Google / Apple pages." };
    const link = Array.from(document.querySelectorAll("a[href], button")).find((e) => /^\\s*(log ?in|sign ?in|login|my account|account|sign ?up \\/ log ?in)\\s*$/i.test(e.innerText || e.getAttribute("aria-label") || ""));
    if (!link) return { ok: false, needs: "page", message: "No login form on this page. Enter your Login page (e.g. /login) in the card above, or open it in the test Chrome, then press Fill in test login again." };
    link.click();
    await wait(2500);
    f = find();
    h = loginHints();
    if (!f.user && !f.pass) {
      if (h.form === "social") return { ok: false, needs: "social", message: "The login page only offers " + h.social.join(" / ") + " sign-in. Log in yourself in the test Chrome window." };
      return { ok: false, needs: "page", message: "Opened the login link, but no login form appeared. Enter your Login page in the card above and try again." };
    }
  }
  if (f.user) set(f.user, U);
  if (!f.pass) {
    // email-first / phone-first: submit the first step, then see what comes next
    if (h.captcha) return { ok: true, needs: "captcha", message: "Filled in the " + (isPhone ? "phone number" : "email") + ". Solve the captcha in the test Chrome window, then continue there." };
    submit(f);
    await wait(3000);
    const err = siteError();
    if (err) return { ok: false, message: "The site said: " + err };
    const n = needs();
    if (n) return n;
    f = find();
    if (!f.pass) return { ok: true, needs: "more", message: "Submitted the " + (isPhone ? "phone number" : "email") + ". Finish the next step in the test Chrome window — we'll see the login when it goes through." };
  }
  if (!P) return { ok: true, needs: "password", message: "This form wants a password — enter it in the card above, or type it in the test Chrome window." };
  set(f.pass, P);
  if (loginHints().captcha) return { ok: true, needs: "captcha", message: "Filled in the login. Solve the captcha in the test Chrome window and press the login button there." };
  await wait(200);
  submit(f);
  await wait(4000);
  const err = siteError();
  if (err) return { ok: false, message: "The site said: " + err };
  const n = needs();
  if (n) return n;
  return find().pass
    ? { ok: true, needs: "more", message: "Submitted. If the site asks for anything else, finish it in the test Chrome window." }
    : { ok: true, message: "Submitted the test login — watching for onUserLogin." };
})()`;

/* ------------------------------------------------------------------ */
/* minimal Chrome DevTools Protocol client                            */
/* ------------------------------------------------------------------ */

class Cdp {
  constructor(url) {
    this.url = url;
    this.seq = 0;
    this.pending = new Map();
    this.listeners = new Set();
    this.closed = false;
  }
  open() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.onopen = () => resolve(this);
      ws.onerror = () => reject(new Error("Couldn't connect to Chrome's debugging port."));
      ws.onclose = () => {
        this.closed = true;
        for (const p of this.pending.values()) p.reject(new Error("Chrome closed"));
        this.pending.clear();
        for (const l of this.listeners) l({ method: "__closed" });
      };
      ws.onmessage = (m) => {
        let msg;
        try { msg = JSON.parse(typeof m.data === "string" ? m.data : Buffer.from(m.data).toString()); } catch { return; }
        if (msg.id && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) p.reject(new Error(msg.error.message));
          else p.resolve(msg.result);
        } else for (const l of this.listeners) l(msg);
      };
    });
  }
  send(method, params = {}, sessionId) {
    if (this.closed) return Promise.reject(new Error("Chrome is closed"));
    const id = ++this.seq;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => this.pending.delete(id) && reject(new Error(`${method} timed out`)), 20_000);
    });
  }
  close() { try { this.ws.close(); } catch {} }
}

/* ------------------------------------------------------------------ */
/* the session                                                        */
/* ------------------------------------------------------------------ */

let session = null; // { cdp, device, proc, sessions: Map, siteOrigin, events, ... }
let seq = 0;

function record(kind, data = {}) {
  if (!session) return;
  session.events.push({ seq: ++seq, t: Date.now(), kind, ...data });
  if (session.events.length > 6000) session.events.splice(0, session.events.length - 5000);
}

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const local = process.env.LOCALAPPDATA || "";
  const list = {
    win32: [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      join(local, "Google", "Chrome", "Application", "chrome.exe"),
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    ],
    darwin: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"],
    linux: ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"],
  }[process.platform] || [];
  return list.find((p) => p && existsSync(p));
}

function findAdb() {
  const exe = process.platform === "win32" ? "adb.exe" : "adb";
  const home = homedir();
  const roots = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT,
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Android", "Sdk"),
    home && join(home, "Library", "Android", "sdk"), home && join(home, "Android", "Sdk")].filter(Boolean);
  for (const r of roots) for (const p of [join(r, "platform-tools", exe), join(r, exe)]) if (existsSync(p)) return p;
  for (const dir of (process.env.PATH || "").split(delimiter)) if (dir && existsSync(join(dir, exe))) return join(dir, exe);
  return exe;
}

const adb = (argv) => new Promise((resolve, reject) =>
  execFile(findAdb(), argv, { timeout: 20_000, windowsHide: true }, (err, stdout, stderr) => (err ? reject(new Error((stderr || err.message).trim())) : resolve(String(stdout)))));

async function waitFor(fn, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn().catch(() => undefined);
    if (v) return v;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Timed out waiting for ${what}.`);
}

async function launchDesktop(fresh) {
  const chrome = findChrome();
  if (!chrome) throw new Error("Google Chrome not found. Install it, or start the helper with CHROME_PATH=/path/to/chrome.");
  if (fresh) {
    try {
      rmSync(PROFILE_DIR, { recursive: true, force: true });
    } catch (e) {
      if (e.code === "EBUSY" || e.code === "EPERM")
        throw new Error("The test Chrome from an earlier session is still open. Close that Chrome window (or press Close Chrome), then try again.");
      throw e;
    }
  }
  mkdirSync(PROFILE_DIR, { recursive: true });
  const portFile = join(PROFILE_DIR, "DevToolsActivePort");
  rmSync(portFile, { force: true });
  const proc = spawn(chrome, [
    "--remote-debugging-port=0",
    `--user-data-dir=${PROFILE_DIR}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--new-window",
    "about:blank",
  ], { stdio: "ignore", detached: false, windowsHide: false });
  proc.on("exit", () => session?.proc === proc && record("closed"));
  const [port, path] = await waitFor(async () => {
    const t = readFileSync(portFile, "utf8").trim().split(/\r?\n/);
    return t.length >= 2 ? t : undefined;
  }, 20_000, "Chrome to start");
  return { proc, ws: `ws://127.0.0.1:${port}${path}` };
}

async function launchAndroid() {
  const devices = (await adb(["devices"])).split("\n").slice(1).filter((l) => /\tdevice$/.test(l.trim()));
  if (!devices.length) throw new Error("No Android phone found. Connect it with USB debugging on, and allow this computer on the phone.");
  await adb(["shell", "am", "start", "-n", "com.android.chrome/com.google.android.apps.chrome.Main"]).catch(() => "");
  await adb(["forward", `tcp:${ANDROID_PORT}`, "localabstract:chrome_devtools_remote"]);
  const info = await waitFor(async () => (await fetch(`http://127.0.0.1:${ANDROID_PORT}/json/version`)).json(), 15_000, "Chrome on the phone");
  if (!info.webSocketDebuggerUrl) throw new Error("Chrome on the phone didn't expose debugging. Open Chrome on the phone once, then retry.");
  return { proc: null, ws: info.webSocketDebuggerUrl.replace(/^ws:\/\/[^/]+/, `ws://127.0.0.1:${ANDROID_PORT}`), browser: info.Browser };
}

async function start({ url, device, fresh }) {
  await stop();
  const target = new URL(url);
  if (!/^https?:$/.test(target.protocol)) throw new Error("Only http(s) websites.");
  const launched = device === "android" ? await launchAndroid() : await launchDesktop(fresh);
  const cdp = await new Cdp(launched.ws).open();
  const version = await cdp.send("Browser.getVersion").catch(() => ({}));
  session = { cdp, device, proc: launched.proc, sessions: new Map(), ready: new Map(), siteOrigin: target.origin, events: [], ct: new Map(), lastState: "", startedAt: Date.now(), browser: version.product || launched.browser };
  cdp.listeners.add(onMessage);
  await cdp.send("Target.setDiscoverTargets", { discover: true });
  await cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  record("started", { device, browser: session.browser, url: target.href });
  const targetId = await openHooked(target.href);
  // close the helper's blank start tab (desktop only)
  if (device !== "android") {
    const { targetInfos } = await cdp.send("Target.getTargets");
    for (const t of targetInfos) if (t.type === "page" && t.url === "about:blank" && t.targetId !== targetId) cdp.send("Target.closeTarget", { targetId: t.targetId }).catch(() => {});
  }
  session.poll = setInterval(pollState, 2500);
}

async function stop() {
  if (!session) return;
  const s = session;
  clearInterval(s.poll);
  if (s.device === "android") s.cdp.close();
  else {
    await s.cdp.send("Browser.close").catch(() => {});
    s.cdp.close();
    try { s.proc?.kill(); } catch {}
  }
  session = null;
}

/**
 * New tab → wait until our hook is installed in it → only then navigate. (A tab
 * created with the URL directly commits its first page before we can attach.)
 */
async function openHooked(url) {
  const s = session;
  const { targetId } = await s.cdp.send("Target.createTarget", { url: "about:blank" });
  const sessionId = await waitFor(async () => s.ready.get(targetId), 10_000, "the new tab");
  s.mainTarget = targetId;
  await s.cdp.send("Page.navigate", { url }, sessionId);
  return targetId;
}

async function openTab(url) {
  if (!session) throw new Error("Open the website first.");
  const u = new URL(url);
  if (u.origin !== session.siteOrigin) throw new Error("Only pages of the website under audit.");
  record("tab", { url: u.href });
  await openHooked(u.href);
}

function mainPageSession() {
  const s = session;
  const pages = [...s.sessions.entries()].filter(([, m]) => m.type === "page" && m.url && m.url.startsWith(s.siteOrigin));
  return (pages.find(([, m]) => m.targetId === s.mainTarget) ?? pages.at(-1))?.[0];
}

async function login({ username, password, url }) {
  if (!session) throw new Error("Open the website first.");
  if (typeof username !== "string" || !username || username.length > 200 || (password !== undefined && (typeof password !== "string" || password.length > 200)))
    throw new Error("Enter the test account's email, phone or username (and the password if the site uses one).");
  if (url) {
    const u = new URL(url, session.siteOrigin);
    if (u.origin !== session.siteOrigin) throw new Error("The login page must be on the website under audit.");
    const sid = mainPageSession();
    if (!sid) throw new Error("The website tab was closed — open the website again.");
    await session.cdp.send("Page.navigate", { url: u.href }, sid);
    await new Promise((r) => setTimeout(r, 3500));
  }
  const sid = mainPageSession();
  if (!sid) throw new Error("The website tab was closed — open the website again.");
  record("login-fill"); // never the values
  try {
    const r = await session.cdp.send("Runtime.evaluate", { expression: FILL(username, password), awaitPromise: true, returnByValue: true, userGesture: true }, sid);
    return r?.result?.value ?? { ok: false, message: "Couldn't run on the page." };
  } catch (e) {
    // the page reloaded after submitting — that's the normal result of a successful login
    if (/navigated|closed|context was destroyed/i.test(e.message)) return { ok: true, message: "Submitted — the site moved on after login. Watching for onUserLogin." };
    throw e;
  }
}

async function onAttached({ sessionId, targetInfo, waitingForDebugger }) {
  const s = session;
  if (!s) return;
  const send = (m, p) => s.cdp.send(m, p, sessionId).catch(() => {});
  s.sessions.set(sessionId, { type: targetInfo.type, targetId: targetInfo.targetId, url: targetInfo.url });
  try {
    if (targetInfo.type === "page") {
      await send("Page.enable");
      await send("Runtime.addBinding", { name: "__ctAuditReport" });
      await send("Page.addScriptToEvaluateOnNewDocument", { source: HOOK, runImmediately: true });
      await send("Runtime.enable");
      await send("Network.enable");
      // follow iframes / dedicated workers of the page too
      await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    } else if (targetInfo.type === "service_worker" && targetInfo.url.startsWith(s.siteOrigin)) {
      await send("Runtime.enable");
      await send("Network.enable");
      record("sw", { url: targetInfo.url });
    }
  } finally {
    if (waitingForDebugger) await send("Runtime.runIfWaitingForDebugger");
    if (targetInfo.type === "page") s.ready.set(targetInfo.targetId, sessionId);
  }
}

function onMessage(msg) {
  const s = session;
  if (!s) return;
  if (msg.method === "__closed") {
    record("closed");
    clearInterval(s.poll);
    return;
  }
  const p = msg.params || {};
  const meta = msg.sessionId ? s.sessions.get(msg.sessionId) : undefined;
  // only the site's own service worker matters (not Chrome's extension workers)
  const siteWorker = meta?.type === "service_worker" && meta.url.startsWith(s.siteOrigin);
  switch (msg.method) {
    case "Target.attachedToTarget":
      onAttached(p);
      break;
    case "Target.detachedFromTarget":
      s.sessions.delete(p.sessionId);
      break;
    case "Target.targetCreated":
      if (p.targetInfo.type === "page" && p.targetInfo.openerId) record("popup", { url: p.targetInfo.url });
      break;
    case "Target.targetInfoChanged":
      if (p.targetInfo.type === "page") for (const m of s.sessions.values()) if (m.targetId === p.targetInfo.targetId) m.url = p.targetInfo.url;
      break;
    case "Page.frameNavigated":
      if (!p.frame.parentId) record("nav", { url: p.frame.url, target: meta?.targetId });
      break;
    case "Page.navigatedWithinDocument": // client-side route change (pushState)
      record("nav", { url: p.url, target: meta?.targetId, spa: true });
      break;
    case "Runtime.bindingCalled":
      if (p.name === "__ctAuditReport") {
        try {
          const x = JSON.parse(p.payload);
          record("hook", { api: x.api, json: String(x.json).slice(0, 20000), url: x.url });
        } catch {}
      }
      break;
    case "Runtime.consoleAPICalled": {
      const text = (p.args || []).map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 300);
      if (meta?.type === "service_worker") {
        if (siteWorker && /^Push event/i.test(text)) record("push-received");
      } else if (/^CleverTap\b/.test(text)) {
        if (!s.debugSeen) { s.debugSeen = true; record("debug-logs"); }
        if (p.type === "error" && !/Error subscribing|push service/i.test(text)) record("ct-error", { text });
      }
      break;
    }
    case "Network.requestWillBeSent": {
      const url = p.request?.url || "";
      let host = "";
      try { host = new URL(url).hostname; } catch {}
      if (!CT_HOST.test(host)) break;
      if (meta?.type === "service_worker") {
        if (!siteWorker) break;
        // CleverTap's worker: viewed ping on arrival; redirect ping with &b=button… on click
        const u = new URL(url);
        if (u.searchParams.has("b") || /[?&]b=button/.test(url)) record("push-click", { deepLink: u.searchParams.get("r") || undefined });
        else record("push-viewed");
      } else {
        s.ct.set(`${msg.sessionId}:${p.requestId}`, url);
        record("ct", { url: url.slice(0, 16000), page: meta?.url });
      }
      break;
    }
    case "Network.loadingFinished": {
      const key = `${msg.sessionId}:${p.requestId}`;
      if (!s.ct.has(key)) break;
      s.ct.delete(key);
      s.cdp.send("Network.getResponseBody", { requestId: p.requestId }, msg.sessionId).then((r) => {
        const body = r.base64Encoded ? Buffer.from(r.body, "base64").toString() : r.body;
        const g = body.match(/\$WZRK_WR\.s\(\s*'([^']+)'/)?.[1];
        record("ct-response", { ok: true, webPush: /enableWebPush\(\s*true/.test(body), gcookie: g });
      }).catch(() => record("ct-response", { ok: true }));
      break;
    }
    case "Network.loadingFailed": {
      const key = `${msg.sessionId}:${p.requestId}`;
      if (s.ct.delete(key)) record("ct-response", { ok: false, error: p.errorText });
      break;
    }
  }
}

async function pollState() {
  const s = session;
  if (!s || s.cdp.closed) return;
  // the newest page of the site under audit
  const main = mainPageSession();
  if (!main) return;
  const r = await s.cdp.send("Runtime.evaluate", { expression: STATE, awaitPromise: true, returnByValue: true }, main).catch(() => null);
  const v = r?.result?.value;
  if (!v) return;
  const key = JSON.stringify(v);
  if (key !== s.lastState) {
    s.lastState = key;
    record("state", v);
  }
}

/* ------------------------------------------------------------------ */
/* HTTP                                                               */
/* ------------------------------------------------------------------ */

function send(res, status, body, origin) {
  res.writeHead(status, { "Content-Type": "application/json", ...(origin ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : {}) });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 16_384) reject(new Error("Body too large"));
    });
    req.on("end", () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error("Invalid JSON")); }
    });
  });
}

const tokenOk = (t) => {
  const a = Buffer.from(String(t ?? "")), b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
};

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  const allowed = origin && ORIGINS.has(origin) ? origin : undefined;
  if (req.method === "OPTIONS") {
    if (!allowed) return send(res, 403, { error: "Origin not allowed" });
    res.writeHead(204, {
      "Access-Control-Allow-Origin": allowed,
      "Access-Control-Allow-Methods": "GET, POST",
      "Access-Control-Allow-Headers": "Content-Type, X-Bridge-Token",
      "Access-Control-Allow-Private-Network": "true",
      "Access-Control-Max-Age": "600",
      Vary: "Origin",
    });
    return res.end();
  }
  if (!allowed) return send(res, 403, { error: `Origin not allowed. Restart with --origin ${origin ?? "<site>"}` });
  if (req.method === "GET" && req.url === "/v1/hello") return send(res, 200, { token: TOKEN, version: HELPER_VERSION, chrome: !!findChrome() }, allowed);
  if (!tokenOk(req.headers["x-bridge-token"])) return send(res, 401, { error: "Wrong helper token — restart the helper." }, allowed);

  try {
    const url = new URL(req.url, "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/v1/state") {
      const since = Number(url.searchParams.get("since") || 0);
      const events = session ? session.events.filter((e) => e.seq > since) : [];
      return send(res, 200, {
        running: !!session && !session.cdp.closed,
        device: session?.device,
        browser: session?.browser,
        startedAt: session?.startedAt,
        last: seq,
        events: events.slice(0, 1500),
      }, allowed);
    }
    if (req.method === "POST" && url.pathname === "/v1/open") {
      const { url: site, device, fresh } = await readJson(req);
      if (typeof site !== "string" || site.length > 2000) throw new Error("Invalid URL.");
      await start({ url: site, device: device === "android" ? "android" : "desktop", fresh: !!fresh });
      return send(res, 200, { ok: true, browser: session?.browser }, allowed);
    }
    if (req.method === "POST" && url.pathname === "/v1/tab") {
      const { url: page } = await readJson(req);
      await openTab(String(page));
      return send(res, 200, { ok: true }, allowed);
    }
    if (req.method === "POST" && url.pathname === "/v1/login") {
      return send(res, 200, await login(await readJson(req)), allowed);
    }
    if (req.method === "POST" && url.pathname === "/v1/close") {
      await stop();
      return send(res, 200, { ok: true }, allowed);
    }
    return send(res, 404, { error: "Not found" }, allowed);
  } catch (e) {
    return send(res, 400, { error: e.message }, allowed);
  }
});

server.listen(PORT, "127.0.0.1", () => {
  const chrome = findChrome();
  console.log("\n  CleverTap audit website helper is running");
  console.log(`  chrome:   ${chrome ?? "NOT FOUND — install Google Chrome (or set CHROME_PATH)"}`);
  console.log(`  profile:  ${PROFILE_DIR} (separate from your normal Chrome)`);
  console.log(`  allowed:  ${[...ORIGINS].join(", ")}`);
  console.log(`\n  Token:    ${TOKEN}  (the audit page picks this up by itself)\n`);
  console.log("  Go back to the audit page — it connects automatically. Keep this window open; Ctrl+C to stop.\n");
});

process.on("SIGINT", async () => {
  await stop();
  process.exit(0);
});
