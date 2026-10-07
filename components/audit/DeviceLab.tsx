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
import { Card, Button, Badge } from "@/components/ui";
import { LogSession, type LogSessionSave } from "./LogSession";
import { mergeInsights } from "@/lib/device/ctlog";
import { Icon } from "@/components/Icon";
import { cx, formatDate } from "@/lib/format";

const STATES: { id: AppState; label: string; auto: string; manual: string }[] = [
  {
    id: "foreground",
    label: "Foreground",
    auto: "We open the app and send a push. Watch it appear.",
    manual: "Open the app and keep it on screen, then press Test.",
  },
  {
    id: "background",
    label: "Background",
    auto: "We open the app, press Home, then send a push.",
    manual: "Open the app, press Home, then press Test.",
  },
  {
    id: "killed",
    label: "Killed",
    auto: "We close the app (like swiping it away), then send a push.",
    manual: "Swipe the app away from recent apps, then press Test.",
  },
];

type Mode = "usb" | "helper";

export function DeviceLab({ audit }: { audit: Audit }) {
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
  const needCreds = !passcode ? "Enter the CleverTap passcode above." : !id ? "Enter the test identity first." : "";
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

      if (!driver || !pkg) throw new Error("Connect the phone first (step 2).");
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
  const nextStep = !pkg
    ? "Scan the build first — the report needs the app's package name."
    : !passcode
      ? "Step 1 — enter your CleverTap passcode."
      : !id
        ? "Step 1 — enter the identity (or email) the phone is logged in with."
        : !tu
          ? "Step 1 — press “Check test user”."
          : !driver
            ? mode === "usb"
              ? "Step 2 — plug the phone in with a USB cable and press “Connect phone”."
              : "Step 2 — start the helper on this computer (command below); the page connects by itself."
            : nextState
              ? `Step 3 — press “Test” on ${nextState.label}. ${nextState.auto} Watch your phone.`
              : "Step 4 — follow the guided checks below: restart, log in, use the app, tap a push.";

  /* ---- render ---- */

  return (
    <Card className="overflow-hidden scroll-mt-20" id="live-device">
      <div className="border-b bg-surface-2 px-5 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <Icon name="terminal" size={18} style={{ color: "var(--manual)" }} />
          <h2 className="font-semibold">Live device testing</h2>
          {driver ? (
            <Badge tone="success">
              {driver.label} · {driver.transport === "wifi" ? "Wi-Fi" : "USB"}
            </Badge>
          ) : (
            <Badge tone="neutral">No phone connected</Badge>
          )}
        </div>
        <p className="mt-1 text-sm text-muted">
          Tests your app on a real phone: push in every app state, channels, permission, login and events.
        </p>
        <details className="mt-2 text-xs text-muted">
          <summary className="cursor-pointer font-medium text-text">Before you start (2 minutes)</summary>
          <ol className="mt-1.5 list-decimal space-y-0.5 pl-5">
            <li>Install a test build of the same app version (CleverTap debug mode on — your developer can switch it on) and log in with a test user.</li>
            <li>Phone: Settings → About → tap “Build number” 7×, then Developer options → USB debugging ON.</li>
            <li>Use Chrome or Edge on a computer. Close Android Studio (it holds the phone).</li>
            <li>Keep the phone unlocked with the screen on while tests run.</li>
          </ol>
        </details>
      </div>

      <div className="flex items-start gap-2 border-b px-5 py-3 text-sm" style={{ background: "var(--accent-soft)" }}>
        <Icon name="arrowRight" size={16} className="mt-0.5 shrink-0 text-accent" />
        <span>
          <b>Next:</b> {nextStep}
        </span>
      </div>

      <div className="space-y-6 p-5">
        {/* 1. test user */}
        <Section n={1} title="Test user on the phone">
          <div className="flex flex-wrap items-end gap-2">
            <label className="w-56">
              <span className="mb-1 block text-xs font-medium text-muted">CleverTap passcode</span>
              <input
                type="password"
                autoComplete="new-password"
                data-1p-ignore
                data-lpignore="true"
                value={passcode}
                onChange={(e) => rememberPasscode(audit.id, e.target.value)}
                className="input font-mono"
                placeholder="kept in this tab only"
              />
            </label>
            <label className="min-w-[220px] flex-1">
              <span className="mb-1 block text-xs font-medium text-muted">Identity (or email) the phone is logged in with</span>
              <input
                value={identityInput}
                onChange={(e) => setIdentityInput(e.target.value)}
                onBlur={() => rememberIdentity(audit.id, identityInput.trim())}
                className="input font-mono"
                placeholder="e.g. test_user_01"
              />
            </label>
            <Button size="sm" variant="secondary" icon="search" disabled={!!needCreds || !!busy} onClick={checkTestUser}>
              {busy === "user" ? "Checking…" : "Check test user"}
            </Button>
          </div>
          {tu && <TestUserCard tu={tu} scanVersion={scan?.app.versionName} />}
        </Section>

        {/* 2. connection */}
        <Section n={2} title="Connect the phone">
          <div className="mb-3 flex flex-wrap gap-2">
            {(
              [
                ["usb", "USB cable"],
                ["helper", "Wi-Fi (or USB) via helper"],
              ] as [Mode, string][]
            ).map(([m, label]) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={cx(
                  "rounded-full border px-3 py-1.5 text-xs font-medium transition",
                  mode === m ? "border-brand bg-brand-soft text-brand" : "text-muted hover:bg-surface-2",
                )}
              >
                {label}
              </button>
            ))}
          </div>
          {mode === "usb" && <UsbConnect supported={typeof window !== "undefined" && webUsbSupported()} busy={busy === "connect"} onConnect={connect} />}
          {mode === "helper" && <HelperConnect onDriver={setDriver} onError={(t) => setMsg({ tone: "err", text: t })} />}
          <p className="mt-2 text-[11px] text-muted">
            Both work the same: we open, background and close the app on the phone for you. USB needs Chrome/Edge; Wi-Fi needs the small
            helper because browsers can&apos;t reach a phone over the network.
          </p>
        </Section>

        {/* 3. tests */}
        <Section n={3} title="Run the tests">
          {!pkg && <p className="text-xs text-muted">Scan the build first — the package name comes from the scan.</p>}
          <div className="mb-3 grid gap-3 sm:grid-cols-2">
            <label>
              <span className="mb-1 block text-xs font-medium text-muted">Notification channel ID for the test push</span>
              <input value={channel} onChange={(e) => setChannel(e.target.value)} className="input font-mono" placeholder="channel id" />
              {channelMissing && (
                <span className="mt-1 block text-[11px]" style={{ color: "var(--warn)" }}>
                  “{channel}” doesn&apos;t exist on the phone — the push will be dropped.{" "}
                  <button type="button" className="font-semibold underline" onClick={() => setChannel(phoneChannels[0])}>
                    Use {phoneChannels[0]}
                  </button>
                </span>
              )}
            </label>
            {driver && (
              <div className="flex items-end">
                <Button size="sm" variant="secondary" icon="search" disabled={!!busy || !pkg} onClick={deviceChecks}>
                  {busy === "checks" ? "Checking…" : "Run device checks"}
                </Button>
              </div>
            )}
          </div>

          <div className="grid gap-2 sm:grid-cols-3">
            {STATES.map((s) => (
              <StateCard
                key={s.id}
                label={s.label}
                how={s.auto}
                device={findings?.pushTests[s.id]}
                apiRecord={audit.api?.pushTests?.[s.id]}
                busy={busy === s.id}
                disabled={!!busy || !!needCreds || !pkg || !driver}
                onRun={() => pushTest(s.id)}
                confirming={false}
              />
            ))}
          </div>
          {(needCreds || !driver) && <p className="mt-2 text-xs text-muted">{needCreds || "Connect the phone (step 2) to run the tests."}</p>}
          <p className="mt-2 text-[11px] text-muted">
            Each test takes about 15–30 s: the app opens on the phone, goes to the background or closes, then the push appears. We wait up to
            60 s for it.
          </p>
          {step && (
            <p className="mt-3 flex items-center gap-2 text-xs text-muted">
              <span className="h-3 w-3 rounded-full border-2 border-brand border-t-transparent animate-spin-slow" /> {step}
            </p>
          )}
        </Section>

        {/* 4. guided log checks */}
        <Section n={4} title="Guided checks">
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
            <p className="text-xs text-muted">
              Connect the phone (step 2), then do each action shown here — login, restart, your key actions, a push with a link, an in-app.
            </p>
          )}
        </Section>

        {findings && <DeviceSummary f={findings} />}

        {msg && (
          <div
            className="rounded-lg px-3 py-2 text-xs"
            style={{ background: msg.tone === "ok" ? "var(--pass-soft)" : "var(--fail-soft)", color: msg.tone === "ok" ? "var(--pass)" : "var(--fail)" }}
          >
            {msg.text}
          </div>
        )}
      </div>
    </Card>
  );
}

/* ---------------- pieces ---------------- */

function Section({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-surface-3 text-[11px]">{n}</span>
        {title}
      </div>
      {children}
    </div>
  );
}

function TestUserCard({ tu, scanVersion }: { tu: TestUserRecord; scanVersion?: string }) {
  if (!tu.found) return <p className="mt-2 text-xs" style={{ color: "var(--fail)" }}>No profile found for {tu.identity}.</p>;
  const a = tu.android;
  const rows: [string, string, boolean | undefined][] = [
    ["Android device", a ? `${a.model ?? "Unknown model"} · Android ${a.osVersion ?? "?"}` : "None on this profile", !!a],
    ["App version", a?.appVersion ? `${a.appVersion}${scanVersion && a.appVersion !== scanVersion ? ` (scanned build is ${scanVersion})` : ""}` : "—", a?.appVersion ? !scanVersion || a.appVersion === scanVersion : undefined],
    ["Push token", a ? (a.hasPushToken ? "Registered" : "Missing") : "—", a?.hasPushToken],
    ["Last App Launched", tu.lastLaunchedAt ? formatDate(tu.lastLaunchedAt) : "Never", !!tu.lastLaunchedAt],
    ["Email / phone", `${tu.hasEmail ? "email ✓" : "no email"} · ${tu.hasPhone ? (tu.phoneValid ? "phone ✓" : "phone format ✗") : "no phone"}`, tu.hasEmail || tu.hasPhone],
  ];
  return (
    <div className="mt-3 grid gap-px overflow-hidden rounded-xl border bg-[var(--border)] sm:grid-cols-2">
      {rows.map(([k, v, ok]) => (
        <div key={k} className="flex items-center justify-between gap-2 bg-surface px-3 py-2 text-xs">
          <span className="text-muted">{k}</span>
          <span className="flex items-center gap-1.5 text-right font-medium">
            {ok !== undefined && <Icon name={ok ? "check" : "alert"} size={12} style={{ color: ok ? "var(--pass)" : "var(--warn)" }} />}
            {v}
          </span>
        </div>
      ))}
    </div>
  );
}

function UsbConnect({ supported, busy, onConnect }: { supported: boolean; busy: boolean; onConnect: () => void }) {
  if (!supported)
    return (
      <p className="text-xs leading-relaxed text-muted">
        This browser can&apos;t talk to USB devices. Open this page in <b className="text-text">Chrome or Edge on a computer</b>, or use the helper.
      </p>
    );
  return (
    <div className="space-y-2">
      <ol className="list-decimal space-y-1 pl-5 text-xs leading-relaxed text-muted">
        <li>On the phone: Settings → About → tap “Build number” 7 times, then Developer options → turn on USB debugging.</li>
        <li>Plug the phone in with a data cable. Close Android Studio / scrcpy, and run <code className="font-mono">adb kill-server</code> if adb is installed.</li>
        <li>Press Connect, pick the phone, then tap “Allow” on the phone.</li>
      </ol>
      <Button size="sm" icon="link" disabled={busy} onClick={onConnect}>
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
    <div className="space-y-3 text-xs">
      {outdated && (
        <div className="rounded-xl px-3 py-2" style={{ background: "var(--warn-soft)" }}>
          <b>Your helper is out of date.</b> Stop it (Ctrl+C in its terminal) and run the command below again — it downloads the new
          version.
        </div>
      )}
      <div className="rounded-xl border p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="font-medium">
            {token ? (
              <span style={{ color: "var(--pass)" }}>● Helper running</span>
            ) : (
              <>1. Paste this into {os === "win" ? "PowerShell" : "Terminal"} (needs Node.js and Android platform-tools):</>
            )}
          </span>
          {!token && (
            <span className="flex gap-1">
              {(["win", "mac"] as const).map((o) => (
                <button
                  key={o}
                  onClick={() => setOs(o)}
                  className={cx("rounded-full border px-2 py-0.5", os === o ? "border-brand text-brand" : "text-muted")}
                >
                  {o === "win" ? "Windows" : "Mac / Linux"}
                </button>
              ))}
            </span>
          )}
        </div>
        {!token && (
          <>
            <div className="mt-2 flex items-start gap-2">
              <code className="block flex-1 break-all rounded-lg bg-surface-3 px-2 py-1.5 font-mono">{cmd}</code>
              <Button size="sm" variant="secondary" onClick={() => void navigator.clipboard?.writeText(cmd)}>
                Copy
              </Button>
            </div>
            <p className="mt-1.5 text-muted">
              It downloads the helper into the folder you&apos;re in and starts it. This page finds it by itself — keep the terminal open. Already
              downloaded? Run it from that folder:{" "}
              <code className="font-mono">node ct-device-bridge.mjs --origin {origin}</code>
            </p>
          </>
        )}
      </div>

      {token && (
        <details className="rounded-xl border p-3" open={!devices?.some((d) => d.transport === "wifi")}>
          <summary className="cursor-pointer font-medium">Connect over Wi-Fi (Android 11+) — skip if the phone is on a USB cable</summary>
          <ol className="mt-2 list-decimal space-y-0.5 pl-5 leading-relaxed text-muted">
            <li>Phone and computer on the same Wi-Fi.</li>
            <li>Phone: Developer options → Wireless debugging ON → “Pair device with pairing code”.</li>
            <li>
              Type the <b>IP address &amp; port</b> and the <b>6-digit code</b> from that pop-up, then press Pair. We connect right after.
            </li>
          </ol>
          <div className="mt-2 grid gap-2 sm:grid-cols-4">
            <input value={ip} onChange={(e) => setIp(e.target.value)} className="input font-mono" placeholder="IP e.g. 192.168.0.103" />
            <input value={pairPort} onChange={(e) => setPairPort(e.target.value)} className="input font-mono" placeholder="port in the pop-up" />
            <input value={code} onChange={(e) => setCode(e.target.value)} className="input font-mono" placeholder="6-digit code" />
            <Button size="sm" variant="secondary" disabled={!ip || !pairPort || code.trim().length !== 6 || busy} onClick={pair}>
              {busy ? "Pairing…" : "Pair & connect"}
            </Button>
          </div>
          <details className="mt-2">
            <summary className="cursor-pointer text-muted">Already paired before? Connect with the port on the main Wireless debugging screen</summary>
            <div className="mt-2 grid gap-2 sm:grid-cols-4">
              <input value={connPort} onChange={(e) => setConnPort(e.target.value)} className="input font-mono" placeholder="port e.g. 37115" />
              <Button size="sm" variant="secondary" disabled={!ip || !connPort || busy} onClick={connectWifi}>
                Connect
              </Button>
            </div>
          </details>
        </details>
      )}

      {token && devices && (
        <div className="space-y-1.5">
          {devices.length === 0 && <p className="text-muted">Waiting for a phone — plug in a USB cable or pair over Wi-Fi above.</p>}
          {devices.map((d) => (
            <div key={d.serial} className="flex items-center justify-between gap-2 rounded-lg border px-3 py-2">
              <span>
                <b>{d.model ?? d.serial}</b> <span className="text-muted">· {d.transport === "wifi" ? "Wi-Fi" : "USB"} · {d.state}</span>
              </span>
              <Button size="sm" disabled={d.state !== "device"} onClick={() => onDriver(helperDriver(token, d))}>
                {d.state === "unauthorized" ? "Tap “Allow” on the phone" : "Use"}
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function StateCard({
  label,
  how,
  device,
  apiRecord,
  busy,
  disabled,
  onRun,
  onConfirm,
  confirming,
}: {
  label: string;
  how: string;
  device?: PushTestResult;
  apiRecord?: TestPushRecord;
  busy: boolean;
  disabled: boolean;
  onRun: () => void;
  onConfirm?: () => void;
  confirming: boolean;
}) {
  const status =
    device?.status === "delivered"
      ? { t: "Delivered", c: "var(--pass)" }
      : device?.status === "not-delivered"
        ? { t: "Not delivered", c: "var(--fail)" }
        : apiRecord?.status === "confirmed"
          ? { t: "Confirmed", c: "var(--pass)" }
          : apiRecord?.status === "failed"
            ? { t: "Send failed", c: "var(--fail)" }
            : apiRecord
              ? { t: "Sent", c: "var(--manual)" }
              : null;
  return (
    <div className="rounded-xl border p-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold">{label}</span>
        {status && (
          <span className="text-xs font-medium" style={{ color: status.c }}>
            {status.t}
          </span>
        )}
      </div>
      <p className="mt-0.5 text-[11px] text-muted">{how}</p>
      {device?.stateDetail && <p className="mt-1 text-[11px] text-muted">{device.stateDetail}</p>}
      {device?.status === "error" && device.detail && <p className="mt-1 text-[11px]" style={{ color: "var(--fail)" }}>{device.detail}</p>}
      {device?.status === "not-delivered" && device.background?.hints.length ? (
        <p className="mt-1 text-[11px] text-muted">Likely the phone: {device.background.hints[0]}</p>
      ) : null}
      <div className="mt-2 flex gap-1.5">
        <Button size="sm" variant="secondary" icon="bell" disabled={disabled} onClick={onRun}>
          {busy ? "Testing…" : "Test"}
        </Button>
        {onConfirm && (
          <Button size="sm" variant="ghost" icon="check" disabled={disabled || confirming} onClick={onConfirm}>
            {confirming ? "Checking…" : "Check delivery"}
          </Button>
        )}
      </div>
    </div>
  );
}

function DeviceSummary({ f }: { f: DeviceFindings }) {
  return (
    <div className="rounded-xl border bg-surface-2 p-4 text-xs">
      <div className="mb-2 font-semibold">
        Test phone · {f.device.manufacturer} {f.device.model} · Android {f.device.android} · {f.transport === "wifi" ? "Wi-Fi" : "USB"}
      </div>
      <ul className="space-y-1 text-muted">
        <li>
          App: {f.app.installed ? `installed, version ${f.app.versionName ?? "?"}` : "not installed"}
          {f.app.matchesScan === false && " — different from the scanned build"}
        </li>
        <li>Notifications allowed: {f.notificationPermission === "granted" || f.notificationPermission === "not-required" ? "yes" : f.notificationPermission === "denied" ? "no" : "unknown"}</li>
      </ul>
      {f.logging?.status === "blocked" && f.logging.fix && (
        <p className="mt-2" style={{ color: "var(--fail)" }}>
          {f.logging.fix}
        </p>
      )}
      {f.background && f.background.hints.length > 0 && (
        <div className="mt-2">
          <div className="font-medium">For reliable background / killed pushes on this phone:</div>
          <ul className="mt-0.5 list-disc pl-5 text-muted">
            {f.background.hints.map((h) => (
              <li key={h}>{h}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
