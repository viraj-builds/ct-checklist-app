"use client";

import { useAudits, useAuditsError } from "@/lib/store";
import { AuditCard } from "@/components/audit/AuditCard";
import { Card, Button, EmptyState } from "@/components/ui";
import { Icon, type IconName } from "@/components/Icon";

export default function Dashboard() {
  const loaded = useAudits();
  const listError = useAuditsError();
  const audits = loaded ?? [];

  return (
    <div className="flex flex-col gap-12">
      {/* Intro */}
      <section className="max-w-3xl">
        <h1 className="text-4xl font-bold tracking-[-0.02em]">Check your CleverTap integration</h1>
        <p className="mt-3 text-lg text-muted">
          We scan your app, read your CleverTap data and guide you through a few tests on a real phone. Anything that needs fixing comes with clear
          steps.
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <Button href="/new" icon="plus" size="lg">
            Start an audit
          </Button>
          <Button href="/checklist" variant="secondary" size="lg">
            See what we check
          </Button>
        </div>
      </section>

      {/* Recent audits */}
      <section aria-labelledby="recent">
        <div className="mb-4 flex items-end justify-between gap-4">
          <div>
            <h2 id="recent" className="text-xl font-bold">
              Your recent audits
            </h2>
            <p className="mt-1 text-sm text-muted">Pick up where you left off.</p>
          </div>
          {audits.length > 0 && (
            <Button href="/audits" variant="ghost" size="sm" iconRight="arrowRight">
              See all
            </Button>
          )}
        </div>
        {!loaded ? (
          <div className="space-y-px overflow-hidden rounded-[var(--radius)] border">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-[76px] skeleton" />
            ))}
          </div>
        ) : listError ? (
          <EmptyState icon="alert" title="Couldn't load your audits" desc={listError} />
        ) : audits.length === 0 ? (
          <EmptyState
            icon="clipboard"
            title="No audits yet"
            desc="Your first audit takes a few minutes. You'll need your CleverTap Account ID and your app build."
            action={
              <Button href="/new" icon="plus">
                Start an audit
              </Button>
            }
          />
        ) : (
          <Card className="overflow-hidden">
            {audits.slice(0, 5).map((a, i) => (
              <AuditCard key={a.id} audit={a} first={i === 0} />
            ))}
          </Card>
        )}
      </section>

      {/* How it works */}
      <section aria-labelledby="how">
        <h2 id="how" className="text-xl font-bold">
          How it works
        </h2>
        <ol className="mt-4 grid gap-4 md:grid-cols-3">
          <HowStep
            n={1}
            icon="key"
            title="Connect your project"
            desc="Add your CleverTap Account ID and passcode. We only read your data."
          />
          <HowStep
            n={2}
            icon="lock"
            title="Scan your build"
            desc="Drop in your APK or AAB. It's checked inside your browser and never uploaded."
          />
          <HowStep
            n={3}
            icon="phone"
            title="Test on your phone"
            desc="Plug in a test phone. We send pushes, open the app and tick checks for you."
          />
        </ol>
      </section>
    </div>
  );
}

function HowStep({ n, icon, title, desc }: { n: number; icon: IconName; title: string; desc: string }) {
  return (
    <li>
      <Card className="h-full p-6">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-[10px] bg-brand-soft text-brand-text">
            <Icon name={icon} size={20} />
          </span>
          <span className="text-sm font-bold text-muted">Step {n}</span>
        </div>
        <h3 className="mt-4 text-lg font-bold">{title}</h3>
        <p className="mt-1.5 text-[15px] text-muted">{desc}</p>
      </Card>
    </li>
  );
}
