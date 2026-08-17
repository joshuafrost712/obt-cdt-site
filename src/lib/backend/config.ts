/**
 * Backend feature flag (Throughline pattern): the portal activates only when a
 * Supabase project is provisioned and both env vars are set at build time (as
 * repo Actions variables, or in .env.local for dev). With them unset the site
 * builds fully static: no /portal route, no nav entry, no supabase in any
 * loaded chunk.
 *
 * This module must stay dependency-free (no supabase import) — it is the only
 * backend file the main bundle and the SSR prerender ever touch.
 *
 * Two names for the key, on purpose. Supabase's dashboard now issues
 * `sb_publishable_...` keys and calls the old `anon` JWT legacy, so an
 * administrator reading the dashboard in 2027 will be looking for the word
 * "publishable" and will not find "anon" anywhere on the page. The portal's key
 * is a publishable one; VITE_SUPABASE_ANON_KEY still works so that an existing
 * Actions variable, or docs/PHASE-2-BACKEND.md, does not silently disable the
 * backend. Either key type is safe in the bundle: both carry the `anon` role and
 * RLS is what actually decides who reads what.
 */
export const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined

export const SUPABASE_PUBLISHABLE_KEY = (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ??
  import.meta.env.VITE_SUPABASE_ANON_KEY) as string | undefined

export const backendEnabled: boolean = Boolean(SUPABASE_URL && SUPABASE_PUBLISHABLE_KEY)
