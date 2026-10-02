import { z } from "zod";
import { getAudit, recompute, updateAudit } from "@/lib/server/audits";
import { auditId, body, handle, HttpError, zPasscode } from "@/lib/server/http";
import { sampleEvents } from "@/lib/clevertap/client";

// Confirm step: look for a Notification Viewed (and Clicked) event from the
// test identity since the push was sent. Silence never fails the item — it
// stays a manual check (it could be "not delivered" or "impressions off").
export const maxDuration = 120;

const Confirm = z.object({ passcode: zPasscode, identity: z.string().trim().min(1).max(200) });

export const POST = handle(async (req: Request, ctx: RouteContext<"/api/audits/[id]/test-push/confirm">) => {
  const id = auditId((await ctx.params).id);
  const { passcode, identity } = await body(req, Confirm);
  const audit = await getAudit(id);
  const push = audit?.api?.testPush;
  if (!audit || !audit.api || !push) throw new HttpError(409, "Send a test push first.");
  if (!audit.accountId || !audit.region) throw new HttpError(400, "Audit has no Account ID / region.");

  const creds = { accountId: audit.accountId, passcode, region: audit.region };
  // Event timestamps are in the account's timezone (unknown here), so allow a
  // window of ±14h around the send time.
  const since = toTs(push.sentAt - 14 * 3600_000);
  const mine = (name: string) =>
    sampleEvents(creds, name, 1, 500).then((recs) =>
      recs.some((r) => String(r.profile?.identity ?? "") === identity && (r.ts ?? 0) >= since),
    );
  const viewed = await mine("Notification Viewed");
  const clicked = await mine("Notification Clicked").catch(() => false);

  push.status = viewed ? "confirmed" : "not-confirmed";
  push.clicked = clicked;
  if (viewed) push.confirmedAt = Date.now();
  await updateAudit(id, { api: audit.api });
  await recompute(id);
  return Response.json({ testPush: push });
});

function toTs(ms: number): number {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return Number(`${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`);
}
