"use client";

import type { DeviceDriver } from "./drivers";

// ---------------------------------------------------------------------------
// What is actually on the phone's screen — framework-independent.
//
// Android's accessibility tree (uiautomator dump) lists the visible text and
// buttons of whatever is on screen. Native Kotlin/Java, Flutter, React Native,
// Cordova/Ionic (WebView) and .NET MAUI all expose it; game engines (Unity)
// usually don't — for those the screenshot + the user's confirmation decide.
// ---------------------------------------------------------------------------

export interface ScreenRead {
  activity?: string; // "pkg/.Activity" on top
  packages: string[]; // packages owning the visible nodes
  texts: string[]; // visible text / content descriptions (deduped, capped)
  readable: boolean; // the tree had any content
}

const decode = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&");

export function parseUiDump(xml: string, onlyPkg?: string): Omit<ScreenRead, "activity"> {
  const texts = new Set<string>();
  const packages = new Set<string>();
  for (const m of xml.matchAll(/<node\b([^>]*)>/g)) {
    const attrs = m[1];
    const pkg = attrs.match(/\bpackage="([^"]*)"/)?.[1] ?? "";
    if (pkg) packages.add(pkg);
    if (onlyPkg && pkg !== onlyPkg) continue;
    for (const a of ["text", "content-desc"]) {
      const v = decode(attrs.match(new RegExp(`\\b${a}="([^"]*)"`))?.[1] ?? "").trim();
      if (v && v.length <= 120 && !/^\d{1,2}:\d{2}$/.test(v)) texts.add(v); // skip clocks
    }
  }
  const list = [...texts].slice(0, 200);
  return { packages: [...packages], texts: list, readable: list.length > 0 };
}

export async function readScreen(d: DeviceDriver, onlyPkg?: string): Promise<ScreenRead> {
  const [xml, focus] = await Promise.all([d.run({ t: "uiDump" }).catch(() => ""), d.run({ t: "focus" }).catch(() => "")]);
  return { ...parseUiDump(xml, onlyPkg), activity: topActivity(focus) };
}

/** How different two screens are: 0 = identical text, 1 = nothing in common. */
export function screenDiff(a: string[], b: string[]): number {
  if (!a.length && !b.length) return 0;
  const A = new Set(a);
  const B = new Set(b);
  let common = 0;
  for (const x of A) if (B.has(x)) common++;
  return 1 - common / (A.size + B.size - common);
}

/** Does the browser show the link's website (URL bar / page text mentions the host)? */
export function showsHost(texts: string[], url: string): boolean | undefined {
  const host = url.match(/^https?:\/\/([^/?#]+)/i)?.[1]?.toLowerCase().replace(/^www\./, "");
  if (!host || !texts.length) return undefined;
  return texts.some((t) => t.toLowerCase().includes(host));
}

/** Screenshot as a data URL — shown in the browser only, never uploaded. */
export async function screenshot(d: DeviceDriver): Promise<string | undefined> {
  const b64 = (await d.run({ t: "screenshot" }).catch(() => "")).replace(/\s+/g, "");
  return b64.startsWith("iVBOR") ? `data:image/png;base64,${b64}` : undefined; // PNG signature
}

// "u0 com.android.chrome/org.chromium.chrome.browser.ChromeTabbedActivity t12" → package/activity on screen
export function topActivity(focus: string): string | undefined {
  const pick = (re: RegExp) => focus.match(re)?.[1];
  return (
    pick(/topResumedActivity=ActivityRecord\{\S+ u\d+ (\S+\/\S+)/) ??
    pick(/mResumedActivity: ActivityRecord\{\S+ u\d+ (\S+\/\S+)/) ??
    pick(/mCurrentFocus=Window\{\S+ \S+ ([^}\s]+\/[^}\s]+)\}/)
  );
}
