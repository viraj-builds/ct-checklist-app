"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card, Button, StatusMark } from "@/components/ui";
import { Icon, type IconName } from "@/components/Icon";
import { PLATFORM_META, REGIONS } from "@/lib/meta";
import type { Platform } from "@/lib/types";
import { itemsForPlatform } from "@/lib/checklist";
import { GROUPS } from "@/lib/stages";
import { api } from "@/lib/store";
import { scanInBrowser } from "@/lib/analyzer/android/client";
import { scanIosInBrowser } from "@/lib/analyzer/ios/client";
import { uploadToSignedUrl } from "@/lib/upload";
import { rememberIdentity, rememberPasscode, rememberWebLogin } from "@/lib/session-secrets";
import { cx, formatBytes } from "@/lib/format";
import { ConsentFields, consentBody } from "@/components/audit/Consent";

const PLATFORMS: Platform[] = ["android", "ios", "web"];
const AVAILABLE: Record<Platform, boolean> = { android: true, ios: true, web: true };
const PLATFORM_NEEDS: Record<Platform, string> = {
  android: "Your APK or AAB, plus a test phone",
  ios: "Your IPA, plus a test iPhone",
  web: "Your website URL",
};
// Debug-logging line from the CleverTap docs — the build must have it so the
// live tests can read what the SDK does.
const VERBOSE: Partial<Record<Platform, { code: string; wrappers: string; doc: string }>> = {
  android: {
    code: "CleverTapAPI.setDebugLevel(CleverTapAPI.LogLevel.VERBOSE);",
    wrappers: "Flutter / React Native: CleverTapPlugin.setDebugLevel(3) · CleverTap.setDebugLevel(3)",
    doc: "https://developer.clevertap.com/docs/android-quickstart-guide#debugging",
  },
  ios: {
    code: "CleverTap.setDebugLevel(CleverTapLogLevel.debug.rawValue)",
    wrappers: "Call it before CleverTap.autoIntegrate(). Flutter / React Native: setDebugLevel(3)",
    doc: "https://developer.clevertap.com/docs/ios-quickstart-guide#debug-clevertap-sdk-in-your-swift-application",
  },
};

const DROP_HINT: Record<Platform, string> = {
  android: ".apk · .aab · .apks · .xapk",
  ios: ".ipa",
  web: ".zip",
};
type ScanWhere = "browser" | "upload" | "url";

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
  const [platform, setPlatform] = useState<Platform | null>("android");

  const [name, setName] = useState("");
  const [region, setRegion] = useState("in1");
  const [accountId, setAccountId] = useState("");
  const [passcode, setPasscode] = useState("");
  const [skipApi, setSkipApi] = useState(false);
  const [showPass, setShowPass] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  // Builds are scanned in the browser. Server upload ("upload") still works in
  // the backend and can be re-enabled here if a slow-device option is needed.
  const [siteUrl, setSiteUrl] = useState("");
  const [loginUrl, setLoginUrl] = useState("");
  const [loginUser, setLoginUser] = useState("");
  const [loginPass, setLoginPass] = useState("");
  const [showLoginPass, setShowLoginPass] = useState(false);
  const isWeb = platform === "web";
  const where: ScanWhere = isWeb ? "url" : "browser";
  const [events, setEvents] = useState("");
  const [consentData, setConsentData] = useState(false);
  const [consentShots, setConsentShots] = useState(false);
  const [run, setRun] = useState<RunState | null>(null);

  const criticalEvents = events
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 10);

  function projectValid() {
    if (!name.trim()) return false;
    if (accountId.trim().length < 3) return false;
    return skipApi || passcode.length >= 3;
  }

  async function start() {
    if (!platform || (isWeb ? !siteUrl.trim() : !file)) return;
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
          ...(isWeb ? { siteUrl: siteUrl.trim() } : { fileName: file!.name, fileSize: file!.size }),
          withApi,
          criticalEvents,
          consent: consentBody(consentShots),
        }),
      });
      auditId = created.id;
      if (withApi) rememberPasscode(auditId, passcode);

      let identity: string | undefined;
      if (where === "url") {
        go(1, { auditId });
        const login = loginUser.trim() && loginPass ? { url: loginUrl.trim() || undefined, username: loginUser.trim(), password: loginPass } : undefined;
        if (login) rememberWebLogin(auditId, login);
        const crawled = await api<{ identity?: string }>(`/api/audits/${auditId}/crawl`, { method: "POST", body: JSON.stringify({ login }) });
        identity = crawled.identity ?? (login && login.username.includes("@") ? login.username : undefined);
        if (identity) rememberIdentity(auditId, identity);
      } else if (where === "browser") {
        go(1, { auditId });
        const onProgress = (stage: string, pct: number) => setRun((r) => r && { ...r, label: stage, pct });
        const report = platform === "ios" ? await scanIosInBrowser(file!, onProgress) : await scanInBrowser(file!, onProgress);
        await api(`/api/audits/${auditId}/scan`, { method: "POST", body: JSON.stringify(report) });
      } else {
        go(1, { auditId, pct: 0 });
        await uploadToSignedUrl(created.upload!.url, file!, (pct) => setRun((r) => r && { ...r, pct }));
        go(2, { auditId });
        await api(`/api/audits/${auditId}/analyze`, { method: "POST" });
      }

      if (withApi) {
        go(steps.length - 2, { auditId });
        await api(`/api/audits/${auditId}/verify`, { method: "POST", body: JSON.stringify({ passcode, ...(identity ? { identity } : {}) }) });
      }
      go(steps.length - 1, { auditId });
      router.push(`/audit/${auditId}`);
    } catch (e) {
      setRun((r) => ({ ...(r ?? { step: 0, label: "" }), auditId, error: (e as Error).message }));
    }
  }

  const itemCount = platform ? itemsForPlatform(platform).length : 0;
  const busy = !!run && !run.error;
  const regionLabel = REGIONS.find((r) => r.id === region)?.label ?? region;

  return (
    <div>
      <div className="mb-8 max-w-2xl">
        <h1 className="text-4xl font-bold tracking-[-0.02em]">Check your CleverTap integration</h1>
        <p className="mt-3 text-lg text-muted">
          Three short steps to set up. Then we guide you through each test, read the data for you and point out anything to fix.
        </p>
      </div>

      <div className="flex flex-wrap items-start gap-10">
        <section aria-label="Set up your audit" className="min-w-0 flex-[999_1_560px]">
          <Card className="overflow-hidden">
            {/* STEP 1: platform */}
            <StepBlock
              n={1}
              state={step === 0 ? "current" : "done"}
              title="Choose what to audit"
              done={platform ? `${platform === "web" ? "Website" : `${PLATFORM_META[platform].label} app`} · ${itemCount} checks` : ""}
              onChange={busy ? undefined : () => setStep(0)}
            >
              <div role="group" aria-label="Platform" className="grid gap-3 sm:grid-cols-3">
                {PLATFORMS.map((p) => (
                  <ChoiceCard
                    key={p}
                    selected={platform === p}
                    disabled={!AVAILABLE[p]}
                    onClick={() => {
                      if (!AVAILABLE[p]) return;
                      if (p !== platform) setFile(null);
                      setPlatform(p);
                    }}
                    icon={PLATFORM_META[p].icon as IconName}
                    title={`${PLATFORM_META[p].label} app`.replace("Web app", "Website")}
                    desc={PLATFORM_NEEDS[p]}
                    foot={AVAILABLE[p] ? `${itemsForPlatform(p).length} checks · any framework` : "Coming soon"}
                  />
                ))}
              </div>
              <div className="mt-6">
                <Button size="lg" disabled={!platform || !AVAILABLE[platform]} onClick={() => setStep(1)}>
                  Continue
                </Button>
              </div>
            </StepBlock>

            {/* STEP 2: CleverTap project */}
            <StepBlock
              n={2}
              state={step === 1 ? "current" : step > 1 ? "done" : "upcoming"}
              title="Connect your CleverTap project"
              hint="Your Account ID and passcode, so we can read your data"
              done={`${name.trim()} · ${regionLabel} · ${accountId.trim()}${skipApi ? " · build checks only" : ""}`}
              onChange={busy ? undefined : () => setStep(1)}
            >
              <p className="mb-5 text-[15px] text-muted">Find these in Settings › Project on your CleverTap dashboard.</p>
              <div className="space-y-5">
                <Field label="Name this audit" htmlFor="name">
                  <input
                    id="name"
                    autoFocus
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder={platform ? `For example ShopMate — ${PLATFORM_META[platform].label}` : "For example ShopMate"}
                    className="input"
                  />
                </Field>
                <div className="grid gap-5 sm:grid-cols-2">
                  <Field label="Account ID" htmlFor="acc">
                    <input
                      id="acc"
                      value={accountId}
                      onChange={(e) => setAccountId(e.target.value)}
                      placeholder="For example W8R-K6R-XXXX"
                      className="input font-mono"
                    />
                  </Field>
                  <Field label="Region" htmlFor="region">
                    <select id="region" value={region} onChange={(e) => setRegion(e.target.value)} className="input">
                      {REGIONS.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.label}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
                <Field label="Passcode" htmlFor="pass">
                  <div className="relative">
                    <input
                      id="pass"
                      type={showPass ? "text" : "password"}
                      autoComplete="new-password"
                      data-1p-ignore
                      data-lpignore="true"
                      value={passcode}
                      disabled={skipApi}
                      onChange={(e) => setPasscode(e.target.value)}
                      placeholder={skipApi ? "Not needed for build-only checks" : "Paste your passcode"}
                      className="input pr-12 font-mono disabled:opacity-50"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPass((v) => !v)}
                      className="absolute right-1.5 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-lg text-muted hover:bg-surface-3 hover:text-text"
                      aria-label={showPass ? "Hide passcode" : "Show passcode"}
                    >
                      <Icon name={showPass ? "eyeOff" : "eye"} size={18} />
                    </button>
                  </div>
                </Field>
                <label className="flex cursor-pointer items-start gap-3 text-[15px] text-text-2">
                  <input type="checkbox" className="mt-1 h-4 w-4 accent-[var(--brand)]" checked={skipApi} onChange={(e) => setSkipApi(e.target.checked)} />
                  <span>
                    I don&apos;t have the passcode — only check the build.
                    <span className="block text-sm text-muted">Checks that need your CleverTap data will be left for you to confirm.</span>
                  </span>
                </label>
                <div className="flex items-start gap-3 rounded-xl bg-surface-2 px-4 py-3.5 text-sm text-muted">
                  <Icon name="lock" size={17} className="mt-0.5 shrink-0" style={{ color: "var(--pass)" }} />
                  <span>
                    The passcode is only used for this run and is never stored. We only read from CleverTap — except the test push you send yourself
                    later.
                  </span>
                </div>
              </div>
              <div className="mt-6">
                <Button size="lg" disabled={!projectValid()} onClick={() => setStep(2)}>
                  Continue
                </Button>
              </div>
            </StepBlock>

            {/* STEP 3: build */}
            <StepBlock
              n={3}
              state={step === 2 ? "current" : "upcoming"}
              title={`Add your ${platform ? PLATFORM_META[platform].targetLabel : "build"}`}
              hint={isWeb ? "We open it in a private browser and watch what CleverTap receives" : "We scan it right here in your browser"}
            >
              {isWeb ? (
                <WebTarget
                  siteUrl={siteUrl}
                  setSiteUrl={setSiteUrl}
                  loginUrl={loginUrl}
                  setLoginUrl={setLoginUrl}
                  loginUser={loginUser}
                  setLoginUser={setLoginUser}
                  loginPass={loginPass}
                  setLoginPass={setLoginPass}
                  showPass={showLoginPass}
                  setShowPass={setShowLoginPass}
                  events={events}
                  setEvents={setEvents}
                  canStart={!!siteUrl.trim() && projectValid() && consentData && !busy}
                  consent={<ConsentFields data={consentData} onData={setConsentData} screenshots={consentShots} onScreenshots={setConsentShots} />}
                  busy={busy}
                  onStart={start}
                />
              ) : (
              <div className="space-y-6">
                <div>
                  <Dropzone accept={platform ? PLATFORM_META[platform].accept : ""} file={file} onFile={setFile} hint={platform ? DROP_HINT[platform] : ""} />
                  <p className="mt-2.5 flex items-center gap-2 text-sm text-muted">
                    <Icon name="lock" size={15} style={{ color: "var(--pass)" }} />
                    Checked in your browser — your app file isn&apos;t uploaded or stored.
                  </p>
                  {platform && VERBOSE[platform] && (
                    <div className="mt-4 rounded-xl border px-4 py-3.5" style={{ background: "var(--brand-soft)" }}>
                      <div className="flex items-center gap-2 text-[15px] font-bold">
                        <Icon name="info" size={17} className="text-brand" /> Before you upload: turn on CleverTap debug logs
                      </div>
                      <p className="mt-1 text-sm text-text-2">
                        Build the {platform === "ios" ? ".ipa" : "APK / AAB"} with this line where you set up CleverTap, as the CleverTap docs describe. Then install
                        that same build on your test {platform === "ios" ? "iPhone" : "phone"} — the live tests read these logs to check each item.
                      </p>
                      <code className="mt-2 block overflow-x-auto rounded-lg bg-surface px-3 py-2 font-mono text-[13px]">{VERBOSE[platform]!.code}</code>
                      <p className="mt-1.5 text-[13px] text-muted">{VERBOSE[platform]!.wrappers}</p>
                      <a href={VERBOSE[platform]!.doc} target="_blank" rel="noreferrer" className="link mt-1.5 inline-flex items-center gap-1 text-sm">
                        CleverTap docs: debugging the SDK <Icon name="external" size={13} />
                      </a>
                      {platform === "ios" && (
                        <p className="mt-2 text-[13px] text-muted">
                          Export it from Xcode → Product → Archive → Distribute App → Development or Ad Hoc, so it installs on your test iPhone.
                        </p>
                      )}
                    </div>
                  )}
                </div>

                <Field label="Your custom events (optional)" htmlFor="events" hint="The 3–4 custom events that matter most, spelled exactly as in your code. You can change them later.">
                  <input
                    id="events"
                    value={events}
                    onChange={(e) => setEvents(e.target.value)}
                    placeholder="For example Product Viewed, Added To Cart, Charged"
                    className="input"
                  />
                </Field>

                <ConsentFields data={consentData} onData={setConsentData} screenshots={consentShots} onScreenshots={setConsentShots} />

                <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
                  <Button size="lg" icon="zap" onClick={start} disabled={!file || !projectValid() || !consentData || busy}>
                    {busy ? "Starting…" : "Start audit"}
                  </Button>
                  <span className="text-sm text-muted">Takes about a minute. Your progress is saved as you go.</span>
                </div>
              </div>
              )}
            </StepBlock>
          </Card>
        </section>

        <aside aria-label="About the audit" className="min-w-0 flex-[1_1_280px] pt-1">
          <h2 className="text-lg font-bold">What the audit covers</h2>
          <ol className="mt-4 space-y-4">
            {GROUPS.map((g, i) => (
              <li key={g.id} className="flex items-start gap-3">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-[1.5px] border-[var(--border-strong)] text-[13px] font-bold text-muted">
                  {i + 1}
                </span>
                <span className="min-w-0">
                  <span className="block font-bold">{g.name}</span>
                  <span className="block text-sm text-muted">{g.desc}</span>
                </span>
              </li>
            ))}
          </ol>
          <div className="mt-6 grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2.5 border-t pt-5">
            <span className="col-span-2 font-bold">Every check shows who does the work</span>
            <span className="inline-flex items-center gap-1.5 justify-self-start rounded-full bg-surface-3 py-0.5 pl-2 pr-2.5 text-xs font-bold text-text-2">
              <Icon name="auto" size={14} /> Automatic
            </span>
            <span className="text-sm text-muted">We verify it from your build and data.</span>
            <span className="inline-flex items-center gap-1.5 justify-self-start rounded-full bg-brand-soft py-0.5 pl-2 pr-2.5 text-xs font-bold text-brand-text">
              <Icon name="phone" size={14} /> On your phone
            </span>
            <span className="text-sm text-muted">You do something first, then we verify it.</span>
          </div>
        </aside>
      </div>

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
    ...(where === "url" ? ["Checking the website"] : where === "browser" ? ["Checking the build"] : ["Uploading the build", "Analysing on the server"]),
    ...(withApi ? ["Verifying with the CleverTap API"] : []),
    "Building report",
  ];
}

/* ---------------- sub components ---------------- */

function StepBlock({
  n,
  state,
  title,
  hint,
  done,
  onChange,
  children,
}: {
  n: number;
  state: "done" | "current" | "upcoming";
  title: string;
  hint?: string;
  done?: string;
  onChange?: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className={cx(n > 1 && "border-t")}>
      <div className="flex items-center gap-4 px-6 py-5">
        {state === "done" ? (
          <StatusMark status="pass" size={32} />
        ) : (
          <span
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full font-bold"
            style={
              state === "current"
                ? { background: "var(--brand)", color: "var(--brand-fg)" }
                : { border: "1.5px solid var(--border-strong)", color: "var(--muted-2)" }
            }
          >
            {n}
          </span>
        )}
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h2 className={cx("text-lg font-bold", state === "upcoming" && "text-text-2")}>{title}</h2>
          {state === "done" && done && <span className="truncate text-sm text-muted">{done}</span>}
          {state === "upcoming" && hint && <span className="text-sm text-muted">{hint}</span>}
        </div>
        {state === "done" && onChange && (
          <button type="button" onClick={onChange} className="link min-h-11 px-2.5 text-[15px]">
            Change
          </button>
        )}
      </div>
      {state === "current" && <div className="animate-fade-in px-6 pb-7 sm:pl-[72px]">{children}</div>}
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
  foot,
}: {
  selected: boolean;
  disabled?: boolean;
  onClick: () => void;
  icon: IconName;
  title: string;
  desc: string;
  foot: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={selected}
      className={cx(
        "relative flex min-h-[176px] flex-col items-start gap-2 rounded-xl border-2 p-4.5 text-left transition-colors",
        disabled && "cursor-not-allowed opacity-55",
        selected ? "border-brand bg-brand-soft" : "border-[var(--border)] bg-surface",
        !selected && !disabled && "hover:border-[var(--border-strong)]",
      )}
    >
      <span className="flex h-10 w-10 items-center justify-center rounded-[10px] bg-surface-3 text-text">
        <Icon name={icon} size={22} />
      </span>
      <span className="text-base font-bold">{title}</span>
      <span className="text-sm text-muted">{desc}</span>
      <span className="mt-auto text-[13px] text-muted-2">{foot}</span>
      {selected && (
        <span className="absolute right-3.5 top-3.5">
          <StatusMark status="pass" size={22} />
        </span>
      )}
    </button>
  );
}

function Field({ label, htmlFor, hint, children }: { label: string; htmlFor?: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label htmlFor={htmlFor} className="mb-1.5 block text-sm font-bold">
        {label}
      </label>
      {children}
      {hint && <span className="mt-1.5 block text-[13px] text-muted">{hint}</span>}
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
        "flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-4 py-10 text-center transition-colors hover:bg-surface-2",
        file || drag ? "border-brand bg-brand-soft" : "border-[var(--border-strong)]",
      )}
    >
      <input type="file" accept={accept} className="sr-only" onChange={(e) => onFile(e.target.files?.[0] ?? null)} />
      {file ? <StatusMark status="pass" size={36} /> : <Icon name="upload" size={28} className="text-muted" />}
      <div className="mt-3 text-base font-bold">{file ? file.name : "Drop your build here, or click to choose"}</div>
      <div className="mt-1 text-sm text-muted">{file ? `${formatBytes(file.size)} · click to choose another` : hint}</div>
    </label>
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
      <Card className="w-full max-w-md p-7 shadow-[var(--shadow-lg)]">
        <h3 className="text-xl font-bold">{run.error ? "Something went wrong" : "Setting up your audit"}</h3>
        <p className="mt-1 text-sm text-muted">{run.error ? "Nothing is lost — you can try again." : "This takes about a minute. Keep this tab open."}</p>
        <ol className="mt-5 space-y-3.5">
          {steps.map((s, i) => {
            const done = i < run.step;
            const active = i === run.step;
            return (
              <li key={s} className="flex items-start gap-3">
                {done ? (
                  <StatusMark status="pass" size={24} />
                ) : active && run.error ? (
                  <StatusMark status="fail" size={24} />
                ) : active ? (
                  <StatusMark status="busy" size={24} />
                ) : (
                  <StatusMark status="todo" size={24} />
                )}
                <span className={cx("min-w-0 flex-1 pt-0.5 text-[15px]", active ? "font-bold text-text" : "text-muted")}>
                  {s}
                  {active && !run.error && (run.label !== s || run.pct !== undefined) && (
                    <span className="mt-0.5 block text-sm font-normal text-muted">
                      {run.label !== s ? run.label : ""}
                      {run.pct !== undefined && ` · ${run.pct}%`}
                    </span>
                  )}
                  {active && run.pct !== undefined && !run.error && (
                    <span className="mt-2 block h-1.5 overflow-hidden rounded-full bg-surface-3">
                      <span className="block h-full bg-brand transition-all" style={{ width: `${run.pct}%` }} />
                    </span>
                  )}
                </span>
              </li>
            );
          })}
        </ol>
        {run.error && (
          <>
            <p className="mt-5 rounded-xl border px-4 py-3 text-sm" style={{ background: "var(--fail-soft)", borderColor: "var(--fail-border)" }}>
              {run.error}
            </p>
            <div className="mt-5 flex justify-end gap-2">
              {onOpen && (
                <Button variant="secondary" onClick={onOpen}>
                  Open what we have
                </Button>
              )}
              <Button onClick={onClose}>Close</Button>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}

function WebTarget(p: {
  siteUrl: string;
  setSiteUrl: (v: string) => void;
  loginUrl: string;
  setLoginUrl: (v: string) => void;
  loginUser: string;
  setLoginUser: (v: string) => void;
  loginPass: string;
  setLoginPass: (v: string) => void;
  showPass: boolean;
  setShowPass: (fn: (v: boolean) => boolean) => void;
  events: string;
  setEvents: (v: string) => void;
  canStart: boolean;
  consent: React.ReactNode;
  busy: boolean;
  onStart: () => void;
}) {
  return (
    <div className="space-y-6">
      <Field label="Website address" htmlFor="site" hint="The public or staging URL where CleverTap is installed.">
        <input
          id="site"
          type="url"
          inputMode="url"
          value={p.siteUrl}
          onChange={(e) => p.setSiteUrl(e.target.value)}
          placeholder="For example https://www.yourstore.com"
          className="input font-mono"
        />
      </Field>

      <div className="rounded-xl border px-4 py-4">
        <div className="flex items-center gap-2 text-[15px] font-bold">
          <Icon name="user" size={17} className="text-brand" /> Test login for your website (recommended)
        </div>
        <p className="mt-1 text-sm text-text-2">
          We sign in once with a test account to check onUserLogin, identity, phone format and returning users. Leave empty to only check what a logged-out
          visitor sends.
        </p>
        <div className="mt-4 space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Email or username" htmlFor="wl-user">
              <input
                id="wl-user"
                autoComplete="off"
                data-1p-ignore
                data-lpignore="true"
                value={p.loginUser}
                onChange={(e) => p.setLoginUser(e.target.value)}
                placeholder="test.user@yourstore.com"
                className="input"
              />
            </Field>
            <Field label="Password" htmlFor="wl-pass">
              <div className="relative">
                <input
                  id="wl-pass"
                  type={p.showPass ? "text" : "password"}
                  autoComplete="new-password"
                  data-1p-ignore
                  data-lpignore="true"
                  value={p.loginPass}
                  onChange={(e) => p.setLoginPass(e.target.value)}
                  placeholder="Test account password"
                  className="input pr-12"
                />
                <button
                  type="button"
                  onClick={() => p.setShowPass((v) => !v)}
                  className="absolute right-1.5 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-lg text-muted hover:bg-surface-3 hover:text-text"
                  aria-label={p.showPass ? "Hide password" : "Show password"}
                >
                  <Icon name={p.showPass ? "eyeOff" : "eye"} size={18} />
                </button>
              </div>
            </Field>
          </div>
          <Field label="Login page (optional)" htmlFor="wl-url" hint="Only if we can't find the login form from the home page, e.g. /login or /account/sign-in.">
            <input id="wl-url" value={p.loginUrl} onChange={(e) => p.setLoginUrl(e.target.value)} placeholder="/login" className="input font-mono" />
          </Field>
        </div>
        <p className="mt-3 flex items-start gap-2 text-[13px] text-muted">
          <Icon name="lock" size={14} className="mt-0.5 shrink-0" style={{ color: "var(--pass)" }} />
          Use a test account, not a real customer&apos;s. The password is used once for this check and never stored. Logins with OTP or captcha can&apos;t be
          automated — leave it empty and use Website tests afterwards.
        </p>
      </div>

      <div className="rounded-xl border px-4 py-3.5" style={{ background: "var(--brand-soft)" }}>
        <div className="flex items-center gap-2 text-[15px] font-bold">
          <Icon name="info" size={17} className="text-brand" /> Nothing to change on your site
        </div>
        <p className="mt-1 text-sm text-text-2">
          We open it in a private browser with CleverTap&apos;s debug logs switched on (the same as typing{" "}
          <code className="font-mono text-[13px]">sessionStorage[&apos;WZRK_D&apos;]=&apos;&apos;</code> in the console), visit with test UTM tags, and read every
          request the SDK sends. We only follow links — we never click buy, delete or log-out buttons.
        </p>
      </div>

      <Field label="Your custom events (optional)" htmlFor="events" hint="The 3–4 custom events that matter most, spelled exactly as in your code. You can change them later.">
        <input id="events" value={p.events} onChange={(e) => p.setEvents(e.target.value)} placeholder="For example Product Viewed, Added To Cart, Charged" className="input" />
      </Field>

      {p.consent}

      <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
        <Button size="lg" icon="zap" onClick={p.onStart} disabled={!p.canStart}>
          {p.busy ? "Starting…" : "Start audit"}
        </Button>
        <span className="text-sm text-muted">Takes 1–2 minutes. Your progress is saved as you go.</span>
      </div>
    </div>
  );
}
