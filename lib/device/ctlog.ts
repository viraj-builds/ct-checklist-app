// Parses CleverTap SDK verbose logs (logcat, tag "CleverTap…") into facts the
// rule engine can use. Personal data never leaves this function: profile values
// are reduced to key names plus "phone looks valid".
//
// Log lines this relies on (CleverTap Android SDK, verbose/debug level):
//   Activity Lifecycle Callback successfully registered
//   Firing App Launched event
//   Send queue contains N items: [{"type":"meta","af":{"SDK Version":70800,"lib":"Flutter","Flutter":30801,
//        "Latitude":..,"Longitude":..},"id":"<account>","ct_pi":"Email,Identity",...}, ...]
//   Sending request to: https://eu1.clevertap-prod.com/a1?...
//   Queue sent successfully
//   Queued event: {"evtName":"Home Viewed","evtData":{...},"type":"event"}
//   Queued event: {"profile":{...},"type":"profile"}
//   onUserLogin: ... maps to current device id ... | queuing reset profile for ... | no identifier provided ...
//   [PushType:fcm] getting Cached Token - ...
//   received notification from CleverTap: ... | Rendering Push on channel = X | Rendered Push Notification in N
//   Created default fallback channel: X | Not rendering Push since channel id is null or blank.
//   Displaying In-App: ... | Not showing notification on blacklisted activity
//   Unable to display In-App: Activity/Fragment is null | InApp media failed to load

export interface LoggedEvent {
  name: string;
  count: number;
  props: Record<string, string[]>; // prop -> observed types
  issues: string[];
}

export interface LogInsights {
  lines: number;
  sdkVersion?: string;
  wrapper?: { lib: string; version?: string };
  accountId?: string;
  region?: string;
  identityKeys?: string[];
  lifecycleRegistered: boolean;
  appLaunchedFired: boolean;
  queueSent: number;
  queueFailed: number;
  pushToken: boolean;
  locationSent: boolean;
  networkInfo?: boolean; // carrier / network fields sent → enableDeviceNetworkInfoReporting(true)
  onUserLogin: { kind: "same-user" | "switch-user" | "anonymous" | "aborted" | "failed"; line: number }[];
  profilePushes: { keys: string[]; hasIdentity: boolean; phoneValid?: boolean; nullish: string[]; line: number }[];
  events: LoggedEvent[];
  clicks: { deepLink?: string; line: number }[];
  push: {
    received: number; // CleverTap pushes the SDK received from FCM
    rendered: number;
    channels: string[]; // channels pushes were rendered on
    fallbackChannel?: string; // the app's channel didn't exist, SDK created a fallback
    impressions: number; // push "Notification Viewed" queued from this device
    errors: string[];
  };
  inApp: {
    shown: number;
    blockedOnExcludedScreen: boolean;
    impressions: number; // in-app "Notification Viewed" queued
    errors: string[];
  };
  errors: string[];
}

const SYSTEM = /^(App Launched|App Installed|Notification Viewed|Notification Clicked|App Uninstalled|wzrk_.*|Push Impressions|UTM Visited|App Version Changed)$/;
const NULLISH = new Set(["null", "undefined", "nil", "none", ""]);
const DATE_STRING = /^(\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?|\d{1,2}[/-]\d{1,2}[/-]\d{2,4})$/;
const NUMERIC_KEY = /amount|price|qty|quantity|total|revenue|value|count|discount|cost/i;
const E164 = /^\+[1-9]\d{7,14}$/;
const IDENTITY_KEYS = new Set(["Identity", "Email", "Phone"]);

/** CleverTap version codes are MMmmpp (70800 -> 7.8.0, 80401 -> 8.4.1). */
export function versionFromCode(code: number): string {
  return `${Math.floor(code / 10000)}.${Math.floor(code / 100) % 100}.${code % 100}`;
}

function jsonAfter(line: string, marker: string): unknown {
  const i = line.indexOf(marker);
  if (i < 0) return undefined;
  try {
    return JSON.parse(line.slice(i + marker.length).trim());
  } catch {
    return undefined; // truncated by logcat's 4 KB limit
  }
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
  return typeof v; // number | boolean | object
}

export function parseCtLog(text: string): LogInsights {
  const lines = text.split(/\r?\n/).filter((l) => l.includes("CleverTap"));
  const out: LogInsights = {
    lines: lines.length,
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
  let rcvA = 0;
  let rcvB = 0;
  const addErr = (list: string[], msg: string) => {
    if (list.length < 8 && !list.includes(msg)) list.push(msg);
  };
  const events = new Map<string, LoggedEvent>();

  lines.forEach((l, i) => {
    if (l.includes("Activity Lifecycle Callback successfully registered")) out.lifecycleRegistered = true;
    if (l.includes("Firing App Launched event")) out.appLaunchedFired = true;
    if (l.includes("Queue sent successfully")) out.queueSent++;
    if (/Queue send failed|Error sending queue|An exception occurred while sending the queue/i.test(l)) out.queueFailed++;
    if (/\[PushType:fcm\].*Token/i.test(l) || /FCM token/i.test(l)) out.pushToken = true;

    // push
    // the same push can appear under two tags — count each source once, keep the larger
    if (l.includes("received notification from CleverTap")) rcvA++;
    if (/Handling notification: Bundle\[\{.*wzrk_/.test(l)) rcvB++;
    if (/Rendered Push Notification in|Rendered notification:/.test(l)) out.push.rendered++;
    const ch = l.match(/Rendering Push on channel = (\S+)/)?.[1];
    if (ch && !out.push.channels.includes(ch)) out.push.channels.push(ch);
    const fb = l.match(/Created (?:default|low importance) fallback channel: (\S+)/)?.[1];
    if (fb) out.push.fallbackChannel = fb;
    if (/Not rendering Push since channel id is null or blank/.test(l)) addErr(out.push.errors, "Push not shown: no notification channel ID was sent.");
    if (/Couldn't render notification/.test(l)) addErr(out.push.errors, "A push couldn't be rendered.");
    if (/Push notification message is empty, not rendering/.test(l)) addErr(out.push.errors, "A push had an empty message and wasn't shown.");
    if (/Error getting or creating notification channel/.test(l)) addErr(out.push.errors, "The SDK couldn't create the notification channel.");

    // in-app
    if (/Displaying (PIP )?In-App|Notification ready: \{"type":"(?!custom-key-value)/.test(l)) out.inApp.shown++;
    if (l.includes("Not showing notification on blacklisted activity")) out.inApp.blockedOnExcludedScreen = true;
    if (/Unable to display In-App: Activity\/Fragment is null/.test(l))
      addErr(out.inApp.errors, "In-app couldn't be shown: the host activity isn't a FragmentActivity (common on Flutter/React Native).");
    if (/InApp media failed to load|PIP media failed to load/.test(l)) addErr(out.inApp.errors, "An in-app's image/video failed to load.");
    if (/InApp has elapsed its time to live/.test(l)) addErr(out.inApp.errors, "An in-app expired before it could be shown.");

    const host = l.match(/Sending request to: https?:\/\/([a-z0-9-]+)\.clevertap-prod\.com/i)?.[1];
    if (host) out.region = host.toLowerCase().replace(/-spiky$/, ""); // eu1-spiky = eu1's impression host

    if (l.includes("Send queue contains")) {
      // the meta header is the first item — read fields by regex (the JSON may be truncated)
      const sdk = l.match(/"SDK Version":(\d+)/)?.[1];
      if (sdk) out.sdkVersion = versionFromCode(Number(sdk));
      const lib = l.match(/"lib":"([A-Za-z-]+)"/)?.[1];
      if (lib && lib !== "Android") {
        const v = l.match(new RegExp(`"${lib}":(\\d+)`))?.[1];
        out.wrapper = { lib, version: v ? versionFromCode(Number(v)) : undefined };
      }
      const acc = l.match(/"type":"meta".*?"id":"([A-Z0-9]{3}-[A-Z0-9]{3}-[A-Z0-9]{4})"/)?.[1];
      if (acc) out.accountId = acc;
      const pi = l.match(/"ct_pi":"([^"]*)"/)?.[1];
      if (pi) out.identityKeys = pi.split(",").filter(Boolean);
      if (/"Latitude":-?\d/.test(l) && /"Longitude":-?\d/.test(l)) out.locationSent = true;
      // the SDK only adds carrier / radio / wifi to the header when network info reporting is on
      if (/"af":\{[^}]*"(Carrier|Radio|wifi)":/.test(l)) out.networkInfo = true;
    }

    const login = l.match(/onUserLogin: (.*)$/)?.[1];
    if (login) {
      const kind = /maps to current device id/.test(login)
        ? "same-user"
        : /queuing reset profile/.test(login)
          ? "switch-user"
          : /no identifier provided|device is anonymous/.test(login)
            ? "anonymous"
            : /Aborting/.test(login)
              ? "aborted"
              : undefined;
      if (kind) out.onUserLogin.push({ kind, line: i });
    }
    if (/onUserLogin failed/.test(l)) out.onUserLogin.push({ kind: "failed", line: i });

    if (l.includes("Queued event: {")) {
      const ev = jsonAfter(l, "Queued event:") as
        | { type?: string; evtName?: string; evtData?: Record<string, unknown>; profile?: Record<string, unknown> }
        | undefined;
      if (!ev) return;
      if (ev.type === "profile" && ev.profile) {
        const keys = Object.keys(ev.profile).filter((k) => !/^(Carrier|cc|tz|ct_.*)$/.test(k));
        if (!keys.length) return;
        const phone = ev.profile.Phone;
        out.profilePushes.push({
          keys,
          hasIdentity: keys.some((k) => IDENTITY_KEYS.has(k)),
          phoneValid: phone === undefined ? undefined : E164.test(String(phone)),
          nullish: keys.filter((k) => ["null", "empty"].includes(typeOf(ev.profile![k]))),
          line: i,
        });
        return;
      }
      if (ev.type === "event" && ev.evtName) {
        if (ev.evtName === "Notification Viewed") {
          // push impressions carry wzrk_pn; in-app ones don't
          if (ev.evtData && "wzrk_pn" in ev.evtData) out.push.impressions++;
          else out.inApp.impressions++;
        }
        if (ev.evtName === "Notification Clicked") {
          const dl = (ev.evtData?.wzrk_dl ?? ev.evtData?.deep_link) as string | undefined;
          out.clicks.push({ deepLink: typeof dl === "string" ? dl : undefined, line: i });
        }
        if (SYSTEM.test(ev.evtName)) return;
        const e = events.get(ev.evtName) ?? { name: ev.evtName, count: 0, props: {}, issues: [] };
        e.count++;
        for (const [k, v] of Object.entries(ev.evtData ?? {})) {
          const t = typeOf(v);
          const seen = (e.props[k] ??= []);
          if (!seen.includes(t)) seen.push(t);
          const issue =
            t === "null" || t === "empty"
              ? `${k} is ${t === "null" ? "null" : "an empty/\"null\" string"}`
              : t === "string" && NUMERIC_KEY.test(k) && /^-?\d+(\.\d+)?$/.test(String(v).trim())
                ? `${k} is a number sent as text`
                : t === "string" && DATE_STRING.test(String(v).trim())
                  ? `${k} is a date sent as text (use $D_ epoch)`
                  : undefined;
          if (issue && !e.issues.includes(issue)) e.issues.push(issue);
        }
        events.set(ev.evtName, e);
      }
    }

    const lvl = l.trim()[0];
    const benign = /Not sending last location|location ping|is not present|already processed|dropping duplicate/i.test(l);
    if (!benign && (lvl === "E" || /invalid|channel.*(not|doesn't) exist|Unable to render|Unable to display/i.test(l))) {
      const msg = l.replace(/\b[A-Za-z0-9_\-:]{24,}\b/g, (s) => (/\d/.test(s) && /[A-Za-z]/.test(s) ? s.slice(0, 4) + "…" : s)).slice(0, 240);
      if (out.errors.length < 15 && !out.errors.includes(msg)) out.errors.push(msg);
    }
  });

  out.push.received = Math.max(rcvA, rcvB);
  out.events = [...events.values()].slice(0, 50);
  out.profilePushes = out.profilePushes.slice(-10);
  out.onUserLogin = out.onUserLogin.slice(-20);
  out.clicks = out.clicks.slice(-10);
  return out;
}

/**
 * Combine what earlier log sessions found with the current one, so a result
 * never disappears just because a new session started (the score would drop).
 */
export function mergeInsights(prev: LogInsights | undefined, next: LogInsights): LogInsights {
  if (!prev) return next;
  // older saved sessions may predate the push / in-app fields
  prev = { ...prev, push: prev.push ?? next.push, inApp: prev.inApp ?? next.inApp, clicks: prev.clicks ?? [], events: prev.events ?? [] };
  const uniq = <T,>(a: T[], b: T[], key: (x: T) => string, max: number) => {
    const m = new Map<string, T>();
    for (const x of [...a, ...b]) m.set(key(x), x);
    return [...m.values()].slice(-max);
  };
  const events = new Map(prev.events.map((e) => [e.name, e]));
  for (const e of next.events) {
    const p = events.get(e.name);
    if (!p) events.set(e.name, e);
    else {
      const props: Record<string, string[]> = { ...p.props };
      for (const [k, t] of Object.entries(e.props)) props[k] = [...new Set([...(props[k] ?? []), ...t])].slice(0, 8);
      events.set(e.name, { ...e, count: Math.max(p.count, e.count), props, issues: [...new Set([...p.issues, ...e.issues])].slice(0, 30) });
    }
  }
  return {
    ...next,
    lines: Math.max(prev.lines, next.lines),
    sdkVersion: next.sdkVersion ?? prev.sdkVersion,
    wrapper: next.wrapper ?? prev.wrapper,
    accountId: next.accountId ?? prev.accountId,
    region: next.region ?? prev.region,
    identityKeys: next.identityKeys ?? prev.identityKeys,
    lifecycleRegistered: prev.lifecycleRegistered || next.lifecycleRegistered,
    appLaunchedFired: prev.appLaunchedFired || next.appLaunchedFired,
    queueSent: Math.max(prev.queueSent, next.queueSent),
    queueFailed: next.queueFailed,
    pushToken: prev.pushToken || next.pushToken,
    locationSent: prev.locationSent || next.locationSent,
    networkInfo: !!(prev.networkInfo || next.networkInfo),
    onUserLogin: uniq(prev.onUserLogin, next.onUserLogin, (x) => x.kind, 20),
    profilePushes: uniq(prev.profilePushes, next.profilePushes, (x) => x.keys.join(",") + x.hasIdentity + x.phoneValid, 10),
    events: [...events.values()].slice(0, 50),
    clicks: uniq(prev.clicks, next.clicks, (x) => x.deepLink ?? String(x.line), 10),
    push: {
      received: Math.max(prev.push.received, next.push.received),
      rendered: Math.max(prev.push.rendered, next.push.rendered),
      channels: [...new Set([...prev.push.channels, ...next.push.channels])].slice(0, 20),
      fallbackChannel: next.push.fallbackChannel ?? prev.push.fallbackChannel,
      impressions: Math.max(prev.push.impressions, next.push.impressions),
      errors: next.push.errors,
    },
    inApp: {
      shown: Math.max(prev.inApp.shown, next.inApp.shown),
      blockedOnExcludedScreen: prev.inApp.blockedOnExcludedScreen || next.inApp.blockedOnExcludedScreen,
      impressions: Math.max(prev.inApp.impressions, next.inApp.impressions),
      errors: next.inApp.errors,
    },
    errors: [...new Set([...next.errors])].slice(0, 15),
  };
}
