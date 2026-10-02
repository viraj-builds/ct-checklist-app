import "server-only";
import { db, UPLOAD_BUCKET } from "./supabase";
import { getLatestVersions } from "./sdk-versions";
import { evaluateAndroid } from "../engine/android";
import type { AndroidScanReport } from "../analyzer/types";
import type { ApiFindings } from "../clevertap/types";
import type { Audit, AuditSource, AuditStatus, ItemResult, ItemStatus, Platform } from "../types";

// ---------------------------------------------------------------------------
// Audit persistence. Results are always derived by the rule engine from the
// stored scan + API findings; only manual ticks are stored as overrides.
// ---------------------------------------------------------------------------

export const AUDIT_ID = /^aud_[a-f0-9]{32}$/;

export interface AuditInputs {
  criticalEvents?: string[];
  expectApi?: boolean; // the user gave a passcode, so a verify step will follow
}

interface AuditRow {
  id: string;
  name: string;
  platform: Platform;
  mode: string;
  source: AuditSource;
  region: string | null;
  account_id: string | null;
  target: string | null;
  status: AuditStatus;
  stage: string | null;
  error: string | null;
  submitted_by: string | null;
  file_name: string | null;
  file_size: number | null;
  file_sha256: string | null;
  storage_path: string | null;
  inputs: AuditInputs;
  scan: AndroidScanReport | null;
  api: ApiFindings | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  audit_results?: ResultRow[];
}

interface ResultRow {
  audit_id: string;
  item_id: string;
  status: ItemStatus;
  detected: string | null;
  evidence: string | null;
  remediation: string | null;
  details: string[];
  source: string;
  manual_override: boolean;
  updated_by: string | null;
}

const LIST_COLUMNS =
  "id,name,platform,mode,source,region,account_id,target,status,stage,error,submitted_by,file_name,file_size,inputs,created_at,updated_at,completed_at,audit_results(item_id,status)";

function toAudit(row: AuditRow, full: boolean): Audit {
  const results: Record<string, ItemResult> = {};
  for (const r of row.audit_results ?? []) {
    results[r.item_id] = {
      itemId: r.item_id,
      status: r.status,
      detected: r.detected ?? undefined,
      evidence: r.evidence ?? undefined,
      remediation: r.remediation ?? undefined,
      details: r.details?.length ? r.details : undefined,
      source: (r.source as ItemResult["source"]) ?? undefined,
      checkedManually: r.manual_override || undefined,
    };
  }
  return {
    id: row.id,
    name: row.name,
    platform: row.platform,
    mode: (row.mode as Audit["mode"]) ?? "full",
    source: row.source,
    region: row.region ?? undefined,
    accountId: row.account_id ?? undefined,
    target: row.target ?? undefined,
    createdAt: new Date(row.created_at).getTime(),
    status: row.status,
    stage: row.stage ?? undefined,
    error: row.error ?? undefined,
    submittedBy: row.submitted_by ?? "—",
    fileName: row.file_name ?? undefined,
    fileSize: row.file_size ?? undefined,
    criticalEvents: row.inputs?.criticalEvents ?? [],
    results,
    ...(full ? { scan: row.scan ?? undefined, api: row.api ?? undefined } : {}),
  };
}

function fail(e: { message: string } | null, what: string): never {
  throw new Error(`${what}: ${e?.message ?? "unknown error"}`);
}

/* ------------------------------------------------------------------ */

export async function listAudits(limit = 100): Promise<Audit[]> {
  const { data, error } = await db()
    .from("audits")
    .select(LIST_COLUMNS)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) fail(error, "list audits");
  return (data as unknown as AuditRow[]).map((r) => toAudit(r, false));
}

async function getRow(id: string): Promise<AuditRow | null> {
  const { data, error } = await db().from("audits").select("*, audit_results(*)").eq("id", id).maybeSingle();
  if (error) fail(error, "get audit");
  return data as AuditRow | null;
}

export async function getAudit(id: string): Promise<Audit | null> {
  const row = await getRow(id);
  return row ? toAudit(row, true) : null;
}

export async function createAudit(input: {
  name: string;
  platform: Platform;
  source: AuditSource;
  region?: string;
  accountId?: string;
  fileName?: string;
  fileSize?: number;
  submittedBy?: string;
  inputs: AuditInputs;
}): Promise<{ id: string; storagePath?: string }> {
  const { data, error } = await db()
    .from("audits")
    .insert({
      name: input.name,
      platform: input.platform,
      mode: input.inputs.expectApi ? "full" : input.source === "upload" ? "upload" : "cli",
      source: input.source,
      region: input.region ?? null,
      account_id: input.accountId ?? null,
      target: input.fileName ?? null,
      file_name: input.fileName ?? null,
      file_size: input.fileSize ?? null,
      submitted_by: input.submittedBy ?? null,
      status: "draft",
      stage: input.source === "upload" ? "Waiting for upload" : "Waiting for scan",
      inputs: input.inputs,
    })
    .select("id")
    .single();
  if (error) fail(error, "create audit");
  const id = (data as { id: string }).id;
  if (input.source !== "upload") return { id };

  const storagePath = `${id}/${safeName(input.fileName ?? "app.apk")}`;
  await db().from("audits").update({ storage_path: storagePath }).eq("id", id);
  return { id, storagePath };
}

export async function updateAudit(id: string, patch: Partial<Pick<AuditRow, "status" | "stage" | "error" | "scan" | "api" | "file_sha256" | "storage_path" | "completed_at">>) {
  const { error } = await db().from("audits").update(patch).eq("id", id);
  if (error) fail(error, "update audit");
}

export async function deleteAudit(id: string) {
  const row = await getRow(id);
  if (row?.storage_path) await db().storage.from(UPLOAD_BUCKET).remove([row.storage_path]);
  const { error } = await db().from("audits").delete().eq("id", id);
  if (error) fail(error, "delete audit");
}

/** Save a static scan report and re-derive results. */
export async function saveScan(id: string, scan: AndroidScanReport) {
  const row = await getRow(id);
  if (!row) throw new Error("Audit not found");
  const expectApi = !!row.inputs?.expectApi && !row.api;
  await updateAudit(id, {
    scan,
    file_sha256: scan.file.sha256,
    status: expectApi ? "verifying" : "completed",
    stage: expectApi ? "Verifying with the CleverTap API" : null,
    error: null,
    completed_at: expectApi ? null : new Date().toISOString(),
  });
  await recompute(id);
}

export async function saveApi(id: string, api: ApiFindings) {
  await updateAudit(id, {
    api,
    status: "completed",
    stage: null,
    error: api.ok ? null : `CleverTap API: ${api.error}`,
    completed_at: new Date().toISOString(),
  });
  await recompute(id);
}

/** Run the rule engine and upsert results, keeping manual ticks. */
export async function recompute(id: string) {
  const row = await getRow(id);
  if (!row) return;
  if (row.platform !== "android") return; // iOS / Web engines come later

  const latest = await getLatestVersions().catch(() => null);
  const results = evaluateAndroid({
    scan: row.scan,
    api: row.api,
    latest,
    accountId: row.account_id,
    region: row.region,
    criticalEvents: row.inputs?.criticalEvents ?? [],
  });
  const overridden = new Set((row.audit_results ?? []).filter((r) => r.manual_override).map((r) => r.item_id));
  const rows = Object.values(results)
    .filter((r) => !overridden.has(r.itemId))
    .map((r) => ({
      audit_id: id,
      item_id: r.itemId,
      status: r.status,
      detected: r.detected ?? null,
      evidence: r.evidence ?? null,
      remediation: r.remediation ?? null,
      details: r.details ?? [],
      source: r.source ?? "static",
      manual_override: false,
    }));
  if (rows.length) {
    const { error } = await db().from("audit_results").upsert(rows, { onConflict: "audit_id,item_id" });
    if (error) fail(error, "save results");
  }
}

/** A human ticked / unticked an item. "manual" = reset to the engine's verdict. */
export async function setItemStatus(id: string, itemId: string, status: ItemStatus, actor?: string) {
  const row = await getRow(id);
  if (!row) throw new Error("Audit not found");
  const prev = row.audit_results?.find((r) => r.item_id === itemId);

  if (status === "manual") {
    await db().from("audit_results").update({ manual_override: false }).eq("audit_id", id).eq("item_id", itemId);
    await recompute(id);
  } else {
    const { error } = await db()
      .from("audit_results")
      .upsert(
        {
          audit_id: id,
          item_id: itemId,
          status,
          detected: status === "pass" ? "Verified manually" : "Marked as not working",
          evidence: prev?.evidence ?? null,
          remediation: prev?.remediation ?? null,
          details: prev?.details ?? [],
          source: "manual",
          manual_override: true,
          updated_by: actor ?? null,
        },
        { onConflict: "audit_id,item_id" },
      );
    if (error) fail(error, "set item status");
  }
  await db().from("audit_activity").insert({
    audit_id: id,
    actor: actor ?? null,
    action: status === "manual" ? "reset" : "mark",
    item_id: itemId,
    from_status: prev?.status ?? null,
    to_status: status,
  });
}

/* ------------------------------------------------------------------ */

export async function createUploadUrl(path: string) {
  const { data, error } = await db().storage.from(UPLOAD_BUCKET).createSignedUploadUrl(path);
  if (error) fail(error, "create upload url");
  return data as { signedUrl: string; token: string; path: string };
}

export async function downloadUpload(path: string): Promise<Uint8Array> {
  const { data, error } = await db().storage.from(UPLOAD_BUCKET).download(path);
  if (error || !data) fail(error, "download upload");
  return new Uint8Array(await data.arrayBuffer());
}

export async function removeUpload(id: string, path: string) {
  await db().storage.from(UPLOAD_BUCKET).remove([path]);
  await updateAudit(id, { storage_path: null });
}

function safeName(name: string) {
  return name.replace(/[^\w.\-]+/g, "_").slice(-100) || "app.apk";
}
