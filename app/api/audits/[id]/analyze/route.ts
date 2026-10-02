import { analyzeAndroid } from "@/lib/analyzer/android";
import { db } from "@/lib/server/supabase";
import { downloadUpload, removeUpload, saveScan, updateAudit } from "@/lib/server/audits";
import { auditId, handle, HttpError } from "@/lib/server/http";

// Server scan: the browser has uploaded the binary to private storage; analyse
// it here and delete it straight afterwards.
export const maxDuration = 300;

export const POST = handle(async (_req: Request, ctx: RouteContext<"/api/audits/[id]/analyze">) => {
  const id = auditId((await ctx.params).id);
  const { data: row } = await db()
    .from("audits")
    .select("source,storage_path,file_name,status")
    .eq("id", id)
    .maybeSingle();
  if (!row) throw new HttpError(404, "Audit not found");
  if (row.source !== "upload" || !row.storage_path) throw new HttpError(409, "No uploaded file for this audit.");
  if (row.status === "scanning") throw new HttpError(409, "Analysis already running.");

  await updateAudit(id, { status: "scanning", stage: "Unpacking & scanning the binary", error: null });
  try {
    const bytes = await downloadUpload(row.storage_path);
    const report = await analyzeAndroid(bytes, row.file_name ?? "app.apk", "server");
    await saveScan(id, report);
    return Response.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await updateAudit(id, { status: "failed", stage: null, error: `Couldn't analyse the file: ${msg}` });
    throw new HttpError(422, `Couldn't analyse the file: ${msg}`);
  } finally {
    await removeUpload(id, row.storage_path).catch(() => {});
  }
});
