"use client";

import Link from "next/link";
import type { Audit } from "@/lib/types";
import { summarize } from "@/lib/store";
import { timeAgo } from "@/lib/format";
import { PLATFORM_META, MODE_META } from "@/lib/meta";
import { Card, PlatformIcon, StatBar, Badge } from "@/components/ui";
import { Icon } from "@/components/Icon";

export function AuditCard({ audit }: { audit: Audit }) {
  const s = summarize(audit);
  const scoreColor =
    s.score >= 80 ? "var(--pass)" : s.score >= 50 ? "var(--warn)" : "var(--fail)";

  return (
    <Link href={`/audit/${audit.id}`}>
      <Card hover className="p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-surface-2">
              <PlatformIcon platform={audit.platform} size={20} />
            </span>
            <div className="min-w-0">
              <div className="truncate font-semibold">{audit.name}</div>
              <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted">
                <span>{PLATFORM_META[audit.platform].label}</span>
                <span className="text-muted-2">·</span>
                <span>{MODE_META[audit.mode].label}</span>
              </div>
            </div>
          </div>
          <div
            className="text-right text-2xl font-bold leading-none"
            style={{ color: scoreColor }}
          >
            {s.score}
            <span className="text-xs font-medium text-muted">/100</span>
          </div>
        </div>

        <div className="mt-4">
          <StatBar
            segments={[
              { value: s.counts.pass, color: "var(--pass)" },
              { value: s.counts.warn, color: "var(--warn)" },
              { value: s.counts.fail, color: "var(--fail)" },
              { value: s.counts.manual, color: "var(--manual)" },
            ]}
          />
          <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
            <Legend color="var(--pass)" label={`${s.counts.pass} pass`} />
            <Legend color="var(--warn)" label={`${s.counts.warn} warn`} />
            <Legend color="var(--fail)" label={`${s.counts.fail} fail`} />
            <Legend color="var(--manual)" label={`${s.counts.manual} manual`} />
          </div>
        </div>

        <div className="mt-4 flex items-center justify-between border-t pt-3 text-xs text-muted">
          <span className="flex items-center gap-1.5">
            <Icon name="clock" size={13} /> {timeAgo(audit.createdAt)}
          </span>
          {s.counts.fail > 0 ? (
            <Badge tone="danger">{s.counts.fail} to fix</Badge>
          ) : s.counts.warn > 0 ? (
            <Badge tone="warn">{s.counts.warn} to review</Badge>
          ) : (
            <Badge tone="success">
              <Icon name="check" size={12} /> Clean
            </Badge>
          )}
        </div>
      </Card>
    </Link>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1">
      <span className="h-2 w-2 rounded-full" style={{ background: color }} />
      {label}
    </span>
  );
}
