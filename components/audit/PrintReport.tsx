"use client";

import { docUrlFor, itemsForPlatform } from "@/lib/checklist";
import { GROUPS, groupOf } from "@/lib/stages";
import { REGIONS, STATUS_META } from "@/lib/meta";
import { summarize } from "@/lib/store";
import { formatDate } from "@/lib/format";
import type { Audit, ChecklistItem, ItemStatus } from "@/lib/types";

// The exported report (Export → Print / Save as PDF). Only shown when printing:
// a clean document with every check, what we found and how to fix it — not a
// copy of the interactive screen. Always printed in the light palette (see
// @media print in globals.css), so it reads the same whatever theme is on.

const MARK: Record<ItemStatus, string> = { pass: "✓", fail: "✕", warn: "!", manual: "○", na: "–" };

export function PrintReport({ audit }: { audit: Audit }) {
  const items = itemsForPlatform(audit.platform);
  const s = summarize(audit);
  const statusOf = (it: ChecklistItem): ItemStatus => audit.results[it.id]?.status ?? "manual";
  const fixFirst = items.filter((it) => statusOf(it) === "fail" || statusOf(it) === "warn").sort((a, b) => (statusOf(a) === "fail" ? 0 : 1) - (statusOf(b) === "fail" ? 0 : 1));
  const platform = audit.platform === "web" ? "Website" : audit.platform === "ios" ? "iOS app" : "Android app";
  const meta: [string, string | undefined][] = [
    ["Platform", platform],
    [audit.platform === "web" ? "Website" : "Build", audit.platform === "web" ? audit.target : audit.fileName],
    ["CleverTap account", audit.accountId],
    ["Region", audit.region && (REGIONS.find((r) => r.id === audit.region)?.label ?? audit.region)],
    ["Audit started", formatDate(audit.createdAt)],
    ["Run by", audit.submittedBy],
  ];

  return (
    <article className="print-report hidden print:block">
      <div className="pr-head">
        <div className="pr-kicker">CleverTap integration audit</div>
        <h1>{audit.name}</h1>
        <dl className="pr-meta">
          {meta
            .filter(([, v]) => v)
            .map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
        </dl>
      </div>

      <section className="pr-score">
        <div className="pr-score-main">
          <strong>
            {s.counts.pass} of {s.total}
          </strong>{" "}
          checks passed
        </div>
        <ul className="pr-counts">
          {(["pass", "fail", "warn", "manual", "na"] as const).map((k) => (
            <li key={k} className={`st-${k}`}>
              <span className="pr-mark">{MARK[k]}</span> {s.counts[k]} {STATUS_META[k].label.toLowerCase()}
            </li>
          ))}
        </ul>
      </section>

      {fixFirst.length > 0 && (
        <section className="pr-section">
          <h2>Fix these first</h2>
          <ol className="pr-fix">
            {fixFirst.map((it) => {
              const r = audit.results[it.id];
              return (
                <li key={it.id}>
                  <span className={`pr-badge st-${statusOf(it)}`}>{STATUS_META[statusOf(it)].label}</span> <strong>{it.title}</strong>
                  {r?.detected && <div className="pr-found">{r.detected}</div>}
                  {r?.remediation && (
                    <div className="pr-howto">
                      <b>How to fix:</b> {r.remediation}
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        </section>
      )}

      {GROUPS.map((g) => {
        const rows = items.filter((it) => groupOf(it) === g.id);
        if (!rows.length) return null;
        return (
          <section key={g.id} className="pr-section">
            <h2>
              {g.name}{" "}
              <span className="pr-sub">
                {rows.filter((it) => statusOf(it) === "pass").length} of {rows.length} passed
              </span>
            </h2>
            <table className="pr-table">
              <thead>
                <tr>
                  <th style={{ width: "16%" }}>Result</th>
                  <th style={{ width: "28%" }}>Check</th>
                  <th>What we found</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((it) => {
                  const r = audit.results[it.id];
                  const st = statusOf(it);
                  const doc = docUrlFor(it, audit.platform);
                  return (
                    <tr key={it.id}>
                      <td>
                        <span className={`pr-badge st-${st}`}>
                          {MARK[st]} {STATUS_META[st].label}
                        </span>
                        {r?.checkedManually && <div className="pr-note">confirmed by hand</div>}
                      </td>
                      <td>
                        <div className="pr-title">
                          {it.title}
                          {it.critical && <span className="pr-imp">Important</span>}
                        </div>
                        <div className="pr-expected">{it.expected}</div>
                      </td>
                      <td>
                        {r?.detected && <div className="pr-found">{r.detected}</div>}
                        {r?.evidence && <div>{r.evidence}</div>}
                        {r?.details && r.details.length > 0 && (st === "fail" || st === "warn") && (
                          <ul className="pr-details">
                            {r.details.slice(0, 6).map((d) => (
                              <li key={d}>{d}</li>
                            ))}
                          </ul>
                        )}
                        {r?.remediation && (st === "fail" || st === "warn") && (
                          <div className="pr-howto">
                            <b>How to fix:</b> {r.remediation}
                          </div>
                        )}
                        {doc && <div className="pr-doc">Docs: {doc}</div>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
        );
      })}

      <footer className="pr-foot">
        <p>
          <b>Passed</b> works as expected · <b>Needs fix</b> broken or missing · <b>Check this</b> works but risky or outdated · <b>To check</b> not verified yet ·{" "}
          <b>Not needed</b> doesn&apos;t apply.
        </p>
        <p>Results reflect the build, website and CleverTap data checked during this audit.</p>
      </footer>
    </article>
  );
}
