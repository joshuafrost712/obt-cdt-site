/**
 * The portal's whole data surface: a member's own published reports.
 *
 * Note what is NOT here. There is no `.eq('profile_id', ...)` anywhere below,
 * and that is deliberate rather than an omission. RLS on `publication` is the
 * filter; a client-side one would be, at best, redundant, and at worst a second
 * rule that disagrees with the first and hides the disagreement. The client does
 * not know its own profile id and must not need to.
 */
import { supabase } from './client'

export interface PortalReportRow {
  id: string
  event_id: string | null
  workshop_name: string
  title: string
  subject: string
  date_label: string
  sent_at: string | null
  revision: number
  superseded_by: string | null
  source: 'signed' | 'manual'
}

export interface PortalReport extends PortalReportRow {
  body_md: string
}

const LIST_COLUMNS =
  'id, event_id, workshop_name, title, subject, date_label, sent_at, revision, superseded_by, source'

export async function listMyReports(): Promise<PortalReportRow[]> {
  const { data, error } = await supabase()
    .from('publication')
    .select(LIST_COLUMNS)
    .order('sent_at', { ascending: false, nullsFirst: false })
  if (error) throw new Error(error.message)
  return (data ?? []) as PortalReportRow[]
}

/**
 * Returns null when there is no such report FOR THIS READER — which covers both
 * "no such row" and "a row exists and RLS filtered it". Those are indistinguishable
 * on the wire by design (a denied read is a 200 with an empty result, not an
 * error), so the caller must render "no report with that link is in your record"
 * rather than "something went wrong".
 */
export async function getMyReport(id: string): Promise<PortalReport | null> {
  const { data, error } = await supabase()
    .from('publication')
    .select(`${LIST_COLUMNS}, body_md`)
    .eq('id', id)
    .maybeSingle()
  if (error) throw new Error(error.message)
  return (data as PortalReport | null) ?? null
}
