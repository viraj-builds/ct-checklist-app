// Live checks for iOS run through the local iOS helper (public/ct-ios-bridge.mjs).
// It drives a real iPhone (USB or Wi-Fi, via Xcode's devicectl + a syslog
// streamer) or the Xcode Simulator (`xcrun simctl`), and streams the app's
// CleverTap logs. Nothing here talks to Android code.

import type { AppState, LogScenarios, PushTestResult } from "../types";
import type { LogInsights } from "../ctlog";

// The only commands the site can ask the iOS helper to run. The helper builds
// the actual `xcrun simctl` argument list from these — never from free text.
export type IosOp =
  | { t: "listApps" }
  | { t: "appInfo"; bundleId: string }
  | { t: "launch"; bundleId: string; relaunch?: boolean }
  | { t: "terminate"; bundleId: string }
  | { t: "background"; bundleId: string } // opens Settings so the app moves to the background
  | { t: "pid"; bundleId: string }
  | { t: "openUrl"; url: string; bundleId?: string }
  | { t: "push"; bundleId: string; payload: Record<string, unknown> } // local `simctl push` (no APNs)
  | { t: "findNotification"; marker: string } // Simulator: delivered-notifications store
  | { t: "pushSeen"; bundleId: string; since: number } // iPhone: SpringBoard / apsd logged a push for the app
  | { t: "notifSettings" } // base64 of the Simulator's notification settings store
  | { t: "screenshot" };

export interface IosSimulator {
  kind?: "simulator";
  udid: string;
  name: string;
  os: string; // e.g. "iOS 26.5"
  state: "Booted" | "Shutdown" | string;
}

export interface IosPhone {
  kind: "device";
  udid: string;
  name: string;
  model?: string;
  os: string;
  transport: "usb" | "wifi";
  state: "Connected" | "Not reachable" | "Not paired" | string;
  developerMode?: string; // "enabled" | "disabled"
}

/** A Simulator or a real iPhone — the lab treats both the same way. */
export type IosTarget = (IosSimulator & { kind?: "simulator" }) | IosPhone;

export interface IosHelperStatus {
  platform?: string;
  xcode?: string;
  simulators: IosSimulator[];
  devices?: IosPhone[];
  tools?: { control: "devicectl" | null; logs: "idevicesyslog" | "pymobiledevice3" | "log collect" | null; simulator?: boolean };
}

export interface IosApp {
  bundleId: string;
  name?: string;
  version?: string;
  build?: string;
  executable?: string;
}

export type NotifPermission = "granted" | "denied" | "provisional" | "not-determined" | "unknown";

export interface IosPushTestResult extends Omit<PushTestResult, "seenIn"> {
  via: "clevertap" | "simulated"; // simulated = local simctl push, proves the app side only
  seenIn?: "shade" | "log" | "user"; // user = the tester confirmed they saw it on the iPhone
}

export interface IosDeviceFindings {
  platform: "ios";
  connectedVia: "simulator-helper" | "ios-helper";
  target: "simulator" | "device";
  transport?: "usb" | "wifi";
  checkedAt: number;
  device: { name?: string; os?: string; model?: string; xcode?: string };
  app: {
    bundleId: string;
    installed: boolean;
    name?: string;
    versionName?: string;
    buildNumber?: string;
    matchesScan?: boolean;
  };
  notificationPermission?: NotifPermission;
  pushTests: Partial<Record<AppState, IosPushTestResult>>;
  deepLinks: { url: string; ok: boolean; detail?: string }[];
  logs?: LogInsights;
  logScenarios?: LogScenarios;
  apnsError?: string; // "Application failed to register for remote notification: …"
}
