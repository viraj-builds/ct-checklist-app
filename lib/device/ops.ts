import type { DeviceOp } from "./types";

// Turns a DeviceOp into the exact `adb shell` command. Inputs are validated so
// nothing user-controlled can inject shell syntax. Keep in sync with
// public/ct-device-bridge.mjs (the local helper has its own copy).

const PKG = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/;
const MARKER = /^[a-z0-9]{6,12}$/;
const URL_SAFE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[A-Za-z0-9\-._~:/?#[\]@!*+,=%]*$/;

export function buildCommand(op: DeviceOp): string {
  switch (op.t) {
    case "props":
      return "getprop";
    case "package":
      return `dumpsys package ${pkg(op.pkg)}`;
    case "notifications":
      return "dumpsys notification --noredact";
    case "findNotification":
      if (!MARKER.test(op.marker)) throw new Error("Invalid marker.");
      return `dumpsys notification --noredact | grep -F '${op.marker}' || true`;
    case "logcat":
      return `logcat -d -v brief -t ${Math.max(100, Math.min(8000, Math.floor(op.lines)))}`;
    case "logcatClear":
      return "logcat -c";
    case "pidof":
      // pidof exits 1 when not running; old Androids have no pidof → ps
      return `pidof ${pkg(op.pkg)} 2>/dev/null || ps 2>/dev/null | grep -F ' ${pkg(op.pkg)}' | grep -v -F '${pkg(op.pkg)}:' | head -n 1 || true`;
    case "launch":
      // like tapping the icon (resumes the task). `am start` instead of monkey/input:
      // Xiaomi blocks input injection unless "USB debugging (Security settings)" is on.
      return `c=$(cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.LAUNCHER ${pkg(op.pkg)} 2>/dev/null | tail -n 1); case "$c" in */*) am start -W -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -f 0x10200000 -n "$c";; *) monkey -p ${pkg(op.pkg)} -c android.intent.category.LAUNCHER 1;; esac`;
    case "home":
      return "am start -a android.intent.action.MAIN -c android.intent.category.HOME >/dev/null 2>&1 || input keyevent 3";
    case "kill":
      return `am kill ${pkg(op.pkg)}`;
    case "focus":
      return "{ dumpsys window displays | grep -E 'mCurrentFocus|mFocusedApp'; dumpsys activity activities | grep -E 'mResumedActivity|topResumedActivity'; } 2>/dev/null || true";
    case "deeplink":
      if (!URL_SAFE.test(op.url) || op.url.length > 500) throw new Error("Deep link contains unsupported characters.");
      return `am start -W -a android.intent.action.VIEW -d '${op.url}' ${pkg(op.pkg)}`;
    case "getLogTag":
      return "getprop log.tag";
    case "setLogTag":
      if (!/^[A-Za-z]{0,10}$/.test(op.level)) throw new Error("Invalid log level.");
      return `setprop log.tag '${op.level}'`; // not persistent: resets on reboot
    case "ctLogcat":
      return "logcat -d -v brief | grep -F CleverTap | tail -n 4000 || true";
    case "forceStop":
      return `am force-stop ${pkg(op.pkg)}`;
    case "logState":
      return `echo "log.tag=$(getprop log.tag)"; echo "persist.log.tag=$(getprop persist.log.tag)"; logcat -g 2>/dev/null | head -n 1`;
    case "logProbe":
      if (!MARKER.test(op.marker)) throw new Error("Invalid marker.");
      return `log -p v -t CTAuditProbe 'probe ${op.marker}'; log -p d -t CTAuditProbe 'probe ${op.marker}'; log -p i -t CTAuditProbe 'probe ${op.marker}'; sleep 1; logcat -d -v brief -s CTAuditProbe:V | grep -F '${op.marker}' || true`;
    case "setPersistLogTag":
      if (!/^[A-Za-z]{0,10}$/.test(op.level)) throw new Error("Invalid log level.");
      return `setprop persist.log.tag '${op.level}'`; // survives reboot — always restored
    case "setLogBuffer":
      if (!/^\d{2,5}[KM]$/.test(op.size)) throw new Error("Invalid buffer size.");
      return `logcat -G ${op.size}`;
    case "bgState":
      return `echo "bucket=$(am get-standby-bucket ${pkg(op.pkg)} 2>/dev/null)"; cmd appops get ${pkg(op.pkg)} RUN_ANY_IN_BACKGROUND 2>/dev/null; cmd appops get ${pkg(op.pkg)} 10008 2>/dev/null; dumpsys deviceidle whitelist 2>/dev/null | grep -qF ",${pkg(op.pkg)}," && echo whitelisted=1; true`;
    case "screen":
      return "{ dumpsys power | grep -E 'mWakefulness='; dumpsys activity activities | grep -E 'mKeyguardShowing='; dumpsys window | grep -E 'mShowingLockscreen=|mDreamingLockscreen=|isKeyguardShowing='; } 2>/dev/null || true";
    case "wake":
      return "input keyevent 224 2>/dev/null || true";
    case "setTagLevel":
      if (!/^[A-Za-z0-9_.:-]{1,60}$/.test(op.tag) || !/^[A-Za-z]{0,10}$/.test(op.level)) throw new Error("Invalid log tag.");
      return `setprop 'log.tag.${op.tag}' '${op.level}'`;
    case "findLog":
      if (!MARKER.test(op.marker)) throw new Error("Invalid marker.");
      return `logcat -d -v brief | grep -F '${op.marker}' | tail -n 5 || true`;
  }
}

function pkg(p: string) {
  if (!PKG.test(p) || p.length > 200) throw new Error("Invalid package name.");
  return p;
}
