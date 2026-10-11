import "server-only";
import { CtApiError, getMessageReports, getProfile, getProfileByObjectId, sampleEvents, type CtCredentials, type ProfileDetail } from "./client";
import { mask, safeSample, summarizeProfiles } from "./verify";
import type { ApiFindings, ChannelStats, WebApiFindings, WebProfileRecord } from "./types";

// ---------------------------------------------------------------------------
// CleverTap API verifier for website audits. Closes the loop on what the
// crawler did: the anonymous visitor it created (by CleverTap ID), the test
// user it logged in as, custom events across real web users, and web push
// campaign stats. Calls run sequentially (3 concurrent requests per account).
// ---------------------------------------------------------------------------

const PLATFORM = "Web";
const NULLISH = new Set(["null", "undefined", "nil", "none", "nan", ""]);
const E164 = /^\+[1-9]\d{7,14}$/;
const SYSTEM = ["UTM Visited", "Notification Viewed", "Notification Clicked"];

export interface WebVerifyOptions {
  ctId?: string; // the crawler's anonymous visitor
  identity?: string; // test user (Identity or Email)
  customEvents: string[];
  maxCustomEvents?: number;
  waitForVisitorMs?: number; // new profiles take a little while to appear
}

export async function verifyWebAccount(creds: CtCredentials, opts: WebVerifyOptions, prev?: WebApiFindings): Promise<ApiFindings> {
  const t0 = Date.now();
  const findings: ApiFindings = { ok: true, region: creds.region, checkedAt: t0, durationMs: 0, events: {}, customEvents: [], web: { tests: prev?.tests } };
  const web = findings.web!;

  // 1. credentials check + UTM Visited across web users (doubles as the profile sample)
  let utm;
  try {
    utm = await sampleEvents(creds, "UTM Visited", 7, 200);
  } catch (e) {
    const err = e instanceof CtApiError ? e : new CtApiError(String(e), "unknown");
    return { ...findings, ok: false, error: err.message, errorKind: err.kind, durationMs: Date.now() - t0 };
  }
  findings.profiles = summarizeProfiles("UTM Visited", utm, PLATFORM);

  // 2. the crawler's visitor and the test user
  if (opts.ctId) {
    const deadline = Date.now() + (opts.waitForVisitorMs ?? 0);
    for (;;) {
      web.visitor = await lookup(creds, "objectId", opts.ctId).catch(() => undefined);
      if (web.visitor?.found || Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 8000));
    }
  }
  if (opts.identity) web.user = await lookup(creds, opts.identity.includes("@") ? "email" : "identity", opts.identity).catch(() => undefined);

  // 3. web system events + custom events with property types
  for (const name of SYSTEM.slice(1)) findings.events[name] = await safeSample(creds, name, 30, 50, PLATFORM, false);
  const custom = [...new Set(opts.customEvents.map((s) => s.trim()).filter(Boolean))].filter((n) => !SYSTEM.includes(n)).slice(0, opts.maxCustomEvents ?? 8);
  findings.customEvents = custom;
  for (const name of custom) {
    findings.events[name] = await safeSample(creds, name, 30, 100, PLATFORM, true);
    // if the profile sample was empty (no UTM traffic), use the first custom event's profiles
    if (!findings.profiles?.sampled && findings.events[name].sampled) {
      const recs = await sampleEvents(creds, name, 7, 200).catch(() => []);
      findings.profiles = summarizeProfiles(name, recs, PLATFORM);
    }
  }

  // 4. web push campaign stats
  try {
    const reports = await getMessageReports(creds, 30, ["webpush"]);
    const rows = reports.filter((r) => /web ?push/i.test(r.channel));
    const st: ChannelStats = { campaigns: rows.length, sent: 0, viewed: 0, clicked: 0, sentNeverViewed: [] };
    for (const r of rows) {
      st.sent += r.sent;
      st.viewed += r.viewed;
      st.clicked += r.clicked;
      if (r.sent > 0 && r.viewed === 0 && st.sentNeverViewed.length < 5) st.sentNeverViewed.push(r.name);
    }
    web.webPush = st;
  } catch (e) {
    web.webPush = { campaigns: 0, sent: 0, viewed: 0, clicked: 0, sentNeverViewed: [], error: (e as Error).message };
  }

  findings.durationMs = Date.now() - t0;
  return findings;
}

/** Look up one profile for a website audit. */
export async function lookup(creds: CtCredentials, by: "objectId" | "identity" | "email", value: string): Promise<WebProfileRecord> {
  const rec = by === "objectId" ? await getProfileByObjectId(creds, value) : await getProfile(creds, value);
  return toRecord(rec, by === "objectId" ? value.slice(0, 8) + "…" : mask(value));
}

function toRecord(rec: ProfileDetail | null, key: string): WebProfileRecord {
  const base: WebProfileRecord = {
    key,
    found: !!rec,
    checkedAt: Date.now(),
    identified: false,
    hasEmail: false,
    hasPhone: false,
    nullishFields: [],
    webPushToken: false,
    browsers: [],
    events: Object.create(null),
  };
  if (!rec) return base;
  const pd = (rec.profileData ?? {}) as Record<string, unknown>;
  const phone = clean(pd.Phone ?? pd.phone);
  const web = (rec.platformInfo ?? []).filter((i) => !i.platform || /web/i.test(i.platform));
  for (const [name, e] of Object.entries(rec.events ?? {})) {
    if (Object.keys(base.events).length >= 200) break;
    base.events[name] = { count: e.count, lastSeen: e.last_seen ? e.last_seen * 1000 : undefined };
  }
  const nullish = Object.entries(pd)
    .filter(([, v]) => typeof v === "string" && NULLISH.has(v.trim().toLowerCase()))
    .map(([k]) => k);
  return {
    ...base,
    identified: !!(clean(rec.identity) || clean(rec.email)),
    hasEmail: !!clean(rec.email),
    hasPhone: !!phone,
    phoneValid: phone ? E164.test(phone) : undefined,
    nullishFields: nullish.slice(0, 20),
    webPushToken: web.some((i) => !!i.push_token),
    browsers: web
      .map((i) => {
        const x = i as { browser?: string; os_version?: string; app_version?: string };
        return [x.browser, x.os_version ?? x.app_version].filter(Boolean).join(" ");
      })
      .filter(Boolean)
      .slice(0, 5),
  };
}

function clean(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v).trim();
  return NULLISH.has(s.toLowerCase()) ? "" : s;
}
