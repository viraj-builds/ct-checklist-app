"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card, Button, PlatformIcon } from "@/components/ui";
import { Icon, type IconName } from "@/components/Icon";
import { PLATFORM_META, MODE_META, REGIONS } from "@/lib/meta";
import type { Platform, AuditMode, Audit } from "@/lib/types";
import { itemsForPlatform } from "@/lib/checklist";
import { generateResults } from "@/lib/mock";
import { addAudit } from "@/lib/store";
import { cx } from "@/lib/format";

const PLATFORMS: Platform[] = ["android", "ios", "web"];
const APP_MODES: AuditMode[] = ["api", "upload", "cli"];
const WEB_MODES: AuditMode[] = ["api", "url", "upload"];

export default function NewAuditPage() {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [platform, setPlatform] = useState<Platform | null>(null);
  const [mode, setMode] = useState<AuditMode | null>(null);

  // inputs
  const [name, setName] = useState("");
  const [region, setRegion] = useState("in1");
  const [accountId, setAccountId] = useState("");
  const [passcode, setPasscode] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [url, setUrl] = useState("");
  const [fileName, setFileName] = useState("");
  const [running, setRunning] = useState(false);

  const modes = platform === "web" ? WEB_MODES : APP_MODES;

  function target(): string {
    if (mode === "api") return accountId ? maskId(accountId) : "API account";
    if (mode === "url") return url || "—";
    if (mode === "upload") return fileName || "—";
    if (mode === "cli") return fileName || "report.json";
    return "—";
  }

  const canContinue =
    step === 0
      ? !!platform
      : step === 1
        ? !!mode
        : step === 2
          ? inputsValid()
          : true;

  function inputsValid() {
    if (!name.trim()) return false;
    if (mode === "api") return accountId.trim().length > 2 && passcode.length > 2;
    if (mode === "url") return /^https?:\/\/.+/.test(url.trim());
    if (mode === "upload") return !!fileName;
    if (mode === "cli") return !!fileName;
    return false;
  }

  function run() {
    if (!platform || !mode) return;
    setRunning(true);
    const id = "aud_" + Math.random().toString(36).slice(2, 9);
    const audit: Audit = {
      id,
      name: name.trim(),
      platform,
      mode,
      region: mode === "api" ? region : undefined,
      target: target(),
      createdAt: Date.now(),
      status: "completed",
      submittedBy: "you@clevertap.com",
      results: generateResults(id, platform, mode),
    };
    // simulate analysis time
    setTimeout(() => {
      addAudit(audit);
      router.push(`/audit/${id}`);
    }, 2200);
  }

  const itemCount = platform ? itemsForPlatform(platform).length : 0;

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">New audit</h1>
        <p className="mt-1 text-sm text-muted">
          Set up an integration check. This preview generates sample results —
          no data is sent anywhere.
        </p>
      </div>

      <Stepper
        step={step}
        labels={["Platform", "Method", "Details", "Review"]}
      />

      <Card className="mt-6 p-6">
        {/* STEP 0: platform */}
        {step === 0 && (
          <div className="animate-fade-in">
            <StepHeading
              title="What are you auditing?"
              sub="Pick the platform of the integration."
            />
            <div className="grid gap-3 sm:grid-cols-3">
              {PLATFORMS.map((p) => (
                <ChoiceCard
                  key={p}
                  selected={platform === p}
                  onClick={() => {
                    setPlatform(p);
                    setMode(null);
                  }}
                  icon={PLATFORM_META[p].icon as IconName}
                  title={PLATFORM_META[p].label}
                  desc={PLATFORM_META[p].targetLabel}
                />
              ))}
            </div>
          </div>
        )}

        {/* STEP 1: mode */}
        {step === 1 && platform && (
          <div className="animate-fade-in">
            <StepHeading
              title="How should we check it?"
              sub="The API method has the highest coverage and needs no source code."
            />
            <div className="grid gap-3">
              {modes.map((m) => (
                <ModeRow
                  key={m}
                  selected={mode === m}
                  onClick={() => setMode(m)}
                  mode={m}
                />
              ))}
            </div>
          </div>
        )}

        {/* STEP 2: details */}
        {step === 2 && platform && mode && (
          <div className="animate-fade-in space-y-5">
            <StepHeading
              title="Details"
              sub={`${itemCount} checklist items will be evaluated for ${PLATFORM_META[platform].label}.`}
            />
            <Field label="Audit name">
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. ShopMate — Android"
                className="input"
              />
            </Field>

            {mode === "api" && (
              <>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Region">
                    <select
                      value={region}
                      onChange={(e) => setRegion(e.target.value)}
                      className="input"
                    >
                      {REGIONS.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.label}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Account ID">
                    <input
                      value={accountId}
                      onChange={(e) => setAccountId(e.target.value)}
                      placeholder="e.g. W8R-K6R-XXXX"
                      className="input font-mono"
                    />
                  </Field>
                </div>
                <Field label="Passcode (read-only)">
                  <div className="relative">
                    <input
                      type={showPass ? "text" : "password"}
                      value={passcode}
                      onChange={(e) => setPasscode(e.target.value)}
                      placeholder="••••••••••••"
                      className="input pr-10 font-mono"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPass((v) => !v)}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted hover:text-text"
                      aria-label="Toggle passcode visibility"
                    >
                      <Icon name={showPass ? "eyeOff" : "eye"} size={17} />
                    </button>
                  </div>
                </Field>
                <SecurityNote>
                  The passcode is never stored — in the real tool it is used for
                  the job in memory and discarded. All calls run server-side.
                </SecurityNote>
              </>
            )}

            {mode === "url" && (
              <Field label="Website URL">
                <input
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://app.example.com"
                  className="input font-mono"
                />
              </Field>
            )}

            {(mode === "upload" || mode === "cli") && (
              <>
                {mode === "cli" && (
                  <div className="rounded-xl border bg-surface-2 p-4">
                    <div className="mb-2 text-xs font-medium text-muted">
                      1 · Run locally (binary never leaves your machine)
                    </div>
                    <CodeLine text={`npx ct-audit scan ./${platform === "web" ? "site" : "app"} --out report.json`} />
                    <div className="mt-3 mb-2 text-xs font-medium text-muted">
                      2 · Upload the generated report
                    </div>
                    <Dropzone
                      accept=".json"
                      fileName={fileName}
                      onFile={setFileName}
                      hint="report.json"
                    />
                  </div>
                )}
                {mode === "upload" && (
                  <Field label={`Upload ${PLATFORM_META[platform].targetLabel}`}>
                    <Dropzone
                      accept={PLATFORM_META[platform].accept}
                      fileName={fileName}
                      onFile={setFileName}
                      hint={PLATFORM_META[platform].accept}
                    />
                    <p className="mt-2 text-xs text-muted">
                      Files are auto-deleted after analysis in the real tool.
                    </p>
                  </Field>
                )}
              </>
            )}
          </div>
        )}

        {/* STEP 3: review */}
        {step === 3 && platform && mode && (
          <div className="animate-fade-in">
            <StepHeading title="Review & run" sub="Confirm the setup below." />
            <div className="divide-y rounded-xl border">
              <ReviewRow label="Name" value={name} />
              <ReviewRow label="Platform" value={PLATFORM_META[platform].label} />
              <ReviewRow label="Method" value={MODE_META[mode].label} />
              {mode === "api" && (
                <ReviewRow
                  label="Region"
                  value={REGIONS.find((r) => r.id === region)?.label ?? region}
                />
              )}
              <ReviewRow label="Target" value={target()} mono />
              <ReviewRow label="Checklist items" value={String(itemCount)} />
            </div>
          </div>
        )}

        {/* Nav */}
        <div className="mt-7 flex items-center justify-between">
          <Button
            variant="ghost"
            icon="chevronRight"
            className="[&_svg]:rotate-180"
            onClick={() => setStep((s) => Math.max(0, s - 1))}
            disabled={step === 0 || running}
          >
            Back
          </Button>
          {step < 3 ? (
            <Button
              iconRight="arrowRight"
              disabled={!canContinue}
              onClick={() => setStep((s) => s + 1)}
            >
              Continue
            </Button>
          ) : (
            <Button icon="zap" onClick={run} disabled={running}>
              {running ? "Running…" : "Run audit"}
            </Button>
          )}
        </div>
      </Card>

      {running && <RunningOverlay platform={platform!} mode={mode!} count={itemCount} />}
    </div>
  );
}

/* ---------------- sub components ---------------- */

function Stepper({ step, labels }: { step: number; labels: string[] }) {
  return (
    <div className="flex items-center">
      {labels.map((l, i) => (
        <div key={l} className="flex flex-1 items-center last:flex-none">
          <div className="flex items-center gap-2">
            <span
              className={cx(
                "flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold transition",
                i < step
                  ? "bg-brand text-brand-fg"
                  : i === step
                    ? "bg-brand-soft text-brand ring-2 ring-brand"
                    : "bg-surface-2 text-muted",
              )}
            >
              {i < step ? <Icon name="check" size={14} /> : i + 1}
            </span>
            <span
              className={cx(
                "hidden text-sm font-medium sm:block",
                i <= step ? "text-text" : "text-muted",
              )}
            >
              {l}
            </span>
          </div>
          {i < labels.length - 1 && (
            <div
              className={cx(
                "mx-2 h-px flex-1 transition",
                i < step ? "bg-brand" : "bg-border",
              )}
            />
          )}
        </div>
      ))}
    </div>
  );
}

function StepHeading({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="mb-5">
      <h2 className="text-lg font-semibold">{title}</h2>
      {sub && <p className="mt-1 text-sm text-muted">{sub}</p>}
    </div>
  );
}

function ChoiceCard({
  selected,
  onClick,
  icon,
  title,
  desc,
}: {
  selected: boolean;
  onClick: () => void;
  icon: IconName;
  title: string;
  desc: string;
}) {
  return (
    <button
      onClick={onClick}
      className={cx(
        "flex flex-col items-start gap-3 rounded-xl border p-4 text-left transition",
        selected
          ? "border-brand bg-brand-soft ring-1 ring-brand"
          : "hover:border-border-strong hover:bg-surface-2",
      )}
    >
      <span
        className={cx(
          "flex h-11 w-11 items-center justify-center rounded-xl",
          selected ? "bg-brand text-brand-fg" : "bg-surface-2 text-text",
        )}
      >
        <Icon name={icon} size={22} />
      </span>
      <div>
        <div className="font-semibold">{title}</div>
        <div className="text-xs text-muted">{desc}</div>
      </div>
    </button>
  );
}

function ModeRow({
  selected,
  onClick,
  mode,
}: {
  selected: boolean;
  onClick: () => void;
  mode: AuditMode;
}) {
  const m = MODE_META[mode];
  return (
    <button
      onClick={onClick}
      className={cx(
        "flex items-center gap-4 rounded-xl border p-4 text-left transition",
        selected
          ? "border-brand bg-brand-soft ring-1 ring-brand"
          : "hover:border-border-strong hover:bg-surface-2",
      )}
    >
      <span
        className={cx(
          "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl",
          selected ? "bg-brand text-brand-fg" : "bg-surface-2 text-text",
        )}
      >
        <Icon name={m.icon as IconName} size={20} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 font-medium">
          {m.label}
          {mode === "api" && (
            <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[10px] font-semibold uppercase text-accent">
              Recommended
            </span>
          )}
        </div>
        <div className="text-xs text-muted">{m.desc}</div>
      </div>
      <span
        className={cx(
          "flex h-5 w-5 items-center justify-center rounded-full border",
          selected ? "border-brand bg-brand text-brand-fg" : "border-border-strong",
        )}
      >
        {selected && <Icon name="check" size={13} />}
      </span>
    </button>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium">{label}</span>
      {children}
    </label>
  );
}

function SecurityNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2.5 rounded-xl border border-dashed p-3.5 text-xs leading-relaxed text-muted">
      <Icon name="lock" size={16} className="mt-0.5 shrink-0 text-[var(--pass)]" />
      <span>{children}</span>
    </div>
  );
}

function Dropzone({
  accept,
  fileName,
  onFile,
  hint,
}: {
  accept: string;
  fileName: string;
  onFile: (name: string) => void;
  hint: string;
}) {
  return (
    <label
      className={cx(
        "flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-4 py-8 text-center transition hover:bg-surface-2",
        fileName && "border-brand bg-brand-soft",
      )}
    >
      <input
        type="file"
        accept={accept}
        className="hidden"
        onChange={(e) => onFile(e.target.files?.[0]?.name ?? "")}
      />
      <Icon
        name={fileName ? "check" : "upload"}
        size={24}
        className={fileName ? "text-brand" : "text-muted"}
      />
      <div className="mt-2 text-sm font-medium">
        {fileName || "Click to choose a file"}
      </div>
      <div className="mt-0.5 text-xs text-muted">{hint}</div>
    </label>
  );
}

function CodeLine({ text }: { text: string }) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-lg bg-surface-3 px-3 py-2 font-mono text-xs">
      <span className="truncate">
        <span className="text-muted-2">$ </span>
        {text}
      </span>
      <Icon name="copy" size={14} className="shrink-0 text-muted" />
    </div>
  );
}

function ReviewRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-center justify-between px-4 py-3 text-sm">
      <span className="text-muted">{label}</span>
      <span className={cx("font-medium", mono && "font-mono text-[13px]")}>
        {value || "—"}
      </span>
    </div>
  );
}

function RunningOverlay({
  platform,
  mode,
  count,
}: {
  platform: Platform;
  mode: AuditMode;
  count: number;
}) {
  const steps = [
    mode === "api"
      ? "Connecting to CleverTap API…"
      : mode === "url"
        ? "Loading the page…"
        : "Unpacking source…",
    "Running checks…",
    `Evaluating ${count} checklist items…`,
    "Building report…",
  ];
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm animate-fade-in">
      <Card className="w-full max-w-sm p-6 text-center">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-brand-soft">
          <span
            className="h-8 w-8 rounded-full border-[3px] border-brand border-t-transparent animate-spin-slow"
            style={{ borderTopColor: "transparent" }}
          />
        </div>
        <h3 className="mt-4 font-semibold">Running audit</h3>
        <p className="mt-1 text-sm text-muted">
          {PLATFORM_META[platform].label} · {MODE_META[mode].label}
        </p>
        <div className="mt-4 space-y-1.5 text-left">
          {steps.map((s, i) => (
            <div
              key={s}
              className="flex items-center gap-2 text-sm text-muted"
              style={{ animation: `fadeIn .4s ${i * 0.45}s both` }}
            >
              <Icon name="check" size={14} className="text-[var(--pass)]" />
              {s}
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

function maskId(id: string): string {
  if (id.length <= 4) return "•••" + id;
  return id.slice(0, 3) + "-•••-" + id.slice(-3);
}
