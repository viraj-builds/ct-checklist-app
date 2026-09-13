// Core domain types for the CleverTap Integration Audit tool (frontend only for now)

export type Platform = "android" | "ios" | "web";

export type AuditMode = "api" | "url" | "upload" | "cli";

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

export type AuditStatus = "queued" | "running" | "completed" | "failed";

export interface ChecklistItem {
  id: string;
  scope: "app" | "web";
  platforms: Platform[]; // which platforms this item applies to
  tier: 1 | 2 | 3 | 4;
  title: string;
  expected: string;
  method: CheckMethod;
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
  submittedBy: string;
  results: Record<string, ItemResult>; // itemId -> result
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
