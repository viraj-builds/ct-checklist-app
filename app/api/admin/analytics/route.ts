import { adminAnalytics, assertAdmin } from "@/lib/server/admin";
import { handle } from "@/lib/server/http";

// Everything the /admin dashboard shows: all users and all audits, with emails.
export const GET = handle(async (_req, _ctx, user) => {
  assertAdmin(user);
  return Response.json(await adminAnalytics());
});
