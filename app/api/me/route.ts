import { handle } from "@/lib/server/http";
import { authClient } from "@/lib/server/auth";
import { touchPresence } from "@/lib/server/admin";

// Who is signed in (for the sidebar). The sidebar calls this every couple of
// minutes while the tab is open, which also feeds "live users" on /admin.
export const GET = handle(async (_req, _ctx, user) => {
  await touchPresence(user);
  return Response.json({ user: { email: user.email, isStaff: user.isStaff, isAdmin: user.isAdmin } });
});

// Sign out: clears the session cookie.
export const DELETE = handle(async () => {
  const supabase = await authClient();
  await supabase.auth.signOut();
  return new Response(null, { status: 204 });
});
