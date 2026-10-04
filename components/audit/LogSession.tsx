"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { DeviceDriver } from "@/lib/device/drivers";
import { mergeInsights, parseCtLog, type LogInsights } from "@/lib/device/ctlog";
import type { LoggingState, LogScenarios } from "@/lib/device/types";
import { detectOem, liftLogging, readyScreen } from "@/lib/device/oem";
import { parseProps } from "@/lib/device/runner";
import { Button } from "@/components/ui";
import { Icon } from "@/components/Icon";

// Guided checks driven by the CleverTap SDK's own verbose logs: the user does
// something in the app, we read logcat over ADB and tick the item.

const POLL_MS = 4000;
const RELAUNCH_WAIT_MS = 15_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface LogSessionSave {
  logs: LogInsights;
  logScenarios: LogScenarios;
  logTagWasRestricted: boolean;
  logging?: LoggingState;
}

// If the phone shows logs but the app prints no CleverTap line this long after
// a restart, the build itself has SDK logging off.
const NO_SDK_LOGS_AFTER_MS = 15_000;

export function LogSession({
  driver,
  pkg,
  initial,
  canSendPush,
  sendPush,
  onSave,
  autoStart,
}: {
  driver: DeviceDriver;
  pkg: string;
  initial?: Partial<LogSessionSave>;
  canSendPush: string; // "" when ready, otherwise the reason
  sendPush: (deepLink: string, marker: string) => Promise<void>;
  onSave: (s: LogSessionSave) => Promise<void>;
  autoStart?: boolean; // start listening as soon as the phone is connected
}) {
  const [active, setActive] = useState(false);
  const [starting, setStarting] = useState(false);
  const [ins, setIns] = useState<LogInsights | null>(initial?.logs ?? null);
  const [sc, setSc] = useState<LogScenarios>(initial?.logScenarios ?? {});
  const [restricted, setRestricted] = useState(!!initial?.logTagWasRestricted);
  const [waiting, setWaiting] = useState<"" | "relaunch" | "tap">("");
  const [url, setUrl] = useState("https://www.clevertap.com");
  const [err, setErr] = useState("");
  const [logging, setLogging] = useState<LoggingState | undefined>(initial?.logging);
  const [locked, setLocked] = useState(false);
  const [startedAt, setStartedAt] = useState(0);
  const [now, setNow] = useState(0);
  const restoreRef = useRef<(() => Promise<void>) | null>(null);
  const tickN = useRef(0);
  const origTag = useRef<string | null>(null); // the phone's own log.tag, restored on Stop
  // why no CleverTap lines arrived: checked before blaming the build
  const [zeroCause, setZeroCause] = useState<"" | "checking" | "not-running" | "rehidden" | "sdk-off">("");
  const mark = useRef(0); // log line where the current scenario started
  const savedJson = useRef("");
  const earlier = useRef<LogInsights | undefined>(initial?.logs); // results from previous sessions are kept
  const tapMarker = useRef("");
  const tapSeenInShade = useRef(false);
  const tapStartedAt = useRef(0);

  const read = async () => parseCtLog(await driver.run({ t: "ctLogcat" }));

  // Start by itself a few seconds after connecting (after the device checks).
  const autoStarted = useRef(false);
  useEffect(() => {
    if (!autoStart || autoStarted.current) return;
    autoStarted.current = true;
    const t = setTimeout(() => void start(), 4000);
    return () => clearTimeout(t);
  }, [autoStart]); // eslint-disable-line react-hooks/exhaustive-deps

  // Poll the logs while the session is running.
  useEffect(() => {
    if (!active) return;
    let alive = true;
    const tick = async () => {
      try {
        if (tickN.current++ % 3 === 0) {
          const tag = (await driver.run({ t: "getLogTag" })).trim();
          if (/^[IWEFAS]/i.test(tag)) {
            // the phone hid debug logs again (vivo changes log.tag on its own) — lift it again
            if (origTag.current === null) origTag.current = tag;
            await driver.run({ t: "setLogTag", level: "V" });
            setRestricted(true);
          }
        }
        const next = await read();
        if (!alive) return;
        setIns(mergeInsights(earlier.current, next));
        // tap scenario. A link to a website opens the browser straight from the
        // notification and the SDK logs no "Notification Clicked", so we also
        // watch our push leave the notification shade and see what's on screen.
        if (waiting === "tap") {
          const click = next.clicks.find((c) => c.line >= mark.current);
          const inShade = (await driver.run({ t: "findNotification", marker: tapMarker.current })).includes(tapMarker.current);
          if (inShade) tapSeenInShade.current = true;
          const tapped = !!click || (tapSeenInShade.current && !inShade);
          if (tapped) {
            await sleep(2500);
            const landed = topActivity(await driver.run({ t: "focus" }));
            setSc((s) => ({
              ...s,
              linkTap: { at: Date.now(), url, clicked: true, landed, openedOutsideApp: landed ? !landed.startsWith(pkg + "/") : undefined },
            }));
            setWaiting("");
          } else if (Date.now() - tapStartedAt.current > 3 * 60_000) {
            setWaiting("");
            setErr("No tap seen in 3 minutes. Send the push again and tap it on the phone.");
          }
        }
      } catch (e) {
        setErr((e as Error).message);
      }
    };
    tick();
    const t = setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [active, waiting, url, pkg]); // eslint-disable-line react-hooks/exhaustive-deps

  // Save whenever the findings change (debounced).
  useEffect(() => {
    if (!ins) return;
    const payload: LogSessionSave = { logs: ins, logScenarios: sc, logTagWasRestricted: restricted, logging };
    const json = JSON.stringify(payload);
    if (json === savedJson.current) return;
    const t = setTimeout(() => {
      savedJson.current = json;
      onSave(payload).catch(() => {});
    }, 2500);
    return () => clearTimeout(t);
  }, [ins, sc, restricted, logging, onSave]);

  // No CleverTap line yet? Find out why before blaming the build.
  const noLines = active && ins?.lines === 0 && now - startedAt > NO_SDK_LOGS_AFTER_MS;
  useEffect(() => {
    if (!noLines || zeroCause) return;
    let alive = true;
    void (async () => {
      setZeroCause("checking");
      try {
        if (!(await driver.run({ t: "pidof", pkg })).trim()) {
          await driver.run({ t: "launch", pkg });
          if (alive) setZeroCause("not-running");
          return;
        }
        const marker = Math.random().toString(36).slice(2, 10);
        if (!(await driver.run({ t: "logProbe", marker })).includes(`V/CTAuditProbe`)) {
          if (origTag.current === null) origTag.current = (await driver.run({ t: "getLogTag" })).trim();
          await driver.run({ t: "setLogTag", level: "V" });
          await driver.run({ t: "forceStop", pkg });
          await driver.run({ t: "launch", pkg });
          if (alive) setZeroCause("rehidden");
          return;
        }
        if (alive) setZeroCause("sdk-off");
      } catch {
        if (alive) setZeroCause("");
      }
    })();
    return () => {
      alive = false;
    };
  }, [noLines, zeroCause, driver, pkg]);
  // after a fix attempt, look again if still nothing arrives
  useEffect(() => {
    if (zeroCause !== "not-running" && zeroCause !== "rehidden") return;
    const t = setTimeout(() => setZeroCause(""), 20_000);
    return () => clearTimeout(t);
  }, [zeroCause]);
  // lines arrived → forget the diagnosis
  if (zeroCause && zeroCause !== "checking" && ins && ins.lines > 0) setZeroCause("");

  // a clock for the "no SDK logs yet" hint
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 3000);
    return () => clearInterval(t);
  }, [active]);

  // Restore the phone's log setting when leaving the page.
  useEffect(
    () => () => {
      void restoreRef.current?.();
      if (origTag.current !== null) void driver.run({ t: "setLogTag", level: origTag.current }).catch(() => {});
    },
    [driver],
  );

  async function start() {
    setStarting(true);
    setErr("");
    try {
      // Phone makers hide debug logs in different ways (log.tag on vivo/Oppo,
      // "Logger buffer: Off", tiny buffers, Huawei's INFO-only logging). We test
      // the phone with a probe line, lift what can be lifted for this session
      // only, and put everything back on Stop.
      await restoreRef.current?.();
      const oem = detectOem(parseProps(await driver.run({ t: "props" })));
      const { state, restore } = await liftLogging(driver, oem);
      restoreRef.current = restore;
      setLogging(state);
      setRestricted(state.status === "lifted");
      const scr = await readyScreen(driver).catch(() => undefined);
      setLocked(!!scr?.locked);
      await driver.run({ t: "logcatClear" });
      await driver.run({ t: "forceStop", pkg });
      await driver.run({ t: "launch", pkg });
      setStartedAt(Date.now());
      setNow(Date.now());
      setActive(true);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setStarting(false);
    }
  }

  async function stop() {
    setActive(false);
    setWaiting("");
    await restoreRef.current?.();
    restoreRef.current = null;
    if (origTag.current !== null) {
      await driver.run({ t: "setLogTag", level: origTag.current }).catch(() => {});
      origTag.current = null;
    }
  }

  async function relaunch() {
    setErr("");
    setWaiting("relaunch");
    try {
      mark.current = (await read()).lines;
      await driver.run({ t: "forceStop", pkg });
      await driver.run({ t: "launch", pkg });
      await sleep(RELAUNCH_WAIT_MS);
      const after = (await read()).onUserLogin.filter((l) => l.line >= mark.current);
      setSc((s) => ({ ...s, relaunch: { at: Date.now(), onUserLoginOnStart: after.length > 0, kinds: after.map((a) => a.kind) } }));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setWaiting("");
    }
  }

  async function restartOnly() {
    setErr("");
    setWaiting("relaunch");
    try {
      await driver.run({ t: "forceStop", pkg });
      await driver.run({ t: "launch", pkg });
      await sleep(8000);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setWaiting("");
    }
  }

  async function sendLink() {
    setErr("");
    try {
      mark.current = (await read()).lines;
      tapMarker.current = Math.random().toString(36).slice(2, 10);
      tapSeenInShade.current = false;
      tapStartedAt.current = Date.now();
      await sendPush(url.trim(), tapMarker.current);
      setWaiting("tap");
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  const logins = ins?.onUserLogin ?? [];
  const identified = ins?.profilePushes.filter((p) => p.hasIdentity) ?? [];
  const customEvents = ins?.events ?? [];

  return (
    <div className="space-y-3">
      <p className="text-xs leading-relaxed text-muted">
        Reads CleverTap&apos;s own logs from the phone while you use the app — needs{" "}
        <code className="font-mono">CleverTapAPI.setDebugLevel(VERBOSE)</code> (or <code className="font-mono">setDebugLevel(3)</code> in
        Flutter/RN) in the build. Nothing personal is saved: profile values are reduced to key names.
      </p>

      {!active ? (
        <Button size="sm" icon="terminal" disabled={starting} onClick={start}>
          {starting ? "Starting…" : ins ? "Start a new log session" : "Start log session (restarts the app)"}
        </Button>
      ) : (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="flex items-center gap-1.5 font-medium" style={{ color: "var(--pass)" }}>
            <span className="h-2 w-2 animate-pulse rounded-full" style={{ background: "var(--pass)" }} /> Listening to CleverTap logs
            {ins ? ` · ${ins.lines} lines` : ""}
          </span>
          <Button size="sm" variant="ghost" onClick={stop}>
            Stop
          </Button>
        </div>
      )}
      {restricted && (
        <p className="text-[11px] text-muted">
          This phone hides debug logs{logging?.logTag ? <> (system setting <code className="font-mono">log.tag={logging.logTag}</code>)</> : null}.
          We lifted it for this session and put it back when you press Stop.
        </p>
      )}
      {logging?.status === "blocked" && (
        <Hint tone="fail" title="This phone is hiding the logs we need">
          {logging.fix}
        </Hint>
      )}
      {active && locked && <Hint title="Unlock the phone">Keep it unlocked with the screen on — in-apps and taps can&apos;t happen on the lock screen.</Hint>}
      {active && noLines && zeroCause === "not-running" && (
        <Hint title="The app wasn't running">We opened it again on the phone. Keep it open — logs should appear in a few seconds.</Hint>
      )}
      {active && noLines && zeroCause === "rehidden" && (
        <Hint title="The phone hid the logs again">
          Some phones (vivo) switch debug logs off by themselves. We switched them back on and restarted the app — logs should appear in a few
          seconds.
        </Hint>
      )}
      {active && logging?.status !== "blocked" && noLines && zeroCause === "sdk-off" && (
        <Hint tone="fail" title="The app isn't printing CleverTap logs">
          The phone shows logs, but this build has CleverTap logging off. Add this before CleverTap starts, install that build, then press Start
          again: Android <code className="font-mono">CleverTapAPI.setDebugLevel(CleverTapAPI.LogLevel.VERBOSE)</code> · Flutter{" "}
          <code className="font-mono">CleverTapPlugin.setDebugLevel(3)</code> · React Native{" "}
          <code className="font-mono">CleverTap.setDebugLevel(3)</code>.
        </Hint>
      )}
      {err && <p className="text-xs" style={{ color: "var(--fail)" }}>{err}</p>}

      {(active || ins) && (
        <div className="grid gap-2 md:grid-cols-2">
          <Step
            n="a"
            title="App start"
            how="Automatic — we restarted the app."
            ok={ins ? ins.appLaunchedFired && ins.queueSent > 0 : undefined}
            rows={
              ins
                ? [
                    ["SDK", ins.sdkVersion ? `v${ins.sdkVersion}${ins.wrapper ? ` · ${ins.wrapper.lib} plugin ${ins.wrapper.version ?? ""}` : ""}` : "—"],
                    ["Account / region", `${ins.accountId ?? "—"} · ${ins.region ?? "—"}`],
                    ["Lifecycle registered", yes(ins.lifecycleRegistered)],
                    ["App Launched fired", yes(ins.appLaunchedFired)],
                    ["Data sent to CleverTap", ins.queueSent ? `yes (${ins.queueSent}×)` : ins.queueFailed ? "FAILED" : "not yet"],
                    ["Push token", yes(ins.pushToken)],
                    ["Location sent", yes(ins.locationSent)],
                  ]
                : []
            }
          />
          <Step
            n="b"
            title="Log in"
            how="In the app: log out, then log in again with your test user."
            ok={logins.some((l) => l.kind !== "aborted" && l.kind !== "failed") || identified.length > 0 ? true : undefined}
            rows={[
              ["onUserLogin calls", logins.length ? logins.map((l) => l.kind).join(", ") : "none yet"],
              ...(identified.at(-1)
                ? ([
                    ["Profile keys sent", identified.at(-1)!.keys.join(", ")],
                    ["Phone format", identified.at(-1)!.phoneValid === undefined ? "no phone" : identified.at(-1)!.phoneValid ? "valid (+country code)" : "INVALID"],
                  ] as [string, string][])
                : []),
            ]}
          />
          <Step
            n="c"
            title="Reopen while logged in (app update)"
            how="Stay logged in. We restart the app and watch for onUserLogin on start."
            ok={sc.relaunch ? sc.relaunch.onUserLoginOnStart : undefined}
            rows={sc.relaunch ? [["Result", sc.relaunch.onUserLoginOnStart ? `called on start (${sc.relaunch.kinds.join(", ")})` : "NOT called on start"]] : []}
            action={
              <Button size="sm" variant="secondary" icon="refresh" disabled={!active || !!waiting} onClick={relaunch}>
                {waiting === "relaunch" ? "Watching (15 s)…" : "Restart the app for me"}
              </Button>
            }
          />
          <Step
            n="d"
            title="Your key actions"
            how="Use the app like a customer: open a product, add to cart, buy… Events appear here live."
            ok={customEvents.length ? customEvents.every((e) => e.issues.length === 0) : undefined}
            rows={customEvents.slice(0, 8).map((e) => [
              `${e.name} ×${e.count}`,
              e.issues.length
                ? `⚠ ${e.issues.join("; ")}`
                : Object.entries(e.props)
                    .slice(0, 4)
                    .map(([k, t]) => `${k}:${t.join("/")}`)
                    .join(", ") || "no properties",
            ])}
          />
          <Step
            n="e"
            title="Tap a push with a link"
            how="We send a push with this link. Tap it on the phone — we check where it opens."
            ok={sc.linkTap ? sc.linkTap.clicked && !!sc.linkTap.landed : undefined}
            rows={
              sc.linkTap
                ? [
                    ["Link", sc.linkTap.url],
                    ["Opened", sc.linkTap.landed ? `${sc.linkTap.landed}${sc.linkTap.openedOutsideApp ? " (outside the app)" : ""}` : "unknown"],
                  ]
                : waiting === "tap"
                  ? [["Waiting", "Tap the notification on the phone…"]]
                  : []
            }
            action={
              <div className="flex w-full flex-wrap gap-2">
                <input value={url} onChange={(e) => setUrl(e.target.value)} className="input min-w-0 flex-1 font-mono text-xs" placeholder="https://… or myapp://screen" />
                <Button size="sm" variant="secondary" icon="bell" disabled={!active || !!waiting || !!canSendPush || !url.trim()} onClick={sendLink}>
                  Send push
                </Button>
                {canSendPush && <span className="w-full text-[11px] text-muted">{canSendPush}</span>}
              </div>
            }
          />
          <Step
            n="f"
            title="See an in-app"
            how="On the CleverTap dashboard, create a test in-app for your test user (trigger: App Launched). Then press Restart."
            ok={ins?.inApp?.errors.length ? false : ins?.inApp?.shown || ins?.inApp?.impressions ? true : undefined}
            rows={[
              ["In-apps shown", String(ins?.inApp?.shown ?? 0)],
              ...((ins?.inApp?.errors ?? []).map((e) => ["Problem", e]) as [string, string][]),
              ...(ins?.inApp?.blockedOnExcludedScreen ? ([["Excluded screen", "respected ✓"]] as [string, string][]) : []),
            ]}
            action={
              <Button size="sm" variant="secondary" icon="refresh" disabled={!active || !!waiting} onClick={restartOnly}>
                {waiting === "relaunch" ? "Restarting…" : "Restart the app"}
              </Button>
            }
          />
          {ins?.push && (ins.push.received > 0 || ins.push.errors.length > 0) && (
            <Step
              n="✓"
              title="Pushes on this phone (automatic)"
              how="Filled in from the SDK logs whenever a push arrives."
              ok={ins.push.errors.length || ins.push.fallbackChannel ? false : ins.push.rendered > 0 ? true : undefined}
              rows={[
                ["Received by the SDK", String(ins.push.received)],
                ["Shown", String(ins.push.rendered)],
                ["Channel", ins.push.fallbackChannel ? `fallback “${ins.push.fallbackChannel}” — app's channel missing` : ins.push.channels.join(", ") || "—"],
                ["Impressions recorded", String(ins.push.impressions)],
                ...(ins.push.errors.map((e) => ["Problem", e]) as [string, string][]),
              ]}
            />
          )}
          {ins && ins.errors.length > 0 && (
            <div className="rounded-xl border p-3 text-xs md:col-span-2">
              <div className="mb-1 font-semibold" style={{ color: "var(--fail)" }}>
                CleverTap errors in the log
              </div>
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-muted">{ins.errors.join("\n")}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const yes = (b: boolean) => (b ? "yes" : "not seen");

function Step({
  n,
  title,
  how,
  ok,
  rows,
  action,
}: {
  n: string;
  title: string;
  how: string;
  ok?: boolean;
  rows: [string, string][];
  action?: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-semibold">
          <span className="mr-1.5 text-muted">{n}.</span>
          {title}
        </span>
        {ok === true ? (
          <Icon name="check" size={16} style={{ color: "var(--pass)" }} />
        ) : ok === false ? (
          <Icon name="alert" size={16} style={{ color: "var(--warn)" }} />
        ) : (
          <Icon name="clock" size={15} className="text-muted" />
        )}
      </div>
      <p className="mt-0.5 text-[11px] text-muted">{how}</p>
      {rows.length > 0 && (
        <dl className="mt-2 space-y-0.5 text-[11.5px]">
          {rows.map(([k, v]) => (
            <div key={k} className="flex justify-between gap-3">
              <dt className="shrink-0 text-muted">{k}</dt>
              <dd className="truncate text-right font-medium" title={v}>
                {v}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

function Hint({ title, children, tone }: { title: string; children: ReactNode; tone?: "fail" }) {
  return (
    <div
      className="rounded-lg px-3 py-2 text-xs"
      style={{ background: tone === "fail" ? "var(--fail-soft)" : "var(--manual-soft)" }}
    >
      <b style={{ color: tone === "fail" ? "var(--fail)" : undefined }}>{title}.</b> {children}
    </div>
  );
}

// "u0 com.android.chrome/org.chromium.chrome.browser.ChromeTabbedActivity t12" → package/activity on screen
function topActivity(focus: string): string | undefined {
  const pick = (re: RegExp) => focus.match(re)?.[1];
  return (
    pick(/topResumedActivity=ActivityRecord\{\S+ u\d+ (\S+\/\S+)/) ??
    pick(/mResumedActivity: ActivityRecord\{\S+ u\d+ (\S+\/\S+)/) ??
    pick(/mCurrentFocus=Window\{\S+ \S+ ([^}\s]+\/[^}\s]+)\}/)
  );
}
