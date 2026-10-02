import { z } from "zod";
import { getAudit, recompute, updateAudit } from "@/lib/server/audits";
import { auditId, body, handle, HttpError, zPasscode } from "@/lib/server/http";
import { CtApiError, sendPushToIdentity } from "@/lib/clevertap/client";
import { mask } from "@/lib/clevertap/verify";
import type { ApiFindings } from "@/lib/clevertap/types";

// Trigger step of "trigger + confirm": send a real push to one test identity.
// This is an explicit user action — it is never run automatically.
const Send = z.object({
  passcode: zPasscode,
  identity: z.string().trim().min(1).max(200),
  channelId: z.string().trim().max(120).optional(),
  deepLink: z.string().trim().max(500).optional(),
});

export const POST = handle(async (req: Request, ctx: RouteContext<"/api/audits/[id]/test-push">) => {
  const id = auditId((await ctx.params).id);
  const input = await body(req, Send);
  const audit = await getAudit(id);
  if (!audit) throw new HttpError(404, "Audit not found");
  if (!audit.accountId || !audit.region) throw new HttpError(400, "Audit has no Account ID / region.");

  const api: ApiFindings = audit.api ?? {
    ok: false,
    error: "Not verified yet",
    region: audit.region,
    checkedAt: Date.now(),
    durationMs: 0,
    events: {},
    customEvents: [],
  };
  const sentAt = Date.now();
  try {
    const message = await sendPushToIdentity(
      { accountId: audit.accountId, passcode: input.passcode, region: audit.region },
      input.identity,
      {
        title: "CleverTap integration test",
        body: "If you can see this, push delivery works ✅",
        channelId: input.channelId || undefined,
        deepLink: input.deepLink || undefined,
      },
    );
    api.testPush = { identity: mask(input.identity), sentAt, channelId: input.channelId, deepLink: input.deepLink, status: "sent", message };
  } catch (e) {
    const msg = e instanceof CtApiError ? e.message : String(e);
    api.testPush = { identity: mask(input.identity), sentAt, channelId: input.channelId, status: "failed", message: msg };
  }
  await updateAudit(id, { api });
  await recompute(id);
  return Response.json({ testPush: api.testPush });
});
