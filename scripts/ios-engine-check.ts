// Dev helper: run the iOS rule engine on a scan report (and optional Simulator log).
//   npx tsx scripts/ios-engine-check.ts scan.json [ctlog.ndjson] [accountId] [region]
import { readFileSync } from "node:fs";
import { evaluateIos } from "../lib/engine/ios";
import { parseIosCtLog } from "../lib/device/ios/ctlog";
import type { IosDeviceFindings } from "../lib/device/ios/types";

const [scanPath, logPath, accountId, region] = process.argv.slice(2);
const scan = JSON.parse(readFileSync(scanPath, "utf8"));
let device: IosDeviceFindings | undefined;
if (logPath) {
  const msgs = readFileSync(logPath, "utf8").split("\n").filter((l) => l.startsWith("{")).map((l, i) => {
    const j = JSON.parse(l);
    return { seq: i, ts: 0, proc: String(j.processImagePath ?? "").split("/").pop() ?? "", msg: String(j.eventMessage) };
  });
  device = {
    platform: "ios", connectedVia: "simulator-helper", target: "simulator", checkedAt: Date.now(),
    device: {}, app: { bundleId: scan.app.bundleId, installed: true }, pushTests: {}, deepLinks: [],
    notificationPermission: "not-determined", logs: parseIosCtLog(msgs, scan.app.executable),
  };
}
const out = evaluateIos({ scan, device, accountId, region, latest: { ios: "7.8.2" } });
for (const r of Object.values(out)) console.log(`${r.status.padEnd(6)} ${r.itemId.padEnd(34)} ${r.detected}`);
