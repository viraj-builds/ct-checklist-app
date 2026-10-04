import "server-only";
import {
  CtApiError,
  getMessageReports,
  getProfile,
  getRealtime,
  sampleEvents,
  sampleProfiles,
  type CtCredentials,
  type EventRecord,
} from "./client";
import type { ApiFindings, ChannelStats, EventSample, ProfileSample, PropStats, TestUserRecord } from "./types";

// ---------------------------------------------------------------------------
// CleverTap API verifier for app (Android) audits. Calls run sequentially — the
// API allows only 3 concurrent requests per account and the customer may have
// other jobs running.
// ---------------------------------------------------------------------------

const SYSTEM_EVENTS = {
  launched: "App Launched",
  installed: "App Installed",
  viewed: "Notification Viewed",
  clicked: "Notification Clicked",
  uninstalled: "App Uninstalled", // only recorded when uninstall tracking is on
} as const;

export interface VerifyOptions {
  platform: "Android" | "iOS";
  customEvents: string[]; // from the static scan + user's critical events
  maxCustomEvents?: number;
}

export async function verifyAppAccount(creds: CtCredentials, opts: VerifyOptions): Promise<ApiFindings> {
  const t0 = Date.now();
  const findings: ApiFindings = {
    ok: true,
    region: creds.region,
    checkedAt: t0,
    durationMs: 0,
    events: {},
    customEvents: [],
  };

  // 1. App Launched — doubles as the credentials check and the profile sample.
  let launched: EventRecord[];
  try {
    launched = await sampleEvents(creds, SYSTEM_EVENTS.launched, 7, 200);
  } catch (e) {
    const err = e instanceof CtApiError ? e : new CtApiError(String(e), "unknown");
    return { ...findings, ok: false, error: err.message, errorKind: err.kind, durationMs: Date.now() - t0 };
  }
  findings.events[SYSTEM_EVENTS.launched] = summarizeEvents(SYSTEM_EVENTS.launched, 7, 200, launched, opts.platform, false);
  findings.profiles = summarizeProfiles(SYSTEM_EVENTS.launched, launched, opts.platform);

  // 2. System events.
  for (const [name, days] of [
    [SYSTEM_EVENTS.installed, 30],
    [SYSTEM_EVENTS.viewed, 30],
    [SYSTEM_EVENTS.clicked, 30],
    [SYSTEM_EVENTS.uninstalled, 30],
  ] as const) {
    findings.events[name] = await safeSample(creds, name, days, 50, opts.platform, false);
  }

  // 3. Custom events (with property type analysis).
  const custom = [...new Set(opts.customEvents.map((s) => s.trim()).filter(Boolean))]
    .filter((n) => !Object.values(SYSTEM_EVENTS).includes(n as never))
    .slice(0, opts.maxCustomEvents ?? 8);
  findings.customEvents = custom;
  for (const name of custom) findings.events[name] = await safeSample(creds, name, 30, 100, opts.platform, true);

  // 4. Push tokens + app versions from Get User Profiles.
  try {
    const profiles = await sampleProfiles(creds, SYSTEM_EVENTS.launched, 7, 100);
    let withToken = 0;
    let sampled = 0;
    const versions: Record<string, number> = {};
    for (const p of profiles) {
      const infos = (p.platformInfo ?? []).filter((i) => !i.platform || i.platform === opts.platform);
      if (!infos.length) continue;
      sampled++;
      if (infos.some((i) => !!i.push_token)) withToken++;
      for (const i of infos) if (i.app_version && !(i.app_version in Object.prototype)) versions[i.app_version] = (versions[i.app_version] ?? 0) + 1;
    }
    if (findings.profiles) {
      findings.profiles.withPushToken = withToken;
      findings.profiles.pushTokenSampled = sampled;
      findings.profiles.appVersions = versions;
    }
  } catch {
    /* optional — token check falls back to static analysis */
  }

  // 5. Campaign delivery stats (push impressions, in-app renders, clicks).
  findings.messages = {};
  try {
    const reports = await getMessageReports(creds, 30, ["push", "inapp"]);
    for (const ch of ["push", "inapp"] as const) {
      const rows = reports.filter(
        (r) => r.channel.toLowerCase().replace(/[^a-z]/g, "") === ch && (r.devices.length === 0 || r.devices.includes(opts.platform)),
      );
      const st: ChannelStats = { campaigns: rows.length, sent: 0, viewed: 0, clicked: 0, sentNeverViewed: [] };
      for (const r of rows) {
        st.sent += r.sent;
        st.viewed += r.viewed;
        st.clicked += r.clicked;
        if (r.sent > 0 && r.viewed === 0 && st.sentNeverViewed.length < 5) st.sentNeverViewed.push(r.name);
      }
      findings.messages[ch] = st;
    }
  } catch (e) {
    findings.messages.push = { campaigns: 0, sent: 0, viewed: 0, clicked: 0, sentNeverViewed: [], error: (e as Error).message };
  }

  // 6. Who's online right now.
  try {
    const rt = await getRealtime(creds);
    findings.realtime = { count: rt.count, android: rt.os[opts.platform] ?? 0, checkedAt: Date.now() };
  } catch {
    /* optional */
  }

  findings.durationMs = Date.now() - t0;
  return findings;
}

/** Look up one test user's profile — used for the live-device session. */
export async function checkTestUser(creds: CtCredentials, identity: string, platform: "Android" | "iOS"): Promise<TestUserRecord> {
  const rec = await getProfile(creds, identity);
  const base: TestUserRecord = {
    identity: mask(identity),
    found: !!rec,
    checkedAt: Date.now(),
    hasEmail: false,
    hasPhone: false,
    events: Object.create(null),
  };
  if (!rec) return base;
  const info = (rec.platformInfo ?? []).filter((i) => i.platform === platform);
  const dev = info.find((i) => i.push_token) ?? info[0];
  const pd = (rec.profileData ?? {}) as Record<string, unknown>;
  const phone = clean(pd.Phone ?? pd.phone);
  for (const [name, e] of Object.entries(rec.events ?? {})) {
    if (Object.keys(base.events).length >= 200) break;
    base.events[name] = { count: e.count, lastSeen: e.last_seen ? e.last_seen * 1000 : undefined };
  }
  const extra = dev as { os_version?: string; model?: string } | undefined;
  return {
    ...base,
    android: dev && {
      objectId: dev.objectId,
      appVersion: dev.app_version,
      osVersion: extra?.os_version,
      model: extra?.model,
      hasPushToken: !!dev.push_token,
    },
    hasEmail: !!clean(rec.email),
    hasPhone: !!phone,
    phoneValid: phone ? E164.test(phone) : undefined,
    lastLaunchedAt: base.events["App Launched"]?.lastSeen,
  };
}

async function safeSample(
  creds: CtCredentials,
  name: string,
  days: number,
  batch: number,
  platform: string,
  withProps: boolean,
): Promise<EventSample> {
  try {
    const recs = await sampleEvents(creds, name, days, batch);
    return summarizeEvents(name, days, batch, recs, platform, withProps);
  } catch (e) {
    return { name, windowDays: days, sampled: 0, androidSampled: 0, capped: false, error: (e as Error).message };
  }
}

/* ------------------------------------------------------------------ */

const NULLISH = new Set(["null", "undefined", "nil", "none", "nan", ""]);
const DATE_STRING = /^(\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?|\d{1,2}[/-]\d{1,2}[/-]\d{2,4})$/;
const NUMERIC_KEY = /amount|price|qty|quantity|total|revenue|value|count|discount|cost/i;
const E164 = /^\+[1-9]\d{7,14}$/;

function summarizeEvents(
  name: string,
  days: number,
  batch: number,
  recs: EventRecord[],
  platform: string,
  withProps: boolean,
): EventSample {
  const onPlatform = recs.filter((r) => !r.profile?.platform || r.profile.platform === platform);
  const ts = recs.map((r) => r.ts ?? 0).filter(Boolean);
  const sample: EventSample = {
    name,
    windowDays: days,
    sampled: recs.length,
    androidSampled: onPlatform.length,
    capped: recs.length >= batch,
    lastSeen: ts.length ? String(Math.max(...ts)) : undefined,
  };
  if (withProps) {
    const props: Record<string, PropStats> = Object.create(null);
    for (const r of onPlatform.length ? onPlatform : recs) {
      for (const [k, v] of Object.entries(r.event_props ?? {})) {
        if (Object.keys(props).length >= 100 && !(k in props)) continue; // cap property fan-out
        const st = (props[k] ??= { types: {}, examples: [], numericStrings: 0, dateLikeStrings: 0 });
        const t = valueType(v);
        st.types[t] = (st.types[t] ?? 0) + 1;
        if (typeof v === "string") {
          if (NUMERIC_KEY.test(k) && /^-?\d+(\.\d+)?$/.test(v.trim())) st.numericStrings++;
          if (DATE_STRING.test(v.trim())) st.dateLikeStrings++;
        }
        const ex = truncate(String(Array.isArray(v) ? v.join(",") : v));
        if (st.examples.length < 3 && !st.examples.includes(ex)) st.examples.push(ex);
      }
    }
    sample.props = props;
  }
  return sample;
}

function summarizeProfiles(source: string, recs: EventRecord[], platform: string): ProfileSample {
  const seen = new Set<string>();
  const s: ProfileSample = {
    source,
    sampled: 0,
    android: 0,
    withIdentity: 0,
    withEmail: 0,
    withPhone: 0,
    phoneValid: 0,
    phoneInvalidExamples: [],
    anonymous: 0,
    nullishFields: [],
    dateLikeStringFields: [],
  };
  const nullish = new Set<string>();
  const dateLike = new Set<string>();
  for (const r of recs) {
    const p = r.profile;
    if (!p) continue;
    const key = p.objectId ?? p.identity ?? JSON.stringify(p).slice(0, 80);
    if (seen.has(key)) continue;
    seen.add(key);
    s.sampled++;
    if (p.platform === platform) s.android++;
    const identity = clean(p.identity);
    const email = clean(p.email);
    const phone = clean(p.phone);
    if (identity) s.withIdentity++;
    if (email) s.withEmail++;
    if (phone) {
      s.withPhone++;
      if (E164.test(phone)) s.phoneValid++;
      else if (s.phoneInvalidExamples.length < 3) s.phoneInvalidExamples.push(mask(phone));
    }
    if (!identity && !email && !phone) s.anonymous++;
    for (const [k, v] of Object.entries(p.profileData ?? {})) {
      if (typeof v === "string" && NULLISH.has(v.trim().toLowerCase())) nullish.add(k);
      if (typeof v === "string" && DATE_STRING.test(v.trim())) dateLike.add(k);
    }
    for (const [k, v] of [["Identity", p.identity], ["Email", p.email], ["Phone", p.phone], ["Name", p.name]] as const)
      if (typeof v === "string" && v.length > 0 && NULLISH.has(v.trim().toLowerCase())) nullish.add(k);
  }
  s.nullishFields = [...nullish].slice(0, 20);
  s.dateLikeStringFields = [...dateLike].slice(0, 20);
  return s;
}

function valueType(v: unknown): keyof PropStats["types"] {
  if (v === null || v === undefined) return "nullish";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return "number";
  if (typeof v === "boolean") return "boolean";
  const s = String(v).trim();
  if (NULLISH.has(s.toLowerCase())) return "nullish";
  if (/^\$D_\d+$/.test(s)) return "date";
  return "string";
}

function clean(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v).trim();
  return NULLISH.has(s.toLowerCase()) ? "" : s;
}

function truncate(s: string) {
  return s.length > 40 ? s.slice(0, 37) + "…" : s;
}

export function mask(s: string) {
  if (s.length <= 5) return "•••";
  return s.slice(0, 3) + "•".repeat(Math.max(3, s.length - 5)) + s.slice(-2);
}
