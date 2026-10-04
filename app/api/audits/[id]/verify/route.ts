import { z } from "zod";
import { assertActionQuota, getAuditFor, saveApi, updateAudit } from "@/lib/server/audits";
import { auditId, body, handle, HttpError, zPasscode } from "@/lib/server/http";
import { verifyAppAccount } from "@/lib/clevertap/verify";
import { customEventNames } from "@/lib/engine/android";

// CleverTap API verification. The passcode arrives in this request only, is
// used in memory, and is never stored or logged.
export const maxDuration = 300;

const Verify = z.object({ passcode: zPasscode });

export const POST = handle(async (req, ctx: RouteContext<"/api/audits/[id]/verify">, user) => {
  const id = auditId((await ctx.params).id);
  const { passcode } = await body(req, Verify);
  const audit = await getAuditFor(id, user);
  if (!audit.accountId || !audit.region) throw new HttpError(400, "Audit has no Account ID / region.");
  await assertActionQuota(user, id, "verify", 15);

  await updateAudit(id, { status: "verifying", stage: "Verifying with the CleverTap API" });
  const findings = await verifyAppAccount(
    { accountId: audit.accountId, passcode, region: audit.region },
    {
      platform: "Android",
      customEvents: [
        ...(audit.criticalEvents ?? []),
        ...(audit.scan?.eventNames ?? []),
        ...customEventNames(audit.api?.testUser),
      ],
      maxCustomEvents: 10,
    },
  );
  // keep an earlier test-push record across re-verification
  if (audit.api?.testPush) findings.testPush = audit.api.testPush;
  if (audit.api?.pushTests) findings.pushTests = audit.api.pushTests;
  if (audit.api?.testUser) findings.testUser = audit.api.testUser;
  await saveApi(id, findings);
  return Response.json({ ok: findings.ok, error: findings.error, errorKind: findings.errorKind });
});
