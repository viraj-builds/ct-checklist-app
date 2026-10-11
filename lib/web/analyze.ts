// Shared by the server crawler and the live Chrome session (runs in the
// browser): how a CleverTap profile / event payload is judged. No Node APIs.
import type { ValueType, WebProfilePush, WebProp } from "./types";

export const NULLISH = new Set(["null", "undefined", "nil", "none", "nan", ""]);
export const DATE_STRING = /^(\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?|\d{1,2}[/-]\d{1,2}[/-]\d{2,4})$/;
export const NUMERIC_KEY = /amount|price|qty|quantity|total|revenue|value|count|discount|cost|rating/i;
export const PII_KEY = /identity|email|phone|mobile|name|address|dob|birth|password|token/i;
export const E164 = /^\+[1-9]\d{7,14}$/;
export const SYSTEM_EVENT = /^(wzrk_|Notification (Viewed|Clicked|Sent|Delivered)|App Launched|UTM Visited|Stayed|Channel Unsubscribed|Push Impressions)/;
export const CT_HOST = /(^|\.)(clevertap-prod\.com|wzrkt\.com)$/i;

export type Phase = WebProfilePush["phase"];

export function mask(s: string) {
  if (s.length <= 5) return "•••";
  return s.slice(0, 3) + "•".repeat(Math.max(3, s.length - 5)) + s.slice(-2);
}

export function analyzeProps(obj: Record<string, unknown>): { props: Record<string, WebProp>; issues: string[] } {
  const props: Record<string, WebProp> = {};
  const issues: string[] = [];
  for (const [k, v] of Object.entries(obj).slice(0, 60)) {
    const type = valueType(v);
    const p: WebProp = { type };
    if (type === "nullish") p.issue = 'empty / "null" value';
    else if (typeof v === "string") {
      const t = v.trim();
      if (NUMERIC_KEY.test(k) && /^-?\d+(\.\d+)?$/.test(t)) p.issue = "number sent as text";
      else if (DATE_STRING.test(t)) p.issue = "date sent as text";
    }
    if (p.issue) issues.push(`${k}: ${p.issue}`);
    if (v !== undefined && v !== null && type !== "object") {
      const s = Array.isArray(v) ? v.join(",") : String(v);
      p.example = PII_KEY.test(k) ? mask(s) : s.length > 40 ? s.slice(0, 37) + "…" : s;
      if (type === "nullish") p.example = JSON.stringify(v);
    }
    props[k] = p;
  }
  return { props, issues };
}

export function valueType(v: unknown): ValueType {
  if (v === null || v === undefined) return "nullish";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return "number";
  if (typeof v === "boolean") return "boolean";
  if (typeof v === "object") return "object";
  const s = String(v).trim();
  if (NULLISH.has(s.toLowerCase())) return "nullish";
  if (/^\$D_-?\d+$/.test(s)) return "date";
  return "string";
}

/** A profile push (onUserLogin / profile.push / network payload) → what the report stores. */
export function profilePush(via: WebProfilePush["via"], phase: Phase, site: Record<string, unknown>): WebProfilePush {
  const { props, issues } = analyzeProps(site);
  const phoneRaw = str(site.Phone ?? site.phone);
  return {
    via,
    phase,
    hasIdentity: !!str(site.Identity),
    hasEmail: !!str(site.Email),
    phone: phoneRaw ? mask(phoneRaw) : undefined,
    phoneValid: phoneRaw ? E164.test(phoneRaw) : undefined,
    keys: Object.keys(site).slice(0, 40),
    props,
    issues,
  };
}

/** onUserLogin / profile.push take {Site: {...}}; accept the bare object too. */
export function siteOf(arg: unknown): Record<string, unknown> | undefined {
  if (!arg || typeof arg !== "object") return undefined;
  const a = arg as Record<string, unknown>;
  const site = a.Site ?? a.site;
  return site && typeof site === "object" ? (site as Record<string, unknown>) : a;
}

export function str(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v).trim();
  return NULLISH.has(s.toLowerCase()) ? "" : s;
}

export function pathOf(url: string) {
  try {
    const u = new URL(url);
    return u.pathname + (u.search && !/utm_/.test(u.search) ? u.search.slice(0, 60) : "");
  } catch {
    return "";
  }
}
