/**
 * Backend feature flag (Throughline pattern): the accounts backend activates
 * only when a Supabase project is provisioned and both env vars are set at
 * build time (VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY as repo Actions
 * variables, or in .env.local for dev). With them unset the site builds fully
 * static: no /account routes, no nav entry, no supabase in any loaded chunk.
 *
 * This module must stay dependency-free (no supabase import) — it is the only
 * backend file the main bundle and the SSR prerender ever touch.
 */
export const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined
export const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

export const backendEnabled: boolean = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY)
