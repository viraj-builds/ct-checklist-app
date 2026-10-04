import { handle } from "@/lib/server/http";
import { authClient } from "@/lib/server/auth";

// Who is signed in (for the sidebar).
export const GET = handle(async (_req, _ctx, user) => Response.json({ user }));

// Sign out: clears the session cookie.
export const DELETE = handle(async () => {
  const supabase = await authClient();
  await supabase.auth.signOut();
  return new Response(null, { status: 204 });
});
