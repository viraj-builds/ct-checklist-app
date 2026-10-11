#!/usr/bin/env node
// CleverTap Integration Audit — local iOS helper.
//
// Lets the audit website test your app on a real iPhone (USB cable or Wi-Fi)
// or in the Xcode Simulator: open / close / background the app, open deep
// links, watch test pushes arrive, and read the CleverTap SDK's debug logs.
// Browsers can't talk to an iPhone or run `xcrun`, so this small helper does
// it for them — the iOS counterpart of the Android adb helper.
//
//   node ct-ios-bridge.mjs [--origin https://your-audit-site] [--port 47812]
//
// What it uses (whatever is installed):
//   - Xcode's `devicectl` (Mac)          — list iPhones, open/close the app, deep links
//   - libimobiledevice `idevicesyslog`   — live iPhone logs, USB or Wi-Fi
//     or pymobiledevice3 `syslog live`   — same, any OS (pip install pymobiledevice3)
//     or macOS `log collect`             — built in, slower, USB
//   - `xcrun simctl`                     — the Simulator
//
// Safety:
//   - listens on 127.0.0.1 only (not reachable from your network)
//   - only accepts requests from the audit site's origin (the browser sets the
//     Origin header; other websites can't fake it); the page picks up the
//     one-time token automatically, other local programs would need it
//   - runs only a fixed list of commands with validated arguments (no shell)
//   - never installs, deletes or changes anything on the iPhone
//   - no dependencies; needs Node 18+

import http from "node:http";
import { execFile, spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, readdirSync, existsSync, mkdtempSync, writeFileSync, rmSync, createReadStream, statSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, basename, delimiter } from "node:path";

const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const PORT = Number(flag("--port", "47812"));
const ORIGINS = new Set(["http://localhost:3000", ...flag("--origin", "").split(",").filter(Boolean)].map((o) => o.replace(/\/$/, "")));
const TOKEN = randomBytes(12).toString("hex");
const HELPER_VERSION = 2; // bump when the command list changes (lib/device/ios/bridge.ts IOS_HELPER_MIN_VERSION)
const IS_MAC = process.platform === "darwin";
const DEVICES_DIR = join(homedir(), "Library", "Developer", "CoreSimulator", "Devices");

function run(cmd, argv, { timeout = 60_000, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, argv, { timeout, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err && !stdout) reject(new Error((stderr || err.message).toString().trim().split("\n").slice(-3).join(" ")));
      else resolve(String(stdout));
    });
    if (input !== undefined) child.stdin.end(input);
  });
}
const simctl = (argv, opts) => run("xcrun", ["simctl", ...argv], opts);
const plistJson = async (text) => JSON.parse(await run("plutil", ["-convert", "json", "-o", "-", "-"], { input: text }));

// --- tools --------------------------------------------------------------
function which(exe) {
  const names = process.platform === "win32" ? [`${exe}.exe`, `${exe}.cmd`, exe] : [exe];
  const dirs = [...(process.env.PATH || "").split(delimiter), "/opt/homebrew/bin", "/usr/local/bin", join(homedir(), ".local", "bin")];
  const py = join(homedir(), "Library", "Python");
  if (existsSync(py)) for (const v of readdirSync(py)) dirs.push(join(py, v, "bin"));
  for (const d of dirs) for (const n of names) if (d && existsSync(join(d, n))) return join(d, n);
  return null;
}
const TOOLS = {
  devicectl: false,
  simctl: false,
  idevicesyslog: which("idevicesyslog"),
  idevice_id: which("idevice_id"),
  ideviceinfo: which("ideviceinfo"),
  pymobiledevice3: which("pymobiledevice3"),
};
async function detectTools() {
  if (!IS_MAC) return;
  TOOLS.devicectl = await run("xcrun", ["devicectl", "--version"], { timeout: 20_000 }).then(() => true, () => false);
  TOOLS.simctl = await run("xcrun", ["simctl", "help"], { timeout: 20_000 }).then(() => true, () => false);
}
const logTool = () => (TOOLS.idevicesyslog ? "idevicesyslog" : TOOLS.pymobiledevice3 ? "pymobiledevice3" : IS_MAC ? "log collect" : null);

// --- validation ---------------------------------------------------------
const TARGET_ID = /^[0-9A-Fa-f-]{20,40}$/; // Simulator UDID or iPhone UDID
const BUNDLE = /^[A-Za-z0-9][A-Za-z0-9.-]{0,199}$/;
const MARKER = /^[a-z0-9]{6,12}$/;
const URL_SAFE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[A-Za-z0-9\-._~:/?#[\]@!*+,=%]*$/;
const targetId = (u) => {
  if (typeof u !== "string" || !TARGET_ID.test(u)) throw new Error("Invalid device id.");
  return u;
};
const bundle = (b) => {
  if (typeof b !== "string" || !BUNDLE.test(b)) throw new Error("Invalid bundle id.");
  return b;
};
const url = (s) => {
  if (typeof s !== "string" || !URL_SAFE.test(s) || s.length > 500) throw new Error("Link contains unsupported characters.");
  return s;
};
const isSim = (u) => IS_MAC && existsSync(join(DEVICES_DIR, u));

/* ======================================================================
   Simulator (xcrun simctl)
   ====================================================================== */

async function simApps(u) {
  const apps = await plistJson(await simctl(["listapps", u]));
  return Object.entries(apps)
    .filter(([id, a]) => !id.startsWith("com.apple.") && a.ApplicationType !== "System")
    .map(([id, a]) => ({ bundleId: id, name: a.CFBundleDisplayName || a.CFBundleName, version: a.CFBundleShortVersionString, build: a.CFBundleVersion, executable: a.CFBundleExecutable }));
}
const simAppPath = async (u, b) => (await simctl(["get_app_container", u, b, "app"])).trim();

async function simOp(u, op) {
  switch (op?.t) {
    case "listApps":
      return JSON.stringify(await simApps(u));
    case "appInfo": {
      const p = await simAppPath(u, bundle(op.bundleId));
      const info = JSON.parse(await run("plutil", ["-convert", "json", "-o", "-", join(p, "Info.plist")]));
      return JSON.stringify({ bundleId: op.bundleId, name: info.CFBundleDisplayName || info.CFBundleName, version: info.CFBundleShortVersionString, build: info.CFBundleVersion, executable: info.CFBundleExecutable });
    }
    case "launch":
      return simctl(["launch", ...(op.relaunch ? ["--terminate-running-process"] : []), u, bundle(op.bundleId)]);
    case "terminate":
      return simctl(["terminate", u, bundle(op.bundleId)]).catch(() => "not running");
    case "background":
      bundle(op.bundleId);
      // there is no Home button in simctl: bringing Settings to the front sends the app to the background
      return simctl(["launch", u, "com.apple.Preferences"]);
    case "pid": {
      const b = bundle(op.bundleId);
      const out = await simctl(["spawn", u, "launchctl", "list"]);
      const line = out.split("\n").find((l) => l.includes(`UIKitApplication:${b}[`));
      const pid = line?.trim().split(/\s+/)[0];
      return pid && pid !== "-" ? pid : "";
    }
    case "openUrl":
      return simctl(["openurl", u, url(op.url)]).then(() => "opened");
    case "push": {
      const b = bundle(op.bundleId);
      const body = JSON.stringify(op.payload ?? null);
      if (!op.payload || typeof op.payload !== "object" || typeof op.payload.aps !== "object" || body.length > 4096) throw new Error("Invalid push payload.");
      const dir = mkdtempSync(join(tmpdir(), "ct-push-"));
      try {
        const f = join(dir, "push.apns");
        writeFileSync(f, body);
        return await simctl(["push", u, b, f]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    case "findNotification": {
      if (typeof op.marker !== "string" || !MARKER.test(op.marker)) throw new Error("Invalid marker.");
      const root = join(DEVICES_DIR, u, "data", "Library", "UserNotifications");
      if (!existsSync(root)) return "";
      const ascii = Buffer.from(op.marker, "latin1");
      const utf16 = Buffer.from(op.marker.split("").map((c) => "\0" + c).join(""), "latin1"); // bplist stores non-ASCII strings as UTF-16BE
      for (const d of readdirSync(root)) {
        const f = join(root, d, "DeliveredNotifications.plist");
        if (!existsSync(f)) continue;
        const buf = readFileSync(f);
        if (buf.includes(ascii) || buf.includes(utf16)) return op.marker;
      }
      return "";
    }
    case "pushSeen":
      return "";
    case "notifSettings": {
      const f = join(DEVICES_DIR, u, "data", "Library", "BulletinBoard", "VersionedSectionInfo.plist");
      return existsSync(f) ? readFileSync(f).toString("base64") : "";
    }
    case "screenshot": {
      const dir = mkdtempSync(join(tmpdir(), "ct-shot-"));
      try {
        const f = join(dir, "s.png");
        await simctl(["io", u, "screenshot", "--type=png", f]);
        return readFileSync(f).toString("base64");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    default:
      throw new Error("Unknown operation.");
  }
}

async function simulators() {
  if (!TOOLS.simctl) return [];
  const j = JSON.parse(await simctl(["list", "devices", "available", "-j"]));
  const sims = [];
  for (const [runtime, list] of Object.entries(j.devices ?? {})) {
    const os = runtime.match(/SimRuntime\.(iOS)-(\d+)-(\d+)/);
    if (!os) continue;
    for (const d of list) sims.push({ kind: "simulator", udid: d.udid, name: d.name, os: `iOS ${os[2]}.${os[3]}`, state: d.state });
  }
  sims.sort((a, b) => (a.state === "Booted" ? -1 : 0) - (b.state === "Booted" ? -1 : 0) || b.os.localeCompare(a.os, undefined, { numeric: true }));
  return sims.slice(0, 60);
}

/* ======================================================================
   Physical iPhone (devicectl + idevicesyslog / pymobiledevice3 / log collect)
   ====================================================================== */

// devicectl's JSON file is its only stable machine interface
async function devicectl(argv, timeout = 60_000) {
  const dir = mkdtempSync(join(tmpdir(), "ct-dc-"));
  const f = join(dir, "out.json");
  try {
    await run("xcrun", ["devicectl", ...argv, "--json-output", f, "--quiet"], { timeout }).catch((e) => {
      if (!existsSync(f)) throw e;
    });
    const j = JSON.parse(readFileSync(f, "utf8"));
    if (j.error) {
      const msg = j.error.userInfo?.NSLocalizedDescription?.string ?? `devicectl error ${j.error.code}`;
      const why = j.error.userInfo?.NSLocalizedFailureReason?.string ?? j.error.userInfo?.NSUnderlyingError?.error?.userInfo?.NSLocalizedDescription?.string;
      throw new Error(explainDevicectl(why ? `${msg} ${why}` : msg));
    }
    return j.result ?? {};
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function explainDevicectl(msg) {
  if (/developer mode/i.test(msg)) return "Developer Mode is off on the iPhone. Turn it on in Settings → Privacy & Security → Developer Mode, restart the iPhone, then try again.";
  if (/locked/i.test(msg)) return "The iPhone is locked. Unlock it and keep the screen on while tests run.";
  if (/not paired|pairing|trust/i.test(msg)) return "The iPhone isn't paired with this Mac. Connect it with a cable, tap “Trust” on the iPhone, then try again.";
  if (/Security|not permitted|Unable to launch|denied/i.test(msg))
    return `${msg} — iOS only lets a Mac open apps signed for development. Install a Debug build from Xcode (or open the app on the iPhone yourself and use the on-screen steps).`;
  return msg;
}

let deviceCache = { at: 0, list: [] };
async function physicalDevices() {
  if (Date.now() - deviceCache.at < 2500) return deviceCache.list;
  const out = new Map();
  if (TOOLS.devicectl) {
    try {
      const r = await devicectl(["list", "devices"], 30_000);
      for (const d of r.devices ?? []) {
        const hw = d.hardwareProperties ?? {};
        const dp = d.deviceProperties ?? {};
        const cp = d.connectionProperties ?? {};
        if (hw.reality && hw.reality !== "physical") continue;
        if (hw.platform && !/^(iOS|iPadOS)$/.test(hw.platform)) continue;
        const udid = hw.udid ?? d.identifier;
        if (!udid || !TARGET_ID.test(udid)) continue;
        const reachable = cp.tunnelState === "connected" || (cp.pairingState === "paired" && cp.tunnelState !== "unavailable");
        out.set(udid, {
          kind: "device",
          udid,
          name: dp.name ?? hw.marketingName ?? "iPhone",
          model: hw.marketingName ?? hw.productType,
          os: dp.osVersionNumber ? `iOS ${dp.osVersionNumber}` : "iOS",
          transport: cp.transportType === "localNetwork" ? "wifi" : "usb",
          state: reachable ? "Connected" : cp.pairingState === "paired" ? "Not reachable" : "Not paired",
          developerMode: dp.developerModeStatus,
        });
      }
    } catch {
      /* fall through to libimobiledevice */
    }
  }
  if (TOOLS.idevice_id) {
    for (const [fl, transport] of [["-l", "usb"], ["-n", "wifi"]]) {
      const ids = (await run(TOOLS.idevice_id, [fl], { timeout: 15_000 }).catch(() => "")).split(/\s+/).filter((x) => TARGET_ID.test(x));
      for (const udid of ids) {
        if (out.has(udid)) continue;
        const info = TOOLS.ideviceinfo ? await run(TOOLS.ideviceinfo, ["-u", udid, ...(transport === "wifi" ? ["-n"] : [])], { timeout: 15_000 }).catch(() => "") : "";
        const k = (key) => info.match(new RegExp(`^${key}: (.*)$`, "m"))?.[1]?.trim();
        out.set(udid, { kind: "device", udid, name: k("DeviceName") ?? "iPhone", model: k("ProductType"), os: k("ProductVersion") ? `iOS ${k("ProductVersion")}` : "iOS", transport, state: "Connected" });
      }
    }
  } else if (TOOLS.pymobiledevice3) {
    try {
      const list = JSON.parse(await run(TOOLS.pymobiledevice3, ["usbmux", "list"], { timeout: 20_000 }));
      for (const d of list) {
        const udid = d.UniqueDeviceID ?? d.Identifier;
        if (!udid || out.has(udid) || !TARGET_ID.test(udid)) continue;
        out.set(udid, { kind: "device", udid, name: d.DeviceName ?? "iPhone", model: d.ProductType, os: d.ProductVersion ? `iOS ${d.ProductVersion}` : "iOS", transport: /network/i.test(d.ConnectionType ?? "") ? "wifi" : "usb", state: "Connected" });
      }
    } catch {
      /* not paired / no device */
    }
  }
  deviceCache = { at: Date.now(), list: [...out.values()] };
  return deviceCache.list;
}

const appUrls = new Map(); // `${udid}:${bundle}` -> bundle path on the iPhone (to find its process)

async function deviceApps(u) {
  if (!TOOLS.devicectl) throw new Error("Listing apps on an iPhone needs Xcode's devicectl (Mac).");
  const r = await devicectl(["device", "info", "apps", "--device", u]);
  return (r.apps ?? [])
    .filter((a) => a.bundleIdentifier && !a.bundleIdentifier.startsWith("com.apple.") && !a.hidden)
    .map((a) => {
      if (a.url) appUrls.set(`${u}:${a.bundleIdentifier}`, String(a.url));
      return { bundleId: a.bundleIdentifier, name: a.name, version: a.version, build: a.bundleVersion, builtByDeveloper: a.builtByDeveloper };
    });
}

async function devicePid(u, b) {
  if (!appUrls.has(`${u}:${b}`)) await deviceApps(u).catch(() => {});
  const base = appUrls.get(`${u}:${b}`);
  if (!base) return "";
  const r = await devicectl(["device", "info", "processes", "--device", u]);
  const p = (r.runningProcesses ?? []).find((x) => String(x.executable ?? "").startsWith(base));
  return p?.processIdentifier ? String(p.processIdentifier) : "";
}

const needControl = () => {
  if (!TOOLS.devicectl) throw new Error("NO_CONTROL: Opening and closing apps on an iPhone needs Xcode's devicectl (Mac). Follow the on-screen steps instead.");
};

async function deviceOp(u, op) {
  switch (op?.t) {
    case "listApps":
      return JSON.stringify(await deviceApps(u));
    case "appInfo": {
      const b = bundle(op.bundleId);
      const a = (await deviceApps(u)).find((x) => x.bundleId === b);
      if (!a) throw new Error(`${b} isn't installed on this iPhone.`);
      return JSON.stringify(a);
    }
    case "launch": {
      needControl();
      const r = await devicectl(["device", "process", "launch", "--device", u, ...(op.relaunch ? ["--terminate-existing"] : []), bundle(op.bundleId)]);
      return `${op.bundleId}: ${r.process?.processIdentifier ?? ""}`;
    }
    case "terminate": {
      needControl();
      const pid = await devicePid(u, bundle(op.bundleId));
      if (!pid) return "not running";
      await devicectl(["device", "process", "terminate", "--device", u, "--pid", pid, "--kill"]);
      return "terminated";
    }
    case "background":
      needControl();
      bundle(op.bundleId);
      await devicectl(["device", "process", "launch", "--device", u, "--activate", "com.apple.Preferences"]);
      return "backgrounded";
    case "pid":
      needControl();
      return devicePid(u, bundle(op.bundleId));
    case "openUrl": {
      needControl();
      const link = url(op.url);
      const target = op.bundleId ? bundle(op.bundleId) : "com.apple.mobilesafari";
      await devicectl(["device", "process", "launch", "--device", u, "--payload-url", link, target]);
      return "opened";
    }
    case "push":
      throw new Error("Simulated pushes only work in the Simulator. On an iPhone, send the test push through CleverTap.");
    case "findNotification":
      return "";
    case "pushSeen": {
      // SpringBoard / apsd log every push they deliver for an app — the iPhone has no readable notification store
      const b = bundle(op.bundleId);
      const since = Number(op.since) || 0;
      const s = streams.get(u);
      const hit = s?.sys.find((x) => x.ts >= since && (x.msg.includes(`[${b}]`) || x.msg.includes(`'${b}'`) || x.msg.includes(` ${b} `)));
      return hit ? "seen" : "";
    }
    case "notifSettings":
      return "";
    default:
      throw new Error("Unknown operation.");
  }
}

/* ======================================================================
   Logs: one stream per target, kept in a ring buffer read with a cursor
   ====================================================================== */

const CT_PREDICATE = 'subsystem == "com.clevertap.sdk" OR eventMessage CONTAINS "[CleverTap]"';
const SYS_PROCS = new Set(["SpringBoard", "usernotificationsd", "apsd"]);
const SYS_PUSH = /Saving notification .*: YES|Received message for enabled topic|Adding notification request|Delivering notification|Presenting notification/;
const streams = new Map(); // id -> { child?, timer?, buf, sys, seq, tool, error }

function record(s, proc, msg, ts = Date.now()) {
  if (msg.includes("[CleverTap]") || msg.includes("CleverTap")) {
    s.buf.push({ seq: ++s.seq, ts, proc, msg: msg.slice(0, 4000) });
    if (s.buf.length > 8000) s.buf.splice(0, s.buf.length - 8000);
  } else if (SYS_PROCS.has(proc) && SYS_PUSH.test(msg)) {
    s.sys.push({ ts, msg: msg.slice(0, 400) });
    if (s.sys.length > 400) s.sys.splice(0, s.sys.length - 400);
  }
}

// lines from idevicesyslog / pymobiledevice3; a message can span several lines
const HEAD = [
  /^[A-Z][a-z]{2} +\d+ \d\d:\d\d:\d\d(?:\.\d+)? \S+ ([^\s[(]+)(?:\([^)]*\))?\[\d+\] <\w+>: ?(.*)$/, // idevicesyslog
  /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d+)? ([^\s[{]+)(?:\{[^}]*\})?\[\d+\] <\w+>: ?(.*)$/, // pymobiledevice3
];
function lineParser(s) {
  let cur = null;
  let rest = "";
  const flush = () => {
    if (cur) record(s, cur.proc, cur.msg);
    cur = null;
  };
  let idle;
  return (chunk) => {
    rest += chunk.toString().replace(/\x1b\[[0-9;]*m/g, "");
    const lines = rest.split("\n");
    rest = lines.pop() ?? "";
    for (const l of lines) {
      const m = HEAD.map((re) => l.match(re)).find(Boolean);
      if (m) {
        flush();
        cur = { proc: m[1], msg: m[2] };
      } else if (cur) cur.msg += "\n" + l;
    }
    clearTimeout(idle);
    idle = setTimeout(flush, 400);
  };
}

function startSimLogs(u, s) {
  const child = spawn("xcrun", ["simctl", "spawn", u, "log", "stream", "--style", "ndjson", "--level", "debug", "--predicate", CT_PREDICATE], { stdio: ["ignore", "pipe", "pipe"] });
  s.child = child;
  s.tool = "simulator log stream";
  let rest = "";
  child.stdout.on("data", (chunk) => {
    rest += chunk.toString();
    const lines = rest.split("\n");
    rest = lines.pop() ?? "";
    for (const l of lines) {
      if (!l.startsWith("{")) continue;
      try {
        const j = JSON.parse(l);
        if (j.eventMessage) record(s, basename(j.processImagePath || ""), String(j.eventMessage), Date.parse(j.timestamp?.replace(" ", "T").replace(/(\.\d{3})\d*/, "$1")) || Date.now());
      } catch {
        /* partial line */
      }
    }
  });
  child.stderr.on("data", (c) => (s.error = c.toString().slice(-300)));
}

function startDeviceLogs(u, s, transport) {
  const tool = logTool();
  s.tool = tool;
  if (tool === "idevicesyslog" || tool === "pymobiledevice3") {
    const argv = tool === "idevicesyslog" ? ["-u", u, ...(transport === "wifi" ? ["-n"] : [])] : ["syslog", "live", "--udid", u];
    const child = spawn(TOOLS[tool], argv, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    s.child = child;
    child.stdout.on("data", lineParser(s));
    child.stderr.on("data", (c) => (s.error = c.toString().slice(-300)));
    return;
  }
  if (tool === "log collect") {
    // macOS fallback: pull the iPhone's log every few seconds (USB, unlocked iPhone)
    let since = Math.floor(Date.now() / 1000) - 5;
    const seen = new Set();
    const pred = `${CT_PREDICATE} OR process == "SpringBoard" OR process == "usernotificationsd" OR process == "apsd"`;
    const tick = async () => {
      if (!streams.has(u) || s.stopped) return;
      const dir = mkdtempSync(join(tmpdir(), "ct-log-"));
      try {
        const arch = join(dir, "d.logarchive");
        await run("/usr/bin/log", ["collect", "--device-udid", u, "--start", `@${since}`, "--output", arch, "--predicate", pred], { timeout: 120_000 });
        const out = await run("/usr/bin/log", ["show", arch, "--style", "ndjson", "--info", "--debug", "--predicate", pred], { timeout: 120_000 });
        for (const l of out.split("\n")) {
          if (!l.startsWith("{")) continue;
          try {
            const j = JSON.parse(l);
            const key = `${j.timestamp}|${j.eventMessage}`;
            if (!j.eventMessage || seen.has(key)) continue;
            seen.add(key);
            if (seen.size > 20_000) seen.clear();
            const ts = Date.parse(j.timestamp?.replace(" ", "T").replace(/(\.\d{3})\d*/, "$1")) || Date.now();
            since = Math.max(since, Math.floor(ts / 1000) - 1);
            record(s, basename(j.processImagePath || j.process || ""), String(j.eventMessage), ts);
          } catch {
            /* skip */
          }
        }
        s.error = "";
      } catch (e) {
        s.error = `log collect: ${e.message}`.slice(0, 300);
      } finally {
        rmSync(dir, { recursive: true, force: true });
        if (!s.stopped) s.timer = setTimeout(tick, 4000);
      }
    };
    void tick();
    return;
  }
  s.error = "No way to read iPhone logs. Install libimobiledevice (brew install libimobiledevice) or pymobiledevice3 (python3 -m pip install -U pymobiledevice3).";
}

async function startLogs(u) {
  const cur = streams.get(u);
  if (cur && !cur.stopped && (cur.timer || (cur.child && cur.child.exitCode === null))) return cur;
  const s = { buf: [], sys: [], seq: 0, startedAt: Date.now(), error: "", tool: null, stopped: false };
  streams.set(u, s);
  if (isSim(u)) startSimLogs(u, s);
  else {
    const dev = (await physicalDevices()).find((d) => d.udid === u);
    startDeviceLogs(u, s, dev?.transport ?? "usb");
  }
  s.child?.on("exit", (code) => {
    if (streams.get(u) === s && !s.stopped) {
      s.error ||= `Log stream ended (exit ${code}). Is the iPhone still connected and unlocked?`;
      s.child = undefined;
    }
  });
  return s;
}

function stopLogs(u) {
  const s = streams.get(u);
  if (!s) return;
  s.stopped = true;
  clearTimeout(s.timer);
  s.child?.kill("SIGTERM");
  streams.delete(u);
}

/* ======================================================================
   HTTP
   ====================================================================== */

function send(res, status, body, origin) {
  res.writeHead(status, { "Content-Type": "application/json", ...(origin ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : {}) });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 32_768) reject(new Error("Body too large"));
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
  });
}

const tokenOk = (t) => {
  const a = Buffer.from(String(t ?? "")),
    b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
};

async function status() {
  const xcode = IS_MAC ? (await run("xcodebuild", ["-version"]).catch(() => "")).split("\n")[0].trim() || undefined : undefined;
  const [sims, devices] = await Promise.all([simulators().catch(() => []), physicalDevices().catch(() => [])]);
  return {
    platform: process.platform,
    xcode,
    simulators: sims,
    devices,
    tools: { control: TOOLS.devicectl ? "devicectl" : null, logs: logTool(), simulator: TOOLS.simctl },
  };
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  const allowed = origin && ORIGINS.has(origin) ? origin : undefined;
  if (req.method === "OPTIONS") {
    if (!allowed) return send(res, 403, { error: "Origin not allowed" });
    res.writeHead(204, {
      "Access-Control-Allow-Origin": allowed,
      "Access-Control-Allow-Methods": "GET, POST",
      "Access-Control-Allow-Headers": "Content-Type, X-Bridge-Token",
      "Access-Control-Allow-Private-Network": "true",
      "Access-Control-Max-Age": "600",
      Vary: "Origin",
    });
    return res.end();
  }
  if (!allowed) return send(res, 403, { error: `Origin not allowed. Restart with --origin ${origin ?? "<site>"}` });
  if (req.method === "GET" && req.url === "/v1/hello") return send(res, 200, { token: TOKEN, version: HELPER_VERSION, kind: "ios" }, allowed);
  if (!tokenOk(req.headers["x-bridge-token"])) return send(res, 401, { error: "Wrong helper token — restart the page." }, allowed);

  try {
    const u0 = new URL(req.url, "http://127.0.0.1");
    if (req.method === "GET" && u0.pathname === "/v1/status") return send(res, 200, await status(), allowed);
    if (req.method === "POST" && u0.pathname === "/v1/boot") {
      const { udid: u } = await readJson(req);
      if (!isSim(targetId(u))) throw new Error("Only Simulators can be started from here.");
      await simctl(["boot", u]).catch((e) => {
        if (!/current state: Booted/i.test(e.message)) throw e;
      });
      await run("open", ["-a", "Simulator"]).catch(() => {});
      return send(res, 200, { ok: true }, allowed);
    }
    if (req.method === "POST" && u0.pathname === "/v1/run") {
      const { udid: u, op } = await readJson(req);
      const id = targetId(u);
      return send(res, 200, { output: await (isSim(id) ? simOp(id, op) : deviceOp(id, op)) }, allowed);
    }
    if (req.method === "POST" && u0.pathname === "/v1/logs/start") {
      const { udid: u } = await readJson(req);
      const s = await startLogs(targetId(u));
      return send(res, 200, { ok: true, seq: s.seq, tool: s.tool }, allowed);
    }
    if (req.method === "POST" && u0.pathname === "/v1/logs/stop") {
      const { udid: u } = await readJson(req);
      stopLogs(targetId(u));
      return send(res, 200, { ok: true }, allowed);
    }
    if (req.method === "GET" && u0.pathname === "/v1/logs") {
      const u = targetId(u0.searchParams.get("udid"));
      const since = Number(u0.searchParams.get("since") || 0);
      const s = streams.get(u);
      if (!s) return send(res, 200, { running: false, next: since, messages: [] }, allowed);
      const messages = s.buf.filter((m) => m.seq > since).slice(0, 3000);
      return send(res, 200, { running: true, next: messages.at(-1)?.seq ?? since, messages, tool: s.tool, error: s.error || undefined }, allowed);
    }
    if (req.method === "GET" && u0.pathname === "/v1/bundle") {
      // zip of the installed .app so the page can scan exactly what's on the Simulator
      const u = targetId(u0.searchParams.get("udid"));
      if (!isSim(u)) throw new Error("Apps can only be read from the Simulator. For an iPhone, upload the .ipa.");
      const b = bundle(u0.searchParams.get("bundleId"));
      const p = await simAppPath(u, b);
      const dir = mkdtempSync(join(tmpdir(), "ct-app-"));
      const zip = join(dir, `${basename(p, ".app")}.zip`);
      await run("ditto", ["-c", "-k", "--keepParent", p, zip], { timeout: 300_000 });
      res.writeHead(200, {
        "Content-Type": "application/zip",
        "Content-Length": statSync(zip).size,
        "Content-Disposition": `attachment; filename="${basename(zip)}"`,
        "Access-Control-Allow-Origin": allowed,
        Vary: "Origin",
      });
      const rs = createReadStream(zip);
      rs.pipe(res);
      rs.on("close", () => rmSync(dir, { recursive: true, force: true }));
      return;
    }
    return send(res, 404, { error: "Not found" }, allowed);
  } catch (e) {
    return send(res, 400, { error: e.message }, allowed);
  }
});

process.on("SIGINT", () => {
  for (const u of [...streams.keys()]) stopLogs(u);
  process.exit(0);
});

await detectTools();
server.listen(PORT, "127.0.0.1", async () => {
  const st = await status().catch((e) => ({ error: e.message }));
  console.log("\n  CleverTap audit iOS helper is running");
  if (IS_MAC) console.log(`  Xcode:      ${st.xcode ?? "NOT FOUND — install Xcode to open/close the app on an iPhone and to use the Simulator"}`);
  console.log(`  iPhones:    ${st.devices?.length ? st.devices.map((d) => `${d.name} (${d.os}, ${d.transport === "wifi" ? "Wi-Fi" : "USB"})`).join(", ") : "none found yet — connect one with a cable and tap Trust"}`);
  console.log(`  iPhone logs: ${logTool() ?? "not available"}${logTool() === "log collect" ? " (slower — for live logs: brew install libimobiledevice)" : ""}`);
  if (IS_MAC) {
    const booted = (st.simulators ?? []).filter((s) => s.state === "Booted");
    console.log(`  Simulators: ${booted.length ? booted.map((s) => `${s.name} (${s.os})`).join(", ") + " running" : "none running"}`);
  }
  console.log(`  allowed:    ${[...ORIGINS].join(", ")}`);
  console.log("\n  Go back to the audit page — it connects automatically. Keep this window open; Ctrl+C to stop.\n");
});
