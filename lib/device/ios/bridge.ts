"use client";

// Browser client for the local iOS helper (public/ct-ios-bridge.mjs). It runs
// on the user's computer and drives a real iPhone (USB / Wi-Fi) or the Xcode
// Simulator.

import type { IosApp, IosHelperStatus, IosOp, IosTarget, NotifPermission } from "./types";
import type { IosLogMessage } from "./ctlog";
import { asDict, parsePlist, type PlistValue } from "../../analyzer/ios/plist";

export const IOS_HELPER_URL = "http://127.0.0.1:47812";
export const IOS_HELPER_MIN_VERSION = 2; // must match HELPER_VERSION in public/ct-ios-bridge.mjs
export const IOS_STALLED = "The device stopped responding.";
export const NO_CONTROL = "NO_CONTROL:";

function withTimeout<T>(p: Promise<T>, ms = 45_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${IOS_STALLED} Unlock the iPhone (or check Xcode isn't showing a dialog), then try again.`)), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    );
  });
}

async function call<T>(token: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(IOS_HELPER_URL + path, {
      method: body ? "POST" : "GET",
      headers: { "X-Bridge-Token": token, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
  } catch {
    throw new Error("Can't reach the iOS helper on this computer. Is it still running?");
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json as { error?: string }).error ?? `iOS helper error (${res.status})`);
  return json as T;
}

/** Ask a running helper for its token (only answered for the audit site's own origin). */
export async function iosHelperHello(): Promise<{ token: string; version: number } | null> {
  try {
    const res = await fetch(IOS_HELPER_URL + "/v1/hello", { cache: "no-store" });
    if (!res.ok) return null;
    const j = (await res.json()) as { token?: string; version?: number; kind?: string };
    return j.token && j.kind === "ios" ? { token: j.token, version: j.version ?? 1 } : null;
  } catch {
    return null;
  }
}

export const iosHelperStatus = (token: string) => call<IosHelperStatus>(token, "/v1/status");
export const iosBoot = (token: string, udid: string) => call<{ ok: boolean }>(token, "/v1/boot", { udid });

export interface IosDriver {
  token: string;
  udid: string;
  label: string; // "iPhone 17 Pro · iOS 26.5"
  sim: IosTarget; // the Simulator or iPhone in use
  isDevice: boolean; // real iPhone
  where: string; // "Simulator" | "iPhone" — for messages
  canControl: boolean; // can open / close the app itself (Simulator, or iPhone with Xcode's devicectl)
  canSimulatePush: boolean; // local pushes (Simulator only)
  run(op: IosOp): Promise<string>;
  startLogs(): Promise<number>;
  readLogs(since: number): Promise<{ running: boolean; next: number; messages: IosLogMessage[]; tool?: string; error?: string }>;
  stopLogs(): Promise<void>;
  bundleZip(bundleId: string): Promise<File>;
}

export function iosDriver(token: string, sim: IosTarget, tools?: IosHelperStatus["tools"]): IosDriver {
  const isDevice = sim.kind === "device";
  return {
    token,
    udid: sim.udid,
    sim,
    isDevice,
    where: isDevice ? "iPhone" : "Simulator",
    canControl: !isDevice || tools?.control === "devicectl",
    canSimulatePush: !isDevice,
    label: `${sim.name} · ${sim.os}${isDevice ? ` · ${sim.transport === "wifi" ? "Wi-Fi" : "USB"}` : ""}`,
    run: async (op) => (await withTimeout(call<{ output: string }>(token, "/v1/run", { udid: sim.udid, op }))).output,
    startLogs: async () => (await call<{ seq: number }>(token, "/v1/logs/start", { udid: sim.udid })).seq,
    readLogs: (since) => call(token, `/v1/logs?udid=${encodeURIComponent(sim.udid)}&since=${since}`),
    stopLogs: async () => {
      await call(token, "/v1/logs/stop", { udid: sim.udid }).catch(() => {});
    },
    bundleZip: async (bundleId) => {
      let res: Response;
      try {
        res = await fetch(`${IOS_HELPER_URL}/v1/bundle?udid=${encodeURIComponent(sim.udid)}&bundleId=${encodeURIComponent(bundleId)}`, {
          headers: { "X-Bridge-Token": token },
          cache: "no-store",
        });
      } catch {
        throw new Error("Can't reach the iOS helper on this computer. Is it still running?");
      }
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? "Couldn't read the app from the Simulator.");
      const name = res.headers.get("Content-Disposition")?.match(/filename="([^"]+)"/)?.[1] ?? `${bundleId}.zip`;
      return new File([await res.blob()], name, { type: "application/zip" });
    },
  };
}

export async function listIosApps(d: IosDriver): Promise<IosApp[]> {
  return JSON.parse(await d.run({ t: "listApps" })) as IosApp[];
}

/** Read the app's notification authorization from the Simulator's settings store (unknown on an iPhone). */
export async function notificationPermission(d: IosDriver, bundleId: string): Promise<NotifPermission> {
  if (d.isDevice) return "unknown";
  try {
    const b64 = await d.run({ t: "notifSettings" });
    if (!b64) return "unknown";
    const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const outer = asDict(parsePlist(bin));
    const sections = asDict(outer?.sectionInfo) ?? outer;
    const raw = sections?.[bundleId];
    if (!raw) return "not-determined"; // the app never asked
    const inner = raw instanceof Uint8Array ? asDict(parsePlist(raw)) : asDict(raw);
    const objs = (inner?.$objects ?? []) as PlistValue[];
    const st = objs.map(asDict).find((o) => o && typeof o.authorizationStatus === "number")?.authorizationStatus as number | undefined;
    return st === 2 ? "granted" : st === 1 ? "denied" : st === 3 || st === 4 ? "provisional" : st === 0 ? "not-determined" : "unknown";
  } catch {
    return "unknown";
  }
}
