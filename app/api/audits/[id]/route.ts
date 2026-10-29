import { z } from "zod";
import { assertAccess, deleteAudit, getAuditFor, setAccountId, setConsent, setCriticalEvents } from "@/lib/server/audits";
import { auditId, body, handle, zAccountId } from "@/lib/server/http";

export const GET = handle(async (_req, ctx: RouteContext<"/api/audits/[id]">, user) => {
  const audit = await getAuditFor(auditId((await ctx.params).id), user);
  return Response.json({ audit });
});

export const DELETE = handle(async (_req, ctx: RouteContext<"/api/audits/[id]">, user) => {
  const id = auditId((await ctx.params).id);
  await assertAccess(id, user);
  await deleteAudit(id);
  return new Response(null, { status: 204 });
});

// Edit the audit's custom events to verify, or accept the data & privacy notice
// (audits created before it existed), from the report page.
const Patch = z.object({
  criticalEvents: z.array(z.string().trim().min(1).max(120)).max(10).optional(),
  accountId: zAccountId.optional(), // switch to the project the app / site really sends to
  consent: z
    .object({ version: z.number().int().min(1), dataCapture: z.literal(true), screenshots: z.boolean().default(false) })
    .optional(),
});

export const PATCH = handle(async (req, ctx: RouteContext<"/api/audits/[id]">, user) => {
  const id = auditId((await ctx.params).id);
  const { criticalEvents, consent, accountId } = await body(req, Patch);
  await assertAccess(id, user);
  if (consent) await setConsent(id, { ...consent, dataCapture: true, at: Date.now(), by: user.email });
  if (criticalEvents) await setCriticalEvents(id, [...new Set(criticalEvents)]);
  if (accountId) await setAccountId(id, accountId);
  return Response.json({ ok: true });
});
