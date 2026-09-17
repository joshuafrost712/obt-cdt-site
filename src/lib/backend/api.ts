/**
 * Typed data access for the accounts backend.
 *
 * PARTLY DORMANT, and the split matters to anyone editing this file. `getProfile`
 * and `updateProfile` are LIVE: SITE-12 routed `/portal/account` and both run on
 * every visit to it, against the real `public.profiles`. Everything below them
 * that touches `registrations`, `events` or `certificates` is dormant, written
 * against `supabase/schema.sql`'s fresh-project design; the live portal project
 * has none of those tables, so calling one returns a PostgREST "table not found".
 *
 * The whole-file DORMANT header this replaced was written when nothing here was
 * routed. It survived SITE-12 unchanged and read as if the live helpers were
 * dead too, which the build's shadow review flagged on 2026-09-17.
 *
 * `listMyEvaluations` and `EvaluationRow` were removed in the same pass: their
 * only caller was the account page SITE-12 rewrote, and an export whose one
 * caller was deleted is dead code, not a reserve. `/portal/evaluations` is
 * SITE-02's surface and has its own helpers in `evalApi.ts`.
 *
 * RLS is not the only thing narrowing these reads; see `getProfile`.
 */
import { supabase } from './client'

/**
 * The live `public.profiles` table is `id, email, full_name, org, created_at`.
 *
 * There is NO `role` column and there never was on this project: it belongs to
 * `supabase/schema.sql`'s fresh-project design, which nobody built. `getProfile`
 * selected it anyway, so the helper would have failed with a PostgREST 400 the
 * first time any routed screen called it (SITE-12 D5; measured 2026-09-11 and
 * again 2026-09-17, count 0 in information_schema.columns). SITE-12's criterion
 * 11 asserts the selected set is a SUBSET of the live columns, so this cannot
 * rot back.
 */
export interface Profile {
  id: string
  full_name: string
  org: string
}

export interface EventRow {
  id: string
  title: string
  location: string
  start_date: string | null
  end_date: string | null
  status: 'open' | 'fully-booked' | 'completed' | 'cancelled'
  description: string
}

export interface Registration {
  id: string
  event_id: string
  status: 'registered' | 'waitlist' | 'attended' | 'cancelled'
}

export interface CertificateRow {
  id: string
  issued_at: string
  events: { id: string; title: string; location: string; start_date: string | null; end_date: string | null } | null
}

export async function getProfile(userId: string): Promise<Profile | null> {
  // `.eq('id', userId)` names the subject explicitly and is NOT decoration.
  // `may_see_profile()` admits the owner, assignment counterparties, the head
  // mentor and the portal administrator, so RLS alone returns every row the
  // caller may see rather than one. A screen saying "your name" that trusted
  // RLS to have narrowed the set would show an administrator someone else's.
  // SITE-12 criterion 4 and its mutation 2; the read shape is pinned by D6,
  // because `.maybeSingle()` is what makes a broken filter observable.
  const { data, error } = await supabase().from('profiles').select('id, full_name, org').eq('id', userId).maybeSingle()
  if (error) throw error
  return data
}

export async function updateProfile(userId: string, patch: Pick<Profile, 'full_name' | 'org'>): Promise<void> {
  const { error } = await supabase().from('profiles').update(patch).eq('id', userId)
  if (error) throw error
}

export async function listEvents(): Promise<EventRow[]> {
  const { data, error } = await supabase()
    .from('events')
    .select('id, title, location, start_date, end_date, status, description')
    .order('start_date', { ascending: true })
  if (error) throw error
  return data ?? []
}

export async function listMyRegistrations(userId: string): Promise<Registration[]> {
  const { data, error } = await supabase()
    .from('registrations')
    .select('id, event_id, status')
    .eq('profile_id', userId)
  if (error) throw error
  return data ?? []
}

/** Register for an open event, or join the waitlist of a fully booked one. */
export async function register(userId: string, event: EventRow): Promise<void> {
  const status = event.status === 'fully-booked' ? 'waitlist' : 'registered'
  const { error } = await supabase()
    .from('registrations')
    .insert({ profile_id: userId, event_id: event.id, status })
  if (error) throw error
}

export async function cancelRegistration(registrationId: string): Promise<void> {
  const { error } = await supabase().from('registrations').update({ status: 'cancelled' }).eq('id', registrationId)
  if (error) throw error
}

export async function listMyCertificates(userId: string): Promise<CertificateRow[]> {
  const { data, error } = await supabase()
    .from('certificates')
    .select('id, issued_at, events (id, title, location, start_date, end_date)')
    .eq('profile_id', userId)
    .order('issued_at', { ascending: false })
  if (error) throw error
  return (data ?? []) as unknown as CertificateRow[]
}
