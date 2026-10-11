// Dev helper: run the iOS static analyzer on a local file.
//   npx tsx scripts/scan-ipa.ts path/to/app.ipa   (or a zipped .app / .xcarchive)
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { analyzeIos } from "../lib/analyzer/ios";

const file = process.argv[2];
if (!file) {
  console.error("usage: tsx scripts/scan-ipa.ts <ipa|zip>");
  process.exit(1);
}
const data = new Uint8Array(readFileSync(file));
analyzeIos(data, basename(file), "server").then((r) => console.log(JSON.stringify(r, null, 2)));
