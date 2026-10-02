"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card, Button } from "@/components/ui";
import { Icon, type IconName } from "@/components/Icon";
import { PLATFORM_META, REGIONS } from "@/lib/meta";
import type { Platform } from "@/lib/types";
import { itemsForPlatform } from "@/lib/checklist";
import { api } from "@/lib/store";
import { scanInBrowser } from "@/lib/analyzer/android/client";
import { uploadToSignedUrl } from "@/lib/upload";
import { rememberPasscode } from "@/lib/session-secrets";
import { cx, formatBytes } from "@/lib/format";

const PLATFORMS: Platform[] = ["android", "ios", "web"];
const AVAILABLE: Record<Platform, boolean> = { android: true, ios: false, web: false };
type ScanWhere = "browser" | "upload";

interface RunState {
  step: number; // index into run steps
  label: string;
  pct?: number;
  error?: string;
  auditId?: string;
}

export default function NewAuditPage() {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [platform, setPlatform] = useState<Platform | null>(null);

  const [name, setName] = useState("");
  const [region, setRegion] = useState("in1");
  const [accountId, setAccountId] = useState("");
  const [passcode, setPasscode] = useState("");
  const [skipApi, setSkipApi] = useState(false);
  const [showPass, setShowPass] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [where, setWhere] = useState<ScanWhere>("browser");
  const [events, setEvents] = useState("");
  const [run, setRun] = useState<RunState | null>(null);

  const criticalEvents = events
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 10);

  function detailsValid() {
    if (!name.trim()) return false;
    if (accountId.trim().length < 3) return false;
    if (!skipApi && passcode.length < 3) return false;
    return !!file;
  }

  const canContinue = step === 0 ? !!platform && AVAILABLE[platform] : step === 1 ? detailsValid() : true;

  async function start() {
    if (!platform || !file) return;
    const withApi = !skipApi;
    const steps = runSteps(where, withApi);
    const go = (i: number, extra: Partial<RunState> = {}) => setRun((r) => ({ ...r, step: i, label: steps[i], pct: undefined, error: undefined, ...extra }));
    let auditId: string | undefined;
    try {
      go(0);
      const created = await api<{ id: string; upload?: { url: string } }>("/api/audits", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          platform,
          source: where,
          region,
          accountId: accountId.trim(),
          fileName: file.name,
          fileSize: file.size,
          withApi,
          criticalEvents,
        }),
      });
      auditId = created.id;
      if (withApi) rememberPasscode(auditId, passcode);

      if (where === "browser") {
        go(1, { auditId });
        const report = await scanInBrowser(file, (stage, pct) => setRun((r) => r && { ...r, label: stage, pct }));
        await api(`/api/audits/${auditId}/scan`, { method: "POST", body: JSON.stringify(report) });
      } else {
        go(1, { auditId, pct: 0 });
        await uploadToSignedUrl(created.upload!.url, file, (pct) => setRun((r) => r && { ...r, pct }));
        go(2, { auditId });
        await api(`/api/audits/${auditId}/analyze`, { method: "POST" });
      }

      if (withApi) {
        go(steps.length - 2, { auditId });
        await api(`/api/audits/${auditId}/verify`, { method: "POST", body: JSON.stringify({ passcode }) });
      }
      go(steps.length - 1, { auditId });
      router.push(`/audit/${auditId}`);
    } catch (e) {
      setRun((r) => ({ ...(r ?? { step: 0, label: "" }), auditId, error: (e as Error).message }));
    }
  }

  const itemCount = platform ? itemsForPlatform(platform).length : 0;

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">New audit</h1>
        <p className="mt-1 text-sm text-muted">
          Scan the {platform ? PLATFORM_META[platform].targetLabel : "build"} and verify the account in one pass.
          Anything that needs a real device shows up as a short checklist at the end.
        </p>
      </div>

      <Stepper step={step} labels={["Platform", "Credentials & source", "Review"]} />

      <Card className="mt-6 p-6">
        {/* STEP 0: platform */}
        {step === 0 && (
          <div className="animate-fade-in">
            <StepHeading title="What are you auditing?" sub="Pick the platform." />
            <div className="grid gap-3 sm:grid-cols-3">
              {PLATFORMS.map((p) => (
                <ChoiceCard
                  key={p}
                  selected={platform === p}
                  disabled={!AVAILABLE[p]}
                  onClick={() => AVAILABLE[p] && setPlatform(p)}
                  icon={PLATFORM_META[p].icon as IconName}
                  title={PLATFORM_META[p].label}
                  desc={AVAILABLE[p] ? "Native, Flutter, React Native, Cordova, Unity…" : "Coming soon"}
                />
              ))}
            </div>
          </div>
        )}

        {/* STEP 1: details */}
        {step === 1 && platform && (
          <div className="animate-fade-in space-y-5">
            <StepHeading title="Credentials & source" sub={`${itemCount} checklist items will be evaluated.`} />
            <Field label="Audit name">
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={`e.g. ShopMate — ${PLATFORM_META[platform].label}`}
                className="input"
              />
            </Field>

            {/* Credentials */}
            <div className="rounded-xl border bg-surface-2 p-4">
              <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
                <Icon name="key" size={16} className="text-accent" />
                CleverTap account
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Region">
                  <select value={region} onChange={(e) => setRegion(e.target.value)} className="input">
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
                    placeholder="W8R-K6R-XXXX"
                    className="input font-mono"
                  />
                </Field>
              </div>
              <div className="mt-4">
                <Field label="Passcode">
                  <div className="relative">
                    <input
                      type={showPass ? "text" : "password"}
                      value={passcode}
                      disabled={skipApi}
                      onChange={(e) => setPasscode(e.target.value)}
                      placeholder={skipApi ? "Not needed for static-only checks" : "••••••••••••"}
                      className="input pr-10 font-mono disabled:opacity-50"
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
                <label className="mt-2.5 flex cursor-pointer items-center gap-2 text-xs text-muted">
                  <input type="checkbox" checked={skipApi} onChange={(e) => setSkipApi(e.target.checked)} />
                  I don&apos;t have the passcode — run the build checks only (data-flow items become manual)
                </label>
              </div>
            </div>

            {/* Source */}
            <Field label={`Upload ${PLATFORM_META[platform].targetLabel}`}>
              <Dropzone accept={PLATFORM_META[platform].accept} file={file} onFile={setFile} hint=".apk · .aab · .apks · .xapk" />
            </Field>

            <div>
              <span className="mb-1.5 block text-sm font-medium">Where should the build be scanned?</span>
              <div className="grid gap-3 sm:grid-cols-2">
                <ScanOption
                  selected={where === "browser"}
                  onClick={() => setWhere("browser")}
                  icon="lock"
                  title="Private scan (recommended)"
                  desc="Runs in this browser. The file never leaves your device — only the findings are saved."
                />
                <ScanOption
                  selected={where === "upload"}
                  onClick={() => setWhere("upload")}
                  icon="upload"
                  title="Upload & scan on server"
                  desc="For slow devices. The file is deleted right after analysis."
                />
              </div>
            </div>

            <Field label="Business-critical events (optional)">
              <input
                value={events}
                onChange={(e) => setEvents(e.target.value)}
                placeholder="e.g. Product Viewed, Added To Cart, Charged"
                className="input"
              />
              <span className="mt-1 block text-xs text-muted">
                Comma-separated, up to 10. These are checked for data flow and property formats (Tier 4).
              </span>
            </Field>

            <SecurityNote>
              The passcode is sent only to our server for this run and is never stored. All CleverTap API calls are
              read-only, except the optional test push you trigger yourself from the report.
            </SecurityNote>
          </div>
        )}

        {/* STEP 2: review */}
        {step === 2 && platform && (
          <div className="animate-fade-in">
            <StepHeading title="Review & run" sub="Confirm the setup below." />
            <div className="divide-y rounded-xl border">
              <ReviewRow label="Name" value={name} />
              <ReviewRow label="Platform" value={PLATFORM_META[platform].label} />
              <ReviewRow label="Region" value={REGIONS.find((r) => r.id === region)?.label ?? region} />
              <ReviewRow label="Account ID" value={accountId.trim()} mono />
              <ReviewRow label="API checks" value={skipApi ? "Skipped (no passcode)" : "Enabled"} />
              <ReviewRow label="Build" value={file ? `${file.name} · ${formatBytes(file.size)}` : ""} mono />
              <ReviewRow label="Scan" value={where === "browser" ? "Private — in this browser" : "Upload to server"} />
              {criticalEvents.length > 0 && <ReviewRow label="Critical events" value={criticalEvents.join(", ")} />}
              <ReviewRow label="Checklist items" value={String(itemCount)} />
            </div>
            <div className="mt-4 flex items-start gap-2.5 rounded-xl border border-dashed p-3.5 text-xs leading-relaxed text-muted">
              <Icon name="info" size={16} className="mt-0.5 shrink-0 text-accent" />
              <span>
                After the automated pass, items that need a real device (killed/background/foreground push, deep-link
                landing, visual render) appear as a short guided <b className="text-text">Live-device checklist</b> on
                the report. You can also send a test push from there.
              </span>
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
            disabled={step === 0 || !!run}
          >
            Back
          </Button>
          {step < 2 ? (
            <Button iconRight="arrowRight" disabled={!canContinue} onClick={() => setStep((s) => s + 1)}>
              Continue
            </Button>
          ) : (
            <Button icon="zap" onClick={start} disabled={!!run && !run.error}>
              {run && !run.error ? "Running…" : "Run full analysis"}
            </Button>
          )}
        </div>
      </Card>

      {run && (
        <RunningOverlay
          steps={runSteps(where, !skipApi)}
          run={run}
          onClose={() => setRun(null)}
          onOpen={run.auditId ? () => router.push(`/audit/${run.auditId}`) : undefined}
        />
      )}
    </div>
  );
}

function runSteps(where: ScanWhere, withApi: boolean): string[] {
  return [
    "Creating audit",
    ...(where === "browser" ? ["Scanning the build in your browser"] : ["Uploading the build", "Analysing on the server"]),
    ...(withApi ? ["Verifying with the CleverTap API"] : []),
    "Building report",
  ];
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
            <span className={cx("hidden text-sm font-medium sm:block", i <= step ? "text-text" : "text-muted")}>{l}</span>
          </div>
          {i < labels.length - 1 && (
            <div className={cx("mx-2 h-px flex-1 transition", i < step ? "bg-brand" : "bg-border")} />
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
  disabled,
  onClick,
  icon,
  title,
  desc,
}: {
  selected: boolean;
  disabled?: boolean;
  onClick: () => void;
  icon: IconName;
  title: string;
  desc: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cx(
        "flex flex-col items-start gap-3 rounded-xl border p-4 text-left transition",
        disabled && "cursor-not-allowed opacity-50",
        selected ? "border-brand bg-brand-soft ring-1 ring-brand" : !disabled && "hover:border-border-strong hover:bg-surface-2",
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

function ScanOption({
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
      type="button"
      onClick={onClick}
      className={cx(
        "flex items-start gap-3 rounded-xl border p-3.5 text-left transition",
        selected ? "border-brand bg-brand-soft ring-1 ring-brand" : "hover:bg-surface-2",
      )}
    >
      <Icon name={icon} size={18} className={cx("mt-0.5 shrink-0", selected ? "text-brand" : "text-muted")} />
      <span>
        <span className="block text-sm font-semibold">{title}</span>
        <span className="mt-0.5 block text-xs leading-relaxed text-muted">{desc}</span>
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
  file,
  onFile,
  hint,
}: {
  accept: string;
  file: File | null;
  onFile: (f: File | null) => void;
  hint: string;
}) {
  const [drag, setDrag] = useState(false);
  return (
    <label
      onDragOver={(e) => {
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        const f = e.dataTransfer.files?.[0];
        if (f) onFile(f);
      }}
      className={cx(
        "flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-4 py-8 text-center transition hover:bg-surface-2",
        (file || drag) && "border-brand bg-brand-soft",
      )}
    >
      <input type="file" accept={accept} className="hidden" onChange={(e) => onFile(e.target.files?.[0] ?? null)} />
      <Icon name={file ? "check" : "upload"} size={24} className={file ? "text-brand" : "text-muted"} />
      <div className="mt-2 text-sm font-medium">{file ? file.name : "Click or drop a file"}</div>
      <div className="mt-0.5 text-xs text-muted">{file ? formatBytes(file.size) : hint}</div>
    </label>
  );
}

function ReviewRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3 text-sm">
      <span className="shrink-0 text-muted">{label}</span>
      <span className={cx("truncate text-right font-medium", mono && "font-mono text-[13px]")}>{value || "—"}</span>
    </div>
  );
}

function RunningOverlay({
  steps,
  run,
  onClose,
  onOpen,
}: {
  steps: string[];
  run: RunState;
  onClose: () => void;
  onOpen?: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm animate-fade-in">
      <Card className="w-full max-w-sm p-6">
        <div className="text-center">
          <div
            className="mx-auto flex h-14 w-14 items-center justify-center rounded-full"
            style={{ background: run.error ? "var(--fail-soft)" : "var(--brand-soft)" }}
          >
            {run.error ? (
              <Icon name="alert" size={26} style={{ color: "var(--fail)" }} />
            ) : (
              <span className="h-8 w-8 rounded-full border-[3px] border-brand border-t-transparent animate-spin-slow" />
            )}
          </div>
          <h3 className="mt-4 font-semibold">{run.error ? "Something went wrong" : "Running full analysis"}</h3>
        </div>
        <div className="mt-4 space-y-2 text-left">
          {steps.map((s, i) => {
            const done = i < run.step;
            const active = i === run.step;
            return (
              <div key={s} className={cx("flex items-start gap-2 text-sm", active ? "text-text" : "text-muted")}>
                <span className="mt-0.5 shrink-0">
                  {done ? (
                    <Icon name="check" size={14} className="text-[var(--pass)]" />
                  ) : active && run.error ? (
                    <Icon name="x" size={14} style={{ color: "var(--fail)" }} />
                  ) : active ? (
                    <span className="block h-3.5 w-3.5 rounded-full border-2 border-brand border-t-transparent animate-spin-slow" />
                  ) : (
                    <span className="block h-3.5 w-3.5 rounded-full border" />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  {s}
                  {active && !run.error && (run.label !== s || run.pct !== undefined) && (
                    <span className="mt-1 block text-xs text-muted">
                      {run.label !== s ? run.label : ""}
                      {run.pct !== undefined && ` · ${run.pct}%`}
                    </span>
                  )}
                  {active && run.pct !== undefined && !run.error && (
                    <span className="mt-1.5 block h-1 overflow-hidden rounded-full bg-surface-3">
                      <span className="block h-full bg-brand transition-all" style={{ width: `${run.pct}%` }} />
                    </span>
                  )}
                </span>
              </div>
            );
          })}
        </div>
        {run.error && (
          <>
            <p className="mt-4 rounded-lg p-3 text-xs leading-relaxed" style={{ background: "var(--fail-soft)", color: "var(--fail)" }}>
              {run.error}
            </p>
            <div className="mt-4 flex justify-end gap-2">
              {onOpen && (
                <Button variant="secondary" size="sm" onClick={onOpen}>
                  Open partial report
                </Button>
              )}
              <Button size="sm" onClick={onClose}>
                Close
              </Button>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
