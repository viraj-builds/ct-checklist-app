import { z } from "zod";
import { assertCreateQuota, createAudit, createUploadUrl, listAudits } from "@/lib/server/audits";
import { body, handle, HttpError, zAccountId, zRegion } from "@/lib/server/http";

export const GET = handle(async (_req, _ctx, user) => {
  return Response.json({ audits: await listAudits(user) });
});

const MAX_UPLOAD = 500 * 1024 * 1024;

const CreateAudit = z.object({
  name: z.string().trim().min(1).max(120),
  platform: z.enum(["android", "ios", "web"]),
  source: z.enum(["browser", "upload"]),
  region: zRegion,
  accountId: zAccountId,
  fileName: z.string().trim().min(1).max(200),
  fileSize: z.number().int().positive().max(MAX_UPLOAD, "File is larger than 500 MB"),
  withApi: z.boolean().default(true),
  criticalEvents: z.array(z.string().trim().min(1).max(120)).max(10).default([]),
}).superRefine((v, ctx) => {
  const ok = v.platform === "ios" ? /\.(ipa|zip)$/i.test(v.fileName) : /\.(apk|aab|apks|xapk)$/i.test(v.fileName);
  if (!ok)
    ctx.addIssue({
      code: "custom",
      path: ["fileName"],
      message: v.platform === "ios" ? "Upload an .ipa, or a zipped .app / .xcarchive" : "Upload an .apk, .aab, .apks or .xapk",
    });
});

// Create an audit. For "upload" audits this also returns a one-time signed
// upload token so the browser sends the file straight to storage (Vercel
// functions cap request bodies at 4.5 MB).
export const POST = handle(async (req, _ctx, user) => {
  const input = await body(req, CreateAudit);
  await assertCreateQuota(user);
  if (input.platform === "web") throw new HttpError(400, "Website audits aren't available yet.");
  if (input.platform === "ios" && input.source !== "browser") throw new HttpError(400, "iOS builds are scanned in your browser.");

  const { id, storagePath } = await createAudit({
    name: input.name,
    platform: input.platform,
    source: input.source,
    region: input.region,
    accountId: input.accountId,
    fileName: input.fileName,
    fileSize: input.fileSize,
    owner: user,
    inputs: { criticalEvents: input.criticalEvents, expectApi: input.withApi },
  });
  const upload = storagePath ? await createUploadUrl(storagePath) : undefined;
  return Response.json({ id, upload: upload && { path: upload.path, url: upload.signedUrl } }, { status: 201 });
});
