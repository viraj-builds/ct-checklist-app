"use client";

import { useState } from "react";
import { FAQS } from "@/lib/faq";
import { Card, PageHeader } from "@/components/ui";
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
      <PageHeader
        title="Help & fixes"
        sub="Common integration problems and how to solve them. The audit links failed checks to these fixes for you."
      />

      <div className="relative mb-6">
        <Icon
          name="search"
          size={17}
          className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-muted-2"
        />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search problems and fixes, e.g. push, login, location"
          aria-label="Search help"
          className="input pl-11"
        />
      </div>

      <Card className="overflow-hidden">
        {filtered.map((f) => {
          const isOpen = open === f.n;
          return (
            <div key={f.n} className="border-t first:border-t-0">
              <button
                onClick={() => setOpen(isOpen ? null : f.n)}
                aria-expanded={isOpen}
                className="flex w-full items-center gap-4 px-6 py-4.5 text-left transition-colors hover:bg-surface-2"
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-[1.5px] border-[var(--border-strong)] text-[13px] font-bold text-muted">
                  {f.n}
                </span>
                <span className="flex-1 text-base font-bold">{f.question}</span>
                <Icon
                  name="chevronDown"
                  size={18}
                  className={cx("shrink-0 text-muted-2 transition", isOpen && "rotate-180")}
                />
              </button>
              {isOpen && (
                <div className="animate-fade-in space-y-5 px-6 pb-6 pt-1 sm:pl-[72px]">
                  <div>
                    <div className="mb-2 text-sm font-bold text-text-2">Why it happens</div>
                    <ul className="space-y-1.5">
                      {f.reasons.map((r, i) => (
                        <li key={i} className="flex gap-2 text-[15px] text-text-2">
                          <Icon name="chevronRight" size={14} className="mt-0.5 shrink-0" />
                          {r}
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div>
                    <div className="mb-2 text-sm font-bold text-text-2">How to fix it</div>
                    <ul className="space-y-2">
                      {f.solutions.map((s, i) => (
                        <li key={i} className="flex gap-2.5 text-[15px]">
                          <Icon
                            name="check"
                            size={17}
                            strokeWidth={2.4}
                            className="mt-0.5 shrink-0 text-[var(--pass)]"
                          />
                          {s}
                        </li>
                      ))}
                    </ul>
                  </div>
                  {f.links && f.links.length > 0 && (
                    <div className="flex flex-wrap gap-x-5 gap-y-2">
                      {f.links.map((l) => (
                        <a
                          key={l.url}
                          href={l.url}
                          target="_blank"
                          rel="noreferrer"
                          className="link inline-flex items-center gap-1.5 text-sm"
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
                          className="rounded-full bg-surface-3 px-2.5 py-0.5 text-[13px] text-muted"
                        >
                          #{t}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {filtered.length === 0 && (
          <p className="px-6 py-12 text-center text-[15px] text-muted">
            Nothing matches “{query}”. Try a shorter word.
          </p>
        )}
      </Card>
    </div>
  );
}
