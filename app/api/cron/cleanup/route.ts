import { timingSafeEqual } from "node:crypto";
import { db, UPLOAD_BUCKET } from "@/lib/server/supabase";

// Safety net for the "upload" mode: uploads are deleted right after analysis,
// but if a scan never ran (tab closed mid-upload) the file is removed here.
// Scheduled in vercel.json; Vercel sends `Authorization: Bearer $CRON_SECRET`.
export const maxDuration = 60;

const MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  const given = Buffer.from(req.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  if (!secret || given.length !== expected.length || !timingSafeEqual(given, expected))
    return Response.json({ error: "Unauthorized" }, { status: 401 });

  const cutoff = new Date(Date.now() - MAX_AGE_MS).toISOString();
  const { data, error } = await db()
    .from("audits")
    .select("id,storage_path")
    .not("storage_path", "is", null)
    .lt("created_at", cutoff)
    .limit(500);
  if (error) return Response.json({ error: error.message }, { status: 500 });

  const paths = (data ?? []).map((r) => r.storage_path as string);
  if (paths.length) {
    await db().storage.from(UPLOAD_BUCKET).remove(paths);
    await db()
      .from("audits")
      .update({ storage_path: null })
      .in("id", (data ?? []).map((r) => r.id));
  }
  // Drafts that never got a scan are noise.
  await db().from("audits").delete().eq("status", "draft").lt("created_at", cutoff);
  return Response.json({ removedFiles: paths.length });
}
