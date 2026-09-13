"use client";

import { useState } from "react";
import { FAQS } from "@/lib/faq";
import { Card } from "@/components/ui";
import { Icon } from "@/components/Icon";
import { cx } from "@/lib/format";

export default function FaqPage() {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<number | null>(1);

  const filtered = FAQS.filter((f) => {
    if (!query) return true;
    const q = query.toLowerCase();
    return (
      f.question.toLowerCase().includes(q) ||
      f.solutions.some((s) => s.toLowerCase().includes(q)) ||
      f.tags?.some((t) => t.includes(q))
    );
  });

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-5">
        <h1 className="text-2xl font-bold tracking-tight">FAQ & Fixes</h1>
        <p className="mt-1 text-sm text-muted">
          Common integration issues and their solutions. The audit maps failed
          checks to these fixes automatically.
        </p>
      </div>

      <div className="relative mb-5">
        <Icon
          name="search"
          size={17}
          className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-2"
        />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search issues, fixes, tags (push, ios, location…)"
          className="input pl-10"
        />
      </div>

      <div className="space-y-3">
        {filtered.map((f) => {
          const isOpen = open === f.n;
          return (
            <Card key={f.n}>
              <button
                onClick={() => setOpen(isOpen ? null : f.n)}
                className="flex w-full items-center gap-3 px-4 py-4 text-left"
              >
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-brand-soft text-xs font-bold text-brand">
                  {f.n}
                </span>
                <span className="flex-1 text-sm font-medium">{f.question}</span>
                <Icon
                  name="chevronDown"
                  size={18}
                  className={cx("shrink-0 text-muted transition", isOpen && "rotate-180")}
                />
              </button>
              {isOpen && (
                <div className="animate-fade-in space-y-4 border-t px-4 py-4">
                  <div>
                    <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-2">
                      Possible reasons
                    </div>
                    <ul className="space-y-1">
                      {f.reasons.map((r, i) => (
                        <li key={i} className="flex gap-2 text-sm text-muted">
                          <Icon name="chevronRight" size={14} className="mt-0.5 shrink-0" />
                          {r}
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div>
                    <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--pass)" }}>
                      Solution
                    </div>
                    <ul className="space-y-1.5">
                      {f.solutions.map((s, i) => (
                        <li key={i} className="flex gap-2 text-sm">
                          <Icon
                            name="check"
                            size={15}
                            className="mt-0.5 shrink-0 text-[var(--pass)]"
                          />
                          {s}
                        </li>
                      ))}
                    </ul>
                  </div>
                  {f.links && f.links.length > 0 && (
                    <div className="flex flex-wrap gap-2 pt-1">
                      {f.links.map((l) => (
                        <a
                          key={l.url}
                          href={l.url}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium text-accent transition hover:bg-surface-2"
                        >
                          {l.label} <Icon name="external" size={12} />
                        </a>
                      ))}
                    </div>
                  )}
                  {f.tags && (
                    <div className="flex flex-wrap gap-1.5 pt-1">
                      {f.tags.map((t) => (
                        <span
                          key={t}
                          className="rounded-md bg-surface-2 px-2 py-0.5 text-[11px] text-muted"
                        >
                          #{t}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </Card>
          );
        })}
        {filtered.length === 0 && (
          <p className="py-10 text-center text-sm text-muted">
            No matching FAQs for “{query}”.
          </p>
        )}
      </div>
    </div>
  );
}
