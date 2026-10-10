import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Server-only Supabase client using the secret (service-role) key. Tables have
// RLS enabled with no policies, so this is the only way in — never import this
// file from client components.

let client: SupabaseClient | null = null;

export const UPLOAD_BUCKET = "audit-uploads";

export function db(): SupabaseClient {
  if (client) return client;
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "Supabase is not configured: set SUPABASE_URL and SUPABASE_SECRET_KEY in .env.local (see .env.example).",
    );
  }
  client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: retryingFetch } });
  return client;
}

// Node's fetch reuses keep-alive sockets; after a quiet spell (e.g. a 30 s push
// test) Supabase may already have closed one and the next call dies with
// "TypeError: fetch failed" before reaching the server. Network errors only
// (never HTTP responses) are retried on a fresh connection.
async function retryingFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetch(input, init);
    } catch (e) {
      if (attempt >= 2 || !(e instanceof TypeError) || init?.signal?.aborted) throw e;
      await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
    }
  }
}
