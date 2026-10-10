"use client";

import { useMemo, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAudit, summarize, setItemStatus, deleteAudit, useMounted } from "@/lib/store";
import { itemsForPlatform, methodFor } from "@/lib/checklist";
import { GROUPS, groupOf, groupName } from "@/lib/stages";
import { getFaq } from "@/lib/faq";
import { PLATFORM_META, REGIONS, LIVE_GUIDE, DOCS_HELP, HOW_TO_CHECK, ANDROID_NOTES, STATUS_LEGEND } from "@/lib/meta";
import type { Audit, ChecklistItem, ItemResult, ItemStatus, Platform } from "@/lib/types";
import type { AndroidScanReport } from "@/lib/analyzer/types";
import { DeviceLab, type DeviceView } from "./DeviceLab";
import { CriticalEvents } from "./CriticalEvents";
import { Card, Button, StatusBadge, StatusMark, MethodBadge, PlatformIcon, StatBar, EmptyState, Badge, Notice } from "@/components/ui";
import { Icon } from "@/components/Icon";
import { formatDate, formatBytes, cx } from "@/lib/format";

type Filter = "all" | ItemStatus;
type StageId = "overview" | DeviceView | "confirm" | "all";
type Mark = ItemStatus | "todo";

const FRAMEWORK_LABEL: Record<string, string> = {
  native: "Native (Kotlin/Java)",
  flutter: "Flutter",
  "react-native": "React Native",
  cordova: "Cordova",
  capacitor: "Ionic Capacitor",
  unity: "Unity",
  dotnet: "Xamarin / .NET MAUI",
  unknown: "Unknown",
};

// Items each device stage proves — used for the progress shown in the stage rail.
const PUSH_ITEMS = ["app-t3-test-push", "app-t3-foreground", "app-t3-background", "app-t3-killed"];
const subscribeHash = (cb: () => void) => {
  window.addEventListener("hashchange", cb);
  return () => window.removeEventListener("hashchange", cb);
};
const readHash = () => window.location.hash.slice(1);

const GUIDED_ITEMS = ["app-t1-onuserlogin-update", "app-t4-critical-events", "app-t3-deeplink-internal", "app-t3-deeplink-external", "app-t3-test-inapp"];

export function Results({ id }: { id: string }) {
  const router = useRouter();
  const { audit, error } = useAudit(id);
  const mounted = useMounted();
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  // The open stage lives in the URL hash, so a reload lands in the same place.
  const stage = useSyncExternalStore(subscribeHash, readHash, () => "") as StageId | "";

  const items = useMemo(() => (audit ? itemsForPlatform(audit.platform) : []), [audit]);

  const setStage = (s: StageId) => {
    try {
      history.replaceState(null, "", `#${s}`);
    } catch {
      /* ignore */
    }
    window.dispatchEvent(new Event("hashchange"));
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  if (!mounted || audit === undefined) {
    if (error) return <EmptyState icon="alert" title="Couldn't load the audit" desc={error} />;
    return <ResultsSkeleton />;
  }
  if (audit === null)
    return (
      <EmptyState
        icon="alert"
        title="Audit not found"
        desc="This audit doesn't exist or was deleted."
        action={
          <Button href="/audits" icon="list">
            My audits
          </Button>
        }
      />
    );

  const s = summarize(audit);
  const running = audit.status === "draft" || audit.status === "scanning" || audit.status === "verifying";
  const resultOf = (itemId: string): ItemResult | undefined => audit.results[itemId];
  const statusOf = (itemId: string): ItemStatus => resultOf(itemId)?.status ?? "manual";

  const tierRank = (it: ChecklistItem) => (it.critical ? 0 : 10) + it.tier;
  const issues = items
    .filter((it) => ["fail", "warn"].includes(statusOf(it.id)))
    .sort((a, b) => (statusOf(a.id) === "fail" ? 0 : 1) - (statusOf(b.id) === "fail" ? 0 : 1) || tierRank(a) - tierRank(b));
  const confirmable = items.filter((it) => methodFor(it, audit.platform) !== "auto-api");
  const manualItems = confirmable.filter((it) => statusOf(it.id) === "manual");
  const hasConfirm = manualItems.length > 0 || confirmable.some((it) => resultOf(it.id)?.checkedManually);

  const visible = items.filter((it) => {
    if (filter !== "all" && statusOf(it.id) !== filter) return false;
    if (query && !it.title.toLowerCase().includes(query.toLowerCase())) return false;
    return true;
  });
  const filters: { key: Filter; label: string; count: number }[] = [
    { key: "all", label: "All", count: items.length },
    { key: "fail", label: "Needs fix", count: s.counts.fail },
    { key: "warn", label: "Check this", count: s.counts.warn },
    { key: "manual", label: "To check", count: s.counts.manual },
    { key: "pass", label: "Passed", count: s.counts.pass },
    { key: "na", label: "Not needed", count: s.counts.na },
  ];

  /* ---- stages ---- */
  const hasLab = audit.platform === "android" && !!audit.accountId;
  const progressOf = (ids: string[]): { mark: Mark; text: string } => {
    const present = ids.filter((x) => items.some((it) => it.id === x));
    const st = present.map(statusOf);
    const pass = st.filter((x) => x === "pass").length;
    const fix = st.filter((x) => x === "fail" || x === "warn").length;
    const done = st.filter((x) => x === "pass" || x === "na").length;
    const mark: Mark = present.length > 0 && done === present.length ? "pass" : fix ? "fail" : pass ? "manual" : "todo";
    const text = pass || fix ? `${pass} of ${present.length} passed${fix ? `, ${fix} to fix` : ""}` : "Not started";
    return { mark, text };
  };
  const overallMark: Mark = running ? "todo" : s.counts.fail ? "fail" : s.counts.warn ? "warn" : s.counts.manual ? "manual" : "pass";

  const stages: { id: StageId; name: string; purpose: string; mark: Mark; summary: string }[] = [
    {
      id: "overview",
      name: "Summary",
      purpose: "What we found in your build and CleverTap project, and what to fix first.",
      mark: overallMark,
      summary: running ? "Checking…" : s.counts.fail ? `${s.counts.fail} to fix` : s.counts.warn ? `${s.counts.warn} to look at` : "No fixes needed",
    },
    ...(hasLab
      ? [
          {
            id: "setup" as const,
            name: "Connect your phone",
            purpose: "Link a test phone so we can run the live checks on a real device.",
            mark: (audit.device ? "pass" : "todo") as Mark,
            summary: audit.device
              ? `${audit.device.device.model} checked`
              : audit.api?.testUser?.found
                ? "Test user found"
                : "Not connected yet",
          },
          {
            id: "push" as const,
            name: "Push tests",
            purpose: "We send a test push with the app open, in the background and closed, and watch it arrive.",
            ...(() => {
              const p = progressOf(PUSH_ITEMS);
              return { mark: p.mark, summary: p.text };
            })(),
          },
          {
            id: "guided" as const,
            name: "Guided checks",
            purpose: "Do a few everyday actions in the app. We read the SDK logs and tick each check for you.",
            ...(() => {
              const p = progressOf(GUIDED_ITEMS);
              return { mark: p.mark, summary: p.text };
            })(),
          },
        ]
      : []),
    ...(hasConfirm
      ? [
          {
            id: "confirm" as const,
            name: "Confirm by hand",
            purpose: "A few things only a person can see. Check each one and tell us if it works.",
            mark: (manualItems.length ? "manual" : "pass") as Mark,
            summary: manualItems.length ? `${manualItems.length} left to confirm` : "All confirmed",
          },
        ]
      : []),
    {
      id: "all",
      name: "All checks",
      purpose: "Every check in this audit, with what we expected, what we found and how to fix it.",
      mark: overallMark,
      summary: `${s.counts.pass} of ${s.total} passed`,
    },
  ];
  const current = stages.find((x) => x.id === stage) ?? stages[0];
  const idx = stages.indexOf(current);
  const nextStage = stages[idx + 1];
  const deviceView: DeviceView | null = current.id === "setup" || current.id === "push" || current.id === "guided" ? current.id : null;
  const stageForItem = (itemId: string): StageId | null =>
    !hasLab ? null : PUSH_ITEMS.includes(itemId) || itemId === "app-t1-fcm-service" ? "push" : "guided";

  const openItem = (itemId: string) => {
    setFilter("all");
    setOpenId(itemId);
    setStage("all");
    setTimeout(() => document.getElementById(`item-${itemId}`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 80);
  };

  const meta = [
    `${PLATFORM_META[audit.platform].label} app`,
    audit.region && (REGIONS.find((r) => r.id === audit.region)?.label ?? audit.region),
    audit.accountId,
    audit.fileName && `${audit.fileName}${audit.fileSize ? ` (${formatBytes(audit.fileSize)})` : ""}`,
    formatDate(audit.createdAt),
  ].filter(Boolean) as string[];

  return (
    <div className="flex flex-col gap-8">
      {/* Audit header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-1 basis-96 items-start gap-4">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border bg-surface">
            <PlatformIcon platform={audit.platform} size={24} />
          </span>
          <div className="min-w-0">
            <Link href="/audits" className="text-sm font-semibold text-muted hover:text-text">
              ← My audits
            </Link>
            <h1 className="mt-0.5 text-2xl font-bold">{audit.name}</h1>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted">
              {meta.map((m, i) => (
                <span key={i} className={cx(m === audit.accountId && "font-mono text-[13px]")}>
                  {i > 0 && <span className="mr-2 text-muted-2">·</span>}
                  {m}
                </span>
              ))}
              {audit.source === "browser" && (
                <span className="inline-flex items-center gap-1">
                  <span className="mr-1 text-muted-2">·</span>
                  <Icon name="lock" size={13} style={{ color: "var(--pass)" }} /> Checked privately in your browser
                </span>
              )}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" icon="download" onClick={() => window.print()}>
            Export
          </Button>
          <Button
            variant="ghost"
            size="sm"
            icon="trash"
            disabled={deleting}
            onClick={async () => {
              if (!confirm("Delete this audit and its results?")) return;
              setDeleting(true);
              try {
                await deleteAudit(audit.id);
                router.push("/audits");
              } catch (e) {
                setDeleting(false);
                alert((e as Error).message);
              }
            }}
          >
            Delete
          </Button>
        </div>
      </div>

      {running && (
        <div role="status" className="flex items-start gap-3 rounded-xl px-4 py-3.5" style={{ background: "var(--brand-soft)" }}>
          <span className="pulse-dot mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: "var(--brand)" }} />
          <div className="text-sm text-text-2">
            <div className="font-bold text-text">{audit.stage ?? "Processing…"}</div>
            This page updates by itself. If you closed the window during a private scan, start a new audit.
          </div>
        </div>
      )}
      {audit.status === "failed" && audit.error && <Notice tone="fail" title="The analysis didn't finish">{audit.error}</Notice>}
      {audit.status === "completed" && audit.error && <Notice tone="warn" title="Some checks were skipped">{audit.error}</Notice>}

      <div className="grid grid-cols-[minmax(0,1fr)] gap-8 lg:grid-cols-[264px_minmax(0,1fr)]">
        {/* Stage rail */}
        <nav aria-label="Audit stages" className="no-print min-w-0 lg:sticky lg:top-24 lg:self-start">
          <div className="mb-4 hidden px-3 lg:block">
            <div className="text-[15px] font-bold">
              {s.counts.pass} of {s.total} checks passed
            </div>
            <div className="mt-2">
              <StatBar
                total={s.total}
                segments={[
                  { value: s.counts.pass, color: "var(--pass)" },
                  { value: s.counts.fail, color: "var(--fail)" },
                  { value: s.counts.warn, color: "var(--warn-dot)" },
                ]}
              />
            </div>
            <div className="mt-2 text-[13px] text-muted">
              {[s.counts.fail && `${s.counts.fail} to fix`, s.counts.warn && `${s.counts.warn} to look at`, `${s.counts.manual} still to check`]
                .filter(Boolean)
                .join(", ")}
            </div>
          </div>
          <ol className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1 lg:mx-0 lg:flex-col lg:overflow-visible lg:px-0 lg:pb-0">
            {stages.map((g, i) => {
              const on = g.id === current.id;
              return (
                <li key={g.id} className="shrink-0 lg:shrink">
                  <button
                    onClick={() => setStage(g.id)}
                    aria-current={on ? "step" : undefined}
                    className={cx(
                      "flex min-h-[58px] w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left",
                      on ? "border-[var(--border)] bg-surface shadow-[var(--shadow-sm)]" : "border-transparent hover:bg-surface/70",
                    )}
                  >
                    {g.mark === "todo" || (g.mark === "manual" && !on) ? (
                      <span
                        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[13px] font-bold"
                        style={
                          on || g.mark === "manual"
                            ? { border: "2px solid var(--brand)", color: "var(--brand)" }
                            : { border: "1.5px solid var(--border-strong)", color: "var(--muted-2)" }
                        }
                      >
                        {i + 1}
                      </span>
                    ) : (
                      <StatusMark status={g.mark} />
                    )}
                    <span className="flex min-w-0 flex-col">
                      <span className={cx("whitespace-nowrap text-[15px]", on ? "font-bold" : "font-semibold")}>{g.name}</span>
                      <span className="whitespace-nowrap text-[13px] text-muted">{g.summary}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        </nav>

        {/* Stage content */}
        <div className="min-w-0">
          <div className="mb-6">
            <h2 className="text-[28px] font-bold leading-tight tracking-[-0.015em]">{current.name}</h2>
            <p className="mt-1.5 max-w-[62ch] text-base text-muted">{current.purpose}</p>
          </div>

          {/* ---------- Summary ---------- */}
          <div className={cx(current.id !== "overview" && "hidden print:block")}>
            <div className="space-y-8">
              <Verdict
                running={running}
                s={s}
                onPrimary={
                  hasLab && !audit.device
                    ? { label: "Next: connect your phone", go: () => setStage("setup") }
                    : issues.length
                      ? { label: "See every check", go: () => setStage("all") }
                      : nextStage
                        ? { label: `Continue to ${nextStage.name}`, go: () => setStage(nextStage.id) }
                        : undefined
                }
              />

              {issues.length > 0 && (
                <section aria-labelledby="fix-first">
                  <h3 id="fix-first" className="text-xl font-bold">
                    Fix these first
                  </h3>
                  <p className="mt-1 text-sm text-muted">Most important first. Send these to whoever owns the app code.</p>
                  <ol className="mt-4 overflow-hidden rounded-[var(--radius)] border bg-surface">
                    {issues.map((it, i) => {
                      const r = resultOf(it.id)!;
                      return (
                        <li key={it.id} className={cx("px-6 py-5", i > 0 && "border-t")}>
                          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                            <StatusMark status={r.status} />
                            <h4 className="min-w-0 flex-1 basis-60 text-[17px] font-bold">{it.title}</h4>
                            <Badge tone="neutral">{groupName(groupOf(it))}</Badge>
                            <StatusBadge status={r.status} size="sm" />
                          </div>
                          <div className="mt-3 grid gap-4 sm:pl-10 md:grid-cols-2">
                            {(r.detected || r.evidence) && (
                              <div>
                                <div className="text-sm font-bold text-text-2">What we saw</div>
                                <p className="mt-0.5 text-[15px] text-text-2">{r.detected ?? r.evidence}</p>
                              </div>
                            )}
                            {r.remediation && (
                              <div>
                                <div className="text-sm font-bold text-text-2">How to fix it</div>
                                <p className="mt-0.5 text-[15px] text-text-2">{r.remediation}</p>
                              </div>
                            )}
                          </div>
                          <div className="mt-3 sm:pl-10">
                            <button onClick={() => openItem(it.id)} className="link text-sm">
                              See details
                            </button>
                          </div>
                        </li>
                      );
                    })}
                  </ol>
                  <details className="group mt-4">
                    <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 text-sm font-bold text-muted hover:text-text">
                      What the labels mean
                      <Icon name="chevronDown" size={16} className="transition group-open:rotate-180" />
                    </summary>
                    <ul className="mt-3 space-y-2.5">
                      {STATUS_LEGEND.map((l) => (
                        <li key={l.status} className="flex items-start gap-3 text-[15px] text-text-2">
                          <StatusMark status={l.status} size={22} />
                          <span>
                            <StatusBadge status={l.status} size="sm" /> — {l.text}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </details>
                </section>
              )}

              {audit.scan && <ScanSummary scan={audit.scan} audit={audit} />}

              {audit.platform === "android" && !hasLab && <CriticalEvents audit={audit} />}
            </div>
          </div>

          {/* ---------- Device stages (always mounted) ---------- */}
          {hasLab && <DeviceLab audit={audit} view={deviceView} onNavigate={(v) => setStage(v)} />}

          {/* ---------- Confirm by hand ---------- */}
          {hasConfirm && (
            <div hidden={current.id !== "confirm"}>
              <LiveDevicePanel
                platform={audit.platform}
                items={manualItems}
                statusOf={statusOf}
                onSet={(itemId, st) => setItemStatus(audit.id, itemId, st)}
              />
            </div>
          )}

          {/* ---------- All checks ---------- */}
          <div className={cx(current.id !== "all" && "hidden print:mt-10 print:block")}>
            <div className="mb-6 flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between lg:gap-6">
              <div className="flex flex-wrap items-center gap-2">
                {filters.map((f) => (
                  <button
                    key={f.key}
                    onClick={() => setFilter(f.key)}
                    aria-pressed={filter === f.key}
                    className={cx(
                      "inline-flex min-h-10 items-center gap-2 rounded-full border-[1.5px] px-4 text-sm font-bold transition",
                      filter === f.key ? "border-brand bg-brand-soft text-brand-text" : "border-[var(--border-strong)] bg-surface text-text-2 hover:bg-surface-2",
                    )}
                  >
                    {f.label}
                    <span className="font-semibold text-muted">{f.count}</span>
                  </button>
                ))}
              </div>
              <div className="relative order-first w-full shrink-0 sm:max-w-sm lg:order-none lg:w-64">
                <Icon name="search" size={17} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-2" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Find a check"
                  aria-label="Find a check"
                  className="input w-full pl-10"
                />
              </div>
            </div>

            <div className="flex flex-col gap-6">
              {GROUPS.map((g) => {
                const groupItems = visible.filter((i) => groupOf(i) === g.id);
                if (groupItems.length === 0) return null;
                const all = items.filter((i) => groupOf(i) === g.id);
                const passed = all.filter((i) => statusOf(i.id) === "pass").length;
                return (
                  <section key={g.id} aria-label={g.name}>
                    <div className="mb-2.5 flex flex-wrap items-baseline justify-between gap-2 px-1">
                      <h3 className="text-lg font-bold">{g.name}</h3>
                      <span className="text-sm text-muted">
                        {passed} of {all.length} passed
                      </span>
                    </div>
                    <Card className="overflow-hidden">
                      {groupItems.map((it, i) => (
                        <ItemRow
                          key={it.id}
                          first={i === 0}
                          item={it}
                          platform={audit.platform}
                          result={resultOf(it.id)}
                          open={openId === it.id}
                          onToggle={() => setOpenId((cur) => (cur === it.id ? null : it.id))}
                          onSet={(st) => setItemStatus(audit.id, it.id, st)}
                          onGo={stageForItem(it.id) ? () => setStage(stageForItem(it.id)!) : undefined}
                        />
                      ))}
                    </Card>
                  </section>
                );
              })}
              {visible.length === 0 && <EmptyState icon="search" title="No checks match" desc="Try a different filter or search." />}
            </div>
          </div>

          {/* ---------- Move on ---------- */}
          <div className="no-print mt-10 flex flex-wrap items-center justify-between gap-x-5 gap-y-3 border-t pt-6">
            <span className="text-sm text-muted">You can move on now and come back to any stage later.</span>
            {nextStage && (
              <Button variant="secondary" iconRight="arrowRight" onClick={() => setStage(nextStage.id)}>
                Continue to {nextStage.name}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------------- verdict ---------------- */

function Verdict({
  running,
  s,
  onPrimary,
}: {
  running: boolean;
  s: ReturnType<typeof summarize>;
  onPrimary?: { label: string; go: () => void };
}) {
  const { pass, fail, warn, manual, na } = s.counts;
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const headline = running
    ? "Checking your build…"
    : fail
      ? `${plural(fail, "thing", "things")} to fix`
      : warn
        ? `Almost there — ${plural(warn, "thing", "things")} to look at`
        : manual
          ? "Looking good so far"
          : "Everything passed";
  const sub = running
    ? "Results appear here as each check finishes."
    : `${pass} of ${s.total} checks passed.${manual ? ` ${plural(manual, "check needs", "checks need")} your phone or a quick look.` : ""}`;
  return (
    <Card className="p-7 md:p-8">
      <h3 className="max-w-[20ch] text-4xl font-bold tracking-[-0.025em]">{headline}</h3>
      <p className="mt-3 max-w-[60ch] text-lg text-text-2">{sub}</p>
      <div className="mt-5 flex flex-wrap items-center gap-x-6 gap-y-2 text-[15px]">
        <Count color="var(--pass)" n={pass} label="passed" />
        {fail > 0 && <Count color="var(--fail)" n={fail} label="to fix" />}
        {warn > 0 && <Count color="var(--warn-dot)" n={warn} label="to look at" />}
        {manual > 0 && <Count ring n={manual} label="still to check" />}
        {na > 0 && <Count dashed n={na} label="not needed" />}
      </div>
      <div className="mt-5">
        <StatBar
          height={10}
          total={s.total}
          segments={[
            { value: pass, color: "var(--pass)" },
            { value: fail, color: "var(--fail)" },
            { value: warn, color: "var(--warn-dot)" },
          ]}
        />
      </div>
      {onPrimary && (
        <div className="mt-6">
          <Button size="lg" iconRight="arrowRight" onClick={onPrimary.go}>
            {onPrimary.label}
          </Button>
        </div>
      )}
    </Card>
  );
}

function Count({ color, ring, dashed, n, label }: { color?: string; ring?: boolean; dashed?: boolean; n: number; label: string }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span
        className="h-3 w-3 rounded-full"
        style={
          ring
            ? { border: "2px solid var(--manual)" }
            : dashed
              ? { border: "1.5px dashed var(--muted-2)" }
              : { background: color }
        }
      />
      <strong>{n}</strong> {label}
    </span>
  );
}

/* ---------------- scan summary ---------------- */

function ScanSummary({ scan }: { scan: AndroidScanReport; audit: Audit }) {
  const ct = scan.clevertap;
  const sdk = ct.coreVersion ? `v${ct.coreVersion}` : ct.present ? "found" : "not found";
  const facts: [string, string][] = [
    ["App", scan.app.packageName ?? "—"],
    ["Version", scan.app.versionName ?? "—"],
    ["Framework", FRAMEWORK_LABEL[scan.framework.primary]],
    ["CleverTap SDK", sdk],
  ];
  return (
    <section aria-labelledby="your-build">
      <h3 id="your-build" className="text-xl font-bold">
        Your build
      </h3>
      {scan.notes.some((n) => /debug \(JIT\)/.test(n)) && (
        <Notice tone="warn" title="This is a debug build" className="mt-3">
          Some code checks can&apos;t read it. Upload the release build (<code className="font-mono text-[13px]">flutter build apk --release</code>) for
          full results.
        </Notice>
      )}
      <Card className="mt-4 grid grid-cols-2 overflow-hidden sm:grid-cols-4">
        {facts.map(([k, v], i) => (
          <div key={k} className={cx("px-5 py-4", i > 0 && "border-l", i === 2 && "max-sm:border-l-0 max-sm:border-t", i === 3 && "max-sm:border-t")}>
            <div className="text-[13px] font-semibold text-muted">{k}</div>
            <div className="mt-0.5 truncate text-[15px] font-bold" title={v}>
              {v}
            </div>
          </div>
        ))}
      </Card>
    </section>
  );
}

/* ---------------- confirm-by-hand panel ---------------- */

function LiveDevicePanel({
  platform,
  items,
  statusOf,
  onSet,
}: {
  platform: Platform;
  items: ChecklistItem[];
  statusOf: (id: string) => ItemStatus;
  onSet: (id: string, s: ItemStatus) => void;
}) {
  const g = LIVE_GUIDE[platform];
  return (
    <div className="space-y-5">
      <Card className="p-6">
        <h3 className="text-lg font-bold">How to do it</h3>
        <ol className="mt-3 space-y-2.5">
          {g.steps.map((st, i) => (
            <li key={i} className="flex gap-3 text-[15px] text-text-2">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-[1.5px] border-[var(--border-strong)] text-[13px] font-bold text-muted">
                {i + 1}
              </span>
              <span>{st}</span>
            </li>
          ))}
        </ol>
        <div className="mt-4 overflow-x-auto rounded-lg bg-surface-3 px-3.5 py-2.5 font-mono text-[13px]">{g.verbose}</div>
        <a href={g.helpVideo} target="_blank" rel="noreferrer" className="link mt-4 inline-flex items-center gap-1.5 text-sm">
          New to this? Watch how to turn on USB debugging <Icon name="external" size={14} />
        </a>
      </Card>

      {items.length === 0 ? (
        <Card className="flex items-center gap-4 p-6">
          <StatusMark status="pass" />
          <p className="text-[15px] font-semibold">Nothing left to confirm. You can change any answer under All checks.</p>
        </Card>
      ) : (
        <Card className="overflow-hidden">
          {items.map((it, i) => {
            const st = statusOf(it.id);
            const how = HOW_TO_CHECK[it.id];
            return (
              <div key={it.id} className={cx("flex flex-wrap items-start gap-4 px-6 py-5", i > 0 && "border-t")}>
                <StatusMark status={st} />
                <div className="min-w-0 flex-1 basis-72">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="text-[17px] font-bold">{it.title}</span>
                    {how?.auto && (
                      <span className="inline-flex items-center gap-1.5 rounded-full bg-surface-3 py-0.5 pl-2 pr-2.5 text-xs font-bold text-text-2">
                        <Icon name="auto" size={13} /> Can tick itself
                      </span>
                    )}
                  </div>
                  {how && <p className="mt-1 text-[15px] text-text-2">{how.how}</p>}
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <Button size="sm" variant={st === "pass" ? "primary" : "outline"} icon="check" onClick={() => onSet(it.id, "pass")}>
                      It works
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => onSet(it.id, "fail")}>
                      Not working
                    </Button>
                    <a href={it.docUrl || DOCS_HELP} target="_blank" rel="noreferrer" className="link ml-1 inline-flex items-center gap-1 text-sm">
                      Docs <Icon name="external" size={13} />
                    </a>
                  </div>
                </div>
              </div>
            );
          })}
        </Card>
      )}
    </div>
  );
}

/* ---------------- item row ---------------- */

function HowToCheck({ id, onGo }: { id: string; onGo?: () => void }) {
  const h = HOW_TO_CHECK[id];
  return (
    <div className="rounded-xl px-4 py-3.5" style={{ background: "var(--brand-soft)" }}>
      <div className="flex items-center gap-1.5 text-sm font-bold text-brand-text">
        <Icon name={h.auto ? "auto" : "user"} size={15} /> {h.auto ? "How to check — it ticks itself" : "How to check"}
      </div>
      <p className="mt-1 text-[15px] text-text-2">{h.how}</p>
      {h.auto && onGo && (
        <button onClick={onGo} className="link mt-2 inline-flex items-center gap-1 text-sm">
          Take me there <Icon name="arrowRight" size={14} />
        </button>
      )}
    </div>
  );
}

function ItemRow({
  item,
  platform,
  result,
  open,
  first,
  onToggle,
  onSet,
  onGo,
}: {
  item: ChecklistItem;
  platform: Platform;
  result?: ItemResult;
  open: boolean;
  first: boolean;
  onToggle: () => void;
  onSet: (s: ItemStatus) => void;
  onGo?: () => void;
}) {
  const status: ItemStatus = result?.status ?? "manual";
  const faq = getFaq(item.faqRef);
  const method = methodFor(item, platform);

  return (
    <div id={`item-${item.id}`} className={cx("scroll-mt-24", !first && "border-t")}>
      <button
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-4 px-5 py-4 text-left transition-colors hover:bg-surface-2 sm:px-6"
      >
        <StatusMark status={status} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
            <span className="text-[16px] font-bold">{item.title}</span>
            {item.critical && <Badge tone="brand">Important</Badge>}
            {result?.checkedManually && <Badge tone="neutral">Your answer</Badge>}
          </div>
          {result?.detected && <div className="mt-0.5 truncate text-sm text-muted">{result.detected}</div>}
        </div>
        <span className="hidden md:inline-flex">
          <MethodBadge method={method} />
        </span>
        <span className="hidden w-24 text-right sm:block">
          <StatusBadge status={status} size="sm" />
        </span>
        <Icon name="chevronDown" size={20} className={cx("shrink-0 text-muted-2 transition", open && "rotate-180")} />
      </button>

      {open && (
        <div className="animate-fade-in space-y-4 px-5 pb-6 pt-1 sm:pl-[68px] sm:pr-6">
          <Detail label="What we expect">{item.expected}</Detail>
          {result?.evidence && <Detail label="What we found">{result.evidence}</Detail>}
          {HOW_TO_CHECK[item.id] && status !== "pass" && status !== "na" && <HowToCheck id={item.id} onGo={onGo} />}
          {platform === "android" && ANDROID_NOTES[item.id] && status !== "pass" && status !== "na" && (
            <div className="rounded-xl border bg-surface-2 px-4 py-3.5">
              <div className="flex items-center gap-1.5 text-sm font-bold text-text-2">
                <Icon name="info" size={15} /> Good to know about Android
              </div>
              <p className="mt-1 text-[15px] text-text-2">{ANDROID_NOTES[item.id].text}</p>
              <a href={ANDROID_NOTES[item.id].url} target="_blank" rel="noreferrer" className="link mt-2 inline-flex items-center gap-1 text-sm">
                CleverTap docs <Icon name="external" size={13} />
              </a>
            </div>
          )}
          {result?.details && result.details.length > 0 && (status === "fail" || status === "warn") && (
            <Detail label="Where">
              <ul className="mt-1 space-y-1 font-mono text-[13px] text-text-2">
                {result.details.slice(0, 6).map((d) => (
                  <li key={d} className="break-all">
                    {d}
                  </li>
                ))}
              </ul>
            </Detail>
          )}

          {result?.remediation && (status === "fail" || status === "warn") && (
            <div className="rounded-xl border px-4 py-3.5" style={{ background: "var(--fail-soft)", borderColor: "var(--fail-border)" }}>
              <div className="text-sm font-bold">How to fix it</div>
              <p className="mt-1 text-[15px] text-text-2">{result.remediation}</p>
              {faq?.links?.[0] && (
                <a href={faq.links[0].url} target="_blank" rel="noreferrer" className="link mt-2 inline-flex items-center gap-1 text-sm">
                  {faq.links[0].label} <Icon name="external" size={13} />
                </a>
              )}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2 pt-1">
            {item.docUrl && (
              <a href={item.docUrl} target="_blank" rel="noreferrer" className="link mr-2 inline-flex items-center gap-1 text-sm">
                Documentation <Icon name="external" size={13} />
              </a>
            )}
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <span className="text-sm text-muted">Checked it yourself?</span>
              <Button size="sm" variant={status === "pass" && result?.checkedManually ? "primary" : "secondary"} icon="check" onClick={() => onSet("pass")}>
                It works
              </Button>
              <Button
                size="sm"
                variant={status === "fail" && result?.checkedManually ? "danger" : "secondary"}
                onClick={() => onSet("fail")}
              >
                Not working
              </Button>
              {result?.checkedManually && (
                <Button size="sm" variant="ghost" icon="refresh" onClick={() => onSet("manual")}>
                  Undo my answer
                </Button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-sm font-bold text-text-2">{label}</div>
      <div className="mt-0.5 text-[15px] text-text-2">{children}</div>
    </div>
  );
}

function ResultsSkeleton() {
  return (
    <div className="flex flex-col gap-8">
      <div className="h-14 w-80 skeleton rounded-xl" />
      <div className="grid gap-8 lg:grid-cols-[264px_1fr]">
        <div className="h-80 skeleton rounded-[var(--radius)]" />
        <div className="space-y-5">
          <div className="h-56 skeleton rounded-[var(--radius)]" />
          <div className="h-64 skeleton rounded-[var(--radius)]" />
        </div>
      </div>
    </div>
  );
}
