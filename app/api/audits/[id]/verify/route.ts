import { z } from "zod";
import { getAudit, saveApi, updateAudit } from "@/lib/server/audits";
import { auditId, body, handle, HttpError, zPasscode } from "@/lib/server/http";
import { verifyAppAccount } from "@/lib/clevertap/verify";

// CleverTap API verification. The passcode arrives in this request only, is
// used in memory, and is never stored or logged.
export const maxDuration = 300;

const Verify = z.object({ passcode: zPasscode });

export const POST = handle(async (req: Request, ctx: RouteContext<"/api/audits/[id]/verify">) => {
  const id = auditId((await ctx.params).id);
  const { passcode } = await body(req, Verify);
  const audit = await getAudit(id);
  if (!audit) throw new HttpError(404, "Audit not found");
  if (!audit.accountId || !audit.region) throw new HttpError(400, "Audit has no Account ID / region.");

  await updateAudit(id, { status: "verifying", stage: "Verifying with the CleverTap API" });
  const findings = await verifyAppAccount(
    { accountId: audit.accountId, passcode, region: audit.region },
    {
      platform: "Android",
      customEvents: [...(audit.criticalEvents ?? []), ...(audit.scan?.eventNames ?? [])],
      maxCustomEvents: 10,
    },
  );
  // keep an earlier test-push record across re-verification
  if (audit.api?.testPush) findings.testPush = audit.api.testPush;
  await saveApi(id, findings);
  return Response.json({ ok: findings.ok, error: findings.error, errorKind: findings.errorKind });
});
