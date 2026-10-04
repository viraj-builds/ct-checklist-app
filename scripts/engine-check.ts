// Dev check: re-run the rule engine on a stored audit and print each status.
//   npx tsx --env-file=.env.local scripts/engine-check.ts <audit id>
import { createClient } from "@supabase/supabase-js";
import { evaluateAndroid } from "../lib/engine/android";

const id = process.argv[2];
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, { auth: { persistSession: false } });
(async () => {
  const { data: a, error } = await db.from("audits").select("scan, api, device, account_id, region, inputs").eq("id", id).single();
  if (error || !a) throw new Error(error?.message ?? "not found");
  const out = evaluateAndroid({
    scan: a.scan, api: a.api, device: a.device, accountId: a.account_id, region: a.region,
    criticalEvents: a.inputs?.criticalEvents, latest: { android: "8.4.1", flutter: "4.2.0" },
  });
  const rows = Object.values(out).sort((x, y) => x.status.localeCompare(y.status));
  for (const r of rows) console.log(r.status.padEnd(6), r.itemId.padEnd(28), r.detected);
})().catch((e) => (console.error(e.message), process.exit(1)));
