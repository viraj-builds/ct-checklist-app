"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { DeviceDriver } from "@/lib/device/drivers";
import { mergeInsights, parseCtLog, type LogInsights } from "@/lib/device/ctlog";
import type { LoggingState, LogScenarios } from "@/lib/device/types";
import { ctTags, detectOem, liftLogging, readyScreen } from "@/lib/device/oem";
import { parseProps } from "@/lib/device/runner";
import { Button, Card, Notice, StatusMark } from "@/components/ui";
import { cx } from "@/lib/format";

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
  accountId,
  beforeSteps,
}: {
  driver: DeviceDriver;
  pkg: string;
  initial?: Partial<LogSessionSave>;
  canSendPush: string; // "" when ready, otherwise the reason
  sendPush: (deepLink: string, marker: string) => Promise<void>;
  onSave: (s: LogSessionSave) => Promise<void>;
  autoStart?: boolean; // start listening as soon as the phone is connected
  accountId?: string; // CleverTap account — its log tag is pinned to verbose
  beforeSteps?: ReactNode; // shown between the Start bar and the steps (e.g. key events)
}) {
  const [active, setActive] = useState(false);
  const [starting, setStarting] = useState(false);
  const [ins, setIns] = useState<LogInsights | null>(initial?.logs ?? null);
  const [sc, setSc] = useState<LogScenarios>(initial?.logScenarios ?? {});
  const [restricted, setRestricted] = useState(!!initial?.logTagWasRestricted);
  const [waiting, setWaiting] = useState<"" | "relaunch" | "restart" | "sending" | "tap">("");
  const [url, setUrl] = useState("https://www.clevertap.com");
  const [err, setErr] = useState("");
  const [logging, setLogging] = useState<LoggingState | undefined>(initial?.logging);
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
          for (const tag of ctTags(accountId)) await driver.run({ t: "setTagLevel", tag, level: "V" }).catch(() => {});
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
  }, [noLines, zeroCause, driver, pkg, accountId]);
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
      const { state, restore } = await liftLogging(driver, oem, accountId);
      restoreRef.current = restore;
      setLogging(state);
      setRestricted(state.status === "lifted");
      await readyScreen(driver).catch(() => undefined); // wake the screen
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
    setWaiting("restart");
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
    setWaiting("sending");
    try {
      mark.current = (await read()).lines;
      tapMarker.current = Math.random().toString(36).slice(2, 10);
      tapSeenInShade.current = false;
      tapStartedAt.current = Date.now();
      await sendPush(url.trim(), tapMarker.current);
      setSc((s) => ({ ...s, linkTap: undefined })); // a new send replaces the last result
      setWaiting("tap");
    } catch (e) {
      setErr((e as Error).message);
      setWaiting("");
    }
  }

  const logins = ins?.onUserLogin ?? [];
  const identified = ins?.profilePushes.filter((p) => p.hasIdentity) ?? [];
  const customEvents = ins?.events ?? [];

  // one step at a time: the first unfinished step is highlighted
  const okA = ins ? ins.appLaunchedFired && ins.queueSent > 0 : undefined;
  const okB = logins.some((l) => l.kind !== "aborted" && l.kind !== "failed") || identified.length > 0 ? true : undefined;
  const okC = sc.relaunch ? sc.relaunch.onUserLoginOnStart : undefined;
  const okD = customEvents.length ? customEvents.every((e) => e.issues.length === 0) : undefined;
  const okE = sc.linkTap ? sc.linkTap.clicked && !!sc.linkTap.landed : undefined;
  const okF = ins?.inApp?.errors.length ? false : ins?.inApp?.shown ? true : undefined;
  const cur = !active ? "" : (["a", "b", "c", "d", "e", "f"] as const).find((k) => ({ a: okA, b: okB, c: okC, d: okD, e: okE, f: okF })[k] !== true) ?? "";

  return (
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
          <p className="mt-0.5 text-sm text-muted">Do each action below on the phone. We confirm it from the SDK logs. Nothing personal is saved.</p>
        </div>
        {!active ? (
          <Button icon="terminal" loading={starting} onClick={start}>
            {starting ? "Starting…" : ins ? "Start again" : "Start (restarts the app)"}
          </Button>
        ) : (
          <Button variant="secondary" onClick={stop}>
            Stop
          </Button>
        )}
      </Card>

      {logging?.status === "blocked" && (
        <Hint tone="fail" title="This phone needs one setting changed">
          {logging.fix}
        </Hint>
      )}
      {active && noLines && zeroCause === "not-running" && (
        <Hint title="The app wasn't running">We opened it again on the phone. Keep it open for a few seconds.</Hint>
      )}
      {active && noLines && zeroCause === "rehidden" && (
        <Hint title="One moment">This phone changed a setting by itself — we fixed it and restarted the app.</Hint>
      )}
      {active && logging?.status !== "blocked" && noLines && zeroCause === "sdk-off" && (
        <Hint tone="fail" title="Install a test build">
          The app on this phone has CleverTap&apos;s debug mode off, so we can&apos;t confirm these steps. Ask your developer for a test build with{" "}
          <code className="font-mono">setDebugLevel</code> on (Android <code className="font-mono">CleverTapAPI.LogLevel.VERBOSE</code>, Flutter /
          React Native <code className="font-mono">3</code>), install it, then press Start again.
        </Hint>
      )}
      {err && (
        <p className="text-sm" style={{ color: "var(--fail-text)" }}>
          {err}
        </p>
      )}

      {beforeSteps}

      <Card className="overflow-hidden">
        <Step
          first
          n="1"
          current={cur === "a"}
          title="App start"
          how="Automatic — we open the app for you."
          ok={okA}
          rows={
            ins
              ? [
                  ["App opened (App Launched)", yes(ins.appLaunchedFired)],
                  ["Data reaching CleverTap", ins.queueSent ? "yes" : ins.queueFailed ? "failed" : "not yet"],
                  ["Ready for push", yes(ins.pushToken)],
                  ["Location", yes(ins.locationSent)],
                ]
              : []
          }
        />
        <Step
          n="2"
          current={cur === "b"}
          title="Log in"
          how="In the app: log out, then log in again with your test user."
          ok={okB}
          rows={
            ins || logins.length
              ? [
                  ["User identified", logins.some((l) => l.kind !== "aborted" && l.kind !== "failed") ? "yes" : logins.length ? "failed" : "not yet"],
                  ...(identified.at(-1)
                    ? ([
                        ["Sent", ["Identity", "Email", "Phone", "Name"].filter((k) => identified.at(-1)!.keys.includes(k)).join(", ")],
                        ["Phone format", identified.at(-1)!.phoneValid === undefined ? "no phone" : identified.at(-1)!.phoneValid ? "valid (+country code)" : "missing + / country code"],
                      ] as [string, string][])
                    : []),
                ]
              : []
          }
        />
        <Step
          n="3"
          current={cur === "c"}
          title="Reopen while logged in (app update)"
          how="Stay logged in. We restart the app and check you're still identified, like after an app update."
          ok={okC}
          rows={sc.relaunch ? [["Result", sc.relaunch.onUserLoginOnStart ? "identified on start ✓" : "not identified on start"]] : []}
          action={
            <Button size="sm" variant="secondary" icon="refresh" loading={waiting === "relaunch"} disabled={!active || !!waiting} onClick={relaunch}>
              {waiting === "relaunch" ? "Watching (15 s)…" : "Restart the app for me"}
            </Button>
          }
        />
        <Step
          n="4"
          current={cur === "d"}
          title="Your key actions"
          how="Use the app like a customer: open a product, add to cart, buy… Each action appears here."
          ok={okD}
          rows={customEvents.slice(0, 8).map((e) => [e.name, e.issues.length ? `⚠ ${e.issues[0]}` : "✓"])}
        />
        <Step
          n="5"
          current={cur === "e"}
          title="Tap a push with a link"
          how="We send a push with this link. Tap it on the phone — we check where it opens."
          ok={okE}
          rows={
            sc.linkTap
              ? [
                  ["Link", sc.linkTap.url],
                  ["Opened", sc.linkTap.landed ? `${sc.linkTap.landed}${sc.linkTap.openedOutsideApp ? " (outside the app)" : ""}` : "unknown"],
                ]
              : waiting === "sending"
                ? [["Sending", "Asking CleverTap to send the push — this can take 10–20 s…"]]
                : waiting === "tap"
                  ? [["Sent", "Tap the notification on the phone…"]]
                  : []
          }
          action={
            <div className="flex w-full flex-wrap gap-2">
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                className="input min-w-0 flex-1 basis-64 font-mono"
                placeholder="https://… or myapp://screen"
                aria-label="Link to send in the push"
              />
              <Button
                variant="secondary"
                icon={waiting === "tap" ? "refresh" : "bell"}
                loading={waiting === "sending"}
                disabled={!active || (!!waiting && waiting !== "tap") || !!canSendPush || !url.trim()}
                onClick={sendLink}
              >
                {waiting === "sending" ? "Sending…" : waiting === "tap" ? "Sent — send again" : sc.linkTap ? "Send another" : "Send push"}
              </Button>
              {canSendPush && <span className="w-full text-sm text-muted">{canSendPush}</span>}
            </div>
          }
        />
        <Step
          n="6"
          current={cur === "f"}
          title="See an in-app"
          how="On the CleverTap dashboard, create a test in-app for your test user (trigger: App Launched). Then press Restart."
          ok={okF}
          rows={[
            ["In-apps shown", String(ins?.inApp?.shown ?? 0)],
            ...((ins?.inApp?.errors ?? []).map((e) => ["Problem", e]) as [string, string][]),
            ...(ins?.inApp?.blockedOnExcludedScreen ? ([["Excluded screen", "respected ✓"]] as [string, string][]) : []),
          ]}
          action={
            <Button size="sm" variant="secondary" icon="refresh" loading={waiting === "restart"} disabled={!active || !!waiting} onClick={restartOnly}>
              {waiting === "restart" ? "Restarting…" : "Restart the app"}
            </Button>
          }
        />
        {ins?.push && (ins.push.received > 0 || ins.push.errors.length > 0) && (
          <Step
            n="✓"
            title="Pushes on this phone"
            how="Filled in by itself whenever a push arrives."
            ok={ins.push.errors.length || ins.push.fallbackChannel ? false : ins.push.rendered > 0 ? true : undefined}
            rows={[
              ["Received", String(ins.push.received)],
              ["Shown", String(ins.push.rendered)],
              ["Channel", ins.push.fallbackChannel ? "app's channel missing (default used)" : ins.push.channels.join(", ") || "—"],
              ["Views recorded", String(ins.push.impressions)],
              ...(ins.push.errors.map((e) => ["Problem", e]) as [string, string][]),
            ]}
          />
        )}
      </Card>
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
  current,
  first,
}: {
  n: string;
  title: string;
  how: string;
  ok?: boolean;
  current?: boolean;
  first?: boolean;
  rows: [string, string][];
  action?: React.ReactNode;
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
            {rows.map(([k, v]) => (
              <div key={k} className="flex justify-between gap-4 px-3.5 py-2 text-sm">
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

function Hint({ title, children, tone }: { title: string; children: ReactNode; tone?: "fail" }) {
  return (
    <Notice tone={tone === "fail" ? "fail" : "info"} title={title}>
      {children}
    </Notice>
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
