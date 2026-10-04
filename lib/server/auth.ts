import "server-only";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";

// ---------------------------------------------------------------------------
// Session handling. Users sign in with an email magic link (Supabase Auth).
// Staff = verified email on one of STAFF_EMAIL_DOMAINS (default clevertap.com):
// they can see every audit. Everyone else (customers) only sees their own.
// ---------------------------------------------------------------------------

export interface SessionUser {
  id: string;
  email: string;
  isStaff: boolean;
}

export async function authClient() {
  const store = await cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll: () => store.getAll(),
        setAll: (list) => {
          try {
            for (const { name, value, options } of list) store.set(name, value, options);
          } catch {
            /* called from a Server Component — the proxy refreshes cookies instead */
          }
        },
      },
    },
  );
}

const staffDomains = () =>
  (process.env.STAFF_EMAIL_DOMAINS ?? "clevertap.com")
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);

export function isStaffEmail(email: string) {
  const domain = email.toLowerCase().split("@")[1] ?? "";
  return staffDomains().includes(domain);
}

/** Verified user for this request, or null. getUser() re-validates the JWT with Supabase Auth. */
export async function currentUser(): Promise<SessionUser | null> {
  const supabase = await authClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user?.email) return null;
  const confirmed = !!data.user.email_confirmed_at;
  return { id: data.user.id, email: data.user.email, isStaff: confirmed && isStaffEmail(data.user.email) };
}
