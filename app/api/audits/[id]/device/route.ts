import { z } from "zod";
import { assertAccess, recompute, updateAudit } from "@/lib/server/audits";
import { auditId, body, handle } from "@/lib/server/http";
import type { DeviceFindings } from "@/lib/device/types";

// Results of live-device checks run in the browser (WebUSB or local helper).
// Like the private scan, these are reported by the user's browser.
const short = z.string().max(300);
const background = z.object({
  standbyBucket: z.number().optional(),
  restrictedBucket: z.boolean().optional(),
  backgroundRestricted: z.boolean().optional(),
  batteryUnrestricted: z.boolean(),
  autoStart: z.enum(["allowed", "denied"]).optional(),
  hints: z.array(short).max(6),
});
const pushTest = z.object({
  status: z.enum(["delivered", "not-delivered", "error"]),
  verifiedState: z.boolean(),
  stateDetail: short,
  sentAt: z.number(),
  deliveredAfterMs: z.number().optional(),
  detail: short.optional(),
  seenIn: z.enum(["shade", "log"]).optional(),
  background: background.optional(),
});

const Findings = z.object({
  connectedVia: z.enum(["webusb", "helper"]),
  transport: z.enum(["usb", "wifi"]),
  checkedAt: z.number(),
  device: z.object({
    model: short.optional(),
    manufacturer: short.optional(),
    android: short.optional(),
    sdk: z.number().optional(),
    rom: short.optional(),
  }),
  logging: z
    .object({
      status: z.enum(["ok", "hidden", "lifted", "blocked"]),
      levelSeen: z.enum(["V", "D", "I", "none"]),
      logTag: z.string().max(20),
      persistLogTag: z.string().max(20),
      bufferKb: z.number().optional(),
      fix: short.optional(),
    })
    .optional(),
  background: background.optional(),
  screen: z.object({ awake: z.boolean(), locked: z.boolean() }).optional(),
  app: z.object({
    package: short,
    installed: z.boolean(),
    versionName: short.optional(),
    versionCode: short.optional(),
    matchesScan: z.boolean().optional(),
  }),
  notificationPermission: z.enum(["granted", "denied", "not-required", "unknown"]).optional(),
  channels: z.array(z.object({ id: short, name: short.optional(), importance: z.number().optional() })).max(30),
  ctLogs: z.object({
    lines: z.array(short).max(40),
    verbose: z.boolean(),
    accountId: short.optional(),
    errors: z.array(short).max(10),
  }),
  pushTests: z.object({ foreground: pushTest.optional(), background: pushTest.optional(), killed: pushTest.optional() }),
  deepLinks: z.array(z.object({ url: z.string().max(500), ok: z.boolean(), activity: short.optional(), detail: short.optional() })).max(10),
  logs: z
    .object({
      lines: z.number(),
      sdkVersion: short.optional(),
      wrapper: z.object({ lib: short, version: short.optional() }).optional(),
      accountId: short.optional(),
      region: short.optional(),
      identityKeys: z.array(short).max(10).optional(),
      lifecycleRegistered: z.boolean(),
      appLaunchedFired: z.boolean(),
      queueSent: z.number(),
      queueFailed: z.number(),
      pushToken: z.boolean(),
      locationSent: z.boolean(),
      onUserLogin: z.array(z.object({ kind: z.enum(["same-user", "switch-user", "anonymous", "aborted", "failed"]), line: z.number() })).max(20),
      profilePushes: z
        .array(z.object({ keys: z.array(short).max(60), hasIdentity: z.boolean(), phoneValid: z.boolean().optional(), nullish: z.array(short).max(60), line: z.number() }))
        .max(10),
      events: z
        .array(z.object({ name: short, count: z.number(), props: z.record(z.string().max(120), z.array(short).max(8)), issues: z.array(short).max(30) }))
        .max(50),
      clicks: z.array(z.object({ deepLink: z.string().max(500).optional(), line: z.number() })).max(10),
      push: z
        .object({
          received: z.number(),
          rendered: z.number(),
          channels: z.array(short).max(20),
          fallbackChannel: short.optional(),
          impressions: z.number(),
          errors: z.array(short).max(8),
        })
        .optional(),
      inApp: z
        .object({ shown: z.number(), blockedOnExcludedScreen: z.boolean(), impressions: z.number(), errors: z.array(short).max(8) })
        .optional(),
      errors: z.array(short).max(15),
    })
    .optional(),
  logScenarios: z
    .object({
      relaunch: z.object({ at: z.number(), onUserLoginOnStart: z.boolean(), kinds: z.array(short).max(20) }).optional(),
      linkTap: z
        .object({ at: z.number(), url: z.string().max(500), clicked: z.boolean(), landed: short.optional(), openedOutsideApp: z.boolean().optional() })
        .optional(),
    })
    .optional(),
  logTagWasRestricted: z.boolean().optional(),
});

export const POST = handle(async (req, ctx: RouteContext<"/api/audits/[id]/device">, user) => {
  const id = auditId((await ctx.params).id);
  await assertAccess(id, user);
  const findings = (await body(req, Findings, 512 * 1024)) as DeviceFindings;
  await updateAudit(id, { device: findings });
  await recompute(id);
  return Response.json({ ok: true });
});
