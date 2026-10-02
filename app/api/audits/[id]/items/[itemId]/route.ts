import { z } from "zod";
import { setItemStatus } from "@/lib/server/audits";
import { auditId, body, handle, HttpError } from "@/lib/server/http";
import { getItem } from "@/lib/checklist";

// Tick / untick a checklist item. "manual" resets it to the engine's verdict.
const Patch = z.object({
  status: z.enum(["pass", "fail", "manual"]),
  actor: z.string().trim().max(120).optional(),
});

export const PATCH = handle(async (req: Request, ctx: RouteContext<"/api/audits/[id]/items/[itemId]">) => {
  const { id, itemId } = await ctx.params;
  if (!getItem(itemId)) throw new HttpError(404, "Unknown checklist item");
  const { status, actor } = await body(req, Patch);
  await setItemStatus(auditId(id), itemId, status, actor);
  return Response.json({ ok: true });
});
