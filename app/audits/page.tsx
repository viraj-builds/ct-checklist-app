"use client";

import { useState } from "react";
import { useAudits, useAuditsError } from "@/lib/store";
import { AuditCard } from "@/components/audit/AuditCard";
import { Button, Card, EmptyState, PageHeader } from "@/components/ui";
import { PLATFORM_META } from "@/lib/meta";
import type { Platform } from "@/lib/types";
import { cx } from "@/lib/format";
import { Icon } from "@/components/Icon";

type PF = "all" | Platform;

export default function AuditsPage() {
  const loaded = useAudits();
  const listError = useAuditsError();
  const audits = loaded ?? [];
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
      <PageHeader title="My audits" sub="Every integration audit, newest first." />

      <div className="mb-5 flex flex-wrap items-center gap-2">
        {chips.map((c) => (
          <button
            key={c.key}
            onClick={() => setPf(c.key)}
            aria-pressed={pf === c.key}
            className={cx(
              "inline-flex min-h-10 items-center gap-2 rounded-full border-[1.5px] px-4 text-sm font-bold transition",
              pf === c.key ? "border-brand bg-brand-soft text-brand-text" : "border-[var(--border-strong)] bg-surface text-text-2 hover:bg-surface-2",
            )}
          >
            {c.key !== "all" && <Icon name={PLATFORM_META[c.key as Platform].icon as never} size={16} />}
            {c.label}
            <span className="font-semibold text-muted">
              {c.key === "all" ? audits.length : audits.filter((a) => a.platform === c.key).length}
            </span>
          </button>
        ))}
      </div>

      {!loaded ? (
        <div className="space-y-px overflow-hidden rounded-[var(--radius)] border">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-[76px] skeleton" />
          ))}
        </div>
      ) : listError ? (
        <EmptyState icon="alert" title="Couldn't load your audits" desc={listError} />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon="list"
          title="No audits here yet"
          desc="Start a new audit and it will show up here."
          action={
            <Button href="/new" icon="plus">
              New audit
            </Button>
          }
        />
      ) : (
        <Card className="overflow-hidden">
          {filtered.map((a, i) => (
            <AuditCard key={a.id} audit={a} first={i === 0} />
          ))}
        </Card>
      )}
    </div>
  );
}
