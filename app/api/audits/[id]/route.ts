import { z } from "zod";
import { assertAccess, deleteAudit, getAuditFor, setCriticalEvents } from "@/lib/server/audits";
import { auditId, body, handle } from "@/lib/server/http";

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

// Edit the audit's custom events to verify from the report page.
const Patch = z.object({
  criticalEvents: z.array(z.string().trim().min(1).max(120)).max(10),
});

export const PATCH = handle(async (req, ctx: RouteContext<"/api/audits/[id]">, user) => {
  const id = auditId((await ctx.params).id);
  const { criticalEvents } = await body(req, Patch);
  await assertAccess(id, user);
  await setCriticalEvents(id, [...new Set(criticalEvents)]);
  return Response.json({ ok: true });
});
