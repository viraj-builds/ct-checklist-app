// Dev helper: run the website crawler + web rule engine on a URL.
//   npx tsx --conditions=react-server scripts/scan-site.ts https://example.com [accountId] [region]
//   CT_LOGIN_USER=... CT_LOGIN_PASS=... [CT_LOGIN_URL=/login]  → also tests the login flow
import { crawlSite } from "../lib/web/crawler";
import { assertSafeSiteUrl } from "../lib/web/safe-url";
import { evaluateWeb } from "../lib/engine/web";

const [raw, accountId, region] = process.argv.slice(2);
if (!raw) {
  console.error("usage: tsx --conditions=react-server scripts/scan-site.ts <url> [accountId] [region]");
  process.exit(1);
}

(async () => {
  const url = await assertSafeSiteUrl(raw);
  const login = process.env.CT_LOGIN_USER
    ? { username: process.env.CT_LOGIN_USER, password: process.env.CT_LOGIN_PASS ?? "", url: process.env.CT_LOGIN_URL }
    : undefined;
  const { report, identity } = await crawlSite({ url, login });
  console.log(JSON.stringify(report, null, 2));
  console.log("identity seen on login:", identity ? "yes" : "no");
  const results = evaluateWeb({ scan: report, accountId, region });
  for (const r of Object.values(results)) console.log(`${r.status.padEnd(6)} ${r.itemId.padEnd(28)} ${r.detected ?? ""}`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
