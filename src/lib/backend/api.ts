/**
 * DORMANT — not routed, not reachable.
 *
 * Written against `supabase/schema.sql`'s fresh-project design (a `profiles`
 * table with a role column, plus `registrations` / `evaluations` /
 * `certificates`). The live portal project has none of those tables: it is a
 * reports-only portal whose schema lives in `supabase/migrations/`. Routing this
 * page would show a participant a raw PostgREST "table not found".
 *
 * Kept rather than deleted because docs/PHASE-2-BACKEND.md still describes this
 * design and a memo pointing at deleted files becomes archaeology. Bring it back
 * when event registration or certificates are actually built.
 */
/**
 * Typed data access for the accounts backend. Row shapes mirror
 * supabase/schema.sql; RLS guarantees every query below only ever returns the
 * signed-in user's own rows.
 */
import { supabase } from './client'

export interface Profile {
  id: string
  full_name: string
  org: string
  role: 'participant' | 'mentor' | 'admin'
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

export interface EvaluationRow {
  id: string
  score: number
  evaluator: string
  note: string
  occasion: string | null
  created_at: string
  ksas: { id: string; competency: string; label: string } | null
}

export interface CertificateRow {
  id: string
  issued_at: string
  events: { id: string; title: string; location: string; start_date: string | null; end_date: string | null } | null
}

export async function getProfile(userId: string): Promise<Profile | null> {
  const { data, error } = await supabase().from('profiles').select('id, full_name, org, role').eq('id', userId).maybeSingle()
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

export async function listMyEvaluations(userId: string): Promise<EvaluationRow[]> {
  const { data, error } = await supabase()
    .from('evaluations')
    .select('id, score, evaluator, note, occasion, created_at, ksas (id, competency, label)')
    .eq('profile_id', userId)
    .order('created_at', { ascending: true })
  if (error) throw error
  return (data ?? []) as unknown as EvaluationRow[]
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
