// Dev check: run the brand-specific checks against a real phone over adb
// (USB or Wi-Fi). Changes to the phone's log settings are always restored.
//   npx tsx scripts/device-oem-check.ts com.example.app
import { execFile } from "node:child_process";
import { buildCommand } from "../lib/device/ops";
import { checkBackground, checkLogging, detectOem, liftLogging, readyScreen } from "../lib/device/oem";
import { parseProps } from "../lib/device/runner";
import type { DeviceDriver } from "../lib/device/drivers";

const ADB = process.env.ADB ?? "C:\\Android\\Sdk\\platform-tools\\adb.exe";
const PKG = process.argv[2] ?? "com.example.sportsphere";
const sh = (cmd: string) =>
  new Promise<string>((res, rej) =>
    execFile(ADB, ["shell", cmd], { maxBuffer: 64 << 20, timeout: 30_000 }, (e, out, err) => (e && !out ? rej(new Error(err || e.message)) : res(out))),
  );
const d: DeviceDriver = { via: "helper", transport: "wifi", serial: "", label: "", run: (op) => sh(buildCommand(op)), close: async () => {} };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const oem = detectOem(parseProps(await d.run({ t: "props" })));
  console.log("oem:", oem);
  console.log("logState before:", (await d.run({ t: "logState" })).trim());
  console.log("checkLogging:", await checkLogging(d, oem));
  const { state, restore } = await liftLogging(d, oem);
  console.log("liftLogging:", state);
  await restore();
  console.log("logState after restore:", (await d.run({ t: "logState" })).trim());
  console.log("screen:", await readyScreen(d));
  console.log("background:", await checkBackground(d, PKG, oem));

  console.log("launch:", (await d.run({ t: "launch", pkg: PKG })).trim().split("\n").slice(0, 3).join(" | "));
  await sleep(3000);
  console.log("pid (fg):", (await d.run({ t: "pidof", pkg: PKG })).trim(), "| focus has app:", (await d.run({ t: "focus" })).includes(PKG + "/"));
  await d.run({ t: "home" });
  await sleep(1500);
  console.log("pid (bg):", (await d.run({ t: "pidof", pkg: PKG })).trim(), "| focus has app:", (await d.run({ t: "focus" })).includes(PKG + "/"));
  await d.run({ t: "kill", pkg: PKG });
  await sleep(1500);
  console.log("pid (killed):", JSON.stringify((await d.run({ t: "pidof", pkg: PKG })).trim()));
})().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
