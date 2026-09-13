"use client";

import { useState } from "react";
import { useAudits, resetStore } from "@/lib/store";
import { AuditCard } from "@/components/audit/AuditCard";
import { Button, EmptyState, SectionTitle } from "@/components/ui";
import { PLATFORM_META } from "@/lib/meta";
import type { Platform } from "@/lib/types";
import { cx } from "@/lib/format";
import { Icon } from "@/components/Icon";

type PF = "all" | Platform;

export default function AuditsPage() {
  const audits = useAudits();
  const [pf, setPf] = useState<PF>("all");

  const filtered = pf === "all" ? audits : audits.filter((a) => a.platform === pf);
  const chips: { key: PF; label: string }[] = [
    { key: "all", label: "All" },
    { key: "android", label: "Android" },
    { key: "ios", label: "iOS" },
    { key: "web", label: "Web" },
  ];

  return (
    <div>
      <SectionTitle
        sub="Every integration audit in this browser"
        action={
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" icon="refresh" onClick={resetStore}>
              Reset samples
            </Button>
            <Button href="/new" size="sm" icon="plus">
              New Audit
            </Button>
          </div>
        }
      >
        All audits
      </SectionTitle>

      <div className="mb-5 flex flex-wrap items-center gap-2">
        {chips.map((c) => (
          <button
            key={c.key}
            onClick={() => setPf(c.key)}
            className={cx(
              "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium transition",
              pf === c.key
                ? "border-brand bg-brand-soft text-brand"
                : "text-muted hover:bg-surface-2",
            )}
          >
            {c.key !== "all" && (
              <Icon name={PLATFORM_META[c.key as Platform].icon as never} size={14} />
            )}
            {c.label}
            <span className="text-xs opacity-70">
              {c.key === "all"
                ? audits.length
                : audits.filter((a) => a.platform === c.key).length}
            </span>
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon="list"
          title="No audits here"
          desc="Run a new audit or reset the sample data."
          action={<Button href="/new" icon="plus">New Audit</Button>}
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((a) => (
            <AuditCard key={a.id} audit={a} />
          ))}
        </div>
      )}
    </div>
  );
}
