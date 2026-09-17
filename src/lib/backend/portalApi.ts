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

/**
 * The manual import, spec SITE-14. Both calls below are RPCs rather than table
 * writes because `publication` grants INSERT to nobody and `member_allowlist`
 * grants SELECT to nobody: measured, not assumed. A client cannot reach either
 * one directly, which is the design and not an obstacle.
 */
export interface ResolvedRecipient {
  normalized_email: string
  attested_name: string | null
  on_allowlist: boolean
  has_account: boolean
}

/**
 * Who does this address belong to? Called before the write, never instead of it.
 *
 * The hazard this exists for is not an attacker: it is a well-formed address
 * typed for the wrong person, which every standard in SITE-14's brief leaves to
 * the application. RLS would faithfully deliver a mis-addressed report to
 * whoever eventually registers with that address, and every access would pass
 * authorization legitimately.
 */
export async function resolveImportRecipient(email: string): Promise<ResolvedRecipient | null> {
  const { data, error } = await supabase().rpc('resolve_import_recipient', { _email: email })
  if (error) throw new Error(error.message)
  const rows = (data ?? []) as ResolvedRecipient[]
  return rows[0] ?? null
}

export interface ManualImport {
  recipientEmail: string
  documentId: string
  title: string
  workshopName: string
  dateLabel: string
  bodyMd: string
  eventId: string | null
}

/**
 * Note what is NOT in the argument list: `source`, `imported_by` and
 * `recipient_role`. The function writes all three itself, so a manual row can
 * never claim to have been signed. SITE-14 criterion 3 asserts their absence
 * against the live signature rather than against this type.
 */
export async function importPublicationManual(input: ManualImport): Promise<string> {
  const { data, error } = await supabase().rpc('import_publication_manual', {
    _recipient_email: input.recipientEmail,
    _document_id: input.documentId,
    _title: input.title,
    _workshop_name: input.workshopName,
    _date_label: input.dateLabel,
    _body_md: input.bodyMd,
    _event_id: input.eventId,
  })
  if (error) throw new Error(error.message)
  return data as string
}

export interface PortalEvent {
  id: string
  title: string
}

/**
 * The column is `title`, read from `information_schema.columns` in the build
 * session. Program finding 71 is why that was checked rather than assumed: a
 * helper selecting a column the live table does not have fails with a PostgREST
 * 400 the moment anything routed calls it, and the first draft of this helper
 * said `name`.
 */
export async function listEvents(): Promise<PortalEvent[]> {
  const { data, error } = await supabase().from('events').select('id, title').order('id')
  if (error) throw new Error(error.message)
  return (data ?? []) as PortalEvent[]
}
