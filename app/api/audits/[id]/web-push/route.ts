import { z } from "zod";
import { assertActionQuota, getAuditFor, recompute, updateAudit } from "@/lib/server/audits";
import { auditId, body, handle, HttpError, zPasscode } from "@/lib/server/http";
import { CtApiError, sendWebPush } from "@/lib/clevertap/client";
import { mask } from "@/lib/clevertap/verify";
import type { ApiFindings, TestPushRecord } from "@/lib/clevertap/types";

// Trigger step of "trigger + confirm" for websites: send one web push to the
// test user (optionally with a link). An explicit user action — never automatic.
const Send = z.object({
  passcode: zPasscode,
  identity: z.string().trim().min(1).max(200),
  deepLink: z.string().trim().max(500).optional(),
});

export const POST = handle(async (req, ctx: RouteContext<"/api/audits/[id]/web-push">, user) => {
  const id = auditId((await ctx.params).id);
  const input = await body(req, Send);
  const audit = await getAuditFor(id, user);
  if (audit.platform !== "web") throw new HttpError(400, "This audit isn't a website audit.");
  if (!audit.accountId || !audit.region) throw new HttpError(400, "Audit has no Account ID / region.");
  if (input.deepLink && !/^https:\/\//i.test(input.deepLink)) throw new HttpError(400, "The link must start with https://");
  await assertActionQuota(user, id, "test-push", 20);

  const kind = input.deepLink ? "deeplink" : "push";
  const record: TestPushRecord = { identity: mask(input.identity), sentAt: Date.now(), deepLink: input.deepLink || undefined, status: "sent" };
  try {
    record.message = await sendWebPush({ accountId: audit.accountId, passcode: input.passcode, region: audit.region }, { identity: input.identity }, {
      title: input.deepLink ? "CleverTap integration test — tap me" : "CleverTap integration test",
      body: input.deepLink ? `Clicking this should open ${input.deepLink}` : "If you can see this, web push works ✅",
      deepLink: input.deepLink || undefined,
    });
  } catch (e) {
    record.status = "failed";
    record.message = e instanceof CtApiError ? e.message : String(e);
  }
  const api: ApiFindings = audit.api ?? { ok: false, error: "Not verified yet", region: audit.region, checkedAt: Date.now(), durationMs: 0, events: {}, customEvents: [] };
  api.web = { ...api.web, tests: { ...api.web?.tests, [kind]: record } };
  try {
    await updateAudit(id, { api });
    await recompute(id);
  } catch (e) {
    console.error(`web-push ${id}: saving the record failed`, e);
  }
  return Response.json({ test: record, kind });
});
