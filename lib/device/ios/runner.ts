"use client";

// iOS push tests and deep-link checks on a real iPhone or the Simulator,
// driven through the iOS helper. A push test: put the app in the state, send a
// push carrying a random marker (through CleverTap, or — Simulator only — a
// local `simctl push`), then watch for it:
//   Simulator → the marker in the delivered-notifications store
//   iPhone    → SpringBoard / apsd logging a push for the app, the marker in
//               the SDK log, or the tester confirming they see it
// When the helper can't open/close apps (no Xcode devicectl), the tester is
// asked to do that step on the iPhone.

import type { AppState } from "../types";
import { NO_CONTROL, type IosDriver } from "./bridge";
import type { IosPushTestResult } from "./types";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const WAIT_MS = 60_000;

export type IosSendMode = "clevertap" | "simulated";

/** CleverTap-shaped payload for a local test push (no APNs involved). */
export function simulatedPayload(marker: string, accountId: string | undefined, deepLink?: string) {
  return {
    aps: {
      alert: { title: "CleverTap integration test (simulated)", body: `If you can see this, the app shows CleverTap pushes [${marker}]` },
      sound: "default",
      "mutable-content": 1,
    },
    wzrk_pn: true,
    wzrk_id: "0_0", // CleverTap's id for test pushes
    wzrk_pivot: "wzrk_default",
    ...(accountId ? { wzrk_acct_id: accountId } : {}),
    ...(deepLink ? { wzrk_dl: deepLink } : {}),
  };
}

/** Ask the tester to do something on the iPhone; resolves when they press Done. */
export type AskUser = (text: string) => Promise<void>;

async function pid(d: IosDriver, bundleId: string): Promise<string | null> {
  try {
    return (await d.run({ t: "pid", bundleId })).trim();
  } catch (e) {
    if ((e as Error).message.startsWith(NO_CONTROL)) return null; // can't tell
    throw e;
  }
}

const MANUAL: Record<AppState, string> = {
  foreground: "Open the app on the iPhone and keep it on screen, then press Done.",
  background: "Open the app on the iPhone, then go to the Home Screen (swipe up) so it's in the background. Then press Done.",
  killed: "Swipe the app away in the app switcher (swipe up and hold, then flick the app up). Then press Done.",
};

/** Put the app into `state`, send a push, wait for it to show up. */
export async function runIosPushTest(
  d: IosDriver,
  bundleId: string,
  state: AppState,
  send: (marker: string) => Promise<void>,
  onStep: (s: string) => void,
  opts: { via: IosSendMode; logHas?: (marker: string) => boolean; ask: AskUser; userSaw?: () => boolean },
): Promise<IosPushTestResult> {
  let verifiedState = false;
  let stateDetail = "";
  try {
    if (!d.canControl) {
      await opts.ask(MANUAL[state]);
      verifiedState = true; // the tester set it up
      stateDetail = `${state === "foreground" ? "app on screen" : state === "background" ? "app in background" : "app closed"} (set by the tester)`;
    } else if (state === "killed") {
      onStep(`Closing the app on the ${d.where}`);
      await d.run({ t: "terminate", bundleId });
      await sleep(1500);
      const p = await pid(d, bundleId);
      verifiedState = p === "";
      stateDetail = p ? "app still running" : "app not running";
    } else {
      onStep(`Opening the app on the ${d.where}`);
      await d.run({ t: "launch", bundleId });
      await sleep(3000);
      if (state === "background") {
        onStep("Sending the app to the background");
        await d.run({ t: "background", bundleId });
        await sleep(2000);
      }
      const p = await pid(d, bundleId);
      verifiedState = !!p;
      stateDetail = `${state === "foreground" ? "app on screen" : "app in background (Settings in front)"} · process ${p ? "running" : "not running"}`;
    }
  } catch (e) {
    const msg = (e as Error).message.replace(NO_CONTROL, "").trim();
    // the iPhone refused (e.g. a release build can't be opened from a Mac) — let the tester do it
    if (d.isDevice) {
      try {
        await opts.ask(`${MANUAL[state]} (${msg})`);
        verifiedState = true;
        stateDetail = `${state} (set by the tester)`;
      } catch {
        return { status: "error", via: opts.via, verifiedState, stateDetail, sentAt: Date.now(), detail: msg };
      }
    } else return { status: "error", via: opts.via, verifiedState, stateDetail, sentAt: Date.now(), detail: msg };
  }

  const marker = Math.random().toString(36).slice(2, 10);
  const sentAt = Date.now();
  try {
    onStep(opts.via === "clevertap" ? "Sending a test push through CleverTap" : "Delivering a simulated CleverTap push");
    await send(marker);
  } catch (e) {
    return { status: "error", via: opts.via, verifiedState, stateDetail, sentAt, detail: (e as Error).message };
  }

  onStep(d.isDevice ? "Watching the iPhone for the push — press “I see it” when it appears" : "Watching the Simulator for the push");
  while (Date.now() - sentAt < WAIT_MS) {
    await sleep(2000);
    const done = (seenIn: IosPushTestResult["seenIn"]): IosPushTestResult => ({ status: "delivered", via: opts.via, verifiedState, stateDetail, sentAt, deliveredAfterMs: Date.now() - sentAt, seenIn });
    try {
      if (d.isDevice) {
        if (await d.run({ t: "pushSeen", bundleId, since: sentAt - 2000 })) return done("log");
      } else if ((await d.run({ t: "findNotification", marker })).includes(marker)) return done("shade");
    } catch {
      /* keep waiting */
    }
    if (opts.logHas?.(marker)) return done("log");
    if (opts.userSaw?.()) return done("user");
  }
  return {
    status: "not-delivered",
    via: opts.via,
    verifiedState,
    stateDetail,
    sentAt,
    detail: `No notification from the app appeared within 60 s.`,
  };
}

/** Open each URL-scheme deep link on the device. */
export async function runIosDeepLinks(d: IosDriver, bundleId: string, urls: string[]) {
  const out: { url: string; ok: boolean; detail?: string }[] = [];
  if (!d.canControl) return out;
  for (const url of urls) {
    try {
      await d.run({ t: "openUrl", url, bundleId });
      await sleep(1500);
      const p = await pid(d, bundleId);
      const running = p !== "";
      out.push({ url, ok: running, detail: running ? undefined : "The link opened, but the app isn't running afterwards." });
    } catch (e) {
      const msg = (e as Error).message;
      out.push({ url, ok: false, detail: /LSApplicationWorkspace|No application|unable to find|-10814/i.test(msg) ? `No app on the ${d.where} handles this link.` : msg.slice(0, 160) });
    }
  }
  return out;
}
