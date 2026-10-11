import { z } from "zod";
import { assertActionQuota, getAuditFor, recompute, updateAudit } from "@/lib/server/audits";
import { auditId, body, handle, HttpError, zPasscode } from "@/lib/server/http";
import { lookup } from "@/lib/clevertap/web";

// Confirm step: the test user's profile must show Notification Viewed /
// Clicked after the web push was sent. Silence never fails the item.
export const maxDuration = 60;

const Confirm = z.object({
  passcode: zPasscode,
  identity: z.string().trim().min(1).max(200),
  kind: z.enum(["push", "deeplink"]),
});

const SKEW_MS = 60_000;

export const POST = handle(async (req, ctx: RouteContext<"/api/audits/[id]/web-push/confirm">, user) => {
  const id = auditId((await ctx.params).id);
  const { passcode, identity, kind } = await body(req, Confirm);
  const audit = await getAuditFor(id, user);
  const test = audit.api?.web?.tests?.[kind];
  if (!audit.api || !test) throw new HttpError(409, "Send a test web push first.");
  if (!audit.accountId || !audit.region) throw new HttpError(400, "Audit has no Account ID / region.");
  await assertActionQuota(user, id, "test-push-confirm", 60);

  const profile = await lookup({ accountId: audit.accountId, passcode, region: audit.region }, identity.includes("@") ? "email" : "identity", identity);
  if (!profile.found) throw new HttpError(404, "No CleverTap profile with that identity.");
  const after = (name: string) => (profile.events[name]?.lastSeen ?? 0) >= test.sentAt - SKEW_MS;
  const viewed = after("Notification Viewed");
  test.clicked = after("Notification Clicked");
  test.status = viewed || test.clicked ? "confirmed" : "not-confirmed";
  if (test.status === "confirmed") test.confirmedAt = Date.now();

  audit.api.web = { ...audit.api.web, user: profile, tests: { ...audit.api.web?.tests, [kind]: test } };
  await updateAudit(id, { api: audit.api });
  await recompute(id);
  return Response.json({ test, user: { webPushToken: profile.webPushToken } });
});
