"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useAudit, summarize, setItemStatus, deleteAudit, useMounted } from "@/lib/store";
import { itemsForPlatform, TIER_LABELS } from "@/lib/checklist";
import { getFaq } from "@/lib/faq";
import { PLATFORM_META, MODE_META, STATUS_META, METHOD_META, REGIONS } from "@/lib/meta";
import type { ChecklistItem, ItemStatus } from "@/lib/types";
import {
  Card,
  Button,
  ProgressRing,
  StatusBadge,
  MethodBadge,
  PlatformIcon,
  StatBar,
  EmptyState,
  Badge,
} from "@/components/ui";
import { Icon } from "@/components/Icon";
import { formatDate, cx } from "@/lib/format";

type Filter = "all" | ItemStatus;

export function Results({ id }: { id: string }) {
  const router = useRouter();
  const audit = useAudit(id);
  const mounted = useMounted();
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);

  const items = useMemo(
    () => (audit ? itemsForPlatform(audit.platform) : []),
    [audit],
  );

  if (!mounted) return <ResultsSkeleton />;
  if (!audit)
    return (
      <EmptyState
        icon="alert"
        title="Audit not found"
        desc="This audit doesn't exist in this browser. It may have been created on another device."
        action={<Button href="/audits" icon="list">All audits</Button>}
      />
    );

  const s = summarize(audit);
  const issues = items.filter((it) => {
    const st = audit.results[it.id]?.status;
    return st === "fail" || st === "warn";
  });

  const visible = items.filter((it) => {
    const st = audit.results[it.id]?.status ?? "na";
    if (filter !== "all" && st !== filter) return false;
    if (query && !it.title.toLowerCase().includes(query.toLowerCase()))
      return false;
    return true;
  });

  const tiers = Array.from(new Set(items.map((i) => i.tier))).sort();

  const filters: { key: Filter; label: string; count: number }[] = [
    { key: "all", label: "All", count: items.length },
    { key: "fail", label: "Fail", count: s.counts.fail },
    { key: "warn", label: "Warning", count: s.counts.warn },
    { key: "manual", label: "Manual", count: s.counts.manual },
    { key: "pass", label: "Pass", count: s.counts.pass },
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
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-bold tracking-tight">{audit.name}</h1>
              <Badge tone="neutral">{PLATFORM_META[audit.platform].label}</Badge>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
              <span className="flex items-center gap-1">
                <Icon name={MODE_META[audit.mode].icon as never} size={13} />
                {MODE_META[audit.mode].label}
              </span>
              {audit.region && (
                <span>· {REGIONS.find((r) => r.id === audit.region)?.label}</span>
              )}
              <span className="font-mono">· {audit.target}</span>
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
            onClick={() => {
              deleteAudit(audit.id);
              router.push("/audits");
            }}
          >
            Delete
          </Button>
        </div>
      </div>

      {/* Summary */}
      <div className="grid gap-4 lg:grid-cols-[auto_1fr]">
        <Card className="flex items-center gap-5 p-6">
          <ProgressRing value={s.score} sublabel="auto score" />
          <div className="space-y-2">
            <div className="text-sm font-medium">Integration score</div>
            <p className="max-w-[180px] text-xs leading-relaxed text-muted">
              Share of auto-checkable items passing. Manual items are tracked
              separately.
            </p>
            {s.manualPending > 0 && (
              <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium" style={{ background: "var(--manual-soft)", color: "var(--manual)" }}>
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

      {/* What needs to be done */}
      {issues.length > 0 && (
        <Card className="p-5">
          <div className="mb-3 flex items-center gap-2">
            <Icon name="alert" size={18} className="text-[var(--fail)]" />
            <h2 className="font-semibold">What needs to be done ({issues.length})</h2>
          </div>
          <div className="space-y-2">
            {issues.map((it) => {
              const r = audit.results[it.id];
              return (
                <div
                  key={it.id}
                  className="flex items-start gap-3 rounded-xl border bg-surface-2 p-3"
                >
                  <StatusBadge status={r.status} size="sm" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium">{it.title}</div>
                    {r.remediation && (
                      <div className="mt-0.5 text-xs text-muted">{r.remediation}</div>
                    )}
                  </div>
                  <button
                    onClick={() => {
                      setFilter("all");
                      setOpenId(it.id);
                      document
                        .getElementById(`item-${it.id}`)
                        ?.scrollIntoView({ behavior: "smooth", block: "center" });
                    }}
                    className="shrink-0 text-xs font-medium text-brand hover:underline"
                  >
                    View
                  </button>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        {filters.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={cx(
              "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium transition",
              filter === f.key
                ? "border-brand bg-brand-soft text-brand"
                : "text-muted hover:bg-surface-2",
            )}
          >
            {f.label}
            <span className="text-xs opacity-70">{f.count}</span>
          </button>
        ))}
        <div className="relative ml-auto">
          <Icon
            name="search"
            size={15}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-2"
          />
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
                    status={audit.results[it.id]?.status ?? "na"}
                    detected={audit.results[it.id]?.detected}
                    evidence={audit.results[it.id]?.evidence}
                    remediation={audit.results[it.id]?.remediation}
                    open={openId === it.id}
                    onToggle={() =>
                      setOpenId((cur) => (cur === it.id ? null : it.id))
                    }
                    onSet={(st) => setItemStatus(audit.id, it.id, st)}
                  />
                ))}
              </Card>
            </div>
          );
        })}
        {visible.length === 0 && (
          <EmptyState icon="search" title="No items match" desc="Try a different filter or search." />
        )}
      </div>
    </div>
  );
}

/* ---------------- item row ---------------- */

function ItemRow({
  item,
  status,
  detected,
  evidence,
  remediation,
  open,
  onToggle,
  onSet,
}: {
  item: ChecklistItem;
  status: ItemStatus;
  detected?: string;
  evidence?: string;
  remediation?: string;
  open: boolean;
  onToggle: () => void;
  onSet: (s: ItemStatus) => void;
}) {
  const faq = getFaq(item.faqRef);
  const canOverride = item.method === "manual" || item.method === "hybrid";
  const m = STATUS_META[status];

  return (
    <div id={`item-${item.id}`} className={cx(open && "bg-surface-2")}>
      <button
        onClick={onToggle}
        className="flex w-full items-center gap-3 px-4 py-3.5 text-left transition hover:bg-surface-2"
      >
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
              <span className="rounded bg-brand-soft px-1.5 text-[10px] font-semibold uppercase text-brand">
                Critical
              </span>
            )}
          </div>
          {detected && (
            <div className="mt-0.5 truncate text-xs text-muted">{detected}</div>
          )}
        </div>
        <MethodBadge method={item.method} />
        <StatusBadge status={status} size="sm" />
        <Icon
          name="chevronDown"
          size={16}
          className={cx("shrink-0 text-muted transition", open && "rotate-180")}
        />
      </button>

      {open && (
        <div className="animate-fade-in space-y-4 border-t px-4 py-4 sm:pl-[52px]">
          <Detail label="Expected">{item.expected}</Detail>
          {evidence && <Detail label="How it was checked">{evidence}</Detail>
          }
          <Detail label="Verification method">
            {METHOD_META[item.method].label} — {METHOD_META[item.method].desc}
          </Detail>

          {remediation && (
            <div className="rounded-xl border p-3.5" style={{ background: "var(--fail-soft)" }}>
              <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold" style={{ color: "var(--fail)" }}>
                <Icon name="zap" size={13} /> Suggested fix
              </div>
              <p className="text-sm text-text">{remediation}</p>
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
            {canOverride && (
              <div className="ml-auto flex items-center gap-1.5">
                <span className="text-xs text-muted">Mark:</span>
                <button
                  onClick={() => onSet("pass")}
                  className={cx(
                    "rounded-lg px-2.5 py-1.5 text-xs font-medium transition",
                    status === "pass"
                      ? "text-white"
                      : "border text-muted hover:text-text",
                  )}
                  style={status === "pass" ? { background: "var(--pass)" } : undefined}
                >
                  ✓ Verified
                </button>
                <button
                  onClick={() => onSet("fail")}
                  className={cx(
                    "rounded-lg px-2.5 py-1.5 text-xs font-medium transition",
                    status === "fail"
                      ? "text-white"
                      : "border text-muted hover:text-text",
                  )}
                  style={status === "fail" ? { background: "var(--fail)" } : undefined}
                >
                  ✗ Not working
                </button>
                <button
                  onClick={() => onSet("manual")}
                  className="rounded-lg border px-2.5 py-1.5 text-xs font-medium text-muted transition hover:text-text"
                >
                  Reset
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs font-semibold uppercase tracking-wide text-muted-2">
        {label}
      </div>
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
