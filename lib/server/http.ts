import "server-only";
import { z } from "zod";
import { currentUser, type SessionUser } from "./auth";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Wrap an authenticated route handler:
 *  - rejects cross-site writes (Origin must match the host) — CSRF defence on
 *    top of SameSite=Lax session cookies
 *  - requires a signed-in user and passes it to the handler
 *  - HttpError -> JSON error; anything else -> generic 500 (details only in logs)
 */
export function handle<C = unknown>(fn: (req: Request, ctx: C, user: SessionUser) => Promise<Response>) {
  return async (req: Request, ctx: C): Promise<Response> => {
    try {
      if (UNSAFE.has(req.method)) assertSameOrigin(req);
      const user = await currentUser();
      if (!user) throw new HttpError(401, "Please sign in.");
      return await fn(req, ctx, user);
    } catch (e) {
      if (e instanceof HttpError) return Response.json({ error: e.message }, { status: e.status });
      console.error(e);
      const detail = process.env.NODE_ENV !== "production" && e instanceof Error ? e.message : undefined;
      return Response.json({ error: detail ?? "Something went wrong. Please try again." }, { status: 500 });
    }
  };
}

function assertSameOrigin(req: Request) {
  const origin = req.headers.get("origin");
  if (!origin) return; // non-browser clients; cookies still required
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  let originHost = "";
  try {
    originHost = new URL(origin).host;
  } catch {
    /* malformed */
  }
  if (!host || originHost !== host) throw new HttpError(403, "Cross-site request blocked.");
}

export async function body<T>(req: Request, schema: z.ZodType<T>, maxBytes = 64 * 1024): Promise<T> {
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > maxBytes) throw new HttpError(413, "Request body too large");
  let raw: unknown;
  try {
    const text = await req.text();
    if (text.length > maxBytes) throw new HttpError(413, "Request body too large");
    raw = JSON.parse(text);
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, "Body must be JSON");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new HttpError(400, `Invalid ${issue?.path.join(".") || "body"}: ${issue?.message}`);
  }
  return parsed.data;
}

export const AUDIT_ID = /^aud_[a-f0-9]{32}$/;

export function auditId(id: string): string {
  if (!AUDIT_ID.test(id)) throw new HttpError(404, "Audit not found");
  return id;
}

// Shared field schemas
export const zRegion = z.enum(["in1", "us1", "eu1", "sg1", "aps3", "mec1"]);
export const zAccountId = z.string().trim().min(3).max(40).regex(/^[A-Za-z0-9-]+$/, "Account ID looks invalid");
export const zPasscode = z.string().min(3).max(200);
