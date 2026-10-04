import { z } from "zod";
import { assertActionQuota, getAuditFor, recompute, updateAudit } from "@/lib/server/audits";
import { auditId, body, handle, HttpError, zPasscode } from "@/lib/server/http";
import { CtApiError, sendPushToIdentity } from "@/lib/clevertap/client";
import { mask } from "@/lib/clevertap/verify";
import type { ApiFindings, TestPushRecord } from "@/lib/clevertap/types";

// Trigger step of "trigger + confirm": send a real push to one test identity.
// This is an explicit user action — it is never run automatically.
const Send = z.object({
  passcode: zPasscode,
  identity: z.string().trim().min(1).max(200),
  channelId: z.string().trim().max(120).optional(),
  deepLink: z.string().trim().max(500).optional(),
  appState: z.enum(["foreground", "background", "killed"]).optional(),
  // random tag the device runner looks for in the notification shade
  marker: z.string().regex(/^[a-z0-9]{6,12}$/).optional(),
});

export const POST = handle(async (req, ctx: RouteContext<"/api/audits/[id]/test-push">, user) => {
  const id = auditId((await ctx.params).id);
  const input = await body(req, Send);
  const audit = await getAuditFor(id, user);
  if (!audit.accountId || !audit.region) throw new HttpError(400, "Audit has no Account ID / region.");
  await assertActionQuota(user, id, "test-push", 20);

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
  const stateLabel = input.appState ? ` (app ${input.appState})` : "";
  const record: TestPushRecord = {
    identity: mask(input.identity),
    appState: input.appState,
    sentAt,
    channelId: input.channelId,
    deepLink: input.deepLink,
    status: "sent",
  };
  try {
    record.message = await sendPushToIdentity(
      { accountId: audit.accountId, passcode: input.passcode, region: audit.region },
      input.identity,
      {
        title: `CleverTap integration test${stateLabel}`,
        body: `If you can see this, push delivery works ✅${input.marker ? ` [${input.marker}]` : ""}`,
        channelId: input.channelId || undefined,
        deepLink: input.deepLink || undefined,
      },
    );
  } catch (e) {
    record.status = "failed";
    record.message = e instanceof CtApiError ? e.message : String(e);
  }
  api.testPush = record;
  if (input.appState) api.pushTests = { ...api.pushTests, [input.appState]: record };
  await updateAudit(id, { api });
  await recompute(id);
  return Response.json({ testPush: record });
});
