"use client";

import Link from "next/link";
import { useAudits, summarize } from "@/lib/store";
import { AuditCard } from "@/components/audit/AuditCard";
import { Card, Button, SectionTitle, EmptyState } from "@/components/ui";
import { Icon, type IconName } from "@/components/Icon";

export default function Dashboard() {
  const audits = useAudits();

  const totals = audits.reduce(
    (acc, a) => {
      const s = summarize(a);
      acc.pass += s.counts.pass;
      acc.fail += s.counts.fail;
      acc.warn += s.counts.warn;
      acc.manual += s.counts.manual;
      return acc;
    },
    { pass: 0, fail: 0, warn: 0, manual: 0 },
  );
  const avgScore =
    audits.length === 0
      ? 0
      : Math.round(
          audits.reduce((s, a) => s + summarize(a).score, 0) / audits.length,
        );

  return (
    <div className="flex flex-col gap-8">
      {/* Hero */}
      <Card className="overflow-hidden">
        <div className="relative p-6 md:p-8">
          <div
            className="pointer-events-none absolute -right-16 -top-16 h-56 w-56 rounded-full opacity-20 blur-2xl"
            style={{ background: "var(--brand)" }}
          />
          <div className="relative max-w-2xl">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-brand-soft px-3 py-1 text-xs font-medium text-brand">
              <Icon name="sparkle" size={13} /> Integration Self-Audit
            </span>
            <h1 className="mt-3 text-2xl font-bold tracking-tight md:text-3xl">
              Check a CleverTap integration in minutes — not a call.
            </h1>
            <p className="mt-2 text-[15px] leading-relaxed text-muted">
              Point the tool at an app or website and it verifies the C4S
              checklist automatically: SDK, events, profiles, push, and data
              quality. Failures come with the exact fix.
            </p>
            <div className="mt-5 flex flex-wrap gap-2.5">
              <Button href="/new" icon="plus" size="lg">
                Start an audit
              </Button>
              <Button href="/checklist" variant="secondary" size="lg" icon="clipboard">
                View checklist
              </Button>
            </div>
          </div>
        </div>
      </Card>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat icon="clipboard" label="Audits run" value={audits.length} tone="var(--accent)" />
        <Stat icon="check" label="Checks passing" value={totals.pass} tone="var(--pass)" />
        <Stat icon="alert" label="Issues to fix" value={totals.fail + totals.warn} tone="var(--fail)" />
        <Stat icon="user" label="Avg. score" value={avgScore} suffix="/100" tone="var(--brand)" />
      </div>

      {/* Recent audits */}
      <div>
        <SectionTitle
          sub="Your most recent integration checks"
          action={
            <Button href="/audits" variant="ghost" size="sm" iconRight="arrowRight">
              View all
            </Button>
          }
        >
          Recent audits
        </SectionTitle>
        {audits.length === 0 ? (
          <EmptyState
            icon="clipboard"
            title="No audits yet"
            desc="Run your first integration audit to see results here."
            action={<Button href="/new" icon="plus">New Audit</Button>}
          />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {audits.slice(0, 6).map((a) => (
              <AuditCard key={a.id} audit={a} />
            ))}
          </div>
        )}
      </div>

      {/* How it works */}
      <div>
        <SectionTitle sub="Three engines run together and merge into one checklist">
          How verification works
        </SectionTitle>
        <div className="grid gap-4 md:grid-cols-3">
          <EngineCard
            icon="key"
            title="API Verifier"
            tone="var(--accent)"
            desc="Read-only Account ID + Passcode. Confirms events, profiles, data types — and can trigger a test push, then confirm it via the result event."
            tag="Primary · no source needed"
          />
          <EngineCard
            icon="globe"
            title="Live Web Crawler"
            tone="var(--pass)"
            desc="Loads the site and inspects the SDK in <head>, the service worker, network calls, and UTM tracking — nothing is uploaded."
            tag="Web · URL only"
          />
          <EngineCard
            icon="upload"
            title="Static Scanner"
            tone="var(--warn)"
            desc="Parses APK / IPA / source for SDK version, manifest config, channels, deep links and the iOS Notification Service Extension."
            tag="App · binary or source"
          />
        </div>
      </div>
    </div>
  );
}

function Stat({
  icon,
  label,
  value,
  suffix,
  tone,
}: {
  icon: IconName;
  label: string;
  value: number;
  suffix?: string;
  tone: string;
}) {
  return (
    <Card className="p-4">
      <div className="flex items-center gap-2 text-muted">
        <span
          className="flex h-7 w-7 items-center justify-center rounded-lg"
          style={{ background: "var(--surface-2)", color: tone }}
        >
          <Icon name={icon} size={16} />
        </span>
        <span className="text-xs font-medium">{label}</span>
      </div>
      <div className="mt-2 text-2xl font-bold tracking-tight">
        {value}
        {suffix && <span className="text-sm font-medium text-muted">{suffix}</span>}
      </div>
    </Card>
  );
}

function EngineCard({
  icon,
  title,
  desc,
  tag,
  tone,
}: {
  icon: IconName;
  title: string;
  desc: string;
  tag: string;
  tone: string;
}) {
  return (
    <Card className="p-5" hover>
      <span
        className="flex h-10 w-10 items-center justify-center rounded-xl"
        style={{ background: "var(--surface-2)", color: tone }}
      >
        <Icon name={icon} size={20} />
      </span>
      <h3 className="mt-3 font-semibold">{title}</h3>
      <p className="mt-1.5 text-sm leading-relaxed text-muted">{desc}</p>
      <div className="mt-3 text-[11px] font-medium uppercase tracking-wide" style={{ color: tone }}>
        {tag}
      </div>
    </Card>
  );
}
