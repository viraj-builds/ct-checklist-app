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
  fileName: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(/\.(apk|aab|apks|xapk)$/i, "Upload an .apk, .aab, .apks or .xapk"),
  fileSize: z.number().int().positive().max(MAX_UPLOAD, "File is larger than 500 MB"),
  withApi: z.boolean().default(true),
  criticalEvents: z.array(z.string().trim().min(1).max(120)).max(10).default([]),
});

// Create an audit. For "upload" audits this also returns a one-time signed
// upload token so the browser sends the file straight to storage (Vercel
// functions cap request bodies at 4.5 MB).
export const POST = handle(async (req, _ctx, user) => {
  const input = await body(req, CreateAudit);
  await assertCreateQuota(user);
  if (input.platform !== "android") throw new HttpError(400, "Only Android audits are available right now.");

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
