import "server-only";

// Thin client for the CleverTap REST API. Docs:
//   https://developer.clevertap.com/docs/api-overview
// Credentials are passed per call and never persisted.

export interface CtCredentials {
  accountId: string;
  passcode: string;
  region: string; // in1 | us1 | eu1 | sg1 | aps3 | mec1
}

export class CtApiError extends Error {
  constructor(
    message: string,
    readonly kind: "auth" | "region" | "network" | "limit" | "unknown",
    readonly httpStatus?: number,
    readonly code?: number,
  ) {
    super(message);
  }
}

// Europe is the default region and lives at api.clevertap.com.
export function baseUrl(region: string): string {
  const r = region.trim().toLowerCase();
  if (!r || r === "eu1" || r === "eu") return "https://api.clevertap.com";
  if (!/^[a-z]+\d*$/.test(r)) throw new CtApiError(`Invalid region "${region}"`, "region");
  return `https://${r}.api.clevertap.com`;
}

type Json = Record<string, unknown>;

async function call(creds: CtCredentials, method: "GET" | "POST", path: string, body?: Json, attempt = 0): Promise<Json> {
  const headers: Record<string, string> = {
    "X-CleverTap-Account-Id": creds.accountId.trim(),
    "X-CleverTap-Passcode": creds.passcode,
  };
  if (method === "POST") headers["Content-Type"] = "application/json; charset=utf-8";

  let res: Response;
  try {
    res = await fetch(baseUrl(creds.region) + path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e) {
    if (e instanceof CtApiError) throw e;
    throw new CtApiError(
      `Couldn't reach ${baseUrl(creds.region)} — check the region.`,
      "network",
    );
  }

  // Concurrency limit (3 parallel requests per account) — back off and retry.
  if (res.status === 429 && attempt < 3) {
    await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    return call(creds, method, path, body, attempt + 1);
  }

  let json: Json = {};
  try {
    json = (await res.json()) as Json;
  } catch {
    /* non-JSON error page */
  }
  const status = json.status as string | undefined;
  const msg = String(json.error ?? json.message ?? res.statusText ?? "Request failed");

  if (!res.ok || status === "fail") {
    if (res.status === 401 || /invalid credentials|passcode|account id/i.test(msg))
      throw new CtApiError("CleverTap rejected the Account ID / Passcode.", "auth", res.status, json.code as number);
    if (/account blocked/i.test(msg))
      throw new CtApiError("Account not found in this region (or blocked) — check the region.", "region", res.status);
    if (res.status === 429) throw new CtApiError("CleverTap API concurrency limit hit — retry in a minute.", "limit", 429);
    throw new CtApiError(msg, "unknown", res.status, json.code as number);
  }
  return json;
}

export function ymd(d: Date): number {
  return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
}

export function dateRange(days: number, now = new Date()) {
  const to = new Date(now);
  const from = new Date(now.getTime() - days * 86400_000);
  return { from: ymd(from), to: ymd(to) };
}

export interface EventRecord {
  profile?: {
    objectId?: string;
    platform?: string;
    email?: string;
    identity?: string;
    phone?: string | number;
    name?: string;
    profileData?: Record<string, unknown>;
    app_version?: string;
  };
  ts?: number;
  event_props?: Record<string, unknown>;
}

export interface ProfileRecord {
  identity?: string;
  email?: string;
  name?: string;
  profileData?: Record<string, unknown>;
  platformInfo?: { platform?: string; push_token?: string; app_version?: string; objectId?: string }[];
}

// Cursors come back already URL-encoded (e.g. "...%2F..."). Encoding them a
// second time makes CleverTap reply "Incorrect Usage" (malformed cursor).
function cursorParam(cursor: string) {
  return cursor.includes("%") ? cursor : encodeURIComponent(cursor);
}

const isIncorrectUsage = (e: unknown) => e instanceof CtApiError && /incorrect usage/i.test(e.message);

/**
 * Get Events (cursor flow). Returns at most one batch — enough to sample.
 * `to` may not be in the future in the account's timezone; on error 4002 we
 * retry ending yesterday.
 */
export async function sampleEvents(
  creds: CtCredentials,
  eventName: string,
  days: number,
  batchSize: number,
): Promise<EventRecord[]> {
  const run = async (end: Date) => {
    const range = dateRange(days, end);
    const start = await call(
      creds,
      "POST",
      `/1/events.json?batch_size=${batchSize}&app=true&events=false&profile=true`,
      { event_name: eventName, ...range },
    );
    const cursor = start.cursor as string | undefined;
    if (!cursor) return [];
    const page = await call(creds, "GET", `/1/events.json?cursor=${cursorParam(cursor)}`);
    return (page.records as EventRecord[] | undefined) ?? [];
  };
  try {
    return await run(new Date());
  } catch (e) {
    if (e instanceof CtApiError && (e.code === 4002 || /future/i.test(e.message)))
      return run(new Date(Date.now() - 86400_000));
    if (isIncorrectUsage(e)) return run(new Date()); // stale cursor: restart from step 1 once
    throw e;
  }
}

/** Get User Profiles (cursor flow), first batch only. */
export async function sampleProfiles(
  creds: CtCredentials,
  eventName: string,
  days: number,
  batchSize: number,
): Promise<ProfileRecord[]> {
  const run = async () => {
    const range = dateRange(days, new Date(Date.now() - 86400_000));
    const start = await call(
      creds,
      "POST",
      `/1/profiles.json?batch_size=${batchSize}&app=true&events=false&profile=true`,
      { event_name: eventName, ...range },
    );
    const cursor = start.cursor as string | undefined;
    if (!cursor) return [];
    const page = await call(creds, "GET", `/1/profiles.json?cursor=${cursorParam(cursor)}`);
    return (page.records as ProfileRecord[] | undefined) ?? [];
  };
  try {
    return await run();
  } catch (e) {
    if (isIncorrectUsage(e)) return run();
    throw e;
  }
}

export interface ProfileDetail extends ProfileRecord {
  events?: Record<string, { count?: number; first_seen?: number; last_seen?: number }>;
}

/** Get one user's profile by Identity (or email). `null` when no such profile. */
export async function getProfile(creds: CtCredentials, identity: string): Promise<ProfileDetail | null> {
  const key = identity.includes("@") ? "email" : "identity";
  try {
    const res = await call(creds, "GET", `/1/profile.json?${key}=${encodeURIComponent(identity)}`);
    return (res.record as ProfileDetail | null) ?? null;
  } catch (e) {
    if (e instanceof CtApiError && (e.httpStatus === 404 || /not found/i.test(e.message))) return null;
    throw e;
  }
}

export interface MessageReport {
  name: string;
  channel: string; // "Push", "InApp", ...
  status: string;
  devices: string[];
  sent: number;
  viewed: number;
  clicked: number;
}

/** Get Message Reports: campaigns sent in the window with sent/viewed/clicked totals. */
export async function getMessageReports(creds: CtCredentials, days: number, channels: string[]): Promise<MessageReport[]> {
  const { from, to } = dateRange(days, new Date(Date.now() - 86400_000));
  const res = await call(creds, "POST", "/1/message/report.json", {
    from: String(from),
    to: String(to),
    channel: channels,
    daily: false,
  });
  type Raw = {
    message_name?: string;
    channel?: string;
    status?: string;
    device?: string[];
    data?: unknown;
  };
  return ((res.messages as Raw[] | undefined) ?? []).map((m) => {
    const t = { sent: 0, viewed: 0, clicked: 0 };
    // `data` is an array (or array of arrays) of {sent, viewed, clicked}
    const walk = (x: unknown) => {
      if (Array.isArray(x)) x.forEach(walk);
      else if (x && typeof x === "object") {
        const o = x as Record<string, unknown>;
        for (const k of ["sent", "viewed", "clicked"] as const) if (typeof o[k] === "number") t[k] += o[k] as number;
      }
    };
    walk(m.data);
    return {
      name: String(m.message_name ?? ""),
      channel: String(m.channel ?? ""),
      status: String(m.status ?? ""),
      devices: m.device ?? [],
      ...t,
    };
  });
}

/** Real-Time Counts: users active in the last 5 minutes, by OS. */
export async function getRealtime(creds: CtCredentials): Promise<{ count: number; os: Record<string, number> }> {
  const res = await call(creds, "POST", "/1/now.json", { os: true });
  return { count: Number(res.count ?? 0), os: (res.os as Record<string, number>) ?? {} };
}

/** Send a push to specific identities (Create Campaign API, by identity). */
export async function sendPushToIdentity(
  creds: CtCredentials,
  identity: string,
  opts: { title: string; body: string; channelId?: string; deepLink?: string },
): Promise<string> {
  const android: Json = {};
  if (opts.channelId) android.wzrk_cid = opts.channelId;
  if (opts.deepLink) android.deep_link = opts.deepLink;
  const res = await call(creds, "POST", "/1/send/push.json", {
    to: identity.includes("@") ? { Email: [identity] } : { Identity: [identity] },
    tag_group: "integration-audit-test",
    respect_frequency_caps: false,
    content: { title: opts.title, body: opts.body, platform_specific: { android } },
  });
  return String(res.message ?? "Added to queue for processing");
}
