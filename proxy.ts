import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

// Refreshes the Supabase session cookie on every request and sends signed-out
// visitors to /login. API routes do their own 401 check (lib/server/http.ts).

const PUBLIC_PAGES = ["/login", "/auth/callback", "/checklist", "/faq"];

export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (list) => {
          for (const { name, value } of list) request.cookies.set(name, value);
          response = NextResponse.next({ request });
          for (const { name, value, options } of list) response.cookies.set(name, value, options);
        },
      },
    },
  );

  const { data } = await supabase.auth.getUser();
  const path = request.nextUrl.pathname;
  const isApi = path.startsWith("/api/");
  const isPublic = PUBLIC_PAGES.some((p) => path === p || path.startsWith(p + "/"));

  if (!data.user && !isApi && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = `?next=${encodeURIComponent(path + request.nextUrl.search)}`;
    return NextResponse.redirect(url);
  }
  return response;
}

export const config = {
  matcher: [
    // everything except static assets, the cron endpoint (it uses CRON_SECRET)
    // and the device helper, which is downloaded from a terminal with no session
    "/((?!_next/static|_next/image|favicon.ico|api/cron|ct-device-bridge\\.mjs|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff2?)$).*)",
  ],
};
