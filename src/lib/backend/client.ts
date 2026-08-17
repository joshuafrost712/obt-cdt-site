/**
 * Supabase client singleton. This module lives only inside the lazy-loaded
 * portal chunk, so the main bundle and the SSR prerender never import
 * supabase-js.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from './config'

let client: SupabaseClient | null = null

export function supabase(): SupabaseClient {
  if (!client) {
    if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
      throw new Error('Backend is not configured (VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY unset)')
    }
    client = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY)
  }
  return client
}
