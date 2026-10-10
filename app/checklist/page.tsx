"use client";

import { useState } from "react";
import { itemsForPlatform } from "@/lib/checklist";
import { GROUPS, groupOf } from "@/lib/stages";
import { PLATFORM_META } from "@/lib/meta";
import type { Platform } from "@/lib/types";
import { Card, MethodBadge, Badge, PageHeader } from "@/components/ui";
import { Icon } from "@/components/Icon";
import { cx } from "@/lib/format";

const PLATFORMS: Platform[] = ["android", "ios", "web"];

export default function ChecklistPage() {
  const [platform, setPlatform] = useState<Platform>("android");
  const items = itemsForPlatform(platform);
  const autoCount = items.filter((i) => i.method.startsWith("auto")).length;

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="What we check"
        sub={`Every check in the audit, what it looks for and who does the work. ${autoCount} of ${items.length} are checked for you automatically.`}
      />

      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div className="inline-flex rounded-xl border bg-surface p-1" role="tablist" aria-label="Platform">
          {PLATFORMS.map((p) => (
            <button
              key={p}
              role="tab"
              aria-selected={platform === p}
              onClick={() => setPlatform(p)}
              className={cx(
                "inline-flex min-h-10 items-center gap-2 rounded-lg px-4 text-sm font-bold transition",
                platform === p ? "bg-brand text-brand-fg" : "text-muted hover:text-text",
              )}
            >
              <Icon name={PLATFORM_META[p].icon as never} size={17} />
              {PLATFORM_META[p].label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted">
          <MethodBadge method="auto-api" /> we verify it
          <span className="mx-1 text-muted-2">·</span>
          <MethodBadge method="hybrid" /> you do something first
        </div>
      </div>

      <div className="space-y-8">
        {GROUPS.map((g) => {
          const groupItems = items.filter((i) => groupOf(i) === g.id);
          if (!groupItems.length) return null;
          return (
            <section key={g.id} aria-label={g.name}>
              <div className="mb-3 px-1">
                <h2 className="text-lg font-bold">
                  {g.name} <span className="font-semibold text-muted">· {groupItems.length}</span>
                </h2>
                <p className="text-sm text-muted">{g.desc}</p>
              </div>
              <Card className="overflow-hidden">
                {groupItems.map((it, i) => (
                  <div key={it.id} className={cx("flex flex-wrap items-start gap-x-4 gap-y-2 px-6 py-4", i > 0 && "border-t")}>
                    <div className="min-w-0 flex-1 basis-72">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-base font-bold">{it.title}</span>
                        {it.critical && <Badge tone="brand">Important</Badge>}
                      </div>
                      <p className="mt-1 text-[15px] text-muted">{it.expected}</p>
                      {it.docUrl && (
                        <a href={it.docUrl} target="_blank" rel="noreferrer" className="link mt-1.5 inline-flex items-center gap-1 text-sm">
                          Docs <Icon name="external" size={13} />
                        </a>
                      )}
                    </div>
                    <MethodBadge method={it.method} />
                  </div>
                ))}
              </Card>
            </section>
          );
        })}
      </div>
    </div>
  );
}
