import type { Audit, AuditMode, ItemResult, ItemStatus, Platform } from "./types";
import { itemsForPlatform, getItem } from "./checklist";
import { getFaq } from "./faq";

// Deterministic PRNG so a given audit id always yields the same mock results.
function hashSeed(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function mulberry32(a: number) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DETECTED: Record<string, Partial<Record<ItemStatus, string>>> = {
  "app-t1-sdk-version": {
    pass: "SDK v7.1.2 (latest)",
    warn: "SDK v6.2.1 (2 majors behind)",
    fail: "CleverTap SDK not detected",
  },
  "app-t1-installed": {
    pass: "12,480 events in last 7 days",
    fail: "0 App Installed events",
  },
  "app-t1-launched": {
    pass: "48,930 events in last 7 days",
    warn: "Low volume — 42 events",
  },
  "app-t1-identity": {
    pass: "Identity present on 94% of profiles",
    warn: "Identity on 61% of profiles",
    fail: "No identity found on profiles",
  },
  "app-t1-custom-events": {
    pass: "18 distinct custom events",
    warn: "Only 2 custom events found",
  },
  "app-t3-impressions": {
    pass: "Notification Viewed: 3,204",
    fail: "0 impressions — system event off",
  },
  "web-t1-sdk-head": {
    pass: "clevertap.js found in <head>",
    fail: "CleverTap script not found on page",
  },
  "web-t3-web-push": {
    pass: "Service worker + token generated",
    fail: "clevertap_sw.js missing (404)",
  },
};

function detectedFor(id: string, status: ItemStatus): string | undefined {
  const map = DETECTED[id];
  if (map && map[status]) return map[status];
  const defaults: Partial<Record<ItemStatus, string>> = {
    pass: "Verified",
    warn: "Partially verified",
    fail: "Not detected",
    manual: "Awaiting device/visual check",
    na: "Not applicable",
  };
  return defaults[status];
}

function evidenceFor(method: string, status: ItemStatus): string {
  if (status === "manual")
    return "No account signal exists for this — confirm on a device, then tick.";
  switch (method) {
    case "auto-static":
      return status === "pass"
        ? "Found in the scanned manifest/source."
        : "Not found during static scan.";
    case "auto-api":
      return status === "pass"
        ? "Confirmed via CleverTap API (sampled profiles/events)."
        : status === "warn"
          ? "Present but below the confidence threshold — review."
          : "API returned no matching data.";
    case "auto-trigger":
      return status === "pass"
        ? "Triggered a test and the result event was confirmed."
        : "Triggered a test but no confirmation event returned — investigate.";
    case "hybrid":
      return status === "pass"
        ? "Auto-checks passed; confirm the UI outcome on a device."
        : "Auto-portion flagged an issue — verify manually.";
    default:
      return "";
  }
}

// Build a full result set for an audit
export function generateResults(
  id: string,
  platform: Platform,
  mode: AuditMode,
): Record<string, ItemResult> {
  const rng = mulberry32(hashSeed(id + platform + mode));
  const results: Record<string, ItemResult> = {};
  const items = itemsForPlatform(platform);

  for (const item of items) {
    let status: ItemStatus;
    if (item.method === "manual") {
      status = "manual";
    } else if (item.method === "hybrid") {
      // hybrid: auto part resolves, but stays pending manual confirmation sometimes
      const r = rng();
      status = r < 0.55 ? "pass" : r < 0.78 ? "manual" : r < 0.9 ? "warn" : "fail";
    } else {
      // static / api / trigger
      // Static scanner can't verify API-only items in upload mode -> more warns
      const modePenalty =
        (mode === "upload" || mode === "cli") &&
        (item.method === "auto-api" || item.method === "auto-trigger")
          ? 0.25
          : 0;
      const r = rng() + modePenalty;
      status = r < 0.62 ? "pass" : r < 0.82 ? "warn" : "fail";
    }

    const faq = getFaq(item.faqRef);
    const remediation =
      status === "fail" || status === "warn"
        ? faq
          ? `FAQ #${faq.n}: ${faq.solutions[0]}`
          : item.docUrl
            ? "See the linked documentation for the fix."
            : undefined
        : undefined;

    results[item.id] = {
      itemId: item.id,
      status,
      detected: detectedFor(item.id, status),
      evidence: evidenceFor(item.method, status),
      remediation,
    };
  }
  return results;
}

// ---- seed sample audits so the dashboard isn't empty on first load ----
export function seedAudits(): Audit[] {
  const now = Date.now();
  const base: Omit<Audit, "results">[] = [
    {
      id: "aud_shopmate_and",
      name: "ShopMate — Android",
      platform: "android",
      mode: "api",
      region: "in1",
      target: "SHOP-•••-WK2",
      createdAt: now - 1000 * 60 * 60 * 5,
      status: "completed",
      submittedBy: "you@clevertap.com",
    },
    {
      id: "aud_fintrack_ios",
      name: "FinTrack — iOS",
      platform: "ios",
      mode: "upload",
      target: "FinTrack-1.9.2.ipa",
      createdAt: now - 1000 * 60 * 60 * 26,
      status: "completed",
      submittedBy: "you@clevertap.com",
    },
    {
      id: "aud_wander_web",
      name: "Wanderly — Web",
      platform: "web",
      mode: "url",
      target: "https://app.wanderly.io",
      createdAt: now - 1000 * 60 * 60 * 50,
      status: "completed",
      submittedBy: "customer@wanderly.io",
    },
  ];
  return base.map((a) => ({
    ...a,
    results: generateResults(a.id, a.platform, a.mode),
  }));
}
