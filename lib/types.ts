// Core domain types for the CleverTap Integration Audit tool

export type Platform = "android" | "ios" | "web";

export type AuditMode = "api" | "url" | "upload" | "cli" | "full";

// How a checklist item is verified
export type CheckMethod =
  | "auto-static" // detectable from binary / source / live page
  | "auto-api" // verifiable via CleverTap API (read data)
  | "auto-trigger" // API can trigger + confirm via result event
  | "hybrid" // partly auto, partly manual (e.g. deep-link lands on right screen)
  | "manual"; // visual / device-state check only

// Result status for a single checklist item
export type ItemStatus =
  | "pass"
  | "fail"
  | "warn"
  | "manual" // pending human verification
  | "na"; // not applicable to this platform

export type AuditStatus = "draft" | "scanning" | "verifying" | "completed" | "failed";

// Where the binary was analysed: in the user's browser (never uploaded) or on
// the server after an upload.
export type AuditSource = "browser" | "upload" | "url";

// Which engine produced a result.
export type ResultSource = "static" | "api" | "static+api" | "device" | "manual" | "none";

export interface ChecklistItem {
  id: string;
  scope: "app" | "web";
  platforms: Platform[]; // which platforms this item applies to
  tier: 1 | 2 | 3 | 4;
  title: string;
  expected: string;
  method: CheckMethod;
  // Overrides `method` for a specific platform (e.g. splash exclusion is a
  // manifest setting on Android but a manual check on iOS).
  methodByPlatform?: Partial<Record<Platform, CheckMethod>>;
  // "c4s" = from the C4S audit sheet; "sdk" = required by the SDK docs but
  // missing from the sheet.
  origin?: "c4s" | "sdk";
  docUrl?: string;
  faqRef?: number; // index into FAQ list, 1-based
  critical?: boolean;
}

export interface ItemResult {
  itemId: string;
  status: ItemStatus;
  detected?: string; // e.g. "SDK v7.1.2", "identity on 94% of profiles"
  evidence?: string; // human-readable explanation of how it was checked
  remediation?: string; // fix guidance (often from FAQ)
  checkedManually?: boolean; // user ticked a manual item
  details?: string[]; // extra bullet points (call sites, event names, schemes…)
  source?: ResultSource;
}

export interface Audit {
  id: string;
  name: string;
  platform: Platform;
  mode: AuditMode;
  region?: string; // for api mode
  target?: string; // url / filename / account id (masked)
  createdAt: number;
  status: AuditStatus;
  stage?: string;
  error?: string;
  source?: AuditSource;
  accountId?: string;
  fileName?: string;
  fileSize?: number;
  criticalEvents?: string[];
  submittedBy: string;
  results: Record<string, ItemResult>; // itemId -> result
  scan?: import("./analyzer/types").AndroidScanReport;
  api?: import("./clevertap/types").ApiFindings;
  device?: import("./device/types").DeviceFindings;
}

export interface FaqEntry {
  n: number;
  question: string;
  reasons: string[];
  solutions: string[];
  links?: { label: string; url: string }[];
  tags?: string[];
}

export interface StatusMeta {
  label: string;
  color: string; // css var name
  soft: string;
  icon: string;
}
