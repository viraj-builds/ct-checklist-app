import { z } from "zod";
import { assertActionQuota, getAuditFor, recompute, updateAudit } from "@/lib/server/audits";
import { auditId, body, handle, HttpError, zPasscode } from "@/lib/server/http";
import { lookup } from "@/lib/clevertap/web";

// Confirm step: the test user's profile must show Notification Viewed /
// Clicked *for this send*: only events between this push and the next test
// push (of either kind) count, and only for a recent, unconfirmed send — so an
// old test, the other test or a campaign of your own can't confirm it.
// Silence never fails the item.
export const maxDuration = 60;

const Confirm = z.object({
  passcode: zPasscode,
  identity: z.string().trim().min(1).max(200),
  kind: z.enum(["push", "deeplink"]),
});

const SKEW_MS = 5_000; // both timestamps come from servers; allow a little drift
const MAX_AGE_MS = 30 * 60_000;

export const POST = handle(async (req, ctx: RouteContext<"/api/audits/[id]/web-push/confirm">, user) => {
  const id = auditId((await ctx.params).id);
  const { passcode, identity, kind } = await body(req, Confirm);
  const audit = await getAuditFor(id, user);
  const test = audit.api?.web?.tests?.[kind];
  if (!audit.api || !test) throw new HttpError(409, "Send a test web push first.");
  if (test.status === "failed") throw new HttpError(409, "That push wasn't sent — send a new one.");
  // Done — except a link push that was only viewed so far: keep checking for the click.
  if (test.status === "confirmed" && (kind === "push" || test.clicked)) return Response.json({ test, user: { webPushToken: audit.api.web?.user?.webPushToken ?? true } });
  if (Date.now() - test.sentAt > MAX_AGE_MS) throw new HttpError(409, "This test push was sent more than 30 minutes ago — send a new one.");
  if (!audit.accountId || !audit.region) throw new HttpError(400, "Audit has no Account ID / region.");
  await assertActionQuota(user, id, "test-push-confirm", 60);

  const profile = await lookup({ accountId: audit.accountId, passcode, region: audit.region }, identity.includes("@") ? "email" : "identity", identity);
  if (!profile.found) throw new HttpError(404, "No CleverTap profile with that identity.");
  // a later test push (either kind) closes this one's window
  const other = audit.api.web?.tests?.[kind === "push" ? "deeplink" : "push"];
  const until = other && other.sentAt > test.sentAt ? other.sentAt : test.sentAt + MAX_AGE_MS;
  const after = (name: string) => {
    const t = profile.events[name]?.lastSeen ?? 0;
    return t >= test.sentAt - SKEW_MS && t < until;
  };
  const viewed = after("Notification Viewed");
  test.clicked = after("Notification Clicked");
  // Activity only after the *next* test push: CleverTap keeps just the latest time per
  // event, so we can't tell which push it belongs to. Say so instead of guessing.
  const later = (name: string) => (profile.events[name]?.lastSeen ?? 0) >= until;
  if (!viewed && !test.clicked && other && other.sentAt > test.sentAt && (later("Notification Viewed") || later("Notification Clicked"))) {
    const at = new Date(other.sentAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
    throw new HttpError(
      409,
      `Another test push went to this user after this one (${at} UTC), so CleverTap can't tell which one was viewed or clicked. Send this one again and check it before sending the other — or use the Live session, which sees each push separately.`,
    );
  }
  test.status = viewed || test.clicked ? "confirmed" : "not-confirmed";
  if (test.status === "confirmed") test.confirmedAt = Date.now();

  audit.api.web = { ...audit.api.web, user: profile, tests: { ...audit.api.web?.tests, [kind]: test } };
  await updateAudit(id, { api: audit.api });
  await recompute(id);
  return Response.json({ test, user: { webPushToken: profile.webPushToken } });
});
