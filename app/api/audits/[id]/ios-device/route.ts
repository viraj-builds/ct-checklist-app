import { z } from "zod";
import { assertConsent, getAuditFor, recompute, updateAudit } from "@/lib/server/audits";
import { auditId, body, handle, HttpError } from "@/lib/server/http";
import type { IosDeviceFindings } from "@/lib/device/ios/types";

// Results of live iOS checks run in the browser through the local iOS helper
// (a real iPhone over USB / Wi-Fi, or the Xcode Simulator). Like the private
// scan, these are reported by the user's browser.
const short = z.string().max(300);
const pushTest = z.object({
  status: z.enum(["delivered", "not-delivered", "error"]),
  via: z.enum(["clevertap", "simulated"]),
  verifiedState: z.boolean(),
  stateDetail: short,
  sentAt: z.number(),
  deliveredAfterMs: z.number().optional(),
  detail: short.optional(),
  seenIn: z.enum(["shade", "log", "user"]).optional(),
});

const Findings = z.object({
  platform: z.literal("ios"),
  connectedVia: z.enum(["simulator-helper", "ios-helper"]),
  target: z.enum(["simulator", "device"]),
  transport: z.enum(["usb", "wifi"]).optional(),
  checkedAt: z.number(),
  device: z.object({ name: short.optional(), os: short.optional(), model: short.optional(), xcode: short.optional() }),
  app: z.object({
    bundleId: short,
    installed: z.boolean(),
    name: short.optional(),
    versionName: short.optional(),
    buildNumber: short.optional(),
    matchesScan: z.boolean().optional(),
  }),
  notificationPermission: z.enum(["granted", "denied", "provisional", "not-determined", "unknown"]).optional(),
  pushTests: z.object({ foreground: pushTest.optional(), background: pushTest.optional(), killed: pushTest.optional() }),
  deepLinks: z.array(z.object({ url: z.string().max(500), ok: z.boolean(), detail: short.optional() })).max(10),
  apnsError: short.optional(),
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
      networkInfo: z.boolean().optional(),
      onUserLogin: z.array(z.object({ kind: z.enum(["same-user", "switch-user", "anonymous", "aborted", "failed"]), line: z.number() })).max(20),
      profilePushes: z
        .array(z.object({ keys: z.array(short).max(60), hasIdentity: z.boolean(), phoneValid: z.boolean().optional(), nullish: z.array(short).max(60), line: z.number() }))
        .max(10),
      events: z
        .array(z.object({ name: short, count: z.number(), props: z.record(z.string().max(120), z.array(short).max(8)), issues: z.array(short).max(30) }))
        .max(50),
      clicks: z.array(z.object({ deepLink: z.string().max(500).optional(), line: z.number() })).max(10),
      push: z.object({
        received: z.number(),
        rendered: z.number(),
        channels: z.array(short).max(20),
        fallbackChannel: short.optional(),
        impressions: z.number(),
        errors: z.array(short).max(8),
      }),
      inApp: z.object({ shown: z.number(), blockedOnExcludedScreen: z.boolean(), impressions: z.number(), errors: z.array(short).max(8) }),
      errors: z.array(short).max(15),
    })
    .optional(),
  logScenarios: z
    .object({
      relaunch: z.object({ at: z.number(), onUserLoginOnStart: z.boolean(), kinds: z.array(short).max(20) }).optional(),
      linkTap: z
        .object({ at: z.number(), url: z.string().max(500), clicked: z.boolean(), landed: short.optional(), openedOutsideApp: z.boolean().optional() })
        .optional(),
      linkTaps: z
        .object({
          internal: z.object({ at: z.number(), url: z.string().max(500), clicked: z.boolean(), landed: short.optional(), openedOutsideApp: z.boolean().optional() }).optional(),
          external: z.object({ at: z.number(), url: z.string().max(500), clicked: z.boolean(), landed: short.optional(), openedOutsideApp: z.boolean().optional() }).optional(),
        })
        .optional(),
    })
    .optional(),
});

export const POST = handle(async (req, ctx: RouteContext<"/api/audits/[id]/ios-device">, user) => {
  const id = auditId((await ctx.params).id);
  const audit = await getAuditFor(id, user);
  await assertConsent(id);
  if (audit.platform !== "ios") throw new HttpError(409, "This audit isn't an iOS audit.");
  const findings = (await body(req, Findings, 512 * 1024)) as IosDeviceFindings;
  await updateAudit(id, { device: findings });
  await recompute(id);
  return Response.json({ ok: true });
});
