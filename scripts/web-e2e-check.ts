// Dev check: run a whole website audit through the server code (no HTTP, no
// sign-in) against the real database, print the results, then delete the row.
//   npx tsx --env-file=.env.local --conditions=react-server scripts/web-e2e-check.ts <url> <accountId> <region>
import { db } from "../lib/server/supabase";
import { createAudit, deleteAudit, getAuditFor, saveScan } from "../lib/server/audits";
import { crawlSite } from "../lib/web/crawler";
import { assertSafeSiteUrl } from "../lib/web/safe-url";

const [raw, accountId, region] = process.argv.slice(2);

(async () => {
  const { data } = await db().from("audits").select("owner_id, owner_email").not("owner_id", "is", null).limit(1).single();
  const owner = { id: (data as { owner_id: string }).owner_id, email: (data as { owner_email: string }).owner_email, isStaff: true };
  const url = await assertSafeSiteUrl(raw);
  const { id } = await createAudit({ name: "web e2e check", platform: "web", source: "url", region, accountId, siteUrl: url.href, owner, inputs: { criticalEvents: ["Product Viewed"], expectApi: false } });
  console.log("created", id);
  try {
    const { report } = await crawlSite({ url });
    await saveScan(id, report);
    const audit = await getAuditFor(id, owner);
    console.log("status", audit.status, "mode", audit.mode, "source", audit.source, "target", audit.target, "webScan", !!audit.webScan);
    for (const r of Object.values(audit.results)) console.log(`${r.status.padEnd(6)} ${r.itemId.padEnd(28)} ${r.detected ?? ""}`);
  } finally {
    await deleteAudit(id);
    console.log("deleted", id);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
