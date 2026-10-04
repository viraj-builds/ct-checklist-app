// Dev check: run the live-device logic against a simulated phone that returns
// realistic Android shell output.   npx tsx scripts/device-sim.ts
import { runDeviceChecks, runPushTest, runDeepLinkTests } from "../lib/device/runner";
import { buildCommand } from "../lib/device/ops";
import type { DeviceDriver } from "../lib/device/drivers";
import type { DeviceOp } from "../lib/device/types";

const PKG = "com.example.sportsphere";
let running = false;
let foreground = false;
let pending: string | null = null; // marker of a push "in flight"
let shade = "";
let logTag = "E";

const out: Record<DeviceOp["t"], (op: DeviceOp) => string> = {
  props: () => "[ro.product.model]: [Pixel 7]\n[ro.product.manufacturer]: [Google]\n[ro.build.version.release]: [14]\n[ro.build.version.sdk]: [34]\n",
  package: () =>
    `Packages:\n  Package [${PKG}] (abc):\n    versionCode=1 minSdk=24 targetSdk=36\n    versionName=1.0.0\n    runtime permissions:\n      android.permission.POST_NOTIFICATIONS: granted=true, flags=[ USER_SET ]\n`,
  notifications: () =>
    `  AppSettings: ${PKG} (10234)\n    NotificationChannel{mId='sportsshop_channel', mName=Sports Shop Offers, mDescription=Updates, mImportance=5, mBypassDnd=false}\n    NotificationChannel{mId='novamart_custom_push', mName=Custom, mDescription=, mImportance=4, mBypassDnd=false}\n  AppSettings: com.other.app (10300)\n    NotificationChannel{mId='other', mName=Other, mDescription=, mImportance=3}\n` +
    shade,
  findNotification: (op) => (shade.includes((op as { marker: string }).marker) ? shade : ""),
  logcat: () =>
    "D/CleverTap:8WW-975-K87Z: Account ID: 8WW-975-K87Z\nV/CleverTap: FCM token: fGz81kd9aLq0Xx2_ApA91bH7sdfk23kjsdf89\nE/CleverTap: Unable to render notification, channelId is null\nI/ActivityManager: Start proc\n",
  logcatClear: () => "",
  getLogTag: () => "E",
  setLogTag: (op) => ((logTag = (op as { level: string }).level), ""),
  ctLogcat: () => "D/CleverTap:8WW-975-K87Z(1): Queue sent successfully",
  forceStop: () => ((running = false), (foreground = false), ""),
  // behaves like a vivo: log.tag=E hides V/D/I until lifted
  logState: () => `log.tag=${logTag}
persist.log.tag=
main: ring buffer is 256 KiB (200 KiB consumed), max entry is 5120 B`,
  logProbe: (op) => (logTag === "V" ? ["V", "D", "I"].map((l) => `${l}/CTAuditProbe( 1): probe ${(op as { marker: string }).marker}`).join("\n") : ""),
  setPersistLogTag: () => "",
  setLogBuffer: () => "",
  bgState: () => "bucket=10\nRUN_ANY_IN_BACKGROUND: allow\n",
  screen: () => "  mWakefulness=Awake\n  mKeyguardShowing=false\n",
  wake: () => "",
  findLog: () => "",
  pidof: () => (running ? "12345\n" : ""),
  launch: () => ((running = true), (foreground = true), "Events injected: 1"),
  home: () => ((foreground = false), ""),
  kill: () => ((running = foreground), ""), // am kill only kills background apps
  focus: () => `  mCurrentFocus=Window{1 u0 ${foreground ? `${PKG}/${PKG}.MainActivity` : "com.google.android.apps.nexuslauncher/.NexusLauncherActivity"}}\n`,
  deeplink: (op) =>
    (op as { url: string }).url.startsWith("novamart://")
      ? `Starting: Intent { act=android.intent.action.VIEW }\nStatus: ok\nActivity: ${PKG}/.MainActivity\n`
      : "Error: Activity not started, unable to resolve Intent",
};

const driver: DeviceDriver = {
  via: "webusb",
  transport: "usb",
  serial: "SIM123",
  label: "Simulated Pixel 7",
  async run(op) {
    buildCommand(op); // also validates inputs exactly like the real drivers
    if ((op.t === "notifications" || op.t === "findNotification") && pending) {
      shade = `  NotificationRecord(0x0a1b: pkg=${PKG} user=UserHandle{0} id=1 importance=5)\n      extras={\n        android.title=String (CleverTap integration test)\n        android.text=String (works [${pending}])\n      }\n`;
      pending = null;
    }
    return out[op.t](op);
  },
  close: async () => {},
};

(async () => {
  const base = await runDeviceChecks(driver, { pkg: PKG, scanVersionName: "1.0.0", deepLinks: [] }, () => {});
  console.log("device:", base.device, "\napp:", base.app, "\npermission:", base.notificationPermission);
  console.log("channels:", base.channels.map((c) => c.id), "\nlogs:", base.ctLogs);

  for (const state of ["foreground", "background", "killed"] as const) {
    shade = "";
    const r = await runPushTest(driver, PKG, state, async (marker) => void (pending = marker), () => {});
    console.log(state.padEnd(10), r.status, "verifiedState=" + r.verifiedState, "|", r.stateDetail);
  }
  console.log(await runDeepLinkTests(driver, PKG, ["novamart://home", "other://x"]));
  try {
    buildCommand({ t: "deeplink", pkg: PKG, url: "x://a';reboot" });
  } catch (e) {
    console.log("injection blocked:", (e as Error).message);
  }
})();
