"use client";

import type { DeviceDriver } from "./drivers";
import { checkBackground, checkLogging, detectOem, readyScreen } from "./oem";
import type { AppState, DeviceFindings, PushTestResult } from "./types";

// ---------------------------------------------------------------------------
// Live-device checks over ADB. Everything here reads standard Android shell
// output (getprop / dumpsys / logcat), so it works the same over WebUSB and
// the local helper.
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Extra checks differ between phone makers / Android versions — one failing
// must never stop the rest.
async function soft<T>(p: Promise<T>): Promise<T | undefined> {
  try {
    return await p;
  } catch {
    return undefined;
  }
}

export interface DeviceContext {
  pkg: string;
  scanVersionName?: string;
  targetSdk?: number;
  deepLinks: string[]; // from the manifest scan
}

export async function runDeviceChecks(
  d: DeviceDriver,
  ctx: DeviceContext,
  onStep: (s: string) => void,
): Promise<Omit<DeviceFindings, "pushTests" | "deepLinks">> {
  onStep("Reading device info");
  const props = parseProps(await d.run({ t: "props" }));
  const sdk = Number(props["ro.build.version.sdk"]) || undefined;
  const oem = detectOem(props);

  onStep("Checking the installed app");
  const pkgOut = await d.run({ t: "package", pkg: ctx.pkg });
  const installed = pkgOut.includes(`Package [${ctx.pkg}]`);
  const versionName = pkgOut.match(/versionName=([^\s]+)/)?.[1];
  const versionCode = pkgOut.match(/versionCode=(\d+)/)?.[1];
  const perm = pkgOut.match(/android\.permission\.POST_NOTIFICATIONS: granted=(true|false)/)?.[1];
  const notificationPermission: DeviceFindings["notificationPermission"] =
    sdk && sdk < 33 ? "not-required" : perm === "true" ? "granted" : perm === "false" ? "denied" : installed ? "denied" : "unknown";

  onStep("Reading notification channels");
  const channels = parseChannels((await soft(d.run({ t: "notifications" }))) ?? "", ctx.pkg);

  onStep("Reading CleverTap logs");
  const ctLogs = parseCtLogs((await soft(d.run({ t: "logcat", lines: 6000 }))) ?? "");

  onStep("Checking what this phone allows");
  const logging = await soft(checkLogging(d, oem));
  const background = installed ? await soft(checkBackground(d, ctx.pkg, oem)) : undefined;
  const screen = await soft(readyScreen(d));

  return {
    connectedVia: d.via,
    transport: d.transport,
    checkedAt: Date.now(),
    device: {
      model: props["ro.product.model"],
      manufacturer: props["ro.product.manufacturer"],
      android: props["ro.build.version.release"],
      sdk,
      rom: oem.rom,
    },
    logging,
    background,
    screen,
    app: {
      package: ctx.pkg,
      installed,
      versionName,
      versionCode,
      matchesScan: ctx.scanVersionName && versionName ? ctx.scanVersionName === versionName : undefined,
    },
    notificationPermission,
    channels,
    ctLogs,
  };
}

/**
 * Put the app into `state`, ask the server to send a push carrying `marker`,
 * then watch the notification shade for it.
 */
export async function runPushTest(
  d: DeviceDriver,
  pkg: string,
  state: AppState,
  sendPush: (marker: string) => Promise<void>,
  onStep: (s: string) => void,
): Promise<PushTestResult> {
  const marker = Math.random().toString(36).slice(2, 10);
  let verifiedState = false;
  let stateDetail = "";
  try {
    onStep(`Preparing: app ${state}`);
    // wake the screen; the lock flag alone isn't trusted (some phones, e.g. vivo,
    // report a keyguard while unlocked) — it only matters if the app can't come to front
    const scr = await soft(readyScreen(d));
    await d.run({ t: "launch", pkg });
    await sleep(3500);
    if (state !== "foreground") {
      await d.run({ t: "home" });
      await sleep(1500);
    }
    if (state === "killed") {
      // like swiping it away — not force-stop, which blocks FCM. Android refuses
      // to kill the app it just left ("previous app") for a few seconds, so retry.
      for (let i = 0; i < 4; i++) {
        await sleep(i ? 2500 : 1500);
        await d.run({ t: "kill", pkg });
        await sleep(800);
        if (!(await d.run({ t: "pidof", pkg })).trim()) break;
      }
    }
    const pid = (await d.run({ t: "pidof", pkg })).trim();
    let inFront = (await d.run({ t: "focus" })).includes(pkg + "/");
    if (state === "foreground" && !inFront) {
      // give a slow app one more moment before deciding
      await sleep(2500);
      inFront = (await d.run({ t: "focus" })).includes(pkg + "/");
      if (!inFront && scr?.locked)
        return { status: "error", verifiedState, stateDetail: "app not on screen", sentAt: Date.now(), detail: "The app couldn't come to the front — unlock the phone (keep the screen on), then press Test again." };
    }
    if (state === "foreground") verifiedState = inFront;
    else if (state === "background") verifiedState = !inFront && pid.length > 0;
    else verifiedState = pid.length === 0;
    stateDetail = `${inFront ? "app on screen" : "app not on screen"} · process ${pid ? "running" : "not running"}`;
    if (state === "killed" && pid)
      stateDetail += " (the phone kept the app alive — swipe it away from recents and press Test again)";
  } catch (e) {
    return { status: "error", verifiedState, stateDetail, sentAt: Date.now(), detail: (e as Error).message };
  }

  const sentAt = Date.now();
  try {
    onStep("Sending test push via CleverTap");
    await sendPush(marker);
  } catch (e) {
    return { status: "error", verifiedState, stateDetail, sentAt, detail: (e as Error).message };
  }

  onStep("Waiting for the notification on the phone");
  const deadline = sentAt + 60_000;
  while (Date.now() < deadline) {
    await sleep(2500);
    // the marker is random and only travels in our push, so a hit means it arrived
    // the shade (dumpsys) is the proof; some ROMs redact notification text there,
    // so the SDK's own "received notification" log line (it prints the payload) counts too
    const out = (await soft(d.run({ t: "findNotification", marker }))) ?? "";
    if (out.includes(marker))
      return { status: "delivered", verifiedState, stateDetail, sentAt, deliveredAfterMs: Date.now() - sentAt, seenIn: "shade" };
    const log = (await soft(d.run({ t: "findLog", marker }))) ?? "";
    if (log.includes(marker) && /CleverTap/.test(log) && !/Not rendering|Couldn't render/.test(log))
      return { status: "delivered", verifiedState, stateDetail, sentAt, deliveredAfterMs: Date.now() - sentAt, seenIn: "log" };
  }
  // A miss in background/killed is often the phone, not the integration — say which.
  const background =
    state !== "foreground"
      ? await soft(
          (async () => checkBackground(d, pkg, detectOem(parseProps(await d.run({ t: "props" })))))(),
        )
      : undefined;
  return {
    status: "not-delivered",
    verifiedState,
    stateDetail,
    sentAt,
    detail: "No notification from the app appeared within 60 s.",
    background,
  };
}

export async function runDeepLinkTests(d: DeviceDriver, pkg: string, urls: string[]): Promise<DeviceFindings["deepLinks"]> {
  const out: DeviceFindings["deepLinks"] = [];
  for (const url of urls.slice(0, 5)) {
    try {
      const res = await d.run({ t: "deeplink", pkg, url });
      const activity = res.match(/Activity:\s*(\S+)/)?.[1];
      const ok = /Status:\s*ok/i.test(res) && !!activity && activity.startsWith(pkg);
      out.push({ url, ok, activity, detail: ok ? undefined : res.match(/Error[^\n]*/)?.[0] ?? "Didn't open the app" });
      await sleep(1500);
      await d.run({ t: "home" });
    } catch (e) {
      out.push({ url, ok: false, detail: (e as Error).message });
    }
  }
  return out;
}

/* ---- parsers ------------------------------------------------------ */

export function parseProps(out: string): Record<string, string> {
  const m: Record<string, string> = Object.create(null);
  for (const line of out.split("\n")) {
    const x = line.match(/^\[([^\]]+)\]: \[(.*)\]\s*$/);
    if (x) m[x[1]] = x[2];
  }
  return m;
}

function parseChannels(out: string, pkg: string): DeviceFindings["channels"] {
  const channels: DeviceFindings["channels"] = [];
  let i = out.indexOf(`AppSettings: ${pkg} (`);
  while (i !== -1) {
    const next = out.indexOf("AppSettings: ", i + 10);
    const block = out.slice(i, next === -1 ? undefined : next);
    for (const m of block.matchAll(/NotificationChannel\{mId='([^']*)', mName=([^,]*),[^}]*?mImportance=(-?\d+)/g)) {
      if (!channels.some((c) => c.id === m[1])) channels.push({ id: m[1], name: m[2], importance: Number(m[3]) });
    }
    i = out.indexOf(`AppSettings: ${pkg} (`, i + 10);
  }
  return channels.slice(0, 30);
}

const SECRETISH = /\b[A-Za-z0-9_\-:]{24,}\b/g;

function parseCtLogs(out: string): DeviceFindings["ctLogs"] {
  const lines = out.split("\n").filter((l) => /CleverTap/i.test(l));
  const accountId = lines.map((l) => l.match(/\b([A-Z0-9]{3}-[A-Z0-9]{3}-[A-Z0-9]{4})\b/)?.[1]).find(Boolean);
  const errors = lines
    .filter((l) => /^E\/|\bE\/|error|failed|unable|invalid|missing/i.test(l))
    .map(redact)
    .slice(-10);
  return {
    lines: lines.slice(-40).map(redact),
    verbose: lines.some((l) => /^[VD]\//.test(l.trim())),
    accountId,
    errors,
  };
}

// Push tokens / device ids are long opaque strings — never ship them to the server.
function redact(l: string) {
  return l
    .replace(SECRETISH, (s) => (/\d/.test(s) && /[A-Za-z]/.test(s) ? s.slice(0, 4) + "…" : s))
    .slice(0, 300);
}
