import { z } from "zod";
import { assertActionQuota, getAuditFor, recompute, updateAudit } from "@/lib/server/audits";
import { auditId, body, handle, HttpError, zPasscode } from "@/lib/server/http";
import { checkTestUser } from "@/lib/clevertap/verify";
import type { ApiFindings } from "@/lib/clevertap/types";

// Live session without a cable: look up the test user's profile — is the
// device registered, on which app version, with a push token, launched when?
const Check = z.object({ passcode: zPasscode, identity: z.string().trim().min(1).max(200) });

export const POST = handle(async (req, ctx: RouteContext<"/api/audits/[id]/test-user">, user) => {
  const id = auditId((await ctx.params).id);
  const { passcode, identity } = await body(req, Check);
  const audit = await getAuditFor(id, user);
  if (!audit.accountId || !audit.region) throw new HttpError(400, "Audit has no Account ID / region.");
  await assertActionQuota(user, id, "test-user", 60);

  const testUser = await checkTestUser({ accountId: audit.accountId, passcode, region: audit.region }, identity, "Android");
  const api: ApiFindings = audit.api ?? {
    ok: false,
    error: "Not verified yet",
    region: audit.region,
    checkedAt: Date.now(),
    durationMs: 0,
    events: {},
    customEvents: [],
  };
  api.testUser = testUser;
  await updateAudit(id, { api });
  await recompute(id);
  return Response.json({ testUser });
});
