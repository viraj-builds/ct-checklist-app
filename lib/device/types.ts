// Live-device checks run from the browser against a phone connected over USB
// (WebUSB) or through the local ADB helper (USB or Wi-Fi).

export type AppState = "foreground" | "background" | "killed";

// The only commands the site can ask a device to run. Both the WebUSB driver
// and the local helper build the actual shell command from these — never from
// free text.
export type DeviceOp =
  | { t: "props" }
  | { t: "package"; pkg: string }
  | { t: "notifications" }
  | { t: "findNotification"; marker: string } // tiny output: only lines containing the marker
  | { t: "logcat"; lines: number }
  | { t: "logcatClear" }
  | { t: "pidof"; pkg: string }
  | { t: "launch"; pkg: string }
  | { t: "home" }
  | { t: "kill"; pkg: string }
  | { t: "focus" }
  | { t: "deeplink"; pkg: string; url: string }
  | { t: "getLogTag" } // some OEMs (vivo, Oppo…) set log.tag=E, which hides SDK logs
  | { t: "setLogTag"; level: string } // V…S or the phone's own value when restoring
  | { t: "ctLogcat" } // only CleverTap lines, newest 4000
  | { t: "forceStop"; pkg: string } // only for the "reopen while logged in" check — never before push tests
  | { t: "logState" } // log.tag, persist.log.tag, logcat buffer size
  | { t: "logProbe"; marker: string } // write V/D/I probe lines and read them back
  | { t: "setPersistLogTag"; level: string } // V…S or the phone's own value when restoring
  | { t: "setLogBuffer"; size: string } // e.g. "4M"; resets on reboot
  | { t: "bgState"; pkg: string } // standby bucket, background restriction, autostart, battery whitelist
  | { t: "screen" }
  | { t: "wake" }
  | { t: "findLog"; marker: string };

export interface OemInfo {
  family: "xiaomi" | "vivo" | "oppo" | "huawei" | "samsung" | "other";
  maker?: string;
  rom?: string;
}

export interface LoggingState {
  status: "ok" | "hidden" | "lifted" | "blocked"; // hidden = phone hides them, we lift it during the log session
  levelSeen: "V" | "D" | "I" | "none"; // lowest level that reaches logcat
  logTag: string;
  persistLogTag: string;
  bufferKb?: number;
  fix?: string; // what the user must change on the phone, when we can't
}

export interface BackgroundState {
  standbyBucket?: number;
  restrictedBucket?: boolean;
  backgroundRestricted?: boolean;
  batteryUnrestricted: boolean;
  autoStart?: "allowed" | "denied";
  hints: string[];
}

export interface PushTestResult {
  status: "delivered" | "not-delivered" | "error";
  verifiedState: boolean; // we confirmed the app really was in that state
  stateDetail: string;
  sentAt: number;
  deliveredAfterMs?: number;
  detail?: string;
  seenIn?: "shade" | "log"; // where we spotted it
  background?: BackgroundState; // read when a background/killed push didn't arrive
}

export interface LogScenarios {
  // App restarted while logged in: did onUserLogin run on start?
  relaunch?: { at: number; onUserLoginOnStart: boolean; kinds: string[] };
  // A push with a link was tapped: where did it open?
  linkTap?: { at: number; url: string; clicked: boolean; landed?: string; openedOutsideApp?: boolean };
}

export interface DeviceFindings {
  connectedVia: "webusb" | "helper";
  transport: "usb" | "wifi";
  checkedAt: number;
  device: { model?: string; manufacturer?: string; android?: string; sdk?: number; rom?: string };
  logging?: LoggingState;
  background?: BackgroundState;
  screen?: { awake: boolean; locked: boolean };
  app: { package: string; installed: boolean; versionName?: string; versionCode?: string; matchesScan?: boolean };
  notificationPermission?: "granted" | "denied" | "not-required" | "unknown";
  channels: { id: string; name?: string; importance?: number }[];
  ctLogs: {
    lines: string[]; // last CleverTap log lines (redacted)
    verbose: boolean; // debug logging is on
    accountId?: string;
    errors: string[];
  };
  pushTests: Partial<Record<AppState, PushTestResult>>;
  logs?: import("./ctlog").LogInsights;
  logScenarios?: LogScenarios;
  logTagWasRestricted?: boolean;
  deepLinks: { url: string; ok: boolean; activity?: string; detail?: string }[];
}
