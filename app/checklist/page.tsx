"use client";

import { useState } from "react";
import { itemsForPlatform, TIER_LABELS } from "@/lib/checklist";
import { PLATFORM_META, METHOD_META } from "@/lib/meta";
import type { Platform } from "@/lib/types";
import { Card, MethodBadge, Badge } from "@/components/ui";
import { Icon } from "@/components/Icon";
import { cx } from "@/lib/format";

const PLATFORMS: Platform[] = ["android", "ios", "web"];

export default function ChecklistPage() {
  const [platform, setPlatform] = useState<Platform>("android");
  const items = itemsForPlatform(platform);
  const tiers = Array.from(new Set(items.map((i) => i.tier))).sort();

  const autoCount = items.filter((i) => i.method.startsWith("auto")).length;
  const hybridCount = items.filter((i) => i.method === "hybrid").length;
  const manualCount = items.filter((i) => i.method === "manual").length;

  return (
    <div>
      <div className="mb-5">
        <h1 className="text-2xl font-bold tracking-tight">C4S Audit Checklist</h1>
        <p className="mt-1 text-sm text-muted">
          The full reference — what each item checks and how it&apos;s verified.
        </p>
      </div>

      {/* Platform tabs */}
      <div className="mb-5 inline-flex rounded-xl border bg-surface p-1">
        {PLATFORMS.map((p) => (
          <button
            key={p}
            onClick={() => setPlatform(p)}
            className={cx(
              "inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition",
              platform === p ? "bg-brand text-brand-fg" : "text-muted hover:text-text",
            )}
          >
            <Icon name={PLATFORM_META[p].icon as never} size={16} />
            {PLATFORM_META[p].label}
          </button>
        ))}
      </div>

      {/* Coverage summary */}
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <MiniStat label="Total items" value={items.length} tone="var(--accent)" />
        <MiniStat label="Automatable" value={autoCount} tone="var(--pass)" />
        <MiniStat label="Hybrid" value={hybridCount} tone="var(--warn)" />
        <MiniStat label="Manual only" value={manualCount} tone="var(--manual)" />
      </div>

      {/* Legend */}
      <div className="mb-5 flex flex-wrap gap-2">
        {(["auto-api", "auto-trigger", "auto-static", "hybrid", "manual"] as const).map(
          (m) => (
            <span
              key={m}
              className="inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs text-muted"
            >
              <MethodBadge method={m} />
              {METHOD_META[m].desc}
            </span>
          ),
        )}
      </div>

      {/* Tiers */}
      <div className="space-y-6">
        {tiers.map((tier) => {
          const tierItems = items.filter((i) => i.tier === tier);
          return (
            <div key={tier}>
              <h2 className="mb-2 px-1 text-sm font-semibold">
                {TIER_LABELS[tier]}{" "}
                <span className="text-muted">({tierItems.length})</span>
              </h2>
              <Card className="divide-y">
                {tierItems.map((it) => (
                  <div key={it.id} className="flex items-start gap-3 px-4 py-3.5">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">{it.title}</span>
                        {it.critical && (
                          <Badge tone="brand">Critical</Badge>
                        )}
                      </div>
                      <p className="mt-0.5 text-xs leading-relaxed text-muted">
                        {it.expected}
                      </p>
                      {it.docUrl && (
                        <a
                          href={it.docUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline"
                        >
                          Docs <Icon name="external" size={11} />
                        </a>
                      )}
                    </div>
                    <MethodBadge method={it.method} />
                  </div>
                ))}
              </Card>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MiniStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: string;
}) {
  return (
    <Card className="p-4">
      <div className="text-xs text-muted">{label}</div>
      <div className="mt-1 text-2xl font-bold" style={{ color: tone }}>
        {value}
      </div>
    </Card>
  );
}
