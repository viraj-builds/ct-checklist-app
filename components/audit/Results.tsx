"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useAudit, summarize, setItemStatus, deleteAudit, useMounted } from "@/lib/store";
import { itemsForPlatform, methodFor, TIER_LABELS } from "@/lib/checklist";
import { getFaq } from "@/lib/faq";
import { PLATFORM_META, MODE_META, STATUS_META, REGIONS, LIVE_GUIDE, DOCS_HELP, HOW_TO_CHECK, ANDROID_NOTES, STATUS_LEGEND } from "@/lib/meta";
import type { Audit, ChecklistItem, ItemResult, ItemStatus, Platform } from "@/lib/types";
import type { AndroidScanReport } from "@/lib/analyzer/types";
import { DeviceLab } from "./DeviceLab";
import { CriticalEvents } from "./CriticalEvents";
import { Card, Button, ProgressRing, StatusBadge, MethodBadge, PlatformIcon, StatBar, EmptyState, Badge } from "@/components/ui";
import { Icon } from "@/components/Icon";
import { formatDate, formatBytes, cx } from "@/lib/format";

type Filter = "all" | ItemStatus;

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

export function Results({ id }: { id: string }) {
  const router = useRouter();
  const { audit, error } = useAudit(id);
  const mounted = useMounted();
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const items = useMemo(() => (audit ? itemsForPlatform(audit.platform) : []), [audit]);

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
            All audits
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
  const manualItems = items.filter((it) => statusOf(it.id) === "manual" && methodFor(it, audit.platform) !== "auto-api");

  const visible = items.filter((it) => {
    if (filter !== "all" && statusOf(it.id) !== filter) return false;
    if (query && !it.title.toLowerCase().includes(query.toLowerCase())) return false;
    return true;
  });
  const tiers = Array.from(new Set(items.map((i) => i.tier))).sort();
  const filters: { key: Filter; label: string; count: number }[] = [
    { key: "all", label: "All", count: items.length },
    { key: "fail", label: "Fail", count: s.counts.fail },
    { key: "warn", label: "Warning", count: s.counts.warn },
    { key: "manual", label: "Manual", count: s.counts.manual },
    { key: "pass", label: "Pass", count: s.counts.pass },
    { key: "na", label: "N/A", count: s.counts.na },
  ];

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-surface-2">
            <PlatformIcon platform={audit.platform} size={22} />
          </span>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-bold tracking-tight">{audit.name}</h1>
              <Badge tone="neutral">{PLATFORM_META[audit.platform].label}</Badge>
              {audit.source === "browser" && (
                <Badge tone="success">
                  <Icon name="lock" size={11} /> Private scan
                </Badge>
              )}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
              <span className="flex items-center gap-1">
                <Icon name={MODE_META[audit.mode].icon as never} size={13} />
                {MODE_META[audit.mode].label}
              </span>
              {audit.region && <span>· {REGIONS.find((r) => r.id === audit.region)?.label ?? audit.region}</span>}
              {audit.accountId && <span className="font-mono">· {audit.accountId}</span>}
              {audit.fileName && (
                <span className="font-mono">
                  · {audit.fileName}
                  {audit.fileSize ? ` (${formatBytes(audit.fileSize)})` : ""}
                </span>
              )}
              <span>· {formatDate(audit.createdAt)}</span>
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
        <Banner tone="info" icon="clock" title={audit.stage ?? "Processing…"}>
          This page updates automatically. If you closed the window during a private scan, start a new audit.
        </Banner>
      )}
      {audit.status === "failed" && audit.error && (
        <Banner tone="fail" icon="alert" title="The analysis failed">
          {audit.error}
        </Banner>
      )}
      {audit.status === "completed" && audit.error && (
        <Banner tone="warn" icon="alert" title="Some checks were skipped">
          {audit.error}
        </Banner>
      )}

      {/* Summary */}
      <div className="grid gap-4 lg:grid-cols-[auto_1fr]">
        <Card className="flex items-center gap-5 p-6">
          <ProgressRing value={s.score} sublabel="auto score" />
          <div className="space-y-2">
            <div className="text-sm font-medium">Integration score</div>
            <p className="max-w-[180px] text-xs leading-relaxed text-muted">
              Share of automatically checked items that pass. Manual items are tracked separately.
            </p>
            {s.manualPending > 0 && (
              <span
                className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium"
                style={{ background: "var(--manual-soft)", color: "var(--manual)" }}
              >
                <Icon name="clock" size={12} /> {s.manualPending} manual checks pending
              </span>
            )}
          </div>
        </Card>

        <Card className="p-6">
          <div className="mb-3 flex items-center justify-between">
            <span className="text-sm font-medium">Breakdown</span>
            <span className="text-xs text-muted">{s.total} checks</span>
          </div>
          <StatBar
            segments={[
              { value: s.counts.pass, color: "var(--pass)" },
              { value: s.counts.warn, color: "var(--warn)" },
              { value: s.counts.fail, color: "var(--fail)" },
              { value: s.counts.manual, color: "var(--manual)" },
            ]}
          />
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <CountTile status="pass" n={s.counts.pass} />
            <CountTile status="warn" n={s.counts.warn} />
            <CountTile status="fail" n={s.counts.fail} />
            <CountTile status="manual" n={s.counts.manual} />
          </div>
        </Card>
      </div>

      {/* What the scan found */}
      {audit.scan && <ScanSummary scan={audit.scan} audit={audit} />}

      {/* What needs to be done — failures and warnings kept apart */}
      {issues.length > 0 && (
        <Card className="p-5">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <Icon name="alert" size={18} className="text-[var(--fail)]" />
            <h2 className="font-semibold">What needs to be done ({issues.length})</h2>
          </div>
          {(["fail", "warn"] as const).map((group) => {
            const list = issues.filter((it) => statusOf(it.id) === group);
            if (!list.length) return null;
            return (
              <div key={group} className="mb-4 last:mb-0">
                <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide" style={{ color: STATUS_META[group].token }}>
                  {group === "fail" ? `Must fix (${list.length})` : `Should check (${list.length})`}
                  <span className="font-normal normal-case tracking-normal text-muted">
                    {STATUS_LEGEND.find((l) => l.status === group)?.text}
                  </span>
                </div>
                <div className="space-y-2">
                  {list.map((it) => {
                    const r = resultOf(it.id)!;
                    return (
                      <div key={it.id} className="flex items-start gap-3 rounded-xl border bg-surface-2 p-3">
                        <StatusBadge status={r.status} size="sm" />
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-medium">
                            {it.title}
                            {r.detected && <span className="font-normal text-muted"> — {r.detected}</span>}
                          </div>
                          {(r.remediation || r.evidence) && <div className="mt-0.5 text-xs text-muted">{r.remediation ?? r.evidence}</div>}
                        </div>
                        <button
                          onClick={() => {
                            setFilter("all");
                            setOpenId(it.id);
                            setTimeout(() => document.getElementById(`item-${it.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 50);
                          }}
                          className="shrink-0 text-xs font-medium text-brand hover:underline"
                        >
                          View
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
          <details className="mt-3 text-xs text-muted">
            <summary className="cursor-pointer font-medium">What the statuses mean</summary>
            <ul className="mt-1.5 space-y-1">
              {STATUS_LEGEND.map((l) => (
                <li key={l.status} className="flex items-start gap-2">
                  <StatusBadge status={l.status} size="sm" /> <span>{l.text}</span>
                </li>
              ))}
            </ul>
          </details>
        </Card>
      )}


      {/* Custom events to verify (editable) */}
      {audit.platform === "android" && <CriticalEvents audit={audit} />}

      {/* Live device: USB / Wi-Fi / no cable */}
      {audit.platform === "android" && audit.accountId && <DeviceLab audit={audit} />}

      {/* Live-device guided checklist */}
      {manualItems.length > 0 && (
        <LiveDevicePanel
          platform={audit.platform}
          items={manualItems}
          statusOf={statusOf}
          onSet={(itemId, st) => setItemStatus(audit.id, itemId, st)}
        />
      )}

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        {filters.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={cx(
              "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium transition",
              filter === f.key ? "border-brand bg-brand-soft text-brand" : "text-muted hover:bg-surface-2",
            )}
          >
            {f.label}
            <span className="text-xs opacity-70">{f.count}</span>
          </button>
        ))}
        <div className="relative ml-auto">
          <Icon name="search" size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-2" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter items…"
            className="w-44 rounded-full border bg-surface py-1.5 pl-8 pr-3 text-sm outline-none focus:w-56 focus:border-brand"
          />
        </div>
      </div>

      {/* Checklist by tier */}
      <div className="flex flex-col gap-6">
        {tiers.map((tier) => {
          const tierItems = visible.filter((i) => i.tier === tier);
          if (tierItems.length === 0) return null;
          return (
            <div key={tier}>
              <div className="mb-2 flex items-center gap-2 px-1">
                <h3 className="text-sm font-semibold">{TIER_LABELS[tier]}</h3>
                <span className="text-xs text-muted">({tierItems.length})</span>
              </div>
              <Card className="divide-y overflow-hidden">
                {tierItems.map((it) => (
                  <ItemRow
                    key={it.id}
                    item={it}
                    platform={audit.platform}
                    result={resultOf(it.id)}
                    open={openId === it.id}
                    onToggle={() => setOpenId((cur) => (cur === it.id ? null : it.id))}
                    onSet={(st) => setItemStatus(audit.id, it.id, st)}
                  />
                ))}
              </Card>
            </div>
          );
        })}
        {visible.length === 0 && <EmptyState icon="search" title="No items match" desc="Try a different filter or search." />}
      </div>
    </div>
  );
}

/* ---------------- banners ---------------- */

function Banner({
  tone,
  icon,
  title,
  children,
}: {
  tone: "info" | "warn" | "fail";
  icon: "clock" | "alert";
  title: string;
  children: React.ReactNode;
}) {
  const c = tone === "info" ? "var(--accent)" : tone === "warn" ? "var(--warn)" : "var(--fail)";
  const bg = tone === "info" ? "var(--accent-soft)" : tone === "warn" ? "var(--warn-soft)" : "var(--fail-soft)";
  return (
    <div className="flex items-start gap-3 rounded-xl border p-4" style={{ background: bg }}>
      {tone === "info" ? (
        <span className="mt-0.5 h-4 w-4 shrink-0 rounded-full border-2 border-t-transparent animate-spin-slow" style={{ borderColor: c, borderTopColor: "transparent" }} />
      ) : (
        <Icon name={icon} size={18} style={{ color: c }} className="mt-0.5 shrink-0" />
      )}
      <div className="min-w-0">
        <div className="text-sm font-semibold" style={{ color: c }}>
          {title}
        </div>
        <div className="mt-0.5 text-xs leading-relaxed text-muted">{children}</div>
      </div>
    </div>
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
    <Card className="overflow-hidden">
      <div className="flex items-center gap-2 border-b bg-surface-2 px-5 py-3.5">
        <Icon name="android" size={17} className="text-[var(--pass)]" />
        <h2 className="text-sm font-semibold">Your build</h2>
      </div>
      {scan.notes.some((n) => /debug \(JIT\)/.test(n)) && (
        <div className="flex items-start gap-2 border-b px-5 py-2.5 text-xs" style={{ background: "var(--warn-soft)" }}>
          <Icon name="info" size={14} className="mt-0.5 shrink-0" />
          <span>
            <b>This is a debug build.</b> Some code checks can&apos;t read it — upload the release APK (<code className="font-mono">flutter build apk --release</code>)
            for full results.
          </span>
        </div>
      )}
      <div className="grid grid-cols-2 gap-px bg-[var(--border)] sm:grid-cols-4">
        {facts.map(([k, v]) => (
          <div key={k} className="bg-surface px-4 py-3">
            <div className="text-[11px] font-medium uppercase tracking-wide text-muted-2">{k}</div>
            <div className="mt-0.5 truncate text-sm font-medium" title={v}>
              {v}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

/* ---------------- live-device panel ---------------- */

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
    <Card className="overflow-hidden">
      <div className="border-b bg-surface-2 px-5 py-4">
        <div className="flex items-center gap-2">
          <Icon name="terminal" size={18} style={{ color: "var(--manual)" }} />
          <h2 className="font-semibold">Still to confirm by hand</h2>
          <span className="rounded-full px-2 py-0.5 text-xs font-medium" style={{ background: "var(--manual-soft)", color: "var(--manual)" }}>
            {items.length} to verify
          </span>
        </div>
        <p className="mt-1 text-sm text-muted">
          Items marked <b style={{ color: "var(--pass)" }}>Automatic</b> tick themselves when you run that step with the phone connected.
          Only tick by hand what you checked yourself.
        </p>
      </div>

      <div className="grid gap-5 p-5 md:grid-cols-[1.1fr_1fr]">
        <div>
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-2">How to run it</div>
          <ol className="space-y-2">
            {g.steps.map((s, i) => (
              <li key={i} className="flex gap-2.5 text-sm">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-surface-3 text-[11px] font-semibold">{i + 1}</span>
                <span className="text-muted">{s}</span>
              </li>
            ))}
          </ol>
          <div className="mt-3 flex items-center justify-between gap-2 rounded-lg bg-surface-3 px-3 py-2 font-mono text-xs">
            <span className="truncate">{g.verbose}</span>
          </div>
          <a
            href={g.helpVideo}
            target="_blank"
            rel="noreferrer"
            className="mt-3 inline-flex items-center gap-1.5 text-xs font-medium text-accent hover:underline"
          >
            <Icon name="external" size={13} /> New to this? Watch how to enable USB debugging
          </a>
        </div>

        <div>
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-2">Confirm each item</div>
          <div className="space-y-2">
            {items.map((it) => {
              const st = statusOf(it.id);
              return (
                <div key={it.id} className="rounded-xl border p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium">{it.title}</span>
                    <StatusBadge status={st} size="sm" />
                  </div>
                  {HOW_TO_CHECK[it.id] && (
                    <p className="mt-1 text-xs text-muted">
                      {HOW_TO_CHECK[it.id].auto && (
                        <span className="mr-1 font-semibold" style={{ color: "var(--pass)" }}>
                          Automatic ·
                        </span>
                      )}
                      {HOW_TO_CHECK[it.id].how}
                    </p>
                  )}
                  <div className="mt-2 flex items-center gap-1.5">
                    <button
                      onClick={() => onSet(it.id, "pass")}
                      className="rounded-lg px-2.5 py-1 text-xs font-medium text-white transition"
                      style={{ background: st === "pass" ? "var(--pass)" : "var(--na)" }}
                    >
                      ✓ Verified
                    </button>
                    <button
                      onClick={() => onSet(it.id, "fail")}
                      className="rounded-lg border px-2.5 py-1 text-xs font-medium text-muted transition hover:text-text"
                    >
                      ✗ Not working
                    </button>
                    <a
                      href={it.docUrl || DOCS_HELP}
                      target="_blank"
                      rel="noreferrer"
                      className="ml-auto inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline"
                    >
                      Docs <Icon name="external" size={11} />
                    </a>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </Card>
  );
}

/* ---------------- item row ---------------- */

function HowToCheck({ id }: { id: string }) {
  const h = HOW_TO_CHECK[id];
  return (
    <div className="rounded-xl border p-3.5" style={{ background: h.auto ? "var(--pass-soft)" : "var(--manual-soft)" }}>
      <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold" style={{ color: h.auto ? "var(--pass)" : "var(--manual)" }}>
        <Icon name={h.auto ? "zap" : "clock"} size={13} /> {h.auto ? "How to check — automatic" : "How to check"}
      </div>
      <p className="text-sm text-text">{h.how}</p>
      {h.auto && (
        <a href="#live-device" className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline">
          Go to Live device testing <Icon name="arrowRight" size={12} />
        </a>
      )}
    </div>
  );
}

function ItemRow({
  item,
  platform,
  result,
  open,
  onToggle,
  onSet,
}: {
  item: ChecklistItem;
  platform: Platform;
  result?: ItemResult;
  open: boolean;
  onToggle: () => void;
  onSet: (s: ItemStatus) => void;
}) {
  const status: ItemStatus = result?.status ?? "manual";
  const faq = getFaq(item.faqRef);
  const method = methodFor(item, platform);
  const m = STATUS_META[status];

  return (
    <div id={`item-${item.id}`} className={cx(open && "bg-surface-2")}>
      <button onClick={onToggle} className="flex w-full items-center gap-3 px-4 py-3.5 text-left transition hover:bg-surface-2">
        <span
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[13px]"
          style={{ background: m.soft, color: m.token }}
        >
          {status === "pass" ? (
            <Icon name="check" size={14} />
          ) : status === "fail" ? (
            <Icon name="x" size={14} />
          ) : status === "warn" ? (
            <Icon name="alert" size={13} />
          ) : status === "manual" ? (
            <Icon name="clock" size={13} />
          ) : (
            "○"
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{item.title}</span>
            {item.critical && (
              <span className="rounded bg-brand-soft px-1.5 text-[10px] font-semibold uppercase text-brand">Critical</span>
            )}
            {item.origin === "sdk" && (
              <span className="rounded bg-surface-3 px-1.5 text-[10px] font-semibold uppercase text-muted" title="Required by the SDK docs; not on the C4S sheet">
                SDK
              </span>
            )}
          </div>
          {result?.detected && <div className="mt-0.5 truncate text-xs text-muted">{result.detected}</div>}
        </div>
        {result?.checkedManually && <Badge tone="neutral">Ticked</Badge>}
        <MethodBadge method={method} />
        <StatusBadge status={status} size="sm" />
        <Icon name="chevronDown" size={16} className={cx("shrink-0 text-muted transition", open && "rotate-180")} />
      </button>

      {open && (
        <div className="animate-fade-in space-y-4 border-t px-4 py-4 sm:pl-[52px]">
          <Detail label="Expected">{item.expected}</Detail>
          {result?.evidence && <Detail label="What we found">{result.evidence}</Detail>}
          {HOW_TO_CHECK[item.id] && status !== "pass" && status !== "na" && <HowToCheck id={item.id} />}
          {platform === "android" && ANDROID_NOTES[item.id] && status !== "pass" && status !== "na" && (
            <div className="rounded-xl border bg-surface-2 p-3.5">
              <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-muted">
                <Icon name="alert" size={13} /> Android limits (CleverTap docs)
              </div>
              <p className="text-sm text-text">{ANDROID_NOTES[item.id].text}</p>
              <a href={ANDROID_NOTES[item.id].url} target="_blank" rel="noreferrer" className="mt-1.5 inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline">
                CleverTap docs <Icon name="external" size={12} />
              </a>
            </div>
          )}
          {result?.details && result.details.length > 0 && (status === "fail" || status === "warn") && (
            <Detail label="Where">
              <ul className="mt-1 space-y-0.5 text-[13px] text-muted">
                {result.details.slice(0, 6).map((d) => (
                  <li key={d} className="break-all">
                    {d}
                  </li>
                ))}
              </ul>
            </Detail>
          )}

          {result?.remediation && (status === "fail" || status === "warn") && (
            <div className="rounded-xl border p-3.5" style={{ background: "var(--fail-soft)" }}>
              <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold" style={{ color: "var(--fail)" }}>
                <Icon name="zap" size={13} /> Suggested fix
              </div>
              <p className="text-sm text-text">{result.remediation}</p>
              {faq?.links?.[0] && (
                <a
                  href={faq.links[0].url}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline"
                >
                  {faq.links[0].label} <Icon name="external" size={12} />
                </a>
              )}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            {item.docUrl && (
              <a
                href={item.docUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium text-muted transition hover:bg-surface-3 hover:text-text"
              >
                <Icon name="external" size={13} /> Documentation
              </a>
            )}
            <div className="ml-auto flex items-center gap-1.5">
              <span className="text-xs text-muted">Mark:</span>
              <button
                onClick={() => onSet("pass")}
                className={cx("rounded-lg px-2.5 py-1.5 text-xs font-medium transition", status === "pass" && result?.checkedManually ? "text-white" : "border text-muted hover:text-text")}
                style={status === "pass" && result?.checkedManually ? { background: "var(--pass)" } : undefined}
              >
                ✓ Verified
              </button>
              <button
                onClick={() => onSet("fail")}
                className={cx("rounded-lg px-2.5 py-1.5 text-xs font-medium transition", status === "fail" && result?.checkedManually ? "text-white" : "border text-muted hover:text-text")}
                style={status === "fail" && result?.checkedManually ? { background: "var(--fail)" } : undefined}
              >
                ✗ Not working
              </button>
              {result?.checkedManually && (
                <button
                  onClick={() => onSet("manual")}
                  className="rounded-lg border px-2.5 py-1.5 text-xs font-medium text-muted transition hover:text-text"
                  title="Go back to the automatic result"
                >
                  Reset
                </button>
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
      <div className="text-xs font-semibold uppercase tracking-wide text-muted-2">{label}</div>
      <div className="mt-0.5 text-sm leading-relaxed">{children}</div>
    </div>
  );
}

function CountTile({ status, n }: { status: ItemStatus; n: number }) {
  const m = STATUS_META[status];
  return (
    <div className="rounded-xl border p-3">
      <div className="flex items-center gap-1.5 text-xs text-muted">
        <span className="h-2 w-2 rounded-full" style={{ background: m.token }} />
        {m.label}
      </div>
      <div className="mt-1 text-xl font-bold">{n}</div>
    </div>
  );
}

function ResultsSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="h-10 w-64 skeleton rounded-xl" />
      <div className="grid gap-4 lg:grid-cols-[auto_1fr]">
        <div className="h-40 w-full skeleton rounded-[var(--radius)] lg:w-72" />
        <div className="h-40 skeleton rounded-[var(--radius)]" />
      </div>
      <div className="h-64 skeleton rounded-[var(--radius)]" />
    </div>
  );
}
