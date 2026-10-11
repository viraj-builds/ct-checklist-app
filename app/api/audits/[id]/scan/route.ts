import { z } from "zod";
import { getAuditFor, saveScan } from "@/lib/server/audits";
import { auditId, body, handle, HttpError } from "@/lib/server/http";
import type { AndroidScanReport } from "@/lib/analyzer/types";
import type { IosScanReport } from "@/lib/analyzer/ios/types";

// Browser ("private") scan: the APK was analysed on the user's device and only
// this JSON report is sent. Shape-check it before storing.
const usage = z.object({
  found: z.boolean().nullable(),
  layers: z.array(z.string()).max(6),
  evidence: z.array(z.string().max(400)).max(20),
  strings: z.array(z.string().max(200)).max(200),
  confidence: z.enum(["high", "medium", "low"]),
});

const Report = z.looseObject({
  schema: z.literal(1),
  analyzer: z.string().max(60),
  scannedIn: z.literal("browser"),
  file: z.object({
    name: z.string().max(200),
    size: z.number(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    kind: z.enum(["apk", "aab", "apks", "xapk"]),
  }),
  app: z.looseObject({}),
  framework: z.looseObject({ primary: z.string() }),
  obfuscated: z.boolean(),
  clevertap: z.looseObject({ present: z.boolean() }),
  manifest: z.looseObject({
    metaData: z.record(z.string(), z.string().max(2000)),
    permissions: z.array(z.string()).max(500),
    activities: z.array(z.string()).max(500),
  }),
  firebase: z.looseObject({}),
  apis: z.record(z.string(), usage),
  eventNames: z.array(z.string().max(200)).max(200),
  channelIds: z.array(z.string().max(200)).max(50),
  notes: z.array(z.string().max(500)).max(30),
});

// iOS report (IPA / zipped .app scanned in the browser)
const IosReport = z.looseObject({
  schema: z.literal(1),
  platform: z.literal("ios"),
  analyzer: z.string().max(60),
  scannedIn: z.literal("browser"),
  file: z.object({
    name: z.string().max(200),
    size: z.number(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    kind: z.enum(["ipa", "app-zip", "xcarchive"]),
  }),
  app: z.looseObject({ simulatorBuild: z.boolean(), debugBuild: z.boolean() }),
  framework: z.looseObject({ primary: z.string() }),
  clevertap: z.looseObject({ present: z.boolean(), linkage: z.enum(["dynamic", "static", "none"]) }),
  plist: z.looseObject({
    backgroundModes: z.array(z.string().max(100)).max(30),
    urlSchemes: z.array(z.string().max(200)).max(30),
    other: z.record(z.string(), z.string().max(200)),
  }),
  signing: z.looseObject({ associatedDomains: z.array(z.string().max(300)).max(50) }),
  extensions: z.array(z.looseObject({ name: z.string().max(200), kind: z.enum(["service", "content", "other"]) })).max(30),
  firebase: z.looseObject({}),
  apis: z.record(z.string(), usage),
  eventNames: z.array(z.string().max(200)).max(200),
  notes: z.array(z.string().max(500)).max(30),
});

export const POST = handle(async (req, ctx: RouteContext<"/api/audits/[id]/scan">, user) => {
  const id = auditId((await ctx.params).id);
  const audit = await getAuditFor(id, user);
  if (audit.scan || audit.iosScan) throw new HttpError(409, "This audit already has a scan — start a new audit.");
  if (audit.source !== "browser") throw new HttpError(409, "This audit expects an uploaded file.");
  if (audit.platform === "ios") {
    const ios = (await body(req, IosReport, 1024 * 1024)) as unknown as IosScanReport;
    await saveScan(id, ios);
    return Response.json({ ok: true });
  }
  const report = (await body(req, Report, 1024 * 1024)) as unknown as AndroidScanReport;
  await saveScan(id, report);
  return Response.json({ ok: true });
});
