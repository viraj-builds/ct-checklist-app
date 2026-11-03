import "server-only";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";

// ---------------------------------------------------------------------------
// Session handling. Users sign in with an email magic link (Supabase Auth).
// Everyone — staff or customer — only sees the audits they created. Admins
// (verified email listed in ADMIN_EMAILS) can open any audit and see /admin.
// Staff = verified email on one of STAFF_EMAIL_DOMAINS (default clevertap.com):
// a label plus a higher create quota.
// ---------------------------------------------------------------------------

export interface SessionUser {
  id: string;
  email: string;
  isStaff: boolean;
  isAdmin: boolean;
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

const adminEmails = () =>
  (process.env.ADMIN_EMAILS ?? "viraj.walavalkar@clevertap.com")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

export function isAdminEmail(email: string) {
  return adminEmails().includes(email.toLowerCase());
}

/** Verified user for this request, or null. getUser() re-validates the JWT with Supabase Auth. */
export async function currentUser(): Promise<SessionUser | null> {
  const supabase = await authClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user?.email) return null;
  const confirmed = !!data.user.email_confirmed_at;
  const email = data.user.email;
  return {
    id: data.user.id,
    email,
    isStaff: confirmed && isStaffEmail(email),
    isAdmin: confirmed && isAdminEmail(email),
  };
}
