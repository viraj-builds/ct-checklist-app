import "server-only";
import { z } from "zod";
import { AUDIT_ID } from "./audits";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Wrap a route handler: HttpError -> JSON error, anything else -> 500. */
export function handle<A extends unknown[]>(fn: (...args: A) => Promise<Response>) {
  return async (...args: A): Promise<Response> => {
    try {
      return await fn(...args);
    } catch (e) {
      if (e instanceof HttpError) return Response.json({ error: e.message }, { status: e.status });
      console.error(e);
      const msg = e instanceof Error ? e.message : "Internal error";
      return Response.json({ error: msg }, { status: 500 });
    }
  };
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

export function auditId(id: string): string {
  if (!AUDIT_ID.test(id)) throw new HttpError(404, "Audit not found");
  return id;
}

// Shared field schemas
export const zRegion = z.enum(["in1", "us1", "eu1", "sg1", "aps3", "mec1"]);
export const zAccountId = z.string().trim().min(3).max(40).regex(/^[A-Za-z0-9-]+$/, "Account ID looks invalid");
export const zPasscode = z.string().min(3).max(200);
