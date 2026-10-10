"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, refreshAudit } from "@/lib/store";
import { rememberIdentity, rememberPasscode, useSecrets } from "@/lib/session-secrets";
import {
  STALLED,
  connectWebUsb,
  helperConnect,
  helperDriver,
  helperPair,
  helperHello,
  HELPER_MIN_VERSION,
  helperStatus,
  webUsbSupported,
  type DeviceDriver,
  type HelperDevice,
} from "@/lib/device/drivers";
import { runDeepLinkTests, runDeviceChecks, runPushTest } from "@/lib/device/runner";
import type { AppState, DeviceFindings, PushTestResult } from "@/lib/device/types";
import type { Audit } from "@/lib/types";
import type { TestPushRecord, TestUserRecord } from "@/lib/clevertap/types";
import { Card, Button, Notice, StatusMark } from "@/components/ui";
import { LogSession, type LogSessionSave } from "./LogSession";
import { mergeInsights } from "@/lib/device/ctlog";
import { Icon } from "@/components/Icon";
import { cx, formatDate } from "@/lib/format";

const STATES: { id: AppState; label: string; tech: string; auto: string; manual: string }[] = [
  {
    id: "foreground",
    label: "App open",
    tech: "Foreground",
    auto: "We open the app and send a push. Watch it appear.",
    manual: "Open the app and keep it on screen, then press Test.",
  },
  {
    id: "background",
    label: "In the background",
    tech: "Background",
    auto: "We open the app, press Home, then send a push.",
    manual: "Open the app, press Home, then press Test.",
  },
  {
    id: "killed",
    label: "App closed",
    tech: "Killed",
    auto: "We close the app (like swiping it away), then send a push.",
    manual: "Swipe the app away from recent apps, then press Test.",
  },
];

type Mode = "usb" | "helper";

// The audit page shows one part of the lab at a time. The component itself
// always stays mounted so a connected phone and a running log session survive
// switching between stages.
export type DeviceView = "setup" | "push" | "guided";

export function DeviceLab({
  audit,
  view,
  onNavigate,
}: {
  audit: Audit;
  view: DeviceView | null;
  onNavigate?: (v: DeviceView) => void;
}) {
  const scan = audit.scan;
  const pkg = scan?.app.packageName;
  const { passcode, identity } = useSecrets(audit.id);
  const [identityInput, setIdentityInput] = useState(identity);
  const [mode, setMode] = useState<Mode>(() => (typeof window !== "undefined" && webUsbSupported() ? "usb" : "helper"));
  const [driver, setDriver] = useState<DeviceDriver | null>(null);
  const [busy, setBusy] = useState("");
  const [step, setStep] = useState("");
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [findings, setFindings] = useState<DeviceFindings | null>(audit.device ?? null);

  // Channels that really exist on the phone (minus Firebase's fallback) beat
  // anything guessed from the build.
  const phoneChannels = (findings?.channels ?? []).map((c) => c.id).filter((c) => c !== "fcm_fallback_notification_channel");
  const channelId =
    scan?.channelIds[0] ?? scan?.manifest.metaData.CLEVERTAP_DEFAULT_CHANNEL_ID ?? phoneChannels[0] ?? scan?.apis.androidChannel.strings[0] ?? "";
  const [typedChannel, setChannel] = useState<string | null>(null);
  const channel = typedChannel ?? channelId; // follow the detected channel until the user types
  const channelMissing = !!channel && phoneChannels.length > 0 && !(findings?.channels ?? []).some((c) => c.id === channel);
  const deepLinks = useMemo(
    () =>
      (scan?.manifest.deepLinks ?? [])
        .filter((d) => !/^(com\.google|com\.facebook|com\.clevertap|androidx)/.test(d.activity) && !/^https?$/.test(d.scheme))
        .map((d) => `${d.scheme}://${d.host ?? ""}${d.path ?? ""}`)
        .slice(0, 5),
    [scan],
  );

  useEffect(() => () => void driver?.close(), [driver]);


  const id = identityInput.trim();
  const needCreds = !passcode ? "Enter your CleverTap passcode under “Connect your phone” first." : !id ? "Enter the test user’s identity under “Connect your phone” first." : "";
  const tu = audit.api?.testUser;

  async function guard(name: string, fn: () => Promise<void>) {
    setBusy(name);
    setMsg(null);
    try {
      await fn();
    } catch (e) {
      const text = (e as Error).message;
      if (text.startsWith(STALLED)) {
        void driver?.close().catch(() => {});
        setDriver(null);
      }
      setMsg({ tone: "err", text });
    } finally {
      setBusy("");
      setStep("");
      refreshAudit(audit.id);
    }
  }

  async function saveFindings(next: DeviceFindings) {
    setFindings(next);
    findingsRef.current = next;
    await api(`/api/audits/${audit.id}/device`, { method: "POST", body: JSON.stringify(next) });
  }

  // Log-session results are merged into the latest findings (device checks run first if needed).
  const findingsRef = useRef(findings);
  const saveLogs = useCallback(
    async (l: LogSessionSave) => {
      if (!driver || !pkg) return;
      const base: DeviceFindings =
        findingsRef.current ?? { ...(await runDeviceChecks(driver, { pkg, deepLinks: [] }, () => {})), pushTests: {}, deepLinks: [] };
      // keep what earlier sessions proved — a new session must never lower the score
      const next = { ...base, ...l, logs: mergeInsights(base.logs, l.logs), logScenarios: { ...base.logScenarios, ...l.logScenarios } };
      findingsRef.current = next;
      setFindings(next);
      await api(`/api/audits/${audit.id}/device`, { method: "POST", body: JSON.stringify(next) });
      refreshAudit(audit.id);
    },
    [driver, pkg, audit.id],
  );
  const sendLinkPush = useCallback(
    async (deepLink: string, marker: string) => {
      rememberIdentity(audit.id, id);
      const r = await api<{ testPush: TestPushRecord }>(`/api/audits/${audit.id}/test-push`, {
        method: "POST",
        body: JSON.stringify({ passcode, identity: id, channelId: channel || undefined, deepLink, marker }),
      });
      if (r.testPush.status === "failed") throw new Error(r.testPush.message ?? "CleverTap rejected the push.");
    },
    [audit.id, id, passcode, channel],
  );

  /* ---- actions ---- */

  const checkTestUser = () =>
    guard("user", async () => {
      rememberIdentity(audit.id, id);
      const r = await api<{ testUser: TestUserRecord }>(`/api/audits/${audit.id}/test-user`, {
        method: "POST",
        body: JSON.stringify({ passcode, identity: id }),
      });
      setMsg(
        r.testUser.found
          ? { tone: "ok", text: r.testUser.android ? "Found the test user and their Android device." : "Found the user, but no Android device on the profile yet." }
          : { tone: "err", text: "No CleverTap profile with that identity. Log in on the phone with it, then retry." },
      );
    });

  const connect = () =>
    guard("connect", async () => {
      const d = await connectWebUsb();
      setDriver(d);
      setMsg({ tone: "ok", text: `Connected to ${d.label} over USB.` });
    });

  const deviceChecks = () =>
    guard("checks", async () => {
      if (!driver || !pkg) return;
      const base = await runDeviceChecks(
        driver,
        { pkg, scanVersionName: scan?.app.versionName, targetSdk: scan?.app.targetSdk, deepLinks },
        setStep,
      );
      const deep = deepLinks.length ? (setStep("Opening deep links"), await runDeepLinkTests(driver, pkg, deepLinks)) : [];
      // keep what earlier tests and log sessions proved — re-reading the phone must never lower the score
      const prev = findingsRef.current ?? findings;
      await saveFindings({
        ...base,
        pushTests: prev?.pushTests ?? {},
        deepLinks: deep.length ? deep : prev?.deepLinks ?? [],
        logs: prev?.logs,
        logScenarios: prev?.logScenarios,
        logTagWasRestricted: prev?.logTagWasRestricted,
      });
      setMsg(
        base.app.installed
          ? { tone: "ok", text: "Device checks saved." }
          : { tone: "err", text: `${pkg} isn't installed on this phone.` },
      );
    });

  // As soon as a phone is connected, read it — no extra click needed.
  const autoChecked = useRef<string | null>(null);
  useEffect(() => {
    if (!driver || !pkg || autoChecked.current === driver.serial) return;
    autoChecked.current = driver.serial;
    const t = setTimeout(() => void deviceChecks(), 300);
    return () => clearTimeout(t);
  }, [driver, pkg]); // eslint-disable-line react-hooks/exhaustive-deps

  const pushTest = (state: AppState) =>
    guard(state, async () => {
      rememberIdentity(audit.id, id);
      const send = (marker?: string) =>
        api<{ testPush: TestPushRecord }>(`/api/audits/${audit.id}/test-push`, {
          method: "POST",
          body: JSON.stringify({ passcode, identity: id, channelId: channel || undefined, appState: state, marker }),
        }).then((r) => {
          if (r.testPush.status === "failed") throw new Error(r.testPush.message ?? "CleverTap rejected the push.");
        });

      if (!driver || !pkg) throw new Error("Connect the phone first, under “Connect your phone”.");
      {
        const result = await runPushTest(driver, pkg, state, send, setStep);
        const base: DeviceFindings =
          findingsRef.current ?? findings ?? { ...(await runDeviceChecks(driver, { pkg, deepLinks: [] }, setStep)), pushTests: {}, deepLinks: [] };
        // a delivered result is kept if a later re-test fails for a phone-side reason only
        const prevOk = base.pushTests[state]?.status === "delivered";
        const keep = prevOk && result.status !== "delivered" && (result.status === "error" || !result.verifiedState);
        await saveFindings({ ...base, pushTests: { ...base.pushTests, [state]: keep ? base.pushTests[state]! : result } });
        setMsg(
          result.status === "delivered"
            ? { tone: "ok", text: `Delivered in ${Math.round((result.deliveredAfterMs ?? 0) / 1000)} s with the app ${state}.` }
            : { tone: "err", text: result.detail ?? "Not delivered." },
        );
      }
    });

  /* ---- what to do next ---- */

  const pushDone = (st: AppState) =>
    findings?.pushTests[st]?.status === "delivered" || audit.api?.pushTests?.[st]?.status === "confirmed";
  const nextState = STATES.find((x) => !pushDone(x.id));
  const next: { text: string; view?: DeviceView } = !pkg
    ? { text: "Scan the build first — the report needs the app's package name." }
    : !passcode
      ? { text: "Enter your CleverTap passcode.", view: "setup" }
      : !id
        ? { text: "Enter the identity (or email) the phone is logged in with.", view: "setup" }
        : !tu
          ? { text: "Press “Check test user”.", view: "setup" }
          : !driver
            ? mode === "usb"
              ? { text: "Plug the phone in with a USB cable and press “Connect phone”.", view: "setup" }
              : { text: "Start the helper on this computer (command below). The page connects by itself.", view: "setup" }
            : nextState
              ? { text: `Press “Test” on ${nextState.label}. ${nextState.auto} Watch your phone.`, view: "push" }
              : { text: "Follow the guided checks: restart, log in, use the app, tap a push.", view: "guided" };
  const VIEW_NAME: Record<DeviceView, string> = { setup: "Connect your phone", push: "Push tests", guided: "Guided checks" };

  /* ---- render ---- */

  return (
    <div hidden={!view} className="scroll-mt-24" id="live-device">
      <div className="space-y-5">
        {/* what to do next — the same hint on every device stage */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3 rounded-xl px-4 py-3.5" style={{ background: "var(--brand-soft)" }}>
          <span className="pulse-dot h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: "var(--brand)" }} />
          <span className="min-w-0 flex-1 text-[15px]">
            <b>Next:</b> {next.text}
          </span>
          {next.view && view && next.view !== view && onNavigate && (
            <Button size="sm" variant="outline" iconRight="arrowRight" onClick={() => onNavigate(next.view!)}>
              Go to {VIEW_NAME[next.view]}
            </Button>
          )}
        </div>

        {msg && (
          <Notice tone={msg.tone === "ok" ? "ok" : "fail"} icon={msg.tone === "ok" ? "check" : "info"}>
            {msg.text}
          </Notice>
        )}

        {/* ---------- setup: test user + connection ---------- */}
        <div hidden={view !== "setup"}>
          <div className="space-y-5">
            <Card className="p-6">
              <details className="group">
                <summary className="flex cursor-pointer list-none items-center gap-3 text-[15px] font-bold">
                  <Icon name="info" size={18} className="text-brand" />
                  Before you start (takes about 2 minutes)
                  <Icon name="chevronDown" size={18} className="ml-auto text-muted transition group-open:rotate-180" />
                </summary>
                <ol className="mt-4 list-decimal space-y-2 pl-6 text-[15px] text-text-2">
                  <li>Install a test build of the same app version (with CleverTap debug mode on — your developer can switch it on) and log in with a test user.</li>
                  <li>On the phone: Settings → About → tap “Build number” 7 times, then Developer options → turn on USB debugging.</li>
                  <li>Use Chrome or Edge on a computer. Close Android Studio (it holds on to the phone).</li>
                  <li>Keep the phone unlocked with the screen on while tests run.</li>
                </ol>
              </details>
            </Card>

            <Section n={1} title="Your test user" sub="We look up this user in CleverTap to find the phone.">
              <div className="grid gap-4 sm:grid-cols-[minmax(0,240px)_minmax(0,1fr)]">
                <Field label="CleverTap passcode" hint="Kept in this browser tab only.">
                  <input
                    type="password"
                    autoComplete="new-password"
                    data-1p-ignore
                    data-lpignore="true"
                    value={passcode}
                    onChange={(e) => rememberPasscode(audit.id, e.target.value)}
                    className="input font-mono"
                    placeholder="Paste your passcode"
                  />
                </Field>
                <Field label="Identity or email the phone is logged in with">
                  <input
                    value={identityInput}
                    onChange={(e) => setIdentityInput(e.target.value)}
                    onBlur={() => rememberIdentity(audit.id, identityInput.trim())}
                    className="input font-mono"
                    placeholder="For example test_user_01"
                  />
                </Field>
              </div>
              <div className="mt-4">
                <Button variant="secondary" icon="search" disabled={!!needCreds || !!busy} onClick={checkTestUser}>
                  {busy === "user" ? "Checking…" : "Check test user"}
                </Button>
              </div>
              {tu && <TestUserCard tu={tu} scanVersion={scan?.app.versionName} />}
            </Section>

            <Section n={2} title="Connect the phone" sub="We open, background and close the app on the phone for you.">
              <div className="mb-5 inline-flex flex-wrap rounded-xl border bg-surface-2 p-1" role="tablist" aria-label="Connection type">
                {(
                  [
                    ["usb", "USB cable"],
                    ["helper", "Wi-Fi or USB, with the helper"],
                  ] as [Mode, string][]
                ).map(([m, label]) => (
                  <button
                    key={m}
                    role="tab"
                    aria-selected={mode === m}
                    onClick={() => setMode(m)}
                    className={cx(
                      "min-h-10 rounded-lg px-4 text-sm font-bold transition",
                      mode === m ? "bg-surface text-text shadow-[var(--shadow-md)]" : "text-muted hover:text-text",
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {mode === "usb" && <UsbConnect supported={typeof window !== "undefined" && webUsbSupported()} busy={busy === "connect"} onConnect={connect} />}
              {mode === "helper" && <HelperConnect onDriver={setDriver} onError={(t) => setMsg({ tone: "err", text: t })} />}
              <p className="mt-4 text-sm text-muted">
                Both work the same way. USB needs Chrome or Edge. Wi-Fi needs the small helper, because browsers can&apos;t reach a phone over the network.
              </p>
              {driver && (
                <div className="mt-5 flex flex-wrap items-center gap-3 rounded-xl border bg-surface-2 px-4 py-3">
                  <StatusMark status="pass" size={24} />
                  <span className="text-[15px] font-bold">
                    {driver.label} connected · {driver.transport === "wifi" ? "Wi-Fi" : "USB"}
                  </span>
                  {onNavigate && (
                    <Button size="sm" className="ml-auto" iconRight="arrowRight" onClick={() => onNavigate("push")}>
                      Continue to Push tests
                    </Button>
                  )}
                </div>
              )}
            </Section>

            {findings && <DeviceSummary f={findings} />}
          </div>
        </div>

        {/* ---------- push tests ---------- */}
        <div hidden={view !== "push"}>
          <div className="space-y-5">
            <Card className="p-6">
              {!pkg && <p className="mb-4 text-sm text-muted">Scan the build first — the package name comes from the scan.</p>}
              <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
                <Field label="Notification channel for the test push">
                  <input value={channel} onChange={(e) => setChannel(e.target.value)} className="input font-mono" placeholder="channel id" />
                </Field>
                {driver && (
                  <Button variant="secondary" icon="search" disabled={!!busy || !pkg} onClick={deviceChecks}>
                    {busy === "checks" ? "Checking…" : "Read the phone again"}
                  </Button>
                )}
              </div>
              {channelMissing && (
                <p className="mt-2 text-sm" style={{ color: "var(--warn)" }}>
                  “{channel}” doesn&apos;t exist on the phone, so the push would be dropped.{" "}
                  <button type="button" className="link" onClick={() => setChannel(phoneChannels[0])}>
                    Use {phoneChannels[0]}
                  </button>
                </p>
              )}
            </Card>

            <Card className="overflow-hidden">
              {STATES.map((s, i) => (
                <StateRow
                  key={s.id}
                  first={i === 0}
                  label={s.label}
                  tech={s.tech}
                  how={s.auto}
                  device={findings?.pushTests[s.id]}
                  apiRecord={audit.api?.pushTests?.[s.id]}
                  busy={busy === s.id}
                  disabled={!!busy || !!needCreds || !pkg || !driver}
                  onRun={() => pushTest(s.id)}
                />
              ))}
            </Card>
            {(needCreds || !driver) && (
              <p className="text-sm text-muted">{needCreds || "Connect the phone first, under “Connect your phone”, to run these tests."}</p>
            )}
            {step && (
              <p role="status" className="flex items-center gap-2.5 text-[15px] font-semibold text-text-2">
                <span className="pulse-dot h-2.5 w-2.5 rounded-full" style={{ background: "var(--brand)" }} /> {step}
              </p>
            )}
            <p className="text-sm text-muted">
              Each test takes about 15–30 seconds: the app opens on the phone, goes to the background or closes, then the push appears. We wait up to
              60 seconds for it.
            </p>
          </div>
        </div>

        {/* ---------- guided log checks ---------- */}
        <div hidden={view !== "guided"}>
          {driver && pkg ? (
            <LogSession
              driver={driver}
              pkg={pkg}
              initial={
                findings
                  ? { logs: findings.logs, logScenarios: findings.logScenarios, logTagWasRestricted: findings.logTagWasRestricted, logging: findings.logging }
                  : undefined
              }
              autoStart
              accountId={audit.accountId ?? scan?.manifest.metaData.CLEVERTAP_ACCOUNT_ID}
              canSendPush={needCreds}
              sendPush={sendLinkPush}
              onSave={saveLogs}
            />
          ) : (
            <Card className="p-6">
              <p className="text-[15px] text-text-2">
                Connect your phone first. Then do each action shown here — log in, restart, your key actions, a push with a link and an in-app.
              </p>
              {onNavigate && (
                <div className="mt-4">
                  <Button iconRight="arrowRight" onClick={() => onNavigate("setup")}>
                    Connect your phone
                  </Button>
                </div>
              )}
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---------------- pieces ---------------- */

function Section({ n, title, sub, children }: { n: number; title: string; sub?: string; children: React.ReactNode }) {
  return (
    <Card className="p-6">
      <div className="mb-5 flex items-start gap-4">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand text-sm font-bold text-brand-fg">{n}</span>
        <div className="min-w-0">
          <h3 className="text-lg font-bold">{title}</h3>
          {sub && <p className="mt-0.5 text-sm text-muted">{sub}</p>}
        </div>
      </div>
      <div className="sm:pl-12">{children}</div>
    </Card>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-bold">{label}</span>
      {children}
      {hint && <span className="mt-1.5 block text-[13px] text-muted">{hint}</span>}
    </label>
  );
}

function TestUserCard({ tu, scanVersion }: { tu: TestUserRecord; scanVersion?: string }) {
  if (!tu.found)
    return (
      <Notice tone="fail" className="mt-4">
        No profile found for <b>{tu.identity}</b>. Log in on the phone with this user, then check again.
      </Notice>
    );
  const a = tu.android;
  const rows: [string, string, boolean | undefined][] = [
    ["Android device", a ? `${a.model ?? "Unknown model"} · Android ${a.osVersion ?? "?"}` : "None on this profile", !!a],
    ["App version", a?.appVersion ? `${a.appVersion}${scanVersion && a.appVersion !== scanVersion ? ` (scanned build is ${scanVersion})` : ""}` : "—", a?.appVersion ? !scanVersion || a.appVersion === scanVersion : undefined],
    ["Push token", a ? (a.hasPushToken ? "Registered" : "Missing") : "—", a?.hasPushToken],
    ["Last App Launched", tu.lastLaunchedAt ? formatDate(tu.lastLaunchedAt) : "Never", !!tu.lastLaunchedAt],
    ["Email / phone", `${tu.hasEmail ? "email ✓" : "no email"} · ${tu.hasPhone ? (tu.phoneValid ? "phone ✓" : "phone format ✗") : "no phone"}`, tu.hasEmail || tu.hasPhone],
  ];
  return (
    <ul className="mt-5 divide-y rounded-xl border">
      {rows.map(([k, v, ok]) => (
        <li key={k} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-3">
          <span className="text-sm text-muted">{k}</span>
          <span className="flex items-center gap-2 text-right text-[15px] font-semibold">
            {ok !== undefined && <StatusMark status={ok ? "pass" : "warn"} size={20} />}
            {v}
          </span>
        </li>
      ))}
    </ul>
  );
}

function UsbConnect({ supported, busy, onConnect }: { supported: boolean; busy: boolean; onConnect: () => void }) {
  if (!supported)
    return (
      <Notice tone="warn">
        This browser can&apos;t talk to USB devices. Open this page in <b>Chrome or Edge on a computer</b>, or use the helper.
      </Notice>
    );
  return (
    <div className="space-y-4">
      <ol className="list-decimal space-y-2 pl-6 text-[15px] text-text-2">
        <li>On the phone: Settings → About → tap “Build number” 7 times, then Developer options → turn on USB debugging.</li>
        <li>
          Plug the phone in with a data cable. Close Android Studio or scrcpy, and run <code className="font-mono text-sm">adb kill-server</code> if adb is
          installed.
        </li>
        <li>Press Connect phone, pick the phone, then tap “Allow” on the phone.</li>
      </ol>
      <Button icon="link" disabled={busy} onClick={onConnect}>
        {busy ? "Connecting…" : "Connect phone"}
      </Button>
    </div>
  );
}

function HelperConnect({ onDriver, onError }: { onDriver: (d: DeviceDriver) => void; onError: (t: string) => void }) {
  const [token, setToken] = useState("");
  const [devices, setDevices] = useState<HelperDevice[] | null>(null);
  const [ip, setIp] = useState("");
  const [pairPort, setPairPort] = useState("");
  const [code, setCode] = useState("");
  const [connPort, setConnPort] = useState("");
  const [busy, setBusy] = useState(false);
  const [os, setOs] = useState<"win" | "mac">(() =>
    typeof navigator !== "undefined" && /Mac|Linux/i.test(navigator.platform) ? "mac" : "win",
  );
  const used = useRef(false);
  const [outdated, setOutdated] = useState(false);
  const [copied, setCopied] = useState(false);
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const cmd =
    os === "win"
      ? `irm ${origin}/ct-device-bridge.mjs -OutFile ct-device-bridge.mjs; node ct-device-bridge.mjs --origin ${origin}`
      : `curl -fsSL -o ct-device-bridge.mjs ${origin}/ct-device-bridge.mjs && node ct-device-bridge.mjs --origin ${origin}`;

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // Find the helper by itself, then keep the device list fresh. A single ready
  // phone is used straight away — nothing to click.
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      let t = token;
      if (!t) {
        const h = await helperHello();
        if (!alive || !h) return;
        setOutdated(h.version < HELPER_MIN_VERSION);
        if (h.version < HELPER_MIN_VERSION) return; // old helper lacks commands — ask for the new one
        t = h.token;
        setToken(t);
      }
      try {
        const list = (await helperStatus(t)).devices;
        if (!alive) return;
        setDevices(list);
        const ready = list.filter((d) => d.state === "device");
        if (ready.length === 1 && !used.current) {
          used.current = true;
          onDriver(helperDriver(t, ready[0]));
        }
      } catch {
        if (alive) setToken(""); // helper restarted → new token
      }
    };
    void tick();
    const iv = setInterval(tick, 2500);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, [token, onDriver]);

  const pair = () =>
    run(async () => {
      const r = await helperPair(token, ip.trim(), Number(pairPort), code.trim());
      if (!r.connected) onError("Paired. Now type the port shown on the main Wireless debugging screen and press Connect.");
      setDevices((await helperStatus(token)).devices);
    });
  const connectWifi = () =>
    run(async () => {
      await helperConnect(token, ip.trim(), Number(connPort));
      setDevices((await helperStatus(token)).devices);
    });

  return (
    <div className="space-y-4">
      {outdated && (
        <Notice tone="warn" title="Your helper is out of date">
          Stop it (Ctrl+C in its terminal) and run the command below again — it downloads the new version.
        </Notice>
      )}
      <div className="rounded-xl border p-4">
        {token ? (
          <span className="flex items-center gap-2.5 text-[15px] font-bold" style={{ color: "var(--pass)" }}>
            <StatusMark status="pass" size={22} /> The helper is running
          </span>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span className="text-[15px] font-bold">Paste this into {os === "win" ? "PowerShell" : "Terminal"}</span>
              <span className="inline-flex rounded-lg border bg-surface-2 p-0.5">
                {(["win", "mac"] as const).map((o) => (
                  <button
                    key={o}
                    onClick={() => setOs(o)}
                    className={cx("min-h-9 rounded-md px-3 text-sm font-bold", os === o ? "bg-surface text-text shadow-[var(--shadow-md)]" : "text-muted")}
                  >
                    {o === "win" ? "Windows" : "Mac / Linux"}
                  </button>
                ))}
              </span>
            </div>
            <p className="mt-1 text-sm text-muted">It needs Node.js and Android platform-tools on this computer.</p>
            <div className="mt-3 flex flex-wrap items-start gap-2">
              <code className="block min-w-0 flex-1 break-all rounded-lg bg-surface-3 px-3 py-2.5 font-mono text-[13px] leading-relaxed">{cmd}</code>
              <Button
                size="sm"
                variant="secondary"
                icon={copied ? "check" : "copy"}
                onClick={() => {
                  void navigator.clipboard?.writeText(cmd);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                }}
              >
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
            <p className="mt-3 text-sm text-muted">
              It downloads the helper into the folder you&apos;re in and starts it. This page finds it by itself — keep the terminal open. Already
              downloaded? Run it from that folder: <code className="font-mono text-[13px]">node ct-device-bridge.mjs --origin {origin}</code>
            </p>
          </>
        )}
      </div>

      {token && (
        <details className="group rounded-xl border p-4" open={!devices?.some((d) => d.transport === "wifi")}>
          <summary className="flex cursor-pointer list-none items-center gap-2 text-[15px] font-bold">
            Connect over Wi-Fi (Android 11+)
            <span className="font-normal text-muted">— skip this if the phone is on a USB cable</span>
            <Icon name="chevronDown" size={18} className="ml-auto shrink-0 text-muted transition group-open:rotate-180" />
          </summary>
          <ol className="mt-3 list-decimal space-y-1.5 pl-6 text-[15px] text-text-2">
            <li>Put the phone and computer on the same Wi-Fi.</li>
            <li>On the phone: Developer options → Wireless debugging ON → “Pair device with pairing code”.</li>
            <li>
              Type the <b>IP address and port</b> and the <b>6-digit code</b> from that pop-up, then press Pair. We connect right after.
            </li>
          </ol>
          <div className="mt-4 grid gap-3 sm:grid-cols-[1.4fr_1fr_1fr_auto]">
            <input value={ip} onChange={(e) => setIp(e.target.value)} className="input font-mono" placeholder="IP, e.g. 192.168.0.103" aria-label="Phone IP address" />
            <input value={pairPort} onChange={(e) => setPairPort(e.target.value)} className="input font-mono" placeholder="Port in the pop-up" aria-label="Pairing port" />
            <input value={code} onChange={(e) => setCode(e.target.value)} className="input font-mono" placeholder="6-digit code" aria-label="Pairing code" />
            <Button variant="secondary" disabled={!ip || !pairPort || code.trim().length !== 6 || busy} onClick={pair}>
              {busy ? "Pairing…" : "Pair and connect"}
            </Button>
          </div>
          <details className="mt-4">
            <summary className="cursor-pointer text-sm font-semibold text-muted">Paired before? Connect with the port on the main Wireless debugging screen</summary>
            <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_auto]">
              <input value={connPort} onChange={(e) => setConnPort(e.target.value)} className="input font-mono" placeholder="Port, e.g. 37115" aria-label="Connection port" />
              <Button variant="secondary" disabled={!ip || !connPort || busy} onClick={connectWifi}>
                Connect
              </Button>
            </div>
          </details>
        </details>
      )}

      {token && devices && (
        <div className="space-y-2">
          {devices.length === 0 && (
            <p role="status" className="flex items-center gap-2.5 text-[15px] text-text-2">
              <span className="pulse-dot h-2.5 w-2.5 rounded-full" style={{ background: "var(--brand)" }} />
              Waiting for a phone — plug in a USB cable or pair over Wi-Fi above.
            </p>
          )}
          {devices.map((d) => (
            <div key={d.serial} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border px-4 py-3">
              <span className="flex flex-col">
                <b className="text-[15px]">{d.model ?? d.serial}</b>
                <span className="text-sm text-muted">
                  {d.transport === "wifi" ? "Wi-Fi" : "USB"} · {d.state}
                </span>
              </span>
              <Button size="sm" disabled={d.state !== "device"} onClick={() => onDriver(helperDriver(token, d))}>
                {d.state === "unauthorized" ? "Tap “Allow” on the phone" : "Use this phone"}
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function StateRow({
  first,
  label,
  tech,
  how,
  device,
  apiRecord,
  busy,
  disabled,
  onRun,
}: {
  first: boolean;
  label: string;
  tech: string;
  how: string;
  device?: PushTestResult;
  apiRecord?: TestPushRecord;
  busy: boolean;
  disabled: boolean;
  onRun: () => void;
}) {
  const status =
    device?.status === "delivered"
      ? { t: "Delivered", c: "var(--pass)", m: "pass" as const }
      : device?.status === "not-delivered"
        ? { t: "Not delivered", c: "var(--fail-text)", m: "fail" as const }
        : apiRecord?.status === "confirmed"
          ? { t: "Confirmed", c: "var(--pass)", m: "pass" as const }
          : apiRecord?.status === "failed"
            ? { t: "Send failed", c: "var(--fail-text)", m: "fail" as const }
            : apiRecord
              ? { t: "Sent", c: "var(--brand)", m: "manual" as const }
              : null;
  return (
    <div className={cx("flex flex-wrap items-start gap-4 px-6 py-5", !first && "border-t")}>
      <StatusMark status={busy ? "busy" : status?.m ?? "todo"} />
      <div className="min-w-0 flex-1 basis-60">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="text-[17px] font-bold">{label}</span>
          <span className="text-[13px] text-muted">{tech}</span>
          {status && (
            <span className="text-sm font-bold" style={{ color: status.c }}>
              {status.t}
            </span>
          )}
        </div>
        <p className="mt-1 text-[15px] text-text-2">{how}</p>
        {device?.stateDetail && <p className="mt-1 text-sm text-muted">{device.stateDetail}</p>}
        {device?.status === "error" && device.detail && (
          <p className="mt-1 text-sm" style={{ color: "var(--fail-text)" }}>
            {device.detail}
          </p>
        )}
        {device?.status === "not-delivered" && device.background?.hints.length ? (
          <p className="mt-1 text-sm text-muted">Likely the phone: {device.background.hints[0]}</p>
        ) : null}
      </div>
      <Button variant={status?.m === "pass" ? "secondary" : "primary"} icon="bell" disabled={disabled} onClick={onRun}>
        {busy ? "Testing…" : status?.m === "pass" ? "Test again" : "Test"}
      </Button>
    </div>
  );
}

function DeviceSummary({ f }: { f: DeviceFindings }) {
  const notif =
    f.notificationPermission === "granted" || f.notificationPermission === "not-required" ? "Allowed" : f.notificationPermission === "denied" ? "Blocked" : "Unknown";
  return (
    <Card className="p-6">
      <h3 className="text-lg font-bold">Your test phone</h3>
      <p className="mt-0.5 text-sm text-muted">
        {f.device.manufacturer} {f.device.model} · Android {f.device.android} · {f.transport === "wifi" ? "Wi-Fi" : "USB"}
      </p>
      <ul className="mt-4 divide-y rounded-xl border">
        <li className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-3">
          <span className="text-sm text-muted">App on the phone</span>
          <span className="text-[15px] font-semibold">
            {f.app.installed ? `Installed, version ${f.app.versionName ?? "?"}` : "Not installed"}
            {f.app.matchesScan === false && " — different from the scanned build"}
          </span>
        </li>
        <li className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-3">
          <span className="text-sm text-muted">Notifications</span>
          <span className="text-[15px] font-semibold">{notif}</span>
        </li>
      </ul>
      {f.logging?.status === "blocked" && f.logging.fix && (
        <Notice tone="fail" className="mt-4">
          {f.logging.fix}
        </Notice>
      )}
      {f.background && f.background.hints.length > 0 && (
        <div className="mt-4">
          <div className="text-[15px] font-bold">For reliable pushes in the background or when closed, on this phone:</div>
          <ul className="mt-1.5 list-disc space-y-1 pl-6 text-[15px] text-text-2">
            {f.background.hints.map((h) => (
              <li key={h}>{h}</li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
