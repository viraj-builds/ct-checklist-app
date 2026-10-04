import { z } from "zod";
import { assertActionQuota, getAuditFor, recompute, updateAudit } from "@/lib/server/audits";
import { auditId, body, handle, HttpError, zPasscode } from "@/lib/server/http";
import { getProfile } from "@/lib/clevertap/client";

// Confirm step: read the test user's profile and check that "Notification
// Viewed" was last seen after we sent the push (epoch timestamps — no timezone
// guessing). Silence never fails the item: it could be "not delivered" or
// "impressions not tracked", so it stays a manual check.
export const maxDuration = 60;

const Confirm = z.object({
  passcode: zPasscode,
  identity: z.string().trim().min(1).max(200),
  appState: z.enum(["foreground", "background", "killed"]).optional(),
});

const SKEW_MS = 60_000; // tolerate small clock differences

export const POST = handle(async (req, ctx: RouteContext<"/api/audits/[id]/test-push/confirm">, user) => {
  const id = auditId((await ctx.params).id);
  const { passcode, identity, appState } = await body(req, Confirm);
  const audit = await getAuditFor(id, user);
  const push = appState ? audit.api?.pushTests?.[appState] : audit.api?.testPush;
  if (!audit.api || !push) throw new HttpError(409, "Send a test push first.");
  if (!audit.accountId || !audit.region) throw new HttpError(400, "Audit has no Account ID / region.");
  await assertActionQuota(user, id, "test-push-confirm", 60);

  const profile = await getProfile({ accountId: audit.accountId, passcode, region: audit.region }, identity);
  if (!profile) throw new HttpError(404, "No CleverTap profile with that identity.");
  const after = (name: string) => {
    const last = profile.events?.[name]?.last_seen;
    return !!last && last * 1000 >= push.sentAt - SKEW_MS;
  };
  const viewed = after("Notification Viewed");
  push.clicked = after("Notification Clicked");
  push.status = viewed || push.clicked ? "confirmed" : "not-confirmed";
  if (push.status === "confirmed") push.confirmedAt = Date.now();

  if (appState) audit.api.pushTests = { ...audit.api.pushTests, [appState]: push };
  if (audit.api.testPush?.sentAt === push.sentAt) audit.api.testPush = push;
  await updateAudit(id, { api: audit.api });
  await recompute(id);
  return Response.json({ testPush: push });
});
