"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { createBrowserClient } from "@supabase/ssr";
import { Card, Button } from "@/components/ui";
import { Icon } from "@/components/Icon";

export default function LoginPage() {
  return (
    <Suspense>
      <Login />
    </Suspense>
  );
}

function Login() {
  const params = useSearchParams();
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const [error, setError] = useState(params.get("error") === "link" ? "That sign-in link is invalid or has expired. Request a new one." : "");

  const client = () =>
    createBrowserClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!);
  const callbackUrl = () =>
    `${window.location.origin}/auth/callback?next=${encodeURIComponent(params.get("next") ?? "/")}`;

  async function google() {
    setError("");
    const { error } = await client().auth.signInWithOAuth({ provider: "google", options: { redirectTo: callbackUrl() } });
    if (error) setError(/not enabled|unsupported provider/i.test(error.message) ? "Google sign-in isn't set up yet — use the email link." : error.message);
  }

  async function send(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setState("sending");
    const { error } = await client().auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: callbackUrl() },
    });
    if (error) {
      setState("idle");
      setError(/rate limit/i.test(error.message) ? "Too many sign-in emails were sent. Please wait a few minutes." : error.message);
    } else setState("sent");
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-md p-8">
        <div className="flex items-center gap-2.5">
          <span className="flex h-10 w-10 items-center justify-center rounded-[10px] bg-[var(--text)] text-[var(--surface)]">
            <Icon name="check" size={22} strokeWidth={2.6} />
          </span>
          <div className="leading-tight">
            <div className="text-base font-bold">Integration Audit</div>
            <div className="text-sm text-muted">for CleverTap</div>
          </div>
        </div>

        {state === "sent" ? (
          <div className="mt-6">
            <h1 className="text-2xl font-bold">Check your inbox</h1>
            <p className="mt-2 text-[15px] text-muted">
              We sent a sign-in link to <b className="text-text">{email}</b>. Open it on this device to continue.
            </p>
            <button onClick={() => setState("idle")} className="link mt-5 text-sm">
              Use a different email
            </button>
          </div>
        ) : (
          <form onSubmit={send} className="mt-7 space-y-5">
            <div>
              <h1 className="text-2xl font-bold">Sign in</h1>
              <p className="mt-1 text-[15px] text-muted">No password needed.</p>
            </div>
            <button
              type="button"
              onClick={google}
              className="flex min-h-12 w-full items-center justify-center gap-2.5 rounded-[10px] border border-[var(--border-strong)] bg-surface px-4 text-[15px] font-bold transition hover:bg-surface-2"
            >
              <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden>
                <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
                <path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
                <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
                <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
              </svg>
              Continue with Google
            </button>
            <div className="flex items-center gap-3 text-[13px] text-muted">
              <span className="h-px flex-1 bg-[var(--border)]" /> or email me a link <span className="h-px flex-1 bg-[var(--border)]" />
            </div>
            <label className="block">
              <span className="mb-1.5 block text-sm font-bold">Work email</span>
              <input
                type="email"
                required
                autoFocus
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
                className="input"
              />
            </label>
            {error && (
              <p className="rounded-xl border px-4 py-3 text-sm" style={{ background: "var(--fail-soft)", borderColor: "var(--fail-border)" }}>
                {error}
              </p>
            )}
            <Button type="submit" size="lg" iconRight="arrowRight" disabled={state === "sending" || !email.includes("@")} className="w-full">
              {state === "sending" ? "Sending…" : "Email me a sign-in link"}
            </Button>
            <p className="text-[13px] text-muted">
              CleverTap engineers see every audit. Customers only see the audits they create.
            </p>
          </form>
        )}
      </Card>
    </div>
  );
}
