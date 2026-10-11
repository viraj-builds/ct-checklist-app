// Parses CleverTap iOS SDK debug logs (unified log, subsystem
// "com.clevertap.sdk" or NSLog lines starting "[CleverTap]") into the same
// LogInsights shape the Android log session produces. Personal data never
// leaves this function: profile values become key names plus "phone looks
// valid".
//
// Lines this relies on (CleverTap iOS SDK, setDebugLevel(1+)):
//   Initializing default CleverTap SDK instance. CleverTapAccountID: X CleverTapToken: Y CleverTapRegion: eu1
//   recording App Launched event from: appEnteredForeground
//   New event processed: {"evtName":"…","evtData":{…},"type":"event"} | {"type":"profile","profile":{…}}
//   Sending [{"type":"meta","af":{"SDK Version":70701,"lib":"Flutter",…}}, …] to servers at https://eu1.clevertap-prod.com/a1?…
//   Successfully sent N events | Got N response when sending queue, will retry | Network error while sending queue
//   onUserLogin: profile {…} maps to current device id … | either don't have identifier or device is anonymous
//   async switching user with properties
//   registering APNs device token … | Saving APNS token … | APNS Push Token not found
//   Application failed to register for remote notification: …
//   handling push notification: … | Firing deep link: … | handling open URL …
//   InApp did show: … | InApp Notifications are set to be suspended … | unable to process inapp notification
//   Setting device network info reporting state from storage to: YES|NO
// Every message is capped at ~1 KB by os_log, so JSON payloads are often cut
// off — they are repaired before reading.

import type { LogInsights, LoggedEvent } from "../ctlog";

export interface IosLogMessage {
  seq: number;
  ts: number; // epoch ms
  proc: string; // process name (app executable or extension)
  msg: string;
}

const SYSTEM = /^(App Launched|App Installed|Notification Viewed|Notification Clicked|App Uninstalled|wzrk_.*|Push Impressions|UTM Visited|App Version Changed|Push Permission Response|Channel Subscribed)$/;
const NULLISH = new Set(["null", "undefined", "nil", "none", "(null)", ""]);
const DATE_STRING = /^(\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?|\d{1,2}[/-]\d{1,2}[/-]\d{2,4})$/;
const NUMERIC_KEY = /amount|price|qty|quantity|total|revenue|value|count|discount|cost/i;
const E164 = /^\+[1-9]\d{7,14}$/;
const IDENTITY_KEYS = new Set(["Identity", "Email", "Phone"]);

/** Close a JSON prefix cut off by the log size limit so its complete part can be read. */
export function parseLooseJson(s: string): unknown {
  const t = s.trim();
  try {
    return JSON.parse(t);
  } catch {
    /* repair below */
  }
  const stack: string[] = [];
  let inStr = false;
  let esc = false;
  let lastSafe = -1; // index after the last complete value at any depth
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{" || c === "[") stack.push(c === "{" ? "}" : "]");
    else if (c === "}" || c === "]") {
      stack.pop();
      lastSafe = i + 1;
    } else if (c === ",") lastSafe = i;
  }
  if (lastSafe < 0) return undefined;
  // recompute the open brackets at the cut point
  const head = t.slice(0, lastSafe);
  const open: string[] = [];
  inStr = false;
  esc = false;
  for (const c of head) {
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{" || c === "[") open.push(c === "{" ? "}" : "]");
    else if (c === "}" || c === "]") open.pop();
  }
  try {
    return JSON.parse(head.replace(/,\s*$/, "") + open.reverse().join(""));
  } catch {
    return undefined;
  }
}

function jsonAfter(msg: string, marker: string, end?: string): unknown {
  const i = msg.indexOf(marker);
  if (i < 0) return undefined;
  let body = msg.slice(i + marker.length);
  if (end) {
    const j = body.lastIndexOf(end);
    if (j > 0) body = body.slice(0, j);
  }
  return parseLooseJson(body);
}

function typeOf(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "string") {
    const s = v.trim();
    if (NULLISH.has(s.toLowerCase())) return "empty";
    if (/^\$D_\d+$/.test(s)) return "date";
    return "string";
  }
  return typeof v;
}

export function parseIosCtLog(messages: IosLogMessage[] | string[], executable?: string): LogInsights {
  const all = (messages as (IosLogMessage | string)[]).map((m, i) => (typeof m === "string" ? { seq: i, ts: 0, proc: "", msg: m } : m));
  const msgs = all.filter((m) => m.msg.includes("[CleverTap]") || m.msg.includes("CleverTap"));
  const out: LogInsights = {
    lines: msgs.length,
    lifecycleRegistered: false,
    appLaunchedFired: false,
    queueSent: 0,
    queueFailed: 0,
    pushToken: false,
    locationSent: false,
    networkInfo: false,
    onUserLogin: [],
    profilePushes: [],
    events: [],
    clicks: [],
    push: { received: 0, rendered: 0, channels: [], impressions: 0, errors: [] },
    inApp: { shown: 0, blockedOnExcludedScreen: false, impressions: 0, errors: [] },
    errors: [],
  };
  const addErr = (list: string[], msg: string) => {
    if (list.length < 8 && !list.includes(msg)) list.push(msg);
  };
  const events = new Map<string, LoggedEvent>();

  for (const { seq, msg, proc } of msgs) {
    const fromExtension = !!executable && !!proc && proc !== executable;

    // credentials + region
    const init = msg.match(/CleverTapAccountID:\s*(\S+)\s+CleverTapToken:\s*\S*\s+CleverTapRegion:\s*(\S*)/);
    if (init) {
      out.accountId = init[1];
      if (init[2]) out.region = init[2].toLowerCase();
    }
    const host = msg.match(/to servers at https?:\/\/([a-z0-9-]+)\.(?:clevertap-prod|wzrkt)\.com/i) ?? msg.match(/https?:\/\/([a-z0-9-]+)\.clevertap-prod\.com/i);
    if (host && !/^(api|ios|d2)$/i.test(host[1])) out.region = host[1].toLowerCase();
    const acct = msg.match(/CleverTap\.([A-Z0-9]{3}-[A-Z0-9]{3}-[A-Z0-9]{3,5})\b/);
    if (acct && !out.accountId) out.accountId = acct[1];

    if (/Auto Integration enabled/i.test(msg)) out.lifecycleRegistered = true; // iOS: SDK hooked into the app delegate

    // queue
    const sent = msg.match(/Successfully sent (\d+) events/);
    if (sent) out.queueSent += Number(sent[1]);
    if (/Got \d+ response when sending queue|Network error while sending queue/.test(msg)) out.queueFailed++;
    if (/Unauthorized access from a non-test profile/.test(msg)) addErr(out.errors, "CleverTap rejected a request: the profile isn't marked as a test profile.");
    if (/Account ID\/token not found|CleverTap accountId is empty|CleverTap accountToken is empty/.test(msg)) addErr(out.errors, "Account ID or token is missing in the app.");

    // meta header: SDK version, wrapper, location, network info
    if (msg.includes("Sending [") || msg.includes('"af":{')) {
      const v = msg.match(/"SDK Version"\s*:\s*(\d{5,6})/);
      if (v) out.sdkVersion = versionFromCode(Number(v[1]));
      const lib = msg.match(/"lib"\s*:\s*"([^"]+)"/);
      if (lib && !out.wrapper) out.wrapper = { lib: lib[1] };
      if (/"Latitude"\s*:/.test(msg) && /"Longitude"\s*:/.test(msg)) out.locationSent = true;
      if (/"Carrier"\s*:|"Radio"\s*:/.test(msg)) out.networkInfo = true;
    }
    const ni = msg.match(/device network info reporting state(?: from storage)? to:\s*(YES|NO|1|0)/i);
    if (ni) out.networkInfo = /YES|1/i.test(ni[1]);
    if (/enableDeviceNetworkInfoReporting.*(YES|true|1)/i.test(msg)) out.networkInfo = true;

    // push token
    if (/registering APNs device token|Saving APNS token/i.test(msg)) out.pushToken = true;
    const reg = msg.match(/failed to register for remote notification:?\s*(.*)$/i);
    if (reg) addErr(out.push.errors, `APNs registration failed: ${reg[1].slice(0, 160)}`);
    if (/Notification permission is denied/.test(msg)) addErr(out.push.errors, "Notification permission is denied on this device.");

    // push received / clicked
    if (/handling push notification:|Handling notification:/.test(msg) && !/not from CleverTap/.test(msg)) out.push.received++;
    const dl = msg.match(/[Ff]iring deep link:\s*(\S+)/);
    if (dl) out.clicks.push({ deepLink: dl[1], line: seq });
    if (/Unable to fire deep link/.test(msg)) addErr(out.push.errors, msg.replace(/^.*Unable to fire deep link:?\s*/, "Deep link failed: ").slice(0, 160));

    // onUserLogin
    if (/onUserLogin: profile [\s\S]* maps to current device id/.test(msg)) out.onUserLogin.push({ kind: "same-user", line: seq });
    else if (/onUserLogin: either don't have identifier or device is anonymous/.test(msg)) out.onUserLogin.push({ kind: "anonymous", line: seq });
    else if (/async switching user with properties/.test(msg)) out.onUserLogin.push({ kind: "switch-user", line: seq });
    if (/onUserLogin/.test(msg)) {
      const keys = [...msg.matchAll(/\b(Identity|Email|Phone)\s*=/g)].map((m) => m[1]);
      if (keys.length) out.identityKeys = [...new Set([...(out.identityKeys ?? []), ...keys])];
    }

    // events + profile updates
    if (msg.includes("New event processed:")) {
      const ev = jsonAfter(msg, "New event processed:") as Record<string, unknown> | undefined;
      if (!ev) continue;
      if (ev.type === "profile" && ev.profile && typeof ev.profile === "object") {
        const p = ev.profile as Record<string, unknown>;
        const keys = Object.keys(p).filter((k) => !["cc", "tz"].includes(k));
        const phone = typeof p.Phone === "string" ? p.Phone : typeof p.Phone === "number" ? String(p.Phone) : undefined;
        out.profilePushes.push({
          keys,
          hasIdentity: keys.some((k) => IDENTITY_KEYS.has(k)),
          phoneValid: phone === undefined ? undefined : E164.test(phone.replace(/[\s-]/g, "")),
          nullish: keys.filter((k) => ["null", "empty"].includes(typeOf(p[k]))),
          line: seq,
        });
        continue;
      }
      const name = typeof ev.evtName === "string" ? ev.evtName : undefined;
      if (!name) continue;
      const data = (ev.evtData && typeof ev.evtData === "object" ? ev.evtData : {}) as Record<string, unknown>;
      if (name === "App Launched") out.appLaunchedFired = true;
      if (name === "Notification Viewed") {
        if (data.wzrk_pn === true || data.wzrk_pn === "true" || data.wzrk_pn === 1 || fromExtension) out.push.impressions++;
        else out.inApp.impressions++;
      }
      if (name === "Notification Clicked") out.clicks.push({ deepLink: typeof data.wzrk_dl === "string" ? data.wzrk_dl : undefined, line: seq });
      if (SYSTEM.test(name)) continue;
      const e = events.get(name) ?? { name, count: 0, props: {}, issues: [] };
      e.count++;
      for (const [k, v] of Object.entries(data)) {
        const t = typeOf(v);
        const seen = (e.props[k] ??= []);
        if (!seen.includes(t) && seen.length < 8) seen.push(t);
        const issue =
          t === "empty"
            ? `${k} is null/empty`
            : t === "string" && NUMERIC_KEY.test(k) && /^-?\d+(\.\d+)?$/.test(String(v).trim())
              ? `${k} is a number sent as text`
              : t === "string" && DATE_STRING.test(String(v).trim())
                ? `${k} is a date sent as text`
                : undefined;
        if (issue && !e.issues.includes(issue) && e.issues.length < 30) e.issues.push(issue);
      }
      events.set(name, e);
    }
    if (msg.includes("recording App Launched event")) out.appLaunchedFired = true;

    // in-app
    if (/InApp did show:/.test(msg)) out.inApp.shown++;
    if (/InApp Notifications are set to be suspended|InApp Notifications are set to be discarded/.test(msg)) out.inApp.blockedOnExcludedScreen = true;
    if (/unable to process inapp notification|unable to parse inapp notification|Malformed InApp notification|Not showing PiP InApp .* media failed|Failed to display inapp notification/i.test(msg))
      addErr(out.inApp.errors, msg.replace(/^\[CleverTap\]:\s*/, "").replace(/<[^>]+>:\s*/, "").slice(0, 160));
  }
  out.events = [...events.values()].slice(0, 50);
  out.clicks = out.clicks.slice(-10);
  out.onUserLogin = out.onUserLogin.slice(-20);
  out.profilePushes = out.profilePushes.slice(-10);
  return out;
}

/** CleverTap version codes are MMmmpp (70701 -> 7.7.1). */
function versionFromCode(code: number): string {
  return `${Math.floor(code / 10000)}.${Math.floor(code / 100) % 100}.${code % 100}`;
}
