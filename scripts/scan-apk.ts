// Dev helper: run the Android static analyzer on a local file.
//   npx tsx scripts/scan-apk.ts path/to/app.apk
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { analyzeAndroid } from "../lib/analyzer/android";

const file = process.argv[2];
if (!file) {
  console.error("usage: tsx scripts/scan-apk.ts <apk|aab|apks|xapk>");
  process.exit(1);
}
const data = new Uint8Array(readFileSync(file));
analyzeAndroid(data, basename(file), "server").then((r) => console.log(JSON.stringify(r, null, 2)));
