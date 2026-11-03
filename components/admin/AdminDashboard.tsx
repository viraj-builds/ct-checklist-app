"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/store";
import { Badge, Button, Card, EmptyState, PageHeader, PlatformIcon, SectionTitle } from "@/components/ui";
import { Icon } from "@/components/Icon";
import { PLATFORM_META } from "@/lib/meta";
import { cx, formatDate, timeAgo } from "@/lib/format";
import type { AuditStatus, Platform } from "@/lib/types";

// Mirrors lib/server/admin.ts (server-only, so the types are restated here).
interface AdminAudit {
  id: string;
  name: string;
  platform: Platform;
  status: AuditStatus;
  source: "browser" | "upload" | "url";
  email: string;
  target: string | null;
  createdAt: number;
  completedAt: number | null;
  results?: { pass: number; fail: number; warn: number; manual: number };
}
interface AdminUser {
  id: string;
  email: string;
  isStaff: boolean;
  createdAt: number;
  lastSignInAt: number | null;
  lastSeenAt: number | null;
}
interface Data {
  generatedAt: number;
  users: AdminUser[];
  audits: AdminAudit[];
  truncated: boolean;
}

const PLATFORMS: Platform[] = ["android", "ios", "web"];
const PLATFORM_COLOR: Record<Platform, string> = { android: "var(--series-1)", ios: "var(--series-2)", web: "var(--series-3)" };
const RANGES = [
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
];
const LIVE_WINDOW = 5 * 60_000; // the sidebar pings every 2 min while a tab is open
const DAY = 86_400_000;

const startOfDay = (t: number) => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
const dayKey = (t: number) => startOfDay(t);
const shortDay = (t: number) => new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short" });
const pct = (n: number, of: number) => (of ? Math.round((n / of) * 100) : 0);
const running = (s: AuditStatus) => s === "draft" || s === "scanning" || s === "verifying";

export function AdminDashboard() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [days, setDays] = useState(30);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      const next = await api<Data>("/api/admin/analytics");
      setData(next);
      setError(null);
      setNow(Date.now());
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  async function refresh() {
    setLoading(true);
    await load();
    setLoading(false);
  }

  useEffect(() => {
    const t0 = setTimeout(load, 0);
    const t = setInterval(load, 60_000);
    return () => {
      clearTimeout(t0);
      clearInterval(t);
    };
  }, [load]);

  const stats = useMemo(() => (data ? compute(data, days, now) : null), [data, days, now]);

  return (
    <div className="flex flex-col gap-10">
      <PageHeader
        title="Admin"
        sub="Everyone's audits and usage. Only you can see this page."
        action={
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex rounded-xl border bg-surface p-1" role="group" aria-label="Time range">
              {RANGES.map((r) => (
                <button
                  key={r.days}
                  onClick={() => setDays(r.days)}
                  aria-pressed={days === r.days}
                  className={cx(
                    "min-h-9 rounded-lg px-3 text-sm font-bold transition-colors",
                    days === r.days ? "bg-brand-soft text-brand-text" : "text-muted hover:text-text",
                  )}
                >
                  {r.label}
                </button>
              ))}
            </div>
            <Button variant="secondary" size="sm" icon="refresh" onClick={refresh} loading={loading}>
              Refresh
            </Button>
          </div>
        }
      />

      {error && !data ? (
        <EmptyState icon="alert" title="Couldn't load analytics" desc={error} />
      ) : !stats || !data ? (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
            <div key={i} className="h-28 rounded-[var(--radius)] skeleton" />
          ))}
        </div>
      ) : (
        <>
          <section aria-label="Key numbers" className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Kpi label="Live now" value={stats.live.length} hint="active in the last 5 min" live={stats.live.length > 0} />
            <Kpi label="Active users" value={stats.activeUsers} hint={`signed in or ran an audit · ${days}d`} />
            <Kpi label="Total users" value={data.users.length} hint={`${stats.newUsers} new · ${stats.staffUsers} CleverTap`} />
            <Kpi label="Audits" value={stats.inRange.length} hint={`${data.audits.length} all time${data.truncated ? "+" : ""}`} />
            <Kpi label="Completed" value={`${pct(stats.byStatus.completed, stats.inRange.length)}%`} hint={`${stats.byStatus.completed} audits`} />
            <Kpi label="Failed" value={stats.byStatus.failed} hint="errored before finishing" />
            <Kpi label="In progress" value={stats.byStatus.running} hint="draft, scanning or verifying" />
            <Kpi label="Avg. per user" value={stats.auditors ? (stats.inRange.length / stats.auditors).toFixed(1) : "0"} hint={`${stats.auditors} users ran audits`} />
          </section>

          <Card className="p-5 sm:p-6">
            <ChartHead title="Audits per day" sub="By platform" legend={PLATFORMS.map((p) => ({ name: PLATFORM_META[p].label, color: PLATFORM_COLOR[p] }))} />
            <ColumnChart
              series={PLATFORMS.map((p) => ({ name: PLATFORM_META[p].label, color: PLATFORM_COLOR[p] }))}
              buckets={stats.daily.map((d) => ({ key: d.day, label: shortDay(d.day), values: PLATFORMS.map((p) => d[p]) }))}
            />
          </Card>

          <div className="grid gap-6 lg:grid-cols-2">
            <Card className="p-5 sm:p-6">
              <ChartHead title="Active users per day" sub="Distinct people who started an audit" />
              <ColumnChart
                series={[{ name: "Users", color: "var(--series-1)" }]}
                buckets={stats.daily.map((d) => ({ key: d.day, label: shortDay(d.day), values: [d.users] }))}
              />
            </Card>
            <Card className="p-5 sm:p-6">
              <ChartHead title="New sign-ups per day" sub="First time signing in" />
              <ColumnChart
                series={[{ name: "Sign-ups", color: "var(--series-1)" }]}
                buckets={stats.daily.map((d) => ({ key: d.day, label: shortDay(d.day), values: [d.signups] }))}
              />
            </Card>
          </div>

          <div className="grid gap-6 lg:grid-cols-3">
            <Card className="p-5 sm:p-6">
              <ChartHead title="By platform" />
              <Breakdown
                total={stats.inRange.length}
                rows={PLATFORMS.map((p) => ({ label: PLATFORM_META[p].label, icon: p, value: stats.byPlatform[p], color: PLATFORM_COLOR[p] }))}
              />
            </Card>
            <Card className="p-5 sm:p-6">
              <ChartHead title="By outcome" />
              <Breakdown
                total={stats.inRange.length}
                rows={[
                  { label: "Completed", value: stats.byStatus.completed, color: "var(--pass)" },
                  { label: "In progress", value: stats.byStatus.running, color: "var(--manual)" },
                  { label: "Failed", value: stats.byStatus.failed, color: "var(--fail)" },
                ]}
              />
            </Card>
            <Card className="p-5 sm:p-6">
              <ChartHead title="How builds were checked" />
              <Breakdown
                total={stats.inRange.length}
                rows={[
                  { label: "Scanned in browser", value: stats.bySource.browser, color: "var(--series-1)" },
                  { label: "Uploaded", value: stats.bySource.upload, color: "var(--series-1)" },
                  { label: "Website URL", value: stats.bySource.url, color: "var(--series-1)" },
                ]}
              />
            </Card>
          </div>

          <Card className="p-5 sm:p-6">
            <ChartHead title="Busiest hours" sub="Audits started, by hour of day (your time zone)" />
            <ColumnChart
              series={[{ name: "Audits", color: "var(--series-1)" }]}
              buckets={stats.hours.map((n, h) => ({ key: h, label: `${String(h).padStart(2, "0")}:00`, values: [n] }))}
              labelEvery={3}
            />
          </Card>

          <LiveUsers live={stats.live} />
          <UsersTable rows={stats.userRows} days={days} />
          <AuditsTable audits={stats.inRange} />

          <p className="text-xs text-muted">
            Updated {timeAgo(data.generatedAt)} · refreshes every minute{error ? ` · last refresh failed: ${error}` : ""}
          </p>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

interface UserRow extends AdminUser {
  audits: number;
  byPlatform: Record<Platform, number>;
  lastAuditAt: number | null;
  live: boolean;
}

function compute(data: Data, days: number, now: number) {
  const from = startOfDay(now) - (days - 1) * DAY;
  const inRange = data.audits.filter((a) => a.createdAt >= from);

  const daily = Array.from({ length: days }, (_, i) => {
    const day = from + i * DAY;
    return { day, android: 0, ios: 0, web: 0, users: 0, signups: 0, emails: new Set<string>() };
  });
  // DST shifts can make a "day" 23 or 25 hours, so look buckets up by key.
  const byDay = new Map(daily.map((d) => [d.day, d]));
  const find = (t: number) => byDay.get(dayKey(t)) ?? daily.find((d, i) => t >= d.day && (i === daily.length - 1 || t < daily[i + 1].day));

  const byPlatform: Record<Platform, number> = { android: 0, ios: 0, web: 0 };
  const byStatus = { completed: 0, failed: 0, running: 0 };
  const bySource = { browser: 0, upload: 0, url: 0 };
  const hours = Array(24).fill(0) as number[];
  const auditorEmails = new Set<string>();

  for (const a of inRange) {
    const d = find(a.createdAt);
    if (d) {
      d[a.platform]++;
      d.emails.add(a.email);
    }
    byPlatform[a.platform]++;
    if (a.status === "completed") byStatus.completed++;
    else if (a.status === "failed") byStatus.failed++;
    else if (running(a.status)) byStatus.running++;
    bySource[a.source]++;
    hours[new Date(a.createdAt).getHours()]++;
    auditorEmails.add(a.email.toLowerCase());
  }
  for (const d of daily) d.users = d.emails.size;
  for (const u of data.users) {
    if (u.createdAt < from) continue;
    const d = find(u.createdAt);
    if (d) d.signups++;
  }

  // Per-user rollup across all time, with the selected range's audit count.
  const perEmail = new Map<string, { audits: number; byPlatform: Record<Platform, number>; lastAuditAt: number | null }>();
  for (const a of data.audits) {
    const k = a.email.toLowerCase();
    const r = perEmail.get(k) ?? { audits: 0, byPlatform: { android: 0, ios: 0, web: 0 }, lastAuditAt: null };
    if (a.createdAt >= from) {
      r.audits++;
      r.byPlatform[a.platform]++;
    }
    r.lastAuditAt = Math.max(r.lastAuditAt ?? 0, a.createdAt);
    perEmail.set(k, r);
  }
  const userRows: UserRow[] = data.users
    .map((u) => {
      const r = perEmail.get(u.email.toLowerCase());
      const lastSeenAt = Math.max(u.lastSeenAt ?? 0, r?.lastAuditAt ?? 0) || null;
      return {
        ...u,
        lastSeenAt,
        audits: r?.audits ?? 0,
        byPlatform: r?.byPlatform ?? { android: 0, ios: 0, web: 0 },
        lastAuditAt: r?.lastAuditAt ?? null,
        live: !!lastSeenAt && now - lastSeenAt < LIVE_WINDOW,
      };
    })
    .sort((a, b) => (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0));

  return {
    inRange,
    daily,
    byPlatform,
    byStatus,
    bySource,
    hours,
    auditors: auditorEmails.size,
    userRows,
    live: userRows.filter((u) => u.live),
    activeUsers: userRows.filter((u) => (u.lastSeenAt ?? 0) >= from || u.audits > 0).length,
    newUsers: data.users.filter((u) => u.createdAt >= from).length,
    staffUsers: data.users.filter((u) => u.isStaff).length,
  };
}

/* ---------------- pieces ---------------- */

function Kpi({ label, value, hint, live }: { label: string; value: number | string; hint?: string; live?: boolean }) {
  return (
    <Card className="p-5">
      <div className="flex items-center gap-2 text-sm font-semibold text-muted">
        {live !== undefined && (
          <span className={cx("h-2.5 w-2.5 rounded-full", live ? "pulse-dot bg-[var(--pass)]" : "bg-[var(--border-strong)]")} aria-hidden />
        )}
        {label}
      </div>
      <div className="mt-2 text-3xl font-bold tabular-nums tracking-[-0.02em]">{value}</div>
      {hint && <div className="mt-1 text-[13px] text-muted">{hint}</div>}
    </Card>
  );
}

function ChartHead({ title, sub, legend }: { title: string; sub?: string; legend?: { name: string; color: string }[] }) {
  return (
    <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 className="text-lg font-bold">{title}</h2>
        {sub && <p className="mt-0.5 text-sm text-muted">{sub}</p>}
      </div>
      {legend && (
        <ul className="flex flex-wrap gap-4 text-sm text-text-2">
          {legend.map((l) => (
            <li key={l.name} className="flex items-center gap-2">
              <span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: l.color }} aria-hidden />
              {l.name}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Stacked columns with a hover tooltip; one column per bucket. */
function ColumnChart({
  buckets,
  series,
  height = 180,
  labelEvery,
}: {
  buckets: { key: number; label: string; values: number[] }[];
  series: { name: string; color: string }[];
  height?: number;
  labelEvery?: number;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const totals = buckets.map((b) => b.values.reduce((s, v) => s + v, 0));
  const max = niceMax(Math.max(1, ...totals));
  const every = labelEvery ?? Math.max(1, Math.ceil(buckets.length / 7));
  const ticks = [max, max / 2, 0];
  const h = hover !== null ? buckets[hover] : null;

  return (
    <div className="flex gap-3">
      <div className="relative w-7 shrink-0 text-right text-xs tabular-nums text-muted" style={{ height }} aria-hidden>
        {ticks.map((t) => (
          <span key={t} className="absolute right-0 -translate-y-1/2" style={{ top: `${(1 - t / max) * 100}%` }}>
            {Number.isInteger(t) ? t : t.toFixed(1)}
          </span>
        ))}
      </div>
      <div className="min-w-0 flex-1">
        <div className="relative" style={{ height }} onMouseLeave={() => setHover(null)}>
          {ticks.map((t) => (
            <div key={t} className="absolute inset-x-0 border-t border-[var(--border)]" style={{ top: `${(1 - t / max) * 100}%` }} aria-hidden />
          ))}
          <div className="absolute inset-0 flex items-end" role="img" aria-label={`${series.map((s) => s.name).join(", ")} — ${buckets.length} buckets, peak ${Math.max(0, ...totals)}`}>
            {buckets.map((b, i) => (
              <div
                key={b.key}
                className={cx("flex h-full flex-1 cursor-default flex-col justify-end px-[1px]", hover === i && "bg-surface-2")}
                onMouseEnter={() => setHover(i)}
              >
                <div className="flex flex-col-reverse gap-[2px]" style={{ height: `${(totals[i] / max) * 100}%` }}>
                  {b.values.map((v, si) =>
                    v ? (
                      <div
                        key={si}
                        className="w-full last:rounded-t-[4px]"
                        style={{ flexGrow: v, flexBasis: 0, minHeight: 2, background: series[si].color, maxWidth: 28, margin: "0 auto" }}
                      />
                    ) : null,
                  )}
                </div>
              </div>
            ))}
          </div>
          {h && hover !== null && (
            <div
              className="pointer-events-none absolute top-0 z-10 min-w-36 rounded-xl border bg-surface px-3 py-2 text-sm shadow-[var(--shadow-md)]"
              style={hover > buckets.length / 2 ? { right: `${((buckets.length - hover) / buckets.length) * 100}%` } : { left: `${((hover + 1) / buckets.length) * 100}%` }}
            >
              <div className="mb-1 font-bold">{h.label}</div>
              {series.map((s, si) => (
                <div key={s.name} className="flex items-center justify-between gap-4 text-text-2">
                  <span className="flex items-center gap-2">
                    <span className="h-2 w-2 rounded-[2px]" style={{ background: s.color }} aria-hidden />
                    {s.name}
                  </span>
                  <span className="font-bold tabular-nums text-text">{h.values[si]}</span>
                </div>
              ))}
              {series.length > 1 && (
                <div className="mt-1 flex justify-between border-t pt-1 text-text-2">
                  Total <span className="font-bold tabular-nums text-text">{totals[hover]}</span>
                </div>
              )}
            </div>
          )}
        </div>
        <div className="mt-2 flex text-xs text-muted" aria-hidden>
          {buckets.map((b, i) => (
            <span key={b.key} className="flex-1 overflow-visible whitespace-nowrap text-center">
              {i % every === 0 ? b.label : ""}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

function niceMax(n: number) {
  // even, so the midline tick is a whole number
  if (n <= 4) return 4;
  const mag = 10 ** Math.floor(Math.log10(n));
  return [2, 4, 6, 8, 10].map((m) => m * mag).find((v) => v >= n) ?? n;
}

function Breakdown({ rows, total }: { rows: { label: string; value: number; color: string; icon?: Platform }[]; total: number }) {
  return (
    <ul className="flex flex-col gap-4">
      {rows.map((r) => (
        <li key={r.label}>
          <div className="mb-1.5 flex items-center justify-between gap-3 text-sm">
            <span className="flex items-center gap-2 font-semibold">
              {r.icon && <PlatformIcon platform={r.icon} size={16} />}
              {r.label}
            </span>
            <span className="tabular-nums text-muted">
              <span className="font-bold text-text">{r.value}</span> · {pct(r.value, total)}%
            </span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-surface-3">
            <div className="h-full rounded-full" style={{ width: `${pct(r.value, total)}%`, background: r.color }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

function LiveUsers({ live }: { live: UserRow[] }) {
  return (
    <section>
      <SectionTitle sub="Signed-in users with the app open in the last 5 minutes.">Live now</SectionTitle>
      {live.length === 0 ? (
        <Card className="px-5 py-6 text-sm text-muted">Nobody is using the app right now.</Card>
      ) : (
        <div className="flex flex-wrap gap-2">
          {live.map((u) => (
            <span key={u.id} className="inline-flex items-center gap-2 rounded-full border bg-surface px-3 py-1.5 text-sm font-semibold">
              <span className="pulse-dot h-2 w-2 rounded-full bg-[var(--pass)]" aria-hidden />
              {u.email}
              <span className="font-normal text-muted">{timeAgo(u.lastSeenAt!)}</span>
            </span>
          ))}
        </div>
      )}
    </section>
  );
}

function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <label className="flex min-h-10 w-full max-w-xs items-center gap-2 rounded-xl border bg-surface px-3 text-sm focus-within:border-brand">
      <Icon name="search" size={16} className="text-muted" />
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className="w-full bg-transparent outline-none" aria-label={placeholder} />
    </label>
  );
}

const th = "px-4 py-3 text-left text-xs font-bold uppercase tracking-wide text-muted";
const td = "px-4 py-3 align-middle";

function UsersTable({ rows, days }: { rows: UserRow[]; days: number }) {
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<"all" | "staff" | "customer">("all");
  const shown = rows.filter((u) => (kind === "all" || (kind === "staff") === u.isStaff) && u.email.toLowerCase().includes(q.trim().toLowerCase()));

  return (
    <section>
      <SectionTitle sub={`Everyone who has signed in, most recently active first. Audit counts are for the last ${days} days.`}>Users</SectionTitle>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <SearchBox value={q} onChange={setQ} placeholder="Search by email" />
        {(["all", "staff", "customer"] as const).map((k) => (
          <button
            key={k}
            onClick={() => setKind(k)}
            aria-pressed={kind === k}
            className={cx(
              "min-h-10 rounded-full border-[1.5px] px-4 text-sm font-bold transition",
              kind === k ? "border-brand bg-brand-soft text-brand-text" : "border-[var(--border-strong)] bg-surface text-text-2 hover:bg-surface-2",
            )}
          >
            {k === "all" ? "All" : k === "staff" ? "CleverTap" : "Customers"}
          </button>
        ))}
      </div>
      <Card className="overflow-x-auto">
        <table className="w-full min-w-[760px] text-sm">
          <thead className="border-b bg-surface-2">
            <tr>
              <th className={th}>User</th>
              <th className={th}>Audits</th>
              <th className={th}>Android · iOS · Web</th>
              <th className={th}>Last active</th>
              <th className={th}>Joined</th>
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && (
              <tr>
                <td colSpan={5} className={cx(td, "py-8 text-center text-muted")}>
                  No users match.
                </td>
              </tr>
            )}
            {shown.map((u) => (
              <tr key={u.id} className="border-t first:border-t-0">
                <td className={td}>
                  <div className="flex items-center gap-2.5">
                    <span className={cx("h-2 w-2 shrink-0 rounded-full", u.live ? "pulse-dot bg-[var(--pass)]" : "bg-transparent")} aria-label={u.live ? "Live now" : undefined} />
                    <span className="font-semibold">{u.email}</span>
                    <Badge tone={u.isStaff ? "brand" : "neutral"}>{u.isStaff ? "CleverTap" : "Customer"}</Badge>
                  </div>
                </td>
                <td className={cx(td, "font-bold tabular-nums")}>{u.audits}</td>
                <td className={cx(td, "tabular-nums text-text-2")}>
                  {u.byPlatform.android} · {u.byPlatform.ios} · {u.byPlatform.web}
                </td>
                <td className={cx(td, "text-text-2")} title={u.lastSeenAt ? formatDate(u.lastSeenAt) : undefined}>
                  {u.live ? <span className="font-bold text-[var(--pass)]">Live now</span> : u.lastSeenAt ? timeAgo(u.lastSeenAt) : "—"}
                </td>
                <td className={cx(td, "text-text-2")} title={formatDate(u.createdAt)}>
                  {new Date(u.createdAt).toLocaleDateString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </section>
  );
}

const STATUS_LABEL: Record<AuditStatus, { label: string; tone: "success" | "danger" | "accent" }> = {
  completed: { label: "Completed", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
  draft: { label: "Draft", tone: "accent" },
  scanning: { label: "Scanning", tone: "accent" },
  verifying: { label: "Verifying", tone: "accent" },
};

function AuditsTable({ audits }: { audits: AdminAudit[] }) {
  const [q, setQ] = useState("");
  const [pf, setPf] = useState<"all" | Platform>("all");
  const [limit, setLimit] = useState(50);
  const needle = q.trim().toLowerCase();
  const filtered = audits.filter(
    (a) => (pf === "all" || a.platform === pf) && (!needle || a.email.toLowerCase().includes(needle) || a.name.toLowerCase().includes(needle) || (a.target ?? "").toLowerCase().includes(needle)),
  );

  return (
    <section>
      <SectionTitle sub="Every audit in the selected range, newest first. Open one to see the full report.">All audits</SectionTitle>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <SearchBox value={q} onChange={setQ} placeholder="Search email, name or target" />
        {(["all", ...PLATFORMS] as const).map((k) => (
          <button
            key={k}
            onClick={() => setPf(k)}
            aria-pressed={pf === k}
            className={cx(
              "inline-flex min-h-10 items-center gap-2 rounded-full border-[1.5px] px-4 text-sm font-bold transition",
              pf === k ? "border-brand bg-brand-soft text-brand-text" : "border-[var(--border-strong)] bg-surface text-text-2 hover:bg-surface-2",
            )}
          >
            {k !== "all" && <PlatformIcon platform={k} size={16} />}
            {k === "all" ? "All" : PLATFORM_META[k].label}
            <span className="font-semibold text-muted">{k === "all" ? audits.length : audits.filter((a) => a.platform === k).length}</span>
          </button>
        ))}
      </div>
      <Card className="overflow-x-auto">
        <table className="w-full min-w-[860px] text-sm">
          <thead className="border-b bg-surface-2">
            <tr>
              <th className={th}>Audit</th>
              <th className={th}>Run by</th>
              <th className={th}>Status</th>
              <th className={th}>Results</th>
              <th className={th}>Started</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr>
                <td colSpan={5} className={cx(td, "py-8 text-center text-muted")}>
                  No audits match.
                </td>
              </tr>
            )}
            {filtered.slice(0, limit).map((a) => (
              <tr key={a.id} className="border-t first:border-t-0 hover:bg-surface-2">
                <td className={td}>
                  <Link href={`/audit/${a.id}`} className="flex min-w-0 items-center gap-3">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-3">
                      <PlatformIcon platform={a.platform} size={16} />
                    </span>
                    <span className="min-w-0">
                      <span className="block max-w-[260px] truncate font-bold hover:underline">{a.name}</span>
                      {a.target && <span className="block max-w-[260px] truncate text-xs text-muted">{a.target}</span>}
                    </span>
                  </Link>
                </td>
                <td className={cx(td, "text-text-2")}>{a.email}</td>
                <td className={td}>
                  <Badge tone={STATUS_LABEL[a.status].tone}>{STATUS_LABEL[a.status].label}</Badge>
                </td>
                <td className={cx(td, "tabular-nums text-text-2")}>
                  {a.results ? (
                    <span>
                      <span className="font-bold text-[var(--pass)]">{a.results.pass}</span> passed ·{" "}
                      <span className="font-bold text-[var(--fail-text)]">{a.results.fail}</span> to fix
                    </span>
                  ) : (
                    "—"
                  )}
                </td>
                <td className={cx(td, "whitespace-nowrap text-text-2")} title={formatDate(a.createdAt)}>
                  {timeAgo(a.createdAt)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      {filtered.length > limit && (
        <div className="mt-3 flex justify-center">
          <Button variant="secondary" size="sm" onClick={() => setLimit((l) => l + 100)}>
            Show more ({filtered.length - limit} left)
          </Button>
        </div>
      )}
    </section>
  );
}
