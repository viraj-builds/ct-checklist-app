"use client";

import { buildCommand } from "./ops";
import type { DeviceOp } from "./types";

export interface DeviceDriver {
  via: "webusb" | "helper";
  transport: "usb" | "wifi";
  serial: string;
  label: string;
  run(op: DeviceOp): Promise<string>;
  close(): Promise<void>;
}

/* ------------------------------------------------------------------ */
/* WebUSB — ADB straight from the browser (Chrome / Edge, USB only)     */
/* ------------------------------------------------------------------ */

export const STALLED = "The phone stopped responding.";

// A phone that's locked, unplugged or switched USB mode can leave a command
// hanging forever — never wait more than `ms`.
function withTimeout<T>(p: Promise<T>, ms = 30_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`${STALLED} Unlock it, re-plug the cable (or check Wi-Fi), then press “Connect phone” again.`)),
      ms,
    );
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    );
  });
}

export function webUsbSupported(): boolean {
  return typeof navigator !== "undefined" && "usb" in navigator && window.isSecureContext;
}

export async function connectWebUsb(): Promise<DeviceDriver> {
  const [{ AdbDaemonWebUsbDeviceManager }, { Adb, AdbDaemonTransport }, { default: AdbWebCredentialStore }] =
    await Promise.all([
      import("@yume-chan/adb-daemon-webusb"),
      import("@yume-chan/adb"),
      import("@yume-chan/adb-credential-web"),
    ]);
  const manager = AdbDaemonWebUsbDeviceManager.BROWSER;
  if (!manager) throw new Error("This browser doesn't support WebUSB. Use Chrome or Edge on a computer.");

  const device = await manager.requestDevice();
  if (!device) throw new Error("No device selected.");

  let connection;
  try {
    connection = await device.connect();
  } catch (e) {
    const msg = (e as Error).message ?? "";
    if (/claim|busy|in use|Unable to claim interface|access denied/i.test(msg))
      throw new Error(
        "The phone is being used by another ADB program. Close Android Studio / scrcpy, run “adb kill-server” in a terminal, then try again.",
      );
    throw e;
  }
  // The phone shows "Allow USB debugging?" the first time — the key is stored in this browser.
  const transport = await AdbDaemonTransport.authenticate({
    serial: device.serial,
    connection,
    credentialStore: new AdbWebCredentialStore("CT Integration Audit"),
  });
  const adb = new Adb(transport);
  return {
    via: "webusb",
    transport: "usb",
    serial: device.serial,
    label: device.name || device.serial,
    run: (op) => withTimeout(adb.subprocess.noneProtocol.spawnWaitText(buildCommand(op))),
    close: () => adb.close(),
  };
}

/* ------------------------------------------------------------------ */
/* Local helper — runs your own `adb` (USB or Wi-Fi). See public/ct-device-bridge.mjs */
/* ------------------------------------------------------------------ */

export const HELPER_URL = "http://127.0.0.1:47811";

export interface HelperDevice {
  serial: string;
  model?: string;
  state: string;
  transport: "usb" | "wifi";
}

async function helper<T>(token: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(HELPER_URL + path, {
      method: body ? "POST" : "GET",
      headers: { "X-Bridge-Token": token, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error("Can't reach the device helper on this computer. Is it running?");
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json as { error?: string }).error ?? `Helper error (${res.status})`);
  return json as T;
}

export const HELPER_MIN_VERSION = 3; // must match HELPER_VERSION in public/ct-device-bridge.mjs

/** Ask a running helper for its token (only answered for the audit site's own origin). */
export async function helperHello(): Promise<{ token: string; version: number } | null> {
  try {
    const res = await fetch(HELPER_URL + "/v1/hello", { cache: "no-store" });
    if (!res.ok) return null;
    const j = (await res.json()) as { token?: string; version?: number };
    return j.token ? { token: j.token, version: j.version ?? 1 } : null;
  } catch {
    return null;
  }
}

export const helperStatus = (token: string) =>
  helper<{ adb: string; devices: HelperDevice[] }>(token, "/v1/status");

export const helperPair = (token: string, host: string, port: number, code: string) =>
  helper<{ output: string; connected?: boolean }>(token, "/v1/pair", { host, port, code });

export const helperConnect = (token: string, host: string, port: number) =>
  helper<{ output: string }>(token, "/v1/connect", { host, port });

export function helperDriver(token: string, d: HelperDevice): DeviceDriver {
  return {
    via: "helper",
    transport: d.transport,
    serial: d.serial,
    label: d.model ? `${d.model} (${d.transport === "wifi" ? "Wi-Fi" : "USB"})` : d.serial,
    run: async (op) => (await withTimeout(helper<{ output: string }>(token, "/v1/run", { serial: d.serial, op }))).output,
    close: async () => {},
  };
}
