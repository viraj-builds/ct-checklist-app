// Dev check: run the live-device logic on a REAL phone through the local adb
// (same commands the website sends). No push is sent — app states are checked
// and timed only.
//   npx tsx scripts/device-adb.ts <package> [serial]
import { execFile } from "node:child_process";
import { buildCommand } from "../lib/device/ops";
import { runDeviceChecks } from "../lib/device/runner";
import type { DeviceDriver } from "../lib/device/drivers";
import type { DeviceOp } from "../lib/device/types";

const ADB = process.env.ADB ?? "C:\\Android\\Sdk\\platform-tools\\adb.exe";
const [pkg, serial] = process.argv.slice(2);
if (!pkg) throw new Error("usage: tsx scripts/device-adb.ts <package> [serial]");

const shell = (cmd: string) =>
  new Promise<string>((resolve, reject) =>
    execFile(ADB, [...(serial ? ["-s", serial] : []), "shell", cmd], { timeout: 30_000, maxBuffer: 64 << 20 }, (e, out, err) =>
      e && !out ? reject(new Error(err || e.message)) : resolve(String(out)),
    ),
  );

const driver: DeviceDriver = {
  via: "helper",
  transport: "usb",
  serial: serial ?? "default",
  label: "adb",
  async run(op: DeviceOp) {
    const t = Date.now();
    const out = await shell(buildCommand(op));
    console.log(`  ${op.t.padEnd(14)} ${String(Date.now() - t).padStart(5)} ms  ${out.length} bytes`);
    return out;
  },
  close: async () => {},
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log("== device checks");
  const f = await runDeviceChecks(driver, { pkg, deepLinks: [] }, () => {});
  console.log(JSON.stringify({ device: f.device, app: f.app, perm: f.notificationPermission, channels: f.channels, logs: f.ctLogs.lines.length }, null, 1));

  console.log("== app-state control");
  for (const state of ["foreground", "background", "killed"] as const) {
    await driver.run({ t: "launch", pkg });
    await sleep(3500);
    if (state !== "foreground") {
      await driver.run({ t: "home" });
      await sleep(1500);
    }
    if (state === "killed") {
      await driver.run({ t: "kill", pkg });
      await sleep(1500);
    }
    const pid = (await driver.run({ t: "pidof", pkg })).trim();
    const focus = await driver.run({ t: "focus" });
    console.log(`${state.padEnd(10)} pid=${pid || "-"} focus=${focus.trim().split("\n")[0]?.slice(0, 120)}`);
  }
})().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
