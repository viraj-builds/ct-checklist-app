import { z } from "zod";
import { assertActionQuota, getAuditFor, saveApi, updateAudit } from "@/lib/server/audits";
import { auditId, body, handle, HttpError, zPasscode } from "@/lib/server/http";
import { verifyAppAccount } from "@/lib/clevertap/verify";
import { customEventNames } from "@/lib/engine/android";
import { verifyWebAccount } from "@/lib/clevertap/web";
import { webEventNames } from "@/lib/engine/web";

// CleverTap API verification. The passcode arrives in this request only, is
// used in memory, and is never stored or logged.
export const maxDuration = 300;

// identity: website audits only — the test user to look up (from the crawl / login)
const Verify = z.object({ passcode: zPasscode, identity: z.string().trim().min(1).max(200).optional() });

export const POST = handle(async (req, ctx: RouteContext<"/api/audits/[id]/verify">, user) => {
  const id = auditId((await ctx.params).id);
  const { passcode, identity } = await body(req, Verify);
  const audit = await getAuditFor(id, user);
  if (!audit.accountId || !audit.region) throw new HttpError(400, "Audit has no Account ID / region.");
  await assertActionQuota(user, id, "verify", 15);

  await updateAudit(id, { status: "verifying", stage: "Verifying with the CleverTap API" });
  if (audit.platform === "web") {
    const web = await verifyWebAccount(
      { accountId: audit.accountId, passcode, region: audit.region },
      {
        ctId: audit.webScan?.ctId,
        identity,
        customEvents: [...(audit.criticalEvents ?? []), ...webEventNames(audit.webScan)],
        maxCustomEvents: 10,
        // a brand-new visitor takes a few seconds to show up — wait on the first check only
        waitForVisitorMs: audit.api?.web?.visitor?.found ? 0 : 40_000,
      },
      audit.api?.web,
    );
    if (!identity && audit.api?.web?.user && web.web) web.web.user = audit.api.web.user;
    await saveApi(id, web);
    return Response.json({ ok: web.ok, error: web.error, errorKind: web.errorKind });
  }
  const findings = await verifyAppAccount(
    { accountId: audit.accountId, passcode, region: audit.region },
    {
      platform: audit.platform === "ios" ? "iOS" : "Android",
      customEvents: [
        ...(audit.criticalEvents ?? []),
        ...(audit.scan?.eventNames ?? []),
        ...(audit.iosScan?.eventNames ?? []),
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
