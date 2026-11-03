import "server-only";
import type { User } from "@supabase/supabase-js";
import { db } from "./supabase";
import { isStaffEmail, type SessionUser } from "./auth";
import { HttpError } from "./http";
import type { AuditSource, AuditStatus, ItemStatus, Platform } from "../types";

// ---------------------------------------------------------------------------
// Admin analytics (/admin). Presence is kept on the auth user's app_metadata
// (last_seen_at) — set by the sidebar's /api/me heartbeat — so no extra table.
// ---------------------------------------------------------------------------

/** 404 rather than 403 so the admin area isn't discoverable. */
export function assertAdmin(user: SessionUser) {
  if (!user.isAdmin) throw new HttpError(404, "Not found");
}

const TOUCH_EVERY = 2 * 60_000;
const touched = new Map<string, number>();

/** Record that this user is active now (throttled per server instance). */
export async function touchPresence(user: SessionUser) {
  const now = Date.now();
  if (now - (touched.get(user.id) ?? 0) < TOUCH_EVERY) return;
  touched.set(user.id, now);
  const { error } = await db().auth.admin.updateUserById(user.id, { app_metadata: { last_seen_at: new Date(now).toISOString() } });
  if (error) console.error("touch presence:", error.message);
}

export interface AdminAudit {
  id: string;
  name: string;
  platform: Platform;
  status: AuditStatus;
  source: AuditSource;
  email: string;
  target: string | null;
  createdAt: number;
  completedAt: number | null;
  results?: { pass: number; fail: number; warn: number; manual: number };
}

export interface AdminUser {
  id: string;
  email: string;
  isStaff: boolean;
  createdAt: number;
  lastSignInAt: number | null;
  lastSeenAt: number | null;
}

export interface AdminAnalytics {
  generatedAt: number;
  users: AdminUser[];
  audits: AdminAudit[]; // newest first; the dashboard buckets them in the viewer's time zone
  truncated: boolean;
}

const MAX_AUDITS = 5000;
const RESULT_ROWS = 100; // newest audits that also carry pass / fail counts

interface Row {
  id: string;
  name: string;
  platform: Platform;
  status: AuditStatus;
  source: AuditSource;
  owner_email: string | null;
  submitted_by: string | null;
  target: string | null;
  created_at: string;
  completed_at: string | null;
}

const ts = (s: string | null | undefined) => (s ? new Date(s).getTime() : null);

export async function adminAnalytics(): Promise<AdminAnalytics> {
  const [audits, recent, users] = await Promise.all([
    db()
      .from("audits")
      .select("id,name,platform,status,source,owner_email,submitted_by,target,created_at,completed_at")
      .order("created_at", { ascending: false })
      .limit(MAX_AUDITS),
    db()
      .from("audits")
      .select("id,audit_results(status)")
      .order("created_at", { ascending: false })
      .limit(RESULT_ROWS),
    listAllUsers(),
  ]);
  if (audits.error) throw new Error(`admin audits: ${audits.error.message}`);
  if (recent.error) throw new Error(`admin results: ${recent.error.message}`);

  const counts = new Map<string, AdminAudit["results"]>();
  for (const r of recent.data as unknown as { id: string; audit_results: { status: ItemStatus }[] }[]) {
    const c = { pass: 0, fail: 0, warn: 0, manual: 0 };
    for (const x of r.audit_results ?? []) if (x.status in c) c[x.status as keyof typeof c]++;
    counts.set(r.id, c);
  }

  const rows = audits.data as Row[];
  return {
    generatedAt: Date.now(),
    truncated: rows.length >= MAX_AUDITS,
    users,
    audits: rows.map((r) => ({
      id: r.id,
      name: r.name,
      platform: r.platform,
      status: r.status,
      source: r.source,
      email: r.owner_email ?? r.submitted_by ?? "—",
      target: r.target,
      createdAt: ts(r.created_at)!,
      completedAt: ts(r.completed_at),
      results: counts.get(r.id),
    })),
  };
}

async function listAllUsers(): Promise<AdminUser[]> {
  const out: AdminUser[] = [];
  const perPage = 1000;
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await db().auth.admin.listUsers({ page, perPage });
    if (error) throw new Error(`admin users: ${error.message}`);
    for (const u of data.users as User[]) {
      if (!u.email) continue;
      out.push({
        id: u.id,
        email: u.email,
        isStaff: !!u.email_confirmed_at && isStaffEmail(u.email),
        createdAt: ts(u.created_at)!,
        lastSignInAt: ts(u.last_sign_in_at),
        lastSeenAt: ts((u.app_metadata as { last_seen_at?: string } | undefined)?.last_seen_at) ?? ts(u.last_sign_in_at),
      });
    }
    if (data.users.length < perPage) break;
  }
  return out;
}
