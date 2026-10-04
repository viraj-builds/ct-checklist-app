import { z } from "zod";
import { assertAccess, setItemStatus } from "@/lib/server/audits";
import { auditId, body, handle, HttpError } from "@/lib/server/http";
import { getItem } from "@/lib/checklist";

// Tick / untick a checklist item. "manual" resets it to the engine's verdict.
const Patch = z.object({
  status: z.enum(["pass", "fail", "manual"]),
});

export const PATCH = handle(async (req, ctx: RouteContext<"/api/audits/[id]/items/[itemId]">, user) => {
  const { id, itemId } = await ctx.params;
  if (!getItem(itemId)) throw new HttpError(404, "Unknown checklist item");
  const { status } = await body(req, Patch);
  await assertAccess(auditId(id), user);
  await setItemStatus(id, itemId, status, user.email);
  return Response.json({ ok: true });
});
