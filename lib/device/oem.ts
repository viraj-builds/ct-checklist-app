"use client";

import type { DeviceDriver } from "./drivers";
import type { BackgroundState, LoggingState, OemInfo } from "./types";

// ---------------------------------------------------------------------------
// Phone makers change how logging and background work. Instead of keeping a
// list of brands, we *test* the phone: write a probe log line at each level and
// see which ones come back. The brand is only used to word the fix.
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function detectOem(props: Record<string, string>): OemInfo {
  const p = (k: string) => props[k]?.trim() || undefined;
  const maker = (p("ro.product.manufacturer") ?? p("ro.product.brand") ?? "").toLowerCase();
  const rom =
    (p("ro.mi.os.version.name") && `HyperOS ${p("ro.mi.os.version.name")}`) ||
    (p("ro.miui.ui.version.name") && `MIUI ${p("ro.miui.ui.version.name")}`) ||
    (p("ro.vivo.os.version") && `Funtouch/OriginOS ${p("ro.vivo.os.version")}`) ||
    (p("ro.build.version.oplusrom") && `ColorOS ${p("ro.build.version.oplusrom")}`) ||
    (p("ro.build.version.opporom") && `ColorOS ${p("ro.build.version.opporom")}`) ||
    (p("ro.build.version.emui") && p("ro.build.version.emui")) ||
    (p("ro.build.version.magic") && `MagicOS ${p("ro.build.version.magic")}`) ||
    (p("ro.build.version.oneui") && `One UI ${p("ro.build.version.oneui")}`) ||
    (p("ro.oxygen.version") && `OxygenOS ${p("ro.oxygen.version")}`) ||
    (p("ro.build.version.realmeui") && `realme UI ${p("ro.build.version.realmeui")}`) ||
    undefined;
  const family: OemInfo["family"] = /xiaomi|redmi|poco/.test(maker)
    ? "xiaomi"
    : /vivo|iqoo/.test(maker)
      ? "vivo"
      : /oppo|realme|oneplus/.test(maker)
        ? "oppo"
        : /huawei|honor/.test(maker)
          ? "huawei"
          : /samsung/.test(maker)
            ? "samsung"
            : "other";
  return { family, maker: maker || undefined, rom };
}

/* ---- logging ----------------------------------------------------- */

function parseLogState(out: string) {
  const v = (k: string) => out.match(new RegExp(`^${k.replace(/\./g, "\\.")}=(.*)$`, "m"))?.[1]?.trim() ?? "";
  // "main: ring buffer is 256 KiB (…)" (new) or "main: ring buffer is 256Kb (…)" (old)
  const b = out.match(/ring buffer is (\d+)\s*(K|M)i?B?/i);
  const bufferKb = b ? Number(b[1]) * (b[2].toUpperCase() === "M" ? 1024 : 1) : undefined;
  return { logTag: v("log.tag"), persistLogTag: v("persist.log.tag"), bufferKb };
}

// Which levels reach logcat right now: "V" (everything), "D", "I" (Huawei-style) or "none".
async function probe(d: DeviceDriver): Promise<LoggingState["levelSeen"]> {
  const marker = Math.random().toString(36).slice(2, 10);
  const out = await d.run({ t: "logProbe", marker });
  if (out.includes(`V/CTAuditProbe`)) return "V";
  if (out.includes(`D/CTAuditProbe`)) return "D";
  if (out.includes(`I/CTAuditProbe`)) return "I";
  return "none";
}

const LEVEL = /^[A-Za-z]{1,10}$/; // restore exactly what was there (vivo uses e.g. "M")

/** Read-only check used in the device summary. Never changes the phone. */
export async function checkLogging(d: DeviceDriver, oem: OemInfo): Promise<LoggingState> {
  const st = parseLogState(await d.run({ t: "logState" }));
  const levelSeen = await probe(d);
  if (levelSeen === "V") return { ...st, levelSeen, status: "ok" };
  // log.tag / persist.log.tag can be lifted from the shell during the log session
  const liftable = oem.family !== "huawei" && [st.logTag, st.persistLogTag].some((t) => t && t.toUpperCase() !== "V");
  return { ...st, levelSeen, status: liftable ? "hidden" : "blocked", fix: liftable ? undefined : fixFor(oem, levelSeen, st) };
}

/**
 * Make verbose logs visible for a log session, changing as little as possible,
 * and return a function that puts every setting back.
 */
export async function liftLogging(
  d: DeviceDriver,
  oem: OemInfo,
  accountId?: string,
): Promise<{ state: LoggingState; restore: () => Promise<void> }> {
  const st = parseLogState(await d.run({ t: "logState" }));
  const undo: (() => Promise<unknown>)[] = [];
  // Per-tag levels beat the phone-wide log.tag, which some phones (vivo) put
  // back to "E" within seconds. Cleared again on restore.
  for (const tag of ctTags(accountId)) {
    const ok = await d.run({ t: "setTagLevel", tag, level: "V" }).then(
      () => true,
      () => false,
    );
    if (ok) undo.push(() => d.run({ t: "setTagLevel", tag, level: "" }));
  }
  const restore = async () => {
    for (const u of undo.reverse()) await u().catch(() => {});
    undo.length = 0;
  };

  // A small ring buffer (64–256 KB on many phones) rotates CleverTap lines out
  // within a minute on busy devices. 4 MB is enough for a session; put it back after.
  if (st.bufferKb && st.bufferKb < 1024) {
    const ok = await d.run({ t: "setLogBuffer", size: "4M" }).then(
      () => true,
      () => false,
    );
    const was = st.bufferKb >= 1024 && st.bufferKb % 1024 === 0 ? `${st.bufferKb / 1024}M` : `${Math.max(64, st.bufferKb)}K`;
    if (ok) undo.push(() => d.run({ t: "setLogBuffer", size: was }));
  }

  let levelSeen = await probe(d);
  let lifted = false;

  // 1) log.tag (vivo, Oppo, some Xiaomi set it to E/I) — resets on reboot anyway.
  if (levelSeen !== "V") {
    const prev = LEVEL.test(st.logTag) ? st.logTag : "";
    await d.run({ t: "setLogTag", level: "V" });
    undo.push(() => d.run({ t: "setLogTag", level: prev }));
    levelSeen = await probe(d);
    lifted = levelSeen === "V";
  }
  // 2) persist.log.tag ("Logger buffer size: Off" sets it to S) — survives reboots, so always restore.
  if (levelSeen !== "V" && st.persistLogTag && st.persistLogTag.toUpperCase() !== "V") {
    const prev = LEVEL.test(st.persistLogTag) ? st.persistLogTag : "";
    const ok = await d.run({ t: "setPersistLogTag", level: "V" }).then(
      () => true,
      () => false,
    );
    if (ok) {
      undo.push(() => d.run({ t: "setPersistLogTag", level: prev }));
      levelSeen = await probe(d);
      lifted = levelSeen === "V";
    }
  }

  const status: LoggingState["status"] = levelSeen === "V" ? (lifted ? "lifted" : "ok") : "blocked";
  // nothing gained → don't leave half-changed settings behind
  if (status === "blocked") await restore();
  return {
    state: { ...st, levelSeen, status, fix: status === "blocked" ? fixFor(oem, levelSeen, st) : undefined },
    restore,
  };
}

function fixFor(oem: OemInfo, seen: LoggingState["levelSeen"], st: { persistLogTag: string }): string {
  if (oem.family === "huawei")
    return "Huawei/Honor only show INFO and above. Dial *#*#2846579#*#* → Background settings → Log settings → turn on AP log, restart the phone, then reconnect.";
  if (seen === "none" || st.persistLogTag.toUpperCase() === "S")
    return "Logging is switched off on this phone. Settings → Developer options → Logger buffer size → choose 1M or more (not “Off”), then press Start again.";
  if (oem.family === "oppo")
    return "This phone filters debug logs. Developer options → Logger buffer size → 1M or more, and turn off “Disable logging” if present; then press Start again.";
  if (oem.family === "xiaomi")
    return "This phone filters debug logs. Developer options → Logger buffer size → 1M or more, then press Start again.";
  return "This phone hides debug logs and we couldn't lift it. Developer options → Logger buffer size → 1M or more, then press Start again.";
}

/* ---- background / battery ---------------------------------------- */

export async function checkBackground(d: DeviceDriver, pkg: string, oem: OemInfo): Promise<BackgroundState> {
  const out = await d.run({ t: "bgState", pkg });
  const bucket = Number(out.match(/^bucket=(\d+)/m)?.[1]) || undefined;
  const runAny = out.match(/RUN_ANY_IN_BACKGROUND:\s*(\w+)/)?.[1];
  const auto = out.match(/(?:10008|AUTO_START)\)?:\s*(\w+)/i)?.[1];
  const s: BackgroundState = {
    standbyBucket: bucket,
    restrictedBucket: bucket ? bucket >= 45 : undefined, // 45 = RESTRICTED, 50 = NEVER
    backgroundRestricted: runAny ? /ignore|deny/i.test(runAny) : undefined,
    batteryUnrestricted: /^whitelisted=1/m.test(out),
    autoStart: auto ? (/allow/i.test(auto) ? "allowed" : /deny|ignore/i.test(auto) ? "denied" : undefined) : undefined,
    hints: [],
  };
  if (s.restrictedBucket || s.backgroundRestricted)
    s.hints.push("Android has restricted this app in the background (Settings → Apps → the app → Battery → Unrestricted).");
  if (s.autoStart === "denied") s.hints.push("Autostart is off for the app (Security → Autostart, or App info → Autostart).");
  if (!s.batteryUnrestricted) {
    const tip: Partial<Record<OemInfo["family"], string>> = {
      xiaomi: "Xiaomi: App info → Autostart ON and Battery saver → No restrictions.",
      vivo: "vivo: Settings → Battery → Background power consumption → allow the app; i Manager → App manager → Autostart ON.",
      oppo: "Oppo/realme/OnePlus: App info → Battery → Allow background activity and Allow auto launch.",
      huawei: "Huawei/Honor: Settings → Battery → App launch → the app → Manage manually, all three ON.",
      samsung: "Samsung: Settings → Battery → Background usage limits → make sure the app isn't “Sleeping” or “Deep sleeping”.",
    };
    if (tip[oem.family]) s.hints.push(tip[oem.family]!);
  }
  return s;
}

/* ---- screen ------------------------------------------------------ */

/** Wake the screen and report whether it's still locked (a lock blocks in-apps and taps). */
export async function readyScreen(d: DeviceDriver): Promise<{ awake: boolean; locked: boolean }> {
  let s = parseScreen(await d.run({ t: "screen" }));
  if (!s.awake) {
    await d.run({ t: "wake" }).catch(() => {});
    await sleep(800);
    s = parseScreen(await d.run({ t: "screen" }));
  }
  return s;
}

function parseScreen(out: string) {
  const awake = !/mWakefulness=(Asleep|Dozing)/.test(out);
  const locked = /(mKeyguardShowing|mShowingLockscreen|mDreamingLockscreen|isKeyguardShowing)=true/.test(out);
  return { awake, locked };
}

/** Log tags the CleverTap SDK writes under (plus our probe), valid as property names. */
export function ctTags(accountId?: string): string[] {
  const acct = accountId?.trim().toUpperCase();
  return ["CleverTap", "CTAuditProbe", ...(acct && /^[A-Z0-9-]{4,20}$/.test(acct) ? [`CleverTap:${acct}`] : [])];
}
