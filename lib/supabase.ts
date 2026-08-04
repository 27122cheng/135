import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let serverClient: SupabaseClient | null | undefined;
let anonClient: SupabaseClient | null | undefined;

/** Server-side client using the service role key — required to write to `signals` (RLS blocks anon writes). */
export function getSupabaseServerClient(): SupabaseClient | null {
  if (serverClient !== undefined) return serverClient;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  serverClient = url && key ? createClient(url, key, { auth: { persistSession: false } }) : null;
  return serverClient;
}

/** Read-only client using the anon key — safe for the public history page. */
export function getSupabaseAnonClient(): SupabaseClient | null {
  if (anonClient !== undefined) return anonClient;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  anonClient = url && key ? createClient(url, key, { auth: { persistSession: false } }) : null;
  return anonClient;
}
