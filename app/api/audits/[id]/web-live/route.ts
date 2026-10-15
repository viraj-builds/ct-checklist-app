import { z } from "zod";
import { assertConsent, getAuditFor, recompute, updateAudit } from "@/lib/server/audits";
import { auditId, body, handle, HttpError } from "@/lib/server/http";
import type { WebLiveFindings } from "@/lib/web/types";

// Live website session (the user's own Chrome, through public/ct-web-bridge.mjs):
// the report page builds the findings in the browser — identities already
// masked — and saves them here so the rule engine can use them.
const prop = z.looseObject({ type: z.string().max(20), example: z.string().max(200).optional(), issue: z.string().max(100).optional() });
const pushTest = z.looseObject({
  sentAt: z.number(),
  deepLink: z.string().max(500).optional(),
  receivedAt: z.number().optional(),
  viewedAt: z.number().optional(),
  shownAt: z.number().optional(),
  clickedAt: z.number().optional(),
  landedUrl: z.string().max(2000).optional(),
});
const Live = z.looseObject({
  schema: z.literal(1),
  device: z.enum(["desktop", "android"]),
  url: z.string().max(2000),
  startedAt: z.number(),
  updatedAt: z.number(),
  sdk: z.looseObject({ present: z.boolean(), debugLogs: z.boolean() }),
  network: z.looseObject({ requests: z.number(), accepted: z.number(), webPushConfigured: z.boolean() }),
  utm: z.looseObject({ tested: z.boolean(), sent: z.boolean() }),
  login: z.looseObject({ seen: z.boolean() }),
  profiles: z
    .array(
      z.looseObject({
        via: z.enum(["onUserLogin", "profile", "unknown"]),
        phase: z.enum(["anonymous", "login", "revisit", "browse"]),
        hasIdentity: z.boolean(),
        hasEmail: z.boolean(),
        // must already be masked by the page
        phone: z.string().max(40).regex(/•/, "phone must be masked").optional(),
        keys: z.array(z.string().max(120)).max(60),
        props: z.record(z.string().max(120), prop),
        issues: z.array(z.string().max(200)).max(60),
      }),
    )
    .max(20),
  events: z.array(z.looseObject({ name: z.string().max(200), count: z.number(), props: z.record(z.string().max(120), prop), issues: z.array(z.string().max(200)).max(60) })).max(40),
  calls: z.array(z.looseObject({ api: z.string().max(20), phase: z.string().max(20), at: z.number() })).max(200),
  pages: z.array(z.string().max(300)).max(30),
  push: z.looseObject({ subscribed: z.boolean(), tests: z.looseObject({ push: pushTest.optional(), deeplink: pushTest.optional() }) }),
});

export const POST = handle(async (req, ctx: RouteContext<"/api/audits/[id]/web-live">, user) => {
  const id = auditId((await ctx.params).id);
  const live = (await body(req, Live, 512 * 1024)) as unknown as WebLiveFindings;
  const audit = await getAuditFor(id, user);
  await assertConsent(id);
  if (audit.platform !== "web") throw new HttpError(400, "This audit isn't a website audit.");
  await updateAudit(id, { device: live });
  await recompute(id);
  return Response.json({ ok: true });
});
