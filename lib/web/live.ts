"use client";

// Browser side of the live website session: talks to the local helper
// (public/ct-web-bridge.mjs) and turns its raw events into WebLiveFindings.
// Raw identities never leave this tab — only the masked findings are saved.

import { analyzeProps, CT_HOST, pathOf, profilePush, siteOf, str, SYSTEM_EVENT, type Phase } from "./analyze";
import { decodeCtPayload } from "./lz";
import type { LivePushTest, WebEvent, WebLiveFindings, WebProfilePush } from "./types";

export const WEB_HELPER_URL = "http://127.0.0.1:47813";
export const WEB_HELPER_MIN_VERSION = 1; // HELPER_VERSION in public/ct-web-bridge.mjs

export type LiveEvent = { seq: number; t: number; kind: string; [k: string]: unknown };

export interface HelperState {
  running: boolean;
  device?: "desktop" | "android";
  browser?: string;
  startedAt?: number;
  last: number;
  events: LiveEvent[];
}

async function call<T>(token: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(WEB_HELPER_URL + path, {
      method: body ? "POST" : "GET",
      headers: { "X-Bridge-Token": token, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
  } catch {
    throw new Error("The website helper isn't running. Start it with: node ct-web-bridge.mjs");
  }
  const j = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(j.error ?? `Helper error (${res.status})`);
  return j;
}

/** The helper hands its token only to the audit site's own origin. */
export async function webHelperHello(): Promise<{ token: string; version: number; chrome: boolean } | null> {
  try {
    const res = await fetch(WEB_HELPER_URL + "/v1/hello", { cache: "no-store" });
    if (!res.ok) return null;
    const j = (await res.json()) as { token?: string; version?: number; chrome?: boolean };
    return j.token ? { token: j.token, version: j.version ?? 1, chrome: !!j.chrome } : null;
  } catch {
    return null;
  }
}

export const webHelperOpen = (token: string, url: string, device: "desktop" | "android", fresh: boolean) =>
  call<{ ok: boolean; browser?: string }>(token, "/v1/open", { url, device, fresh });
export const webHelperTab = (token: string, url: string) => call<{ ok: boolean }>(token, "/v1/tab", { url });
export const webHelperClose = (token: string) => call<{ ok: boolean }>(token, "/v1/close", {});
export const webHelperState = (token: string, since: number) => call<HelperState>(token, `/v1/state?since=${since}`);

/* ------------------------------------------------------------------ */

export interface BuildOptions {
  url: string;
  device: "desktop" | "android";
  browser?: string;
  startedAt: number;
  revisitAt?: number;
  tests: Partial<Record<"push" | "deeplink", LivePushTest>>;
}

type Hook = { api: WebLiveFindings["calls"][number]["api"]; args: unknown[]; url: string; t: number };

/** Raw helper events → findings (+ the raw identity, kept in memory only). */
export function buildLiveFindings(events: LiveEvent[], o: BuildOptions): { findings: WebLiveFindings; identity?: string } {
  const f: WebLiveFindings = {
    schema: 1,
    device: o.device,
    browser: o.browser,
    url: o.url,
    startedAt: o.startedAt,
    updatedAt: Date.now(),
    sdk: { present: false, debugLogs: false },
    network: { requests: 0, accepted: 0, webPushConfigured: false },
    utm: { tested: /utm_/.test(o.url), sent: false },
    login: { seen: false },
    profiles: [],
    events: [],
    calls: [],
    pages: [],
    push: { subscribed: false, tests: structuredClone(o.tests) },
  };
  const evs = new Map<string, WebEvent>();
  const hooks: Hook[] = [];
  const netProfiles: { site: Record<string, unknown>; t: number }[] = [];
  let identity: string | undefined;
  let lastState: Record<string, unknown> | undefined;

  for (const e of events) {
    switch (e.kind) {
      case "debug-logs":
        f.sdk.debugLogs = true;
        break;
      case "ct": {
        const url = String(e.url ?? "");
        f.network.requests++;
        f.sdk.present = true;
        try {
          const host = new URL(url).hostname;
          if (CT_HOST.test(host)) {
            f.sdk.host ??= host;
            f.sdk.region ??= host.split(".")[0].replace(/-spiky$/, "");
          }
        } catch {
          /* ignore */
        }
        const p = decodeCtPayload(url);
        if (!p) break;
        if (typeof p.id === "string") f.sdk.accountId ??= p.id;
        const v = (p.af as { lib?: string } | undefined)?.lib?.match(/(\d+\.\d+\.\d+)/)?.[1];
        if (v) f.sdk.version ??= v;
        if (p.us || p.um || p.uc) f.utm.sent = true;
        if (p.type === "event" && typeof p.evtName === "string" && !SYSTEM_EVENT.test(p.evtName)) addEvent(evs, p.evtName, p.evtData, String(p.cpg ?? e.page ?? ""));
        if (p.type === "profile" && p.profile && typeof p.profile === "object") {
          const site = p.profile as Record<string, unknown>;
          if (Object.keys(site).some((k) => k !== "ct_optout")) netProfiles.push({ site, t: e.t });
        }
        break;
      }
      case "ct-response":
        if (e.ok) f.network.accepted++;
        if (e.webPush) f.network.webPushConfigured = true;
        if (typeof e.gcookie === "string" && !f.login.seen) f.ctId ??= e.gcookie;
        break;
      case "hook": {
        let args: unknown[] = [];
        try {
          args = JSON.parse(String(e.json)) as unknown[];
        } catch {
          /* ignore */
        }
        hooks.push({ api: e.api as Hook["api"], args, url: String(e.url ?? ""), t: e.t });
        break;
      }
      case "nav":
      case "popup": {
        const path = pathOf(String(e.url ?? ""));
        if (path && f.pages.length < 30 && !f.pages.includes(path)) f.pages.push(path);
        break;
      }
      case "state":
        lastState = e;
        if (e.permission) f.push.permission = e.permission as "default" | "granted" | "denied";
        if (e.subscribed) f.push.subscribed = true;
        if (typeof e.sw === "string") f.push.serviceWorker = e.sw;
        if (typeof e.ctId === "string" && !f.ctId) f.ctId = e.ctId;
        break;
    }
  }

  // phases: anonymous → login (first identified onUserLogin) → browse; revisit after the reopen
  let loginAt: number | undefined;
  const phaseAt = (t: number): Phase => {
    if (o.revisitAt && t >= o.revisitAt && t < o.revisitAt + 30_000) return "revisit";
    if (loginAt === undefined) return "anonymous";
    return t <= loginAt + 4000 ? "login" : "browse";
  };
  for (const h of hooks) {
    const site = siteOf(h.args[0]);
    const identified = !!(site && (str(site.Identity) || str(site.Email)));
    if (h.api === "onUserLogin" && identified && loginAt === undefined && !(o.revisitAt && h.t >= o.revisitAt)) {
      loginAt = h.t;
      f.login = { seen: true, at: h.t, via: "onUserLogin" };
    }
    if ((h.api === "onUserLogin" || h.api === "profile") && site) {
      if (identified) identity = str(site.Identity) || str(site.Email) || identity;
      if (f.profiles.length < 20) f.profiles.push(profilePush(h.api, phaseAt(h.t), site));
    }
    f.calls.push({ api: h.api, phase: phaseAt(h.t), at: h.t });
  }
  // SDKs we couldn't hook: fall back to the decoded network payloads
  if (!hooks.some((h) => h.api === "onUserLogin" || h.api === "profile"))
    for (const n of netProfiles) {
      const identified = !!(str(n.site.Identity) || str(n.site.Email));
      if (identified && loginAt === undefined) {
        loginAt = n.t;
        f.login = { seen: true, at: n.t, via: "unknown" };
        identity = str(n.site.Identity) || str(n.site.Email);
      }
      if (f.profiles.length < 20) f.profiles.push(profilePush("unknown", phaseAt(n.t), n.site) as WebProfilePush);
    }
  if (!evs.size)
    for (const h of hooks)
      if (h.api === "event" && typeof h.args[0] === "string" && !SYSTEM_EVENT.test(h.args[0])) addEvent(evs, h.args[0], h.args[1], h.url);
  f.events = [...evs.values()].sort((a, b) => b.count - a.count);
  f.calls = f.calls.slice(-200);

  if (o.revisitAt) {
    const revisitStates = events.filter((e) => e.kind === "state" && e.t >= o.revisitAt!);
    f.revisit = {
      at: o.revisitAt,
      onUserLogin: hooks.some((h) => h.api === "onUserLogin" && h.t >= o.revisitAt! && h.t < o.revisitAt! + 30_000),
      identified: revisitStates.some((s) => s.identified === true) || (!!lastState?.identified && revisitStates.length === 0),
    };
  }

  // push tests: arrival / view / click / landing page, all from Chrome itself
  for (const kind of ["push", "deeplink"] as const) {
    const t = f.push.tests[kind];
    if (!t) continue;
    const after = events.filter((e) => e.t >= t.sentAt - 2000);
    const other = f.push.tests[kind === "push" ? "deeplink" : "push"];
    // don't credit the other test's push to this one
    const until = other && other.sentAt > t.sentAt ? other.sentAt : Infinity;
    const mine = after.filter((e) => e.t < until);
    t.receivedAt ??= mine.find((e) => e.kind === "push-received")?.t;
    t.viewedAt ??= mine.find((e) => e.kind === "push-viewed")?.t;
    t.shownAt ??= mine.find((e) => e.kind === "state" && Array.isArray(e.shown) && e.shown.length > 0)?.t;
    const click = mine.find((e) => e.kind === "push-click");
    if (click) {
      t.clickedAt ??= click.t;
      const landed = events.find((e) => (e.kind === "nav" || e.kind === "popup") && e.t >= click.t && e.t < click.t + 30_000 && !e.spa);
      if (landed) t.landedUrl ??= String(landed.url);
      else if (typeof click.deepLink === "string") t.landedUrl ??= click.deepLink;
    }
  }
  return { findings: f, identity };
}

function addEvent(evs: Map<string, WebEvent>, name: string, data: unknown, page: string) {
  const obj = data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  const { props, issues } = analyzeProps(obj);
  const prev = evs.get(name);
  if (prev) {
    prev.count++;
    for (const [k, p] of Object.entries(props)) prev.props[k] ??= p;
    for (const i of issues) if (!prev.issues.includes(i)) prev.issues.push(i);
  } else if (evs.size < 40) evs.set(name, { name, count: 1, page: pathOf(page) || page, props, issues });
}
