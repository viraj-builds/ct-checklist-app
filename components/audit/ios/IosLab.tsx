"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, refreshAudit } from "@/lib/store";
import { rememberIdentity, rememberPasscode, useSecrets } from "@/lib/session-secrets";
import { IOS_HELPER_MIN_VERSION, IOS_STALLED, NO_CONTROL, iosBoot, iosDriver, iosHelperHello, iosHelperStatus, listIosApps, notificationPermission, type IosDriver } from "@/lib/device/ios/bridge";
import { runIosDeepLinks, runIosPushTest, simulatedPayload, type IosSendMode } from "@/lib/device/ios/runner";
import { parseIosCtLog, type IosLogMessage } from "@/lib/device/ios/ctlog";
import { mergeInsights, type LogInsights } from "@/lib/device/ctlog";
import type { AppState, LogScenarios } from "@/lib/device/types";
import type { IosApp, IosDeviceFindings, IosHelperStatus, IosPushTestResult, IosTarget } from "@/lib/device/ios/types";
import type { Audit } from "@/lib/types";
import type { TestPushRecord, TestUserRecord } from "@/lib/clevertap/types";
import { Card, Button, Notice, StatusMark } from "@/components/ui";
import { CriticalEvents } from "../CriticalEvents";
import { Icon } from "@/components/Icon";
import { cx, formatDate } from "@/lib/format";

export type IosView = "setup" | "push" | "guided";

const STATES: { id: AppState; label: string; tech: string; how: string }[] = [
  { id: "foreground", label: "App open", tech: "Foreground", how: "We open the app and send a push. Watch it appear." },
  { id: "background", label: "In the background", tech: "Background", how: "We open the app, bring Settings to the front, then send a push." },
  { id: "killed", label: "App closed", tech: "Killed", how: "We close the app (like swiping it away), then send a push." },
];
const VIEW_NAME: Record<IosView, string> = { setup: "Connect your iPhone", push: "Push tests", guided: "Guided checks" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const POLL_MS = 2000;
const RELAUNCH_WAIT_MS = 15_000;
const MAX_MESSAGES = 6000;

export function IosLab({ audit, view, onNavigate }: { audit: Audit; view: IosView | null; onNavigate?: (v: IosView) => void }) {
  const scan = audit.iosScan;
  const bundleHint = scan?.app.bundleId;
  const { passcode, identity } = useSecrets(audit.id);
  const [identityInput, setIdentityInput] = useState(identity);
  const id = identityInput.trim();
  const needCreds = !passcode ? "Enter your CleverTap passcode under “Connect your iPhone” first." : !id ? "Enter the test user’s identity under “Connect your iPhone” first." : "";
  const tu = audit.api?.testUser;

  const [drv, setDrv] = useState<IosDriver | null>(null);
  const [app, setApp] = useState<IosApp | null>(null);
  const [findings, setFindings] = useState<IosDeviceFindings | null>(audit.iosDevice ?? null);
  const findingsRef = useRef(findings);
  const [busy, setBusy] = useState("");
  const [step, setStep] = useState("");
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [pushChoice, setPushVia] = useState<IosSendMode | null>(null); // null = pick for the user

  // log session
  const messages = useRef<IosLogMessage[]>([]);
  const cursor = useRef(0);
  const earlier = useRef<LogInsights | undefined>(audit.iosDevice?.logs);
  const [ins, setIns] = useState<LogInsights | undefined>(audit.iosDevice?.logs);
  const [sc, setSc] = useState<LogScenarios>(audit.iosDevice?.logScenarios ?? {});
  const [active, setActive] = useState(false);
  const [waiting, setWaiting] = useState<"" | "relaunch" | "restart" | "sending" | "tap">("");
  const mark = useRef(0);
  const [url, setUrl] = useState("https://www.clevertap.com");
  const [linkChoice, setLinkVia] = useState<IosSendMode | null>(null);
  const tapUrl = useRef("");

  // a step the tester does on the iPhone (when the helper can't open / close apps itself)
  const [prompt, setPrompt] = useState<{ text: string; done: () => void; cancel: () => void } | null>(null);
  const ask = useCallback(
    (text: string) =>
      new Promise<void>((resolve, reject) =>
        setPrompt({
          text,
          done: () => (setPrompt(null), resolve()),
          cancel: () => (setPrompt(null), reject(new Error("Stopped."))),
        }),
      ),
    [],
  );
  const saw = useRef(false); // "I see it on my iPhone"
  const where = drv?.where ?? "iPhone";

  // The "tap a push with a link" wait ends with a tap, or after 3 minutes (as on Android).
  useEffect(() => {
    if (waiting !== "tap") return;
    const t = setTimeout(() => {
      setWaiting("");
      setMsg({ tone: "err", text: `No tap seen in 3 minutes. Send the push again and tap it on the ${where}.` });
    }, 3 * 60_000);
    return () => clearTimeout(t);
  }, [waiting, where]);

  const procs = useMemo(() => {
    const s = new Set<string>();
    if (app?.executable) s.add(app.executable);
    for (const e of scan?.extensions ?? []) s.add(e.name.replace(/\.appex$/, ""));
    return s;
  }, [app, scan]);

  /* ---- persistence ---- */
  const save = useCallback(
    async (patch: Partial<IosDeviceFindings>) => {
      if (!drv || !app) return;
      const base: IosDeviceFindings = findingsRef.current ?? {
        platform: "ios",
        connectedVia: "ios-helper",
        target: drv.isDevice ? "device" : "simulator",
        transport: drv.sim.kind === "device" ? drv.sim.transport : undefined,
        checkedAt: Date.now(),
        device: {},
        app: { bundleId: app.bundleId, installed: true },
        pushTests: {},
        deepLinks: [],
      };
      const next: IosDeviceFindings = { ...base, ...patch, checkedAt: Date.now() };
      findingsRef.current = next;
      setFindings(next);
      await api(`/api/audits/${audit.id}/ios-device`, { method: "POST", body: JSON.stringify(next) });
      refreshAudit(audit.id);
    },
    [drv, app, audit.id],
  );

  async function guard(name: string, fn: () => Promise<void>) {
    setBusy(name);
    setMsg(null);
    try {
      await fn();
    } catch (e) {
      const text = (e as Error).message;
      if (text.startsWith(IOS_STALLED)) setDrv(null);
      setMsg({ tone: "err", text });
    } finally {
      setBusy("");
      setStep("");
      refreshAudit(audit.id);
    }
  }

  /* ---- device checks (runs once per connected app) ---- */
  const readDevice = () =>
    guard("checks", async () => {
      if (!drv || !app) return;
      setStep(`Reading the app on the ${drv.where}`);
      let info: IosApp = app;
      try {
        info = JSON.parse(await drv.run({ t: "appInfo", bundleId: app.bundleId })) as IosApp;
      } catch (e) {
        if (!drv.isDevice) throw e; // on an iPhone without devicectl we go by the scanned build
      }
      setStep("Checking notification permission");
      const perm = await notificationPermission(drv, app.bundleId);
      const schemes = (scan?.plist.urlSchemes ?? []).filter((x) => !/^(fb\d+|com\.googleusercontent\.apps\..*)$/i.test(x)).slice(0, 4);
      let deepLinks = findingsRef.current?.deepLinks ?? [];
      if (schemes.length) {
        setStep("Opening the app's URL schemes");
        deepLinks = await runIosDeepLinks(drv, app.bundleId, schemes.map((x) => `${x}://`));
      }
      await save({
        device: { name: drv.sim.name, os: drv.sim.os, model: drv.sim.kind === "device" ? drv.sim.model : undefined },
        app: {
          bundleId: app.bundleId,
          installed: true,
          name: info.name,
          versionName: info.version,
          buildNumber: info.build,
          matchesScan: scan ? info.version === scan.app.versionName && info.build === scan.app.buildNumber && app.bundleId === scan.app.bundleId : undefined,
        },
        notificationPermission: perm,
        deepLinks,
      });
      setMsg({ tone: "ok", text: `Read ${info.name ?? app.bundleId} on ${drv.label}.` });
    });

  /** Restart the app — by itself when it can, otherwise the tester does it on the iPhone. */
  const restartApp = useCallback(async () => {
    if (!drv || !app) return;
    const manual = () => ask("Close the app on the iPhone (swipe it away in the app switcher) and open it again. Then press Done.");
    if (!drv.canControl) return manual();
    try {
      await drv.run({ t: "launch", bundleId: app.bundleId, relaunch: true });
    } catch (e) {
      if (!drv.isDevice) throw e;
      await manual();
    }
  }, [drv, app, ask]);

  /* ---- log session ---- */
  const startSession = useCallback(async () => {
    if (!drv || !app) return;
    setWaiting("restart");
    try {
      cursor.current = await drv.startLogs();
      messages.current = [];
      setActive(true);
      await restartApp();
      await sleep(4000);
    } catch (e) {
      setMsg({ tone: "err", text: (e as Error).message.replace(NO_CONTROL, "").trim() });
    } finally {
      setWaiting("");
    }
  }, [drv, app, restartApp]);

  // connect → read the device, then start watching the logs (restarts the app once)
  const autoChecked = useRef<string | null>(null);
  useEffect(() => {
    if (!drv || !app || autoChecked.current === `${drv.udid}:${app.bundleId}`) return;
    autoChecked.current = `${drv.udid}:${app.bundleId}`;
    const t = setTimeout(async () => {
      await readDevice();
      await startSession();
    }, 300);
    return () => clearTimeout(t);
  }, [drv, app]); // eslint-disable-line react-hooks/exhaustive-deps

  // poll the helper's log buffer
  useEffect(() => {
    if (!drv || !app || !active) return;
    let alive = true;
    const tick = async () => {
      try {
        const r = await drv.readLogs(cursor.current);
        if (!alive) return;
        if (!r.running) {
          cursor.current = await drv.startLogs(); // helper restarted
          return;
        }
        cursor.current = r.next;
        const mine = r.messages.filter((m) => !m.proc || procs.has(m.proc));
        if (mine.length) {
          messages.current = [...messages.current, ...mine].slice(-MAX_MESSAGES);
          const parsed = parseIosCtLog(messages.current, app.executable);
          setIns(mergeInsights(earlier.current, parsed));
        }
      } catch {
        /* helper hiccup — keep polling */
      }
    };
    void tick();
    const t = setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [drv, app, active, procs]);

  // tap scenario: a Notification Clicked / deep link after the push was sent
  useEffect(() => {
    if (waiting !== "tap" || !ins) return;
    const click = ins.clicks.find((c) => c.line > mark.current);
    if (click) {
      setSc((s) => ({ ...s, linkTap: { at: Date.now(), url: tapUrl.current, clicked: true, landed: click.deepLink ? `CleverTap opened ${click.deepLink}` : "app opened", openedOutsideApp: /^https?:/i.test(tapUrl.current) || undefined } }));
      setWaiting("");
    }
  }, [ins, waiting]);

  // save the session (debounced)
  const savedJson = useRef("");
  useEffect(() => {
    if (!ins || !drv || !app) return;
    const json = JSON.stringify({ ins, sc });
    if (json === savedJson.current) return;
    const t = setTimeout(() => {
      savedJson.current = json;
      const logApns = ins.push.errors.find((e) => /APNs registration failed/.test(e));
      save({ logs: ins, logScenarios: sc, apnsError: logApns?.slice(0, 280) }).catch(() => {});
    }, 2500);
    return () => clearTimeout(t);
  }, [ins, sc, drv, app, save]);

  // stop the helper's log stream when leaving the page
  useEffect(() => () => void drv?.stopLogs(), [drv]);

  // push route: an iPhone always gets a real CleverTap push; the Simulator can also simulate one
  const defaultVia: IosSendMode = drv?.isDevice || (ins?.pushToken && !needCreds) ? "clevertap" : "simulated";
  const pushVia = drv?.canSimulatePush === false ? "clevertap" : pushChoice ?? defaultVia;
  const linkVia = drv?.canSimulatePush === false ? "clevertap" : linkChoice ?? defaultVia;

  /* ---- actions ---- */
  const checkTestUser = () =>
    guard("user", async () => {
      rememberIdentity(audit.id, id);
      const r = await api<{ testUser: TestUserRecord }>(`/api/audits/${audit.id}/test-user`, { method: "POST", body: JSON.stringify({ passcode, identity: id }) });
      setMsg(
        r.testUser.found
          ? { tone: "ok", text: r.testUser.android ? "Found the test user and their iOS device." : "Found the user, but no iOS device on the profile yet — open the app on the iPhone once." }
          : { tone: "err", text: "No CleverTap profile with that identity. Log in on the iPhone with it, then retry." },
      );
    });

  const sendViaCleverTap = useCallback(
    async (marker: string, extra: { appState?: AppState; deepLink?: string }) => {
      rememberIdentity(audit.id, id);
      const r = await api<{ testPush: TestPushRecord }>(`/api/audits/${audit.id}/test-push`, {
        method: "POST",
        body: JSON.stringify({ passcode, identity: id, marker, ...extra }),
      });
      if (r.testPush.status === "failed") throw new Error(r.testPush.message ?? "CleverTap rejected the push.");
    },
    [audit.id, id, passcode],
  );

  const pushTest = (state: AppState) =>
    guard(state, async () => {
      if (!drv || !app) throw new Error("Connect your iPhone first, under “Connect your iPhone”.");
      const via = pushVia;
      if (via === "clevertap" && needCreds) throw new Error(needCreds);
      const from = cursor.current;
      const send =
        via === "clevertap"
          ? (marker: string) => sendViaCleverTap(marker, { appState: state })
          : async (marker: string) => {
              await drv.run({ t: "push", bundleId: app.bundleId, payload: simulatedPayload(marker, audit.accountId) });
            };
      saw.current = false;
      const result = await runIosPushTest(drv, app.bundleId, state, send, setStep, {
        via,
        logHas: (marker) => messages.current.some((m) => m.seq > from && m.msg.includes(marker)),
        ask,
        userSaw: () => saw.current,
      });
      const prev = findingsRef.current?.pushTests ?? {};
      // a real delivery is kept if a later re-test fails for a device-side reason only
      const keep = prev[state]?.status === "delivered" && prev[state]?.via === "clevertap" && result.status !== "delivered" && (result.status === "error" || !result.verifiedState);
      const perm = await notificationPermission(drv, app.bundleId);
      await save({ pushTests: { ...prev, [state]: keep ? prev[state]! : result }, notificationPermission: perm });
      setMsg(
        result.status === "delivered"
          ? { tone: "ok", text: `${via === "simulated" ? "Simulated push shown" : "Delivered"} in ${Math.round((result.deliveredAfterMs ?? 0) / 1000)} s with the app ${state}.` }
          : { tone: "err", text: result.detail ?? "Not delivered." },
      );
    });

  async function relaunch() {
    if (!drv || !app) return;
    setWaiting("relaunch");
    try {
      mark.current = cursor.current;
      await restartApp();
      await sleep(RELAUNCH_WAIT_MS);
      const after = parseIosCtLog(messages.current.filter((m) => m.seq > mark.current), app.executable).onUserLogin;
      setSc((s) => ({ ...s, relaunch: { at: Date.now(), onUserLoginOnStart: after.length > 0, kinds: after.map((a) => a.kind) } }));
    } catch (e) {
      setMsg({ tone: "err", text: (e as Error).message });
    } finally {
      setWaiting("");
    }
  }

  async function restartOnly() {
    if (!drv || !app) return;
    setWaiting("restart");
    try {
      await restartApp();
      await sleep(8000);
    } catch (e) {
      setMsg({ tone: "err", text: (e as Error).message });
    } finally {
      setWaiting("");
    }
  }

  async function sendLink() {
    if (!drv || !app) return;
    setWaiting("sending");
    setMsg(null);
    try {
      mark.current = cursor.current;
      tapUrl.current = url.trim();
      const marker = Math.random().toString(36).slice(2, 10);
      setSc(({ linkTap: _drop, ...s }) => s); // eslint-disable-line @typescript-eslint/no-unused-vars
      if (linkVia === "clevertap") await sendViaCleverTap(marker, { deepLink: url.trim() });
      else await drv.run({ t: "push", bundleId: app.bundleId, payload: simulatedPayload(marker, audit.accountId, url.trim()) });
      setWaiting("tap");
    } catch (e) {
      setMsg({ tone: "err", text: (e as Error).message });
      setWaiting("");
    }
  }

  /* ---- what to do next ---- */
  const pushDone = (st: AppState) => findings?.pushTests[st]?.status === "delivered" || audit.api?.pushTests?.[st]?.status === "confirmed";
  const nextState = STATES.find((x) => !pushDone(x.id));
  const next: { text: string; view?: IosView } = !scan
    ? { text: "Scan the build first — the report needs the app's bundle id." }
    : !drv
      ? { text: "Start the iOS helper on this computer (command below) and connect your iPhone. The page connects by itself.", view: "setup" }
      : !app
        ? { text: `Install ${scan.app.displayName ?? "your app"} on the ${drv.where} (the build with debug logs), then pick it below.`, view: "setup" }
        : nextState
          ? { text: `Press “Test” on ${nextState.label}. ${nextState.how}`, view: "push" }
          : { text: "Follow the guided checks: log in, restart, use the app, tap a push.", view: "guided" };

  const okA = ins ? ins.appLaunchedFired && ins.queueSent > 0 : undefined;
  const okB = (ins?.onUserLogin ?? []).length > 0 || (ins?.profilePushes ?? []).some((p) => p.hasIdentity) ? true : undefined;
  const okC = sc.relaunch ? sc.relaunch.onUserLoginOnStart : undefined;
  const okD = ins?.events.length ? ins.events.every((e) => e.issues.length === 0) : undefined;
  const okE = sc.linkTap ? sc.linkTap.clicked : undefined;
  const okF = ins?.inApp.errors.length ? false : ins?.inApp.shown ? true : undefined;
  const cur = !active ? "" : (["a", "b", "c", "d", "e", "f"] as const).find((k) => ({ a: okA, b: okB, c: okC, d: okD, e: okE, f: okF })[k] !== true) ?? "";
  const logins = ins?.onUserLogin ?? [];
  const identified = ins?.profilePushes.filter((p) => p.hasIdentity) ?? [];
  const noLogs = active && ins !== undefined && ins.lines === 0;

  /* ---- render ---- */
  return (
    <div hidden={!view} className="scroll-mt-24" id="live-device">
      <div className="space-y-5">
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
        {step && (
          <p role="status" className="flex items-center gap-2.5 text-[15px] font-semibold text-text-2">
            <span className="pulse-dot h-2.5 w-2.5 rounded-full" style={{ background: "var(--brand)" }} /> {step}
          </p>
        )}
        {prompt && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-3 rounded-xl border-[1.5px] border-brand bg-surface px-4 py-3.5" role="alert">
            <Icon name="phone" size={20} className="shrink-0 text-brand" />
            <span className="min-w-0 flex-1 basis-64 text-[15px] font-semibold">{prompt.text}</span>
            <Button size="sm" icon="check" onClick={prompt.done}>
              Done
            </Button>
            <Button size="sm" variant="ghost" onClick={prompt.cancel}>
              Stop
            </Button>
          </div>
        )}
        {drv?.isDevice && STATES.some((x) => busy === x.id) && !prompt && (
          <div className="flex flex-wrap items-center gap-3 rounded-xl bg-surface-2 px-4 py-3">
            <span className="min-w-0 flex-1 basis-64 text-sm text-text-2">We also spot it in the iPhone&apos;s logs. If the push is already on screen, tell us:</span>
            <Button size="sm" variant="outline" icon="bell" onClick={() => (saw.current = true)}>
              I see it on my iPhone
            </Button>
          </div>
        )}

        {/* ---------- setup ---------- */}
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
                  <li>
                    Install a test build of the same version on the iPhone with CleverTap debug logs on:{" "}
                    <code className="font-mono text-sm">CleverTap.setDebugLevel(CleverTapLogLevel.debug.rawValue)</code> before autoIntegrate (Flutter / React
                    Native: <code className="font-mono text-sm">setDebugLevel(3)</code>). Log in with a test user.
                  </li>
                  <li>Connect the iPhone with a cable and tap “Trust” on it. Turn on Settings → Privacy &amp; Security → Developer Mode (iOS 16+).</li>
                  <li>
                    Wi-Fi instead of a cable: pair once with the cable, then in Xcode → Window → Devices tick “Connect via network”. Keep the iPhone
                    and computer on the same Wi-Fi.
                  </li>
                  <li>Keep the iPhone unlocked with the screen on while tests run.</li>
                  <li>Nothing extra to enter: we use the Account ID and passcode you already gave, and read the APNs setup from your build.</li>
                </ol>
              </details>
            </Card>

            <Section n={1} title="Your test user" sub="We look up this user in CleverTap and send test pushes to them.">
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
                <Field label="Identity or email the app is logged in with">
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
                <Button variant="secondary" icon="search" loading={busy === "user"} disabled={!!needCreds || !!busy} onClick={checkTestUser}>
                  {busy === "user" ? "Checking…" : "Check test user"}
                </Button>
              </div>
              {tu && <TestUser tu={tu} scanVersion={scan?.app.versionName} />}
            </Section>

            <Section n={2} title="Connect your iPhone" sub="Cable or Wi-Fi. We open, background and close the app and read CleverTap's logs.">
              <TargetConnect
                bundleHint={bundleHint}
                executableHint={scan?.app.executable}
                drv={drv}
                app={app}
                onDriver={(d) => {
                  setDrv(d);
                  setApp(null);
                }}
                onApp={setApp}
                onError={(t) => setMsg({ tone: "err", text: t })}
              />
              {drv && app && (
                <div className="mt-5 flex flex-wrap items-center gap-3 rounded-xl border bg-surface-2 px-4 py-3">
                  <StatusMark status="pass" size={24} />
                  <span className="text-[15px] font-bold">
                    {app.name ?? app.bundleId} on {drv.label}
                  </span>
                  {onNavigate && (
                    <Button size="sm" className="ml-auto" iconRight="arrowRight" onClick={() => onNavigate("push")}>
                      Continue to Push tests
                    </Button>
                  )}
                </div>
              )}
            </Section>

            {findings && <DeviceSummary f={findings} scanBundle={bundleHint} insights={ins} />}
          </div>
        </div>

        {/* ---------- push tests ---------- */}
        <div hidden={view !== "push"}>
          <div className="space-y-5">
            <Card className="p-6">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0 flex-1 basis-72">
                  <div className="text-[15px] font-bold">How to send the test push</div>
                  <p className="mt-1 text-sm text-muted">
                    {pushVia === "clevertap"
                      ? `A real push from CleverTap through Apple's servers to the ${where} — proves the whole path.`
                      : "Delivered on this Mac with a CleverTap-shaped payload — proves the app shows and handles CleverTap pushes, but not your APNs setup."}
                  </p>
                </div>
                {drv?.canSimulatePush !== false && (
                  <Segmented
                    value={pushVia}
                    onChange={setPushVia}
                    options={[
                      ["simulated", "Simulated"],
                      ["clevertap", "Through CleverTap"],
                    ]}
                  />
                )}
              </div>
              {pushVia === "clevertap" && ins && ins.lines > 0 && !ins.pushToken && (
                <Notice tone="warn" className="mt-4">
                  The app has no APNs token on this {where} yet, so a CleverTap push can&apos;t reach it. Add the Push Notifications capability in Xcode, allow
                  notifications and reopen the app{drv?.canSimulatePush ? ", or use Simulated" : ""}.
                </Notice>
              )}
              {drv?.isDevice && !drv.canControl && (
                <Notice tone="info" className="mt-4">
                  This computer can&apos;t open or close apps on the iPhone (that needs Xcode on a Mac), so we&apos;ll ask you to do each step on the iPhone.
                </Notice>
              )}
              {findings?.notificationPermission && findings.notificationPermission !== "granted" && findings.notificationPermission !== "provisional" && (
                <Notice tone="warn" className="mt-4">
                  {findings.notificationPermission === "denied"
                    ? `Notifications are turned off for the app on the ${where} (Settings → Notifications), so iOS won't show pushes.`
                    : `The app hasn't asked for notification permission on this ${where}, so iOS may not show its pushes.`}
                </Notice>
              )}
              {drv && app && (
                <div className="mt-4">
                  <Button variant="secondary" icon="search" loading={busy === "checks"} disabled={!!busy} onClick={readDevice}>
                    {busy === "checks" ? "Checking…" : `Read the ${where} again`}
                  </Button>
                </div>
              )}
            </Card>

            <Card className="overflow-hidden">
              {STATES.map((s, i) => (
                <StateRow
                  key={s.id}
                  first={i === 0}
                  label={s.label}
                  tech={s.tech}
                  how={s.how}
                  result={findings?.pushTests[s.id]}
                  apiRecord={audit.api?.pushTests?.[s.id]}
                  busy={busy === s.id}
                  disabled={!!busy || !drv || !app || (pushVia === "clevertap" && !!needCreds)}
                  onRun={() => pushTest(s.id)}
                />
              ))}
            </Card>
            {(!drv || !app) && <p className="text-sm text-muted">Connect your iPhone first, under “Connect your iPhone”, to run these tests.</p>}
            {pushVia === "clevertap" && needCreds && <p className="text-sm text-muted">{needCreds}</p>}
            <p className="text-sm text-muted">Each test takes about 10–30 seconds. We wait up to 60 seconds for the push to show on the {where}.</p>
          </div>
        </div>

        {/* ---------- guided checks ---------- */}
        <div hidden={view !== "guided"}>
          {drv && app ? (
            <div className="space-y-5">
              <Card className="flex flex-wrap items-center gap-x-4 gap-y-3 p-5">
                <div className="min-w-0 flex-1 basis-72">
                  {active ? (
                    <span role="status" className="flex items-center gap-2.5 text-[15px] font-bold" style={{ color: "var(--pass)" }}>
                      <span className="pulse-dot h-2.5 w-2.5 rounded-full" style={{ background: "var(--pass)" }} /> Watching the app — results tick themselves
                    </span>
                  ) : (
                    <span className="text-[15px] font-bold">Ready when you are</span>
                  )}
                  <p className="mt-0.5 text-sm text-muted">Do each action below in the app on the {where}. We confirm it from CleverTap&apos;s logs. Nothing personal is saved.</p>
                </div>
                {!active ? (
                  <Button icon="terminal" loading={waiting === "restart"} onClick={startSession}>
                    {waiting === "restart" ? "Starting…" : ins ? "Start again" : "Start (restarts the app)"}
                  </Button>
                ) : (
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setActive(false);
                      setWaiting("");
                      void drv.stopLogs();
                    }}
                  >
                    Stop
                  </Button>
                )}
              </Card>

              {noLogs && (
                <Notice tone="warn" title="No CleverTap logs yet">
                  Turn on debug logs in the app (<code className="font-mono">CleverTap.setDebugLevel(CleverTapLogLevel.debug.rawValue)</code> before autoIntegrate),
                  run it again from Xcode, then press Start again.
                </Notice>
              )}

              <CriticalEvents audit={audit} />

              <Card className="overflow-hidden">
                <Step first n="1" current={cur === "a"} title="App start" how="Automatic — we restart the app for you." ok={okA}
                  rows={ins ? [["App opened (App Launched)", yes(ins.appLaunchedFired)], ["Data reaching CleverTap", ins.queueSent ? "yes" : ins.queueFailed ? "failed" : "not yet"], ["APNs token", ins.pushToken ? "yes" : "not found"], ["Location", yes(ins.locationSent)]] : []}
                />
                <Step n="2" current={cur === "b"} title="Log in" how="In the app: log out, then log in again with your test user." ok={okB}
                  rows={ins || logins.length ? [
                    ["User identified", logins.length || identified.length ? "yes" : "not yet"],
                    ...(identified.at(-1) ? ([["Sent", ["Identity", "Email", "Phone", "Name"].filter((k) => identified.at(-1)!.keys.includes(k)).join(", ")], ["Phone format", identified.at(-1)!.phoneValid === undefined ? "no phone" : identified.at(-1)!.phoneValid ? "valid (+country code)" : "missing + / country code"]] as [string, string][]) : []),
                  ] : []}
                />
                <Step n="3" current={cur === "c"} title="Reopen while logged in (app update)" how="Stay logged in. We restart the app and check you're still identified, like after an app update." ok={okC}
                  rows={sc.relaunch ? [["Result", sc.relaunch.onUserLoginOnStart ? "identified on start ✓" : "not identified on start"]] : []}
                  action={
                    <Button size="sm" variant="secondary" icon="refresh" loading={waiting === "relaunch"} disabled={!active || !!waiting} onClick={relaunch}>
                      {waiting === "relaunch" ? "Watching (15 s)…" : "Restart the app for me"}
                    </Button>
                  }
                />
                <Step n="4" current={cur === "d"} title="Your custom events" how="Use the app like a customer: open a product, add to cart, buy… Each action appears here." ok={okD}
                  rows={(ins?.events ?? []).slice(0, 8).map((e) => [e.name, e.issues.length ? `⚠ ${e.issues[0]}` : "✓"])}
                />
                <Step n="5" current={cur === "e"} title="Tap a push with a link" how={`We send a push with this link. Tap it on the ${where} (swipe down from the top if the banner is gone) — we check CleverTap opens it.`} ok={okE}
                  rows={sc.linkTap ? [["Link", sc.linkTap.url], ["Opened", sc.linkTap.landed ?? "unknown"]] : waiting === "sending" ? [["Sending", "Sending the push…"]] : waiting === "tap" ? [["Sent", `Tap the notification on the ${where}…`]] : []}
                  action={
                    <div className="flex w-full flex-col gap-2">
                      <div className="flex w-full flex-wrap gap-2">
                        <input value={url} onChange={(e) => setUrl(e.target.value)} className="input min-w-0 flex-1 basis-64 font-mono" placeholder="https://… or myapp://screen" aria-label="Link to send in the push" />
                        <Button variant="secondary" icon="bell" loading={waiting === "sending" || waiting === "tap"}
                          disabled={!active || !!waiting || !url.trim() || (linkVia === "clevertap" && !!needCreds)} onClick={sendLink}>
                          {waiting === "sending" ? "Sending…" : waiting === "tap" ? "Waiting for your tap…" : sc.linkTap ? "Send another" : "Send push"}
                        </Button>
                        {waiting === "tap" && (
                          <Button variant="ghost" size="sm" onClick={() => setWaiting("")}>
                            Stop waiting
                          </Button>
                        )}
                      </div>
                      {drv.canSimulatePush && <Segmented value={linkVia} onChange={setLinkVia} options={[["simulated", "Simulated"], ["clevertap", "Through CleverTap"]]} small />}
                    </div>
                  }
                />
                <Step n="6" current={cur === "f"} title="See an in-app" how="On the CleverTap dashboard, create a test in-app for your test user (trigger: App Launched). Then press Restart." ok={okF}
                  rows={[["In-apps shown", String(ins?.inApp.shown ?? 0)], ...((ins?.inApp.errors ?? []).map((e) => ["Problem", e]) as [string, string][]), ...(ins?.inApp.blockedOnExcludedScreen ? ([["Suspended in-apps", "respected ✓"]] as [string, string][]) : [])]}
                  action={
                    <Button size="sm" variant="secondary" icon="refresh" loading={waiting === "restart"} disabled={!active || !!waiting} onClick={restartOnly}>
                      {waiting === "restart" ? "Restarting…" : "Restart the app"}
                    </Button>
                  }
                />
                {ins && (ins.push.received > 0 || ins.push.errors.length > 0 || ins.push.impressions > 0) && (
                  <Step n="✓" title="Pushes on this device" how="Filled in by itself whenever a push arrives." ok={ins.push.errors.length ? false : ins.push.received || ins.push.impressions ? true : undefined}
                    rows={[["Handled by CleverTap", String(ins.push.received)], ["Views recorded", String(ins.push.impressions)], ...(ins.push.errors.map((e) => ["Problem", e]) as [string, string][])]}
                  />
                )}
              </Card>
            </div>
          ) : (
            <div className="space-y-5">
              <Card className="p-6">
                <p className="text-[15px] text-text-2">Connect your iPhone first. Then do each action shown here — log in, restart, your custom events, a push with a link and an in-app.</p>
                {onNavigate && (
                  <div className="mt-4">
                    <Button iconRight="arrowRight" onClick={() => onNavigate("setup")}>
                      Connect your iPhone
                    </Button>
                  </div>
                )}
              </Card>
              <CriticalEvents audit={audit} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---------------- pieces ---------------- */

const yes = (b: boolean) => (b ? "yes" : "not seen");

function Section({ n, title, sub, children }: { n: number; title: string; sub?: string; children: ReactNode }) {
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

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-bold">{label}</span>
      {children}
      {hint && <span className="mt-1.5 block text-[13px] text-muted">{hint}</span>}
    </label>
  );
}

function Segmented<T extends string>({ value, onChange, options, small }: { value: T; onChange: (v: T) => void; options: [T, string][]; small?: boolean }) {
  return (
    <span className="inline-flex self-start rounded-lg border bg-surface-2 p-0.5" role="radiogroup">
      {options.map(([v, label]) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={value === v}
          onClick={() => onChange(v)}
          className={cx("rounded-md px-3 font-bold", small ? "min-h-8 text-[13px]" : "min-h-9 text-sm", value === v ? "bg-surface text-text shadow-[var(--shadow-md)]" : "text-muted hover:text-text")}
        >
          {label}
        </button>
      ))}
    </span>
  );
}

function TestUser({ tu, scanVersion }: { tu: TestUserRecord; scanVersion?: string }) {
  if (!tu.found)
    return (
      <Notice tone="fail" className="mt-4">
        No profile found for <b>{tu.identity}</b>. Log in on the iPhone with this user, then check again.
      </Notice>
    );
  const a = tu.android; // the verifier stores the audit platform's device here
  const rows: [string, string, boolean | undefined][] = [
    ["iOS device", a ? `${a.model ?? "Unknown model"} · iOS ${a.osVersion ?? "?"}` : "None on this profile", !!a],
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

function TargetConnect({
  bundleHint,
  executableHint,
  drv,
  app,
  onDriver,
  onApp,
  onError,
}: {
  bundleHint?: string;
  executableHint?: string;
  drv: IosDriver | null;
  app: IosApp | null;
  onDriver: (d: IosDriver) => void;
  onApp: (a: IosApp) => void;
  onError: (t: string) => void;
}) {
  const [token, setToken] = useState("");
  const [outdated, setOutdated] = useState(false);
  const [st, setSt] = useState<IosHelperStatus | null>(null);
  const [apps, setApps] = useState<IosApp[] | null>(null);
  const [booting, setBooting] = useState("");
  const [copied, setCopied] = useState(false);
  const [os, setOs] = useState<"mac" | "win">(() => (typeof navigator !== "undefined" && /Win/i.test(navigator.platform) ? "win" : "mac"));
  const used = useRef(false);
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const cmd =
    os === "win"
      ? `irm ${origin}/ct-ios-bridge.mjs -OutFile ct-ios-bridge.mjs; node ct-ios-bridge.mjs --origin ${origin}`
      : `curl -fsSL -o ct-ios-bridge.mjs ${origin}/ct-ios-bridge.mjs && node ct-ios-bridge.mjs --origin ${origin}`;

  // find the helper, then keep the device lists fresh. One connected iPhone (or,
  // without one, a single running Simulator) is used straight away.
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      let t = token;
      if (!t) {
        const h = await iosHelperHello();
        if (!alive || !h) return;
        setOutdated(h.version < IOS_HELPER_MIN_VERSION);
        if (h.version < IOS_HELPER_MIN_VERSION) return;
        t = h.token;
        setToken(t);
      }
      try {
        const s = await iosHelperStatus(t);
        if (!alive) return;
        setSt(s);
        if (used.current) return;
        const phones = (s.devices ?? []).filter((d) => d.state === "Connected");
        if (phones.length === 1) {
          used.current = true;
          onDriver(iosDriver(t, phones[0], s.tools));
        }
      } catch {
        if (alive) setToken(""); // helper restarted → new token
      }
    };
    void tick();
    const iv = setInterval(tick, drv ? 10_000 : 3000);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, [token, drv, onDriver]);

  // list the apps on the chosen device; pick the scanned one automatically
  useEffect(() => {
    if (!drv) return;
    let alive = true;
    const load = async () => {
      try {
        const list = await listIosApps(drv);
        if (!alive) return;
        setApps(list);
        if (!app) {
          const hit = list.find((a) => a.bundleId === bundleHint) ?? (!bundleHint && list.length === 1 ? list[0] : undefined);
          if (hit) onApp({ ...hit, executable: hit.executable ?? (hit.bundleId === bundleHint ? executableHint : undefined) });
        }
      } catch (e) {
        if (!alive) return;
        // an iPhone without devicectl can't list apps — go by the scanned build
        if (drv.isDevice && bundleHint && !app) {
          setApps([]);
          onApp({ bundleId: bundleHint, executable: executableHint });
        } else onError((e as Error).message.replace(NO_CONTROL, "").trim());
      }
    };
    void load();
    const iv = setInterval(load, app ? 30_000 : 4000);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, [drv, app, bundleHint, executableHint, onApp, onError]);

  const phones = st?.devices ?? [];
  const tools = st?.tools;

  const row = (t: IosTarget, sub: string, action: ReactNode) => (
    <div key={t.udid} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border px-4 py-3">
      <span className="flex flex-col">
        <b className="text-[15px]">{t.name}</b>
        <span className="text-sm text-muted">{sub}</span>
      </span>
      {drv?.udid === t.udid ? (
        <span className="flex items-center gap-2 text-sm font-bold" style={{ color: "var(--pass)" }}>
          <StatusMark status="pass" size={20} /> In use
        </span>
      ) : (
        action
      )}
    </div>
  );

  return (
    <div className="space-y-4">
      {outdated && (
        <Notice tone="warn" title="Your iOS helper is out of date">
          Stop it (Ctrl+C in its terminal) and run the command below again — it downloads the new version.
        </Notice>
      )}
      <div className="rounded-xl border p-4">
        {token ? (
          <div className="space-y-1.5">
            <span className="flex flex-wrap items-center gap-2.5 text-[15px] font-bold" style={{ color: "var(--pass)" }}>
              <StatusMark status="pass" size={22} /> The iOS helper is running
              {st?.xcode && <span className="font-normal text-muted">· {st.xcode}</span>}
            </span>
            {tools && (
              <ul className="space-y-0.5 pl-8 text-sm text-text-2">
                <li>
                  Open / close the app on an iPhone: {tools.control ? "yes (Xcode devicectl)" : "no — needs Xcode on a Mac; we'll ask you to do those steps"}
                </li>
                <li>
                  iPhone logs:{" "}
                  {tools.logs === "idevicesyslog" || tools.logs === "pymobiledevice3"
                    ? `live (${tools.logs})`
                    : tools.logs === "log collect"
                      ? "every few seconds, cable only (built into macOS)"
                      : "not available"}
                </li>
              </ul>
            )}
            {tools && tools.logs !== "idevicesyslog" && tools.logs !== "pymobiledevice3" && (
              <p className="pl-8 text-sm text-muted">
                For live logs over cable and Wi-Fi install one of these, then restart the helper:{" "}
                <code className="font-mono text-[13px]">brew install libimobiledevice</code> or{" "}
                <code className="font-mono text-[13px]">python3 -m pip install -U pymobiledevice3</code>
              </p>
            )}
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span className="text-[15px] font-bold">Paste this into {os === "win" ? "PowerShell" : "Terminal"}</span>
              <Segmented
                value={os}
                onChange={setOs}
                options={[
                  ["mac", "Mac"],
                  ["win", "Windows"],
                ]}
                small
              />
            </div>
            <p className="mt-1 text-sm text-muted">
              It needs Node.js{os === "mac" ? " and Xcode" : " and Apple Devices (or iTunes) plus pymobiledevice3"}. It only runs a fixed list of device commands and
              reads CleverTap&apos;s logs.
            </p>
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
            <p className="mt-3 text-sm text-muted">This page finds it by itself — keep the terminal open.</p>
          </>
        )}
      </div>

      {token && st && (
        <>
          {(
            <div className="space-y-2">
              {phones.length === 0 && (
                <p role="status" className="flex items-center gap-2.5 text-[15px] text-text-2">
                  <span className="pulse-dot h-2.5 w-2.5 rounded-full" style={{ background: "var(--brand)" }} />
                  Waiting for an iPhone — plug it in, unlock it and tap “Trust”. For Wi-Fi, pair it once with the cable (see “Before you start”).
                </p>
              )}
              {phones.map((p) =>
                row(
                  p,
                  `${p.os} · ${p.transport === "wifi" ? "Wi-Fi" : "USB"} · ${p.state === "Connected" ? "connected" : p.state.toLowerCase()}${p.developerMode === "disabled" ? " · Developer Mode off" : ""}`,
                  <Button size="sm" variant={drv ? "secondary" : "primary"} disabled={p.state !== "Connected"} onClick={() => onDriver(iosDriver(token, p, tools))}>
                    {p.state === "Not paired" ? "Tap “Trust” on the iPhone" : drv ? "Switch to this iPhone" : "Use this iPhone"}
                  </Button>,
                ),
              )}
              {phones.some((p) => p.developerMode === "disabled") && (
                <Notice tone="warn">Turn on Developer Mode on the iPhone (Settings → Privacy &amp; Security → Developer Mode), restart it, and come back.</Notice>
              )}
            </div>
          )}

        </>
      )}

      {drv && apps && (apps.length > 0 || !drv.isDevice) && (
        <div className="rounded-xl border p-4">
          <div className="text-[15px] font-bold">Your app on {drv.sim.name}</div>
          {apps.length === 0 ? (
            <p className="mt-1 text-sm text-muted">No apps of yours on this {drv.where} yet. In Xcode pick it as the run destination and press Run (▶︎).</p>
          ) : (
            <div className="mt-3 flex flex-wrap gap-2">
              {apps.map((a) => (
                <button
                  key={a.bundleId}
                  type="button"
                  onClick={() => onApp({ ...a, executable: a.executable ?? (a.bundleId === bundleHint ? executableHint : undefined) })}
                  aria-pressed={app?.bundleId === a.bundleId}
                  className={cx(
                    "inline-flex min-h-10 items-center gap-2 rounded-full border-[1.5px] px-4 text-sm font-bold transition",
                    app?.bundleId === a.bundleId ? "border-brand bg-brand-soft text-brand-text" : "border-[var(--border-strong)] bg-surface text-text-2 hover:bg-surface-2",
                  )}
                >
                  {app?.bundleId === a.bundleId && <Icon name="check" size={15} />}
                  {a.name ?? a.bundleId}
                  <span className="font-mono text-[12px] font-normal text-muted">{a.bundleId}</span>
                </button>
              ))}
            </div>
          )}
          {bundleHint && !apps.some((a) => a.bundleId === bundleHint) && apps.length > 0 && (
            <p className="mt-3 text-sm" style={{ color: "var(--warn)" }}>
              The scanned app ({bundleHint}) isn&apos;t on this {drv.where}. Install it (Xcode Run, TestFlight or your ad-hoc build), or pick another app.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function DeviceSummary({ f, scanBundle, insights }: { f: IosDeviceFindings; scanBundle?: string; insights?: LogInsights }) {
  const isDevice = f.target === "device";
  const where = isDevice ? "iPhone" : "Simulator";
  const perm = { granted: "Allowed", provisional: "Provisional", denied: "Turned off", "not-determined": "Never asked", unknown: isDevice ? "Check Settings → Notifications on the iPhone" : "Unknown" }[
    f.notificationPermission ?? "unknown"
  ];
  const rows: [string, string, boolean | undefined][] = [
    [
      `App on the ${where}`,
      `${f.app.name ?? f.app.bundleId} ${f.app.versionName ?? ""}${f.app.buildNumber ? ` (${f.app.buildNumber})` : ""}${f.app.matchesScan === false ? " — different from the scanned build" : ""}`,
      f.app.matchesScan ?? (scanBundle ? f.app.bundleId === scanBundle : undefined),
    ],
    ["Notifications", perm, f.notificationPermission === "granted" || f.notificationPermission === "provisional" ? true : f.notificationPermission === "unknown" || !f.notificationPermission ? undefined : false],
    ["APNs token", insights ? (insights.pushToken ? "Registered with CleverTap" : "Not found") : "—", insights ? insights.pushToken : undefined],
    ["CleverTap logs", insights ? (insights.lines ? `${insights.lines} lines · SDK ${insights.sdkVersion ?? "?"}` : "None yet — turn on debug logs") : "—", insights ? insights.lines > 0 : undefined],
  ];
  return (
    <Card className="p-6">
      <h3 className="text-lg font-bold">Your {where}</h3>
      <p className="mt-0.5 text-sm text-muted">
        {f.device.name}
        {f.device.model ? ` · ${f.device.model}` : ""} · {f.device.os}
        {isDevice ? ` · ${f.transport === "wifi" ? "Wi-Fi" : "USB"}` : ""}
      </p>
      <ul className="mt-4 divide-y rounded-xl border">
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
      {f.deepLinks.length > 0 && (
        <div className="mt-4 text-sm text-text-2">
          <div className="font-bold">URL schemes opened on the {where}</div>
          <ul className="mt-1 space-y-0.5 font-mono text-[13px]">
            {f.deepLinks.map((d) => (
              <li key={d.url}>
                {d.ok ? "✓" : "✗"} {d.url}
                {d.detail ? ` — ${d.detail}` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

function StateRow({
  first,
  label,
  tech,
  how,
  result,
  apiRecord,
  busy,
  disabled,
  onRun,
}: {
  first: boolean;
  label: string;
  tech: string;
  how: string;
  result?: IosPushTestResult;
  apiRecord?: TestPushRecord;
  busy: boolean;
  disabled: boolean;
  onRun: () => void;
}) {
  const status =
    result?.status === "delivered"
      ? result.via === "clevertap"
        ? { t: "Delivered", c: "var(--pass)", m: "pass" as const }
        : { t: "Shown (simulated)", c: "var(--pass)", m: "pass" as const }
      : result?.status === "not-delivered"
        ? { t: "Not shown", c: "var(--fail-text)", m: "fail" as const }
        : apiRecord?.status === "confirmed"
          ? { t: "Confirmed", c: "var(--pass)", m: "pass" as const }
          : apiRecord?.status === "failed"
            ? { t: "Send failed", c: "var(--fail-text)", m: "fail" as const }
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
        {result?.stateDetail && <p className="mt-1 text-sm text-muted">{result.stateDetail}</p>}
        {result?.status === "error" && result.detail && (
          <p className="mt-1 text-sm" style={{ color: "var(--fail-text)" }}>
            {result.detail}
          </p>
        )}
      </div>
      <Button variant={status?.m === "pass" ? "secondary" : "primary"} icon="bell" loading={busy} disabled={disabled} onClick={onRun}>
        {busy ? "Testing…" : status?.m === "pass" ? "Test again" : "Test"}
      </Button>
    </div>
  );
}

function Step({
  n,
  title,
  how,
  ok,
  rows,
  action,
  first,
  current,
}: {
  n: string;
  title: string;
  how: string;
  ok?: boolean;
  rows: [string, string][];
  action?: ReactNode;
  first?: boolean;
  current?: boolean;
}) {
  return (
    <div className={cx("flex gap-4 px-6 py-5 transition-colors", !first && "border-t")} style={current ? { background: "var(--brand-soft)" } : undefined}>
      {ok === true ? (
        <StatusMark status="pass" />
      ) : ok === false ? (
        <StatusMark status="warn" />
      ) : current ? (
        <StatusMark status="manual" />
      ) : (
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-[1.5px] border-[var(--border-strong)] text-[13px] font-bold text-muted-2">
          {n}
        </span>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="text-[17px] font-bold">{title}</span>
          {current && (
            <span className="rounded-full px-2.5 py-0.5 text-xs font-bold" style={{ background: "var(--brand)", color: "var(--brand-fg)" }}>
              Your turn
            </span>
          )}
          {ok === true && (
            <span className="text-sm font-bold" style={{ color: "var(--pass)" }}>
              Done
            </span>
          )}
        </div>
        <p className="mt-1 text-[15px] text-text-2">{how}</p>
        {rows.length > 0 && (
          <dl className="mt-3 max-w-xl divide-y rounded-xl border bg-surface">
            {rows.map(([k, v], i) => (
              <div key={`${k}-${i}`} className="flex justify-between gap-4 px-3.5 py-2 text-sm">
                <dt className="shrink-0 text-muted">{k}</dt>
                <dd className="truncate text-right font-semibold" title={v}>
                  {v}
                </dd>
              </div>
            ))}
          </dl>
        )}
        {action && <div className="mt-3">{action}</div>}
      </div>
    </div>
  );
}
