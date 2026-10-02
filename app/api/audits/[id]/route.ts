import { deleteAudit, getAudit } from "@/lib/server/audits";
import { auditId, handle, HttpError } from "@/lib/server/http";

export const GET = handle(async (_req: Request, ctx: RouteContext<"/api/audits/[id]">) => {
  const id = auditId((await ctx.params).id);
  const audit = await getAudit(id);
  if (!audit) throw new HttpError(404, "Audit not found");
  return Response.json({ audit });
});

export const DELETE = handle(async (_req: Request, ctx: RouteContext<"/api/audits/[id]">) => {
  await deleteAudit(auditId((await ctx.params).id));
  return new Response(null, { status: 204 });
});
