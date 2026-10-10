"use client";

import Link from "next/link";
import type { Audit } from "@/lib/types";
import { summarize } from "@/lib/store";
import { timeAgo, cx } from "@/lib/format";
import { PLATFORM_META } from "@/lib/meta";
import { PlatformIcon, StatBar, Badge } from "@/components/ui";
import { Icon } from "@/components/Icon";

// One audit as a list row: what it is, how far along, and what needs attention.
export function AuditCard({ audit, first }: { audit: Audit; first?: boolean }) {
  const s = summarize(audit);
  const running = audit.status === "draft" || audit.status === "scanning" || audit.status === "verifying";

  return (
    <Link
      href={`/audit/${audit.id}`}
      className={cx("group flex flex-wrap items-center gap-x-5 gap-y-3 px-5 py-4 transition-colors hover:bg-surface-2 sm:px-6", !first && "border-t")}
    >
      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-surface-3">
        <PlatformIcon platform={audit.platform} size={22} />
      </span>
      <div className="min-w-0 flex-1 basis-48">
        <div className="truncate text-base font-bold">{audit.name}</div>
        <div className="mt-0.5 text-sm text-muted">
          {PLATFORM_META[audit.platform].label} app · {timeAgo(audit.createdAt)}
        </div>
      </div>
      <div className="hidden w-48 md:block">
        <StatBar
          total={s.total}
          segments={[
            { value: s.counts.pass, color: "var(--pass)" },
            { value: s.counts.fail, color: "var(--fail)" },
            { value: s.counts.warn, color: "var(--warn-dot)" },
          ]}
        />
        <div className="mt-1.5 text-[13px] text-muted">
          {s.counts.pass} of {s.total} passed
        </div>
      </div>
      <div className="w-28 text-right">
        {running ? (
          <Badge tone="brand">Checking…</Badge>
        ) : audit.status === "failed" ? (
          <Badge tone="neutral">Didn&apos;t finish</Badge>
        ) : s.counts.fail > 0 ? (
          <Badge tone="danger">{s.counts.fail} to fix</Badge>
        ) : s.counts.warn > 0 ? (
          <Badge tone="warn">{s.counts.warn} to look at</Badge>
        ) : s.counts.manual > 0 ? (
          <Badge tone="brand">{s.counts.manual} to check</Badge>
        ) : (
          <Badge tone="success">
            <Icon name="check" size={13} strokeWidth={2.6} /> All good
          </Badge>
        )}
      </div>
      <Icon name="chevronRight" size={20} className="shrink-0 text-muted-2 transition group-hover:translate-x-0.5" />
    </Link>
  );
}
