#!/usr/bin/env node
// CleverTap Integration Audit — local device helper.
//
// Lets the audit website talk to an Android phone through YOUR computer's adb,
// over USB or Wi-Fi (Android 11+ "Wireless debugging"). Browsers can't open
// raw TCP connections, so Wi-Fi debugging needs this small helper.
//
//   node ct-device-bridge.mjs [--origin https://your-audit-site] [--port 47811]
//
// Safety:
//   - listens on 127.0.0.1 only (not reachable from your network)
//   - only accepts requests from the audit site's origin (the browser sets the
//     Origin header, other websites can't fake it); the audit page picks up the
//     one-time token automatically, other local programs would need it
//   - runs only a fixed list of read-only/diagnostic adb commands — never
//     arbitrary shell input
//   - no dependencies; needs Node 18+ and Android platform-tools (adb)

import http from "node:http";
import { execFile } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const PORT = Number(flag("--port", "47811"));
const ORIGINS = new Set(["http://localhost:3000", ...flag("--origin", "").split(",").filter(Boolean)].map((o) => o.replace(/\/$/, "")));
const TOKEN = randomBytes(12).toString("hex");
const HELPER_VERSION = 3; // bump when the command list changes (lib/device/drivers.ts HELPER_MIN_VERSION)

function findAdb() {
  const exe = process.platform === "win32" ? "adb.exe" : "adb";
  const home = process.env.HOME || process.env.USERPROFILE;
  const roots = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT,
    process.platform === "win32" && process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Android", "Sdk"),
    process.platform === "win32" && "C:\\Android\\Sdk",
    process.platform === "win32" && "C:\\Android",
    home && join(home, "Library", "Android", "sdk"),
    home && join(home, "Android", "Sdk"),
    home && join(home, "AppData", "Local", "Android", "Sdk")].filter(Boolean);
  for (const r of roots) {
    for (const p of [join(r, "platform-tools", exe), join(r, exe)]) if (existsSync(p)) return p;
  }
  // anything on PATH (e.g. installed with winget / brew / scoop)
  for (const dir of (process.env.PATH || "").split(delimiter)) {
    const p = dir && join(dir, exe);
    if (p && existsSync(p)) return p;
  }
  return exe;
}
const ADB = findAdb();

function adb(argv, timeout = 60_000) {
  return new Promise((resolve, reject) => {
    execFile(ADB, argv, { timeout, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err && !stdout) reject(new Error((stderr || err.message).trim()));
      else resolve(String(stdout));
    });
  });
}

// --- the fixed command list (mirror of lib/device/ops.ts) ---------------
const PKG = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/;
const MARKER = /^[a-z0-9]{6,12}$/;
const URL_SAFE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[A-Za-z0-9\-._~:/?#[\]@!*+,=%]*$/;
const pkg = (p) => {
  if (typeof p !== "string" || !PKG.test(p) || p.length > 200) throw new Error("Invalid package name.");
  return p;
};
const marker = (m) => {
  if (typeof m !== "string" || !MARKER.test(m)) throw new Error("Invalid marker.");
  return m;
};
const level = (l) => {
  if (typeof l !== "string" || !/^[A-Za-z]{0,10}$/.test(l)) throw new Error("Invalid log level.");
  return l;
};
function buildCommand(op) {
  switch (op?.t) {
    case "props": return "getprop";
    case "package": return `dumpsys package ${pkg(op.pkg)}`;
    case "notifications": return "dumpsys notification --noredact";
    case "findNotification":
      if (typeof op.marker !== "string" || !MARKER.test(op.marker)) throw new Error("Invalid marker.");
      return `dumpsys notification --noredact | grep -F '${op.marker}' || true`;
    case "logcat": return `logcat -d -v brief -t ${Math.max(100, Math.min(8000, Math.floor(Number(op.lines) || 2000)))}`;
    case "logcatClear": return "logcat -c";
    case "pidof": return `pidof ${pkg(op.pkg)} 2>/dev/null || ps 2>/dev/null | grep -F ' ${pkg(op.pkg)}' | grep -v -F '${pkg(op.pkg)}:' | head -n 1 || true`;
    case "launch": return `c=$(cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.LAUNCHER ${pkg(op.pkg)} 2>/dev/null | tail -n 1); case "$c" in */*) am start -W -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -f 0x10200000 -n "$c";; *) monkey -p ${pkg(op.pkg)} -c android.intent.category.LAUNCHER 1;; esac`;
    case "home": return "am start -a android.intent.action.MAIN -c android.intent.category.HOME >/dev/null 2>&1 || input keyevent 3";
    case "kill": return `am kill ${pkg(op.pkg)}`;
    case "focus": return "{ dumpsys window displays | grep -E 'mCurrentFocus|mFocusedApp'; dumpsys activity activities | grep -E 'mResumedActivity|topResumedActivity'; } 2>/dev/null || true";
    case "deeplink":
      if (typeof op.url !== "string" || !URL_SAFE.test(op.url) || op.url.length > 500) throw new Error("Deep link contains unsupported characters.");
      return `am start -W -a android.intent.action.VIEW -d '${op.url}' ${pkg(op.pkg)}`;
    case "getLogTag": return "getprop log.tag";
    case "setLogTag":
      if (typeof op.level !== "string" || !/^[A-Za-z]{0,10}$/.test(op.level)) throw new Error("Invalid log level.");
      return `setprop log.tag '${op.level}'`;
    case "ctLogcat": return "logcat -d -v brief | grep -F CleverTap | tail -n 4000 || true";
    case "forceStop": return `am force-stop ${pkg(op.pkg)}`;
    case "logState": return `echo "log.tag=$(getprop log.tag)"; echo "persist.log.tag=$(getprop persist.log.tag)"; logcat -g 2>/dev/null | head -n 1`;
    case "logProbe": return `log -p v -t CTAuditProbe 'probe ${marker(op.marker)}'; log -p d -t CTAuditProbe 'probe ${marker(op.marker)}'; log -p i -t CTAuditProbe 'probe ${marker(op.marker)}'; sleep 1; logcat -d -v brief -s CTAuditProbe:V | grep -F '${marker(op.marker)}' || true`;
    case "setPersistLogTag": return `setprop persist.log.tag '${level(op.level)}'`;
    case "setLogBuffer":
      if (typeof op.size !== "string" || !/^\d{2,5}[KM]$/.test(op.size)) throw new Error("Invalid buffer size.");
      return `logcat -G ${op.size}`;
    case "bgState": return `echo "bucket=$(am get-standby-bucket ${pkg(op.pkg)} 2>/dev/null)"; cmd appops get ${pkg(op.pkg)} RUN_ANY_IN_BACKGROUND 2>/dev/null; cmd appops get ${pkg(op.pkg)} 10008 2>/dev/null; dumpsys deviceidle whitelist 2>/dev/null | grep -qF ",${pkg(op.pkg)}," && echo whitelisted=1; true`;
    case "screen": return "{ dumpsys power | grep -E 'mWakefulness='; dumpsys activity activities | grep -E 'mKeyguardShowing='; dumpsys window | grep -E 'mShowingLockscreen=|mDreamingLockscreen=|isKeyguardShowing='; } 2>/dev/null || true";
    case "wake": return "input keyevent 224 2>/dev/null || true";
    case "setTagLevel":
      if (typeof op.tag !== "string" || !/^[A-Za-z0-9_.:-]{1,60}$/.test(op.tag)) throw new Error("Invalid log tag.");
      return `setprop 'log.tag.${op.tag}' '${level(op.level)}'`;
    case "findLog": return `logcat -d -v brief | grep -F '${marker(op.marker)}' | tail -n 5 || true`;
    default: throw new Error("Unknown operation.");
  }
}
const SERIAL = /^[A-Za-z0-9._:\-]{1,100}$/;
const HOST = /^(\d{1,3}\.){3}\d{1,3}$/;

async function devices() {
  const out = await adb(["devices", "-l"]);
  return out.split("\n").slice(1).map((l) => l.trim()).filter(Boolean).map((l) => {
    const [serial, state] = l.split(/\s+/);
    const model = l.match(/model:(\S+)/)?.[1]?.replace(/_/g, " ");
    return { serial, state, model, transport: /:\d+$|_adb-tls-connect/.test(serial) ? "wifi" : "usb" };
  });
}

// --- HTTP ---------------------------------------------------------------
function send(res, status, body, origin) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    ...(origin ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : {}),
  });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 16_384) reject(new Error("Body too large"));
    });
    req.on("end", () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error("Invalid JSON")); }
    });
  });
}

const tokenOk = (t) => {
  const a = Buffer.from(String(t ?? "")), b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
};

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
  // The audit page asks for the token itself, so nobody has to copy it.
  if (req.method === "GET" && req.url === "/v1/hello") return send(res, 200, { token: TOKEN, version: HELPER_VERSION }, allowed);
  if (!tokenOk(req.headers["x-bridge-token"])) return send(res, 401, { error: "Wrong helper token — copy it from the helper window." }, allowed);

  try {
    const url = new URL(req.url, "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/v1/status") {
      const version = (await adb(["version"])).split("\n")[0].trim();
      return send(res, 200, { adb: version, devices: await devices() }, allowed);
    }
    if (req.method === "POST" && url.pathname === "/v1/run") {
      const { serial, op } = await readJson(req);
      if (!SERIAL.test(String(serial))) throw new Error("Invalid device serial.");
      const output = await adb(["-s", serial, "shell", buildCommand(op)]);
      return send(res, 200, { output }, allowed);
    }
    if (req.method === "POST" && url.pathname === "/v1/pair") {
      const { host, port, code } = await readJson(req);
      if (!HOST.test(String(host)) || !(port > 0 && port < 65536) || !/^\d{6}$/.test(String(code))) throw new Error("Enter the IP, port and 6-digit code shown on the phone.");
      const output = await adb(["pair", `${host}:${port}`, String(code)], 30_000);
      if (!/Successfully paired/i.test(output)) throw new Error(output.trim() || "Pairing failed — check the code and port.");
      // After pairing, the phone announces its connect port over mDNS. Connect
      // to it ourselves so the user doesn't have to type a second port.
      for (let i = 0; i < 8; i++) {
        const list = await devices();
        if (list.some((d) => d.transport === "wifi" && d.state === "device")) return send(res, 200, { output, connected: true }, allowed);
        const mdns = await adb(["mdns", "services"], 10_000).catch(() => "");
        const hit = mdns.split("\n").map((l) => l.match(/_adb-tls-connect\._tcp\.?\s+(\d{1,3}(?:\.\d{1,3}){3}):(\d+)/)).find((m) => m && m[1] === host);
        if (hit) await adb(["connect", `${hit[1]}:${hit[2]}`], 15_000).catch(() => "");
        await new Promise((r) => setTimeout(r, 1500));
      }
      return send(res, 200, { output, connected: false }, allowed);
    }
    if (req.method === "POST" && url.pathname === "/v1/connect") {
      const { host, port } = await readJson(req);
      if (!HOST.test(String(host)) || !(port > 0 && port < 65536)) throw new Error("Enter the IP and port shown under Wireless debugging.");
      return send(res, 200, { output: await adb(["connect", `${host}:${port}`], 30_000) }, allowed);
    }
    return send(res, 404, { error: "Not found" }, allowed);
  } catch (e) {
    return send(res, 400, { error: e.message }, allowed);
  }
});

server.listen(PORT, "127.0.0.1", async () => {
  let adbInfo = "";
  try { adbInfo = (await adb(["version"])).split("\n")[0].trim(); } catch { adbInfo = "NOT FOUND — install Android platform-tools"; }
  console.log("\n  CleverTap audit device helper is running");
  console.log(`  adb:      ${adbInfo}`);
  console.log(`  allowed:  ${[...ORIGINS].join(", ")}`);
  console.log(`\n  Token:    ${TOKEN}  (the audit page picks this up by itself)\n`);
  console.log("  Go back to the audit page — it connects automatically. Keep this window open; Ctrl+C to stop.\n");
});
