import { z } from "zod";
import { assertActionQuota, assertConsent, getAuditFor, saveScan, updateAudit } from "@/lib/server/audits";
import { auditId, body, handle, HttpError } from "@/lib/server/http";
import { crawlSite } from "@/lib/web/crawler";
import { assertSafeSiteUrl, UnsafeUrlError } from "@/lib/web/safe-url";
import { NoBrowserError } from "@/lib/web/browser";

// Website check: open the site in headless Chromium and record what the
// CleverTap Web SDK sends. The optional test login (website account, not
// CleverTap) arrives in this request only, is used in memory, and is never
// stored or logged. The identity the site sent on login is returned to the
// caller (it's their own test user) so the API step can look it up.
export const maxDuration = 300;

const BROWSER_CRASH = /Target closed|Protocol error|Session closed|Connection closed|browser has disconnected|Navigating frame was detached/i;

const Crawl = z.object({
  login: z
    .object({
      url: z.string().trim().max(500).optional(),
      username: z.string().trim().min(1).max(200),
      password: z.string().min(1).max(200),
    })
    .optional(),
});

export const POST = handle(async (req, ctx: RouteContext<"/api/audits/[id]/crawl">, user) => {
  const id = auditId((await ctx.params).id);
  const { login } = await body(req, Crawl);
  const audit = await getAuditFor(id, user);
  await assertConsent(id);
  if (audit.platform !== "web" || !audit.target) throw new HttpError(400, "This audit isn't a website audit.");
  await assertActionQuota(user, id, "crawl", 12);

  let url: URL;
  try {
    url = await assertSafeSiteUrl(audit.target);
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
  await updateAudit(id, { status: "scanning", stage: login ? "Opening your website and logging in" : "Opening your website", error: null });
  try {
    const input = { url, login: login && { ...login, url: login.url || undefined } };
    // Headless Chromium on a serverless function occasionally dies mid-run; one retry
    // with a fresh browser fixes that without bothering the user.
    const started = Date.now();
    const { report, identity } = await crawlSite(input).catch((e) => {
      const left = 280_000 - (Date.now() - started); // stay inside maxDuration
      if (!BROWSER_CRASH.test(String((e as Error)?.message)) || left < 60_000) throw e;
      console.warn(`crawl ${id}: browser crashed, retrying once`, e);
      return crawlSite({ ...input, budgetMs: Math.min(170_000, left - 15_000) });
    });
    await saveScan(id, report);
    return Response.json({ ok: true, identity, ctId: report.ctId, login: report.login });
  } catch (e) {
    const msg =
      e instanceof NoBrowserError || e instanceof UnsafeUrlError
        ? e.message
        : BROWSER_CRASH.test(String((e as Error)?.message))
          ? "The browser we use for the website check stopped unexpectedly (twice). Please try again in a minute — or use the Live session in your Chrome, which doesn't depend on it."
          : `The website check didn't finish: ${(e as Error).message.split("\n")[0].slice(0, 200)}`;
    console.error(`crawl ${id}`, e);
    await updateAudit(id, { status: audit.webScan ? "completed" : "failed", stage: null, error: msg });
    throw new HttpError(502, msg);
  }
});
