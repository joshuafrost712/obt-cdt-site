/**
 * Supabase client singleton. This module lives only inside the lazy-loaded
 * backend chunk (the /account, /events, /certificates pages), so the main
 * bundle and the SSR prerender never import supabase-js.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { SUPABASE_ANON_KEY, SUPABASE_URL } from './config'

let client: SupabaseClient | null = null

export function supabase(): SupabaseClient {
  if (!client) {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      throw new Error('Backend is not configured (VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY unset)')
    }
    client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  }
  return client
}
