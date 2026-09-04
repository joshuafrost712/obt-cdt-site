/**
 * The assessment spine's data surface: assignments, write-ups and their ratings.
 *
 * Spec CDT-02 D8. This module follows `portalApi.ts`'s doctrine verbatim, and the
 * two rules worth restating because they are what make it safe:
 *
 * **No client-side filter, anywhere.** There is no `.eq('consultant_profile_id',
 * ...)` below. RLS is the filter: `may_see_assignment()` and
 * `may_see_submission()` decide what a reader gets, and a second rule in the
 * browser would be redundant at best and, at worst, a rule that disagrees with
 * the server's and hides the disagreement. The client does not know its own
 * profile id and must not need to.
 *
 * **A denied read and a missing row are indistinguishable.** Postgres returns a
 * 200 with an empty result for a row RLS filtered, not an error. So every
 * single-row getter here returns `null` for both cases, and callers must render
 * "not in your record" rather than "not found" — the difference is not knowable
 * on the wire, and pretending otherwise leaks whether a row exists.
 *
 * Two more constraints from the spec:
 *
 * - Writes that carry a rule go through an RPC, never a table write. Creating an
 *   assignment, approving and returning a write-up, and changing the approval
 *   mode are all `rpc()` calls, because each is gated on `is_portal_admin()` or
 *   `is_head_mentor()` inside the database. The table grants deliberately do not
 *   permit them: `assignment` has no insert grant for any client role.
 * - It imports the client singleton from `./client` and never constructs a second
 *   one. It adds no import to `./config`.
 *
 * `AuthGate` from `src/pages/backend/shared.tsx` is the reuse for the sign-in
 * boundary. There is no `SignInCard` export there, so nothing here presumes one.
 */
import { supabase } from './client'
// Spec SITE-02: lifted out of this file so `evalApi.ts` shares the mitigation
// rather than reimplementing it. The reasoning lives in retry.ts.
import { retryIfTooNew } from './retry'

// ---------------------------------------------------------------- row types

export type AssignmentState =
  | 'proposed'
  | 'scheduled'
  | 'held'
  | 'submitted'
  | 'returned'
  | 'closed'
  | 'cancelled'

export type RatingRole = 'primary' | 'second'

export type ApprovalState =
  | 'awaiting-head-mentor'
  | 'auto-accepted'
  | 'approved'
  | 'returned'

export interface AssessmentBundle {
  bundle_key: string
  name: string
  format: string
  minutes: number
  prep_minutes: number
  writeup_minutes: number
  ordinal: number
  active: boolean
}

export interface BundleUnit {
  bundle_key: string
  unit_key: string
  is_primary: boolean
}

export interface AssignmentRow {
  id: string
  subject_profile_id: string
  consultant_profile_id: string
  bundle_key: string
  state: AssignmentState
  scheduled_at: string | null
  meeting_language: string | null
  subject_l1: boolean | null
  meeting_url: string | null
  qualification_basis: string
  rating_role: RatingRole
  second_of: string | null
  created_at: string
}

export interface AssignmentEventRow {
  id: number
  assignment_id: string
  kind: 'created' | 'state-changed' | 'rescheduled' | 'meeting-url-set' | 'language-set'
  detail: Record<string, unknown>
  actor: string | null
  at: string
}

export interface SubmissionRow {
  id: string
  assignment_id: string
  bundle_key: string
  consultant_profile_id: string
  body_md: string
  strength_note: string | null
  growth_note_1: string | null
  growth_note_2: string | null
  context_note: string | null
  connection_quality: 'good' | 'patchy' | 'poor' | null
  consent_recorded: boolean
  transcript_source: 'manual-upload' | 'none'
  submitted_at: string | null
  released_at: string | null
  approval_state: ApprovalState
  approved_at: string | null
  return_reason: string | null
}

export interface SubmissionRatingRow {
  submission_id: string
  bundle_key: string
  unit_key: string
  observed_level: 0 | 1 | 2 | 3
  recommended_level: 0 | 1 | 2 | 3
  confidence: 'low' | 'medium' | 'high'
  evidence_sentence: string
  plain_language_check: 'yes' | 'partly' | 'no'
  plain_language_note: string | null
  escalate: boolean
}

// Column lists rather than `*`, so a column added later does not silently start
// crossing the wire. This mirrors portalApi.ts's LIST_COLUMNS.
// Each of these is ONE string literal, deliberately, even though it makes for a
// long line. supabase-js infers the row type from the literal passed to
// `.select()`, and a concatenated string is not a literal type, so splitting these
// across `+` makes every result `GenericStringError[]` and every cast a TS2352.
// portalApi.ts's LIST_COLUMNS is a single literal for the same reason.
const ASSIGNMENT_COLUMNS =
  'id, subject_profile_id, consultant_profile_id, bundle_key, state, scheduled_at, meeting_language, subject_l1, meeting_url, qualification_basis, rating_role, second_of, created_at'

const SUBMISSION_COLUMNS =
  'id, assignment_id, bundle_key, consultant_profile_id, body_md, strength_note, growth_note_1, growth_note_2, context_note, connection_quality, consent_recorded, transcript_source, submitted_at, released_at, approval_state, approved_at, return_reason'

const RATING_COLUMNS =
  'submission_id, bundle_key, unit_key, observed_level, recommended_level, confidence, evidence_sentence, plain_language_check, plain_language_note, escalate'

// ------------------------------------------------------------- the instrument
//
// The four occasions and their unit membership. Readable by every signed-in user
// by design: a CIT must be able to read the instrument they sit.

export async function listBundles(): Promise<AssessmentBundle[]> {
  const { data, error } = await supabase()
    .from('assessment_bundle')
    .select('bundle_key, name, format, minutes, prep_minutes, writeup_minutes, ordinal, active')
    .order('ordinal')
  if (error) throw new Error(error.message)
  return (data ?? []) as AssessmentBundle[]
}

export async function listBundleUnits(bundleKey: string): Promise<BundleUnit[]> {
  // `bundleKey` is an argument, not a reader identity: narrowing to one bundle is
  // the caller's question, not an access rule. The access rule is the policy.
  const { data, error } = await supabase()
    .from('bundle_unit')
    .select('bundle_key, unit_key, is_primary')
    .eq('bundle_key', bundleKey)
    .order('unit_key')
  if (error) throw new Error(error.message)
  return (data ?? []) as BundleUnit[]
}

// ------------------------------------------------------------- assignments

export async function listMyAssignments(): Promise<AssignmentRow[]> {
  return retryIfTooNew(async () => {
    const { data, error } = await supabase()
      .from('assignment')
      .select(ASSIGNMENT_COLUMNS)
      .order('scheduled_at', { ascending: true, nullsFirst: false })
    if (error) throw new Error(error.message)
    return (data ?? []) as AssignmentRow[]
  })
}

/** Null covers both "no such assignment" and "one exists and RLS filtered it". */
export async function getAssignment(id: string): Promise<AssignmentRow | null> {
  return retryIfTooNew(async () => {
    const { data, error } = await supabase()
      .from('assignment')
      .select(ASSIGNMENT_COLUMNS)
      .eq('id', id)
      .maybeSingle()
    if (error) throw new Error(error.message)
    return (data ?? null) as AssignmentRow | null
  })
}

export async function listAssignmentEvents(assignmentId: string): Promise<AssignmentEventRow[]> {
  const { data, error } = await supabase()
    .from('assignment_event')
    .select('id, assignment_id, kind, detail, actor, at')
    .eq('assignment_id', assignmentId)
    .order('at', { ascending: true })
  if (error) throw new Error(error.message)
  return (data ?? []) as AssignmentEventRow[]
}

/**
 * Only the four columns `assignment` grants update on: state, scheduled_at,
 * meeting_url, meeting_language. Anything else is refused by the column grant
 * with 42501 before RLS is consulted, and the state graph is enforced by
 * `assignment_change_guard`, so an illegal transition raises rather than saving.
 */
export async function updateAssignmentSchedule(
  id: string,
  patch: {
    state?: AssignmentState
    scheduled_at?: string | null
    meeting_url?: string | null
    meeting_language?: string | null
  },
): Promise<void> {
  const { error } = await supabase().from('assignment').update(patch).eq('id', id)
  if (error) throw new Error(error.message)
}

/**
 * Admin/head-mentor only, and gated inside the database rather than here. The
 * qualification rule runs twice on this call: once in the RPC's own insert and
 * again in `assignment_qualification_guard`. A consultant calling it is refused
 * with 42501.
 */
export async function createAssignment(args: {
  subject: string
  consultant: string
  bundleKey: string
  qualificationBasis: string
  ratingRole?: RatingRole
  secondOf?: string | null
}): Promise<string> {
  const { data, error } = await supabase().rpc('create_assignment', {
    _subject: args.subject,
    _consultant: args.consultant,
    _bundle_key: args.bundleKey,
    _qualification_basis: args.qualificationBasis,
    _rating_role: args.ratingRole ?? 'primary',
    _second_of: args.secondOf ?? null,
  })
  if (error) throw new Error(error.message)
  return data as string
}

// ------------------------------------------------------------- the write-up

export async function listMySubmissions(): Promise<SubmissionRow[]> {
  const { data, error } = await supabase()
    .from('submission')
    .select(SUBMISSION_COLUMNS)
    .order('submitted_at', { ascending: false, nullsFirst: false })
  if (error) throw new Error(error.message)
  return (data ?? []) as SubmissionRow[]
}

/**
 * Null covers three cases here, not two: no such write-up, one that RLS filtered
 * because the reader is neither its author nor oversight, and one whose subject
 * is the reader but which has not been released. The third is the important one:
 * a CIT gets null until `released_at` is set, because a rating that reaches CBC
 * has to have been shown to the person first.
 */
export async function getSubmission(id: string): Promise<SubmissionRow | null> {
  const { data, error } = await supabase()
    .from('submission')
    .select(SUBMISSION_COLUMNS)
    .eq('id', id)
    .maybeSingle()
  if (error) throw new Error(error.message)
  return (data ?? null) as SubmissionRow | null
}

/**
 * `consent_recorded` is required because the column has no default: absence
 * cannot mean yes. Omitting it raises 23502 rather than storing a false.
 *
 * `approval_state` is not a parameter and cannot be one: it is outside the
 * granted columns, and a BEFORE INSERT trigger sets it from
 * `approval_state_for()`. A caller that passed one would be ignored, so the type
 * does not offer it.
 */
export async function createSubmission(args: {
  assignmentId: string
  bundleKey: string
  consentRecorded: boolean
  bodyMd?: string
  strengthNote?: string | null
  growthNote1?: string | null
  growthNote2?: string | null
  contextNote?: string | null
  connectionQuality?: 'good' | 'patchy' | 'poor' | null
  transcriptSource?: 'manual-upload' | 'none'
}): Promise<string> {
  const { data, error } = await supabase()
    .from('submission')
    .insert({
      assignment_id: args.assignmentId,
      bundle_key: args.bundleKey,
      consent_recorded: args.consentRecorded,
      body_md: args.bodyMd ?? '',
      strength_note: args.strengthNote ?? null,
      growth_note_1: args.growthNote1 ?? null,
      growth_note_2: args.growthNote2 ?? null,
      context_note: args.contextNote ?? null,
      connection_quality: args.connectionQuality ?? null,
      transcript_source: args.transcriptSource ?? 'none',
    })
    .select('id')
    .single()
  if (error) throw new Error(error.message)
  return (data as { id: string }).id
}

export async function listRatings(submissionId: string): Promise<SubmissionRatingRow[]> {
  const { data, error } = await supabase()
    .from('submission_rating')
    .select(RATING_COLUMNS)
    .eq('submission_id', submissionId)
    .order('unit_key')
  if (error) throw new Error(error.message)
  return (data ?? []) as SubmissionRatingRow[]
}

/**
 * A rating cannot escape its bundle: two composite foreign keys tie
 * `(submission_id, bundle_key)` to the write-up and `(bundle_key, unit_key)` to
 * `bundle_unit`, so a unit outside the assignment's bundle raises 23503. That is
 * why `bundleKey` is a required argument rather than something this function
 * looks up: the constraint wants it on the row.
 */
export async function upsertRatings(
  rows: Array<Omit<SubmissionRatingRow, 'escalate' | 'plain_language_note'> &
    Partial<Pick<SubmissionRatingRow, 'escalate' | 'plain_language_note'>>>,
): Promise<void> {
  const { error } = await supabase()
    .from('submission_rating')
    .upsert(
      rows.map((r) => ({
        submission_id: r.submission_id,
        bundle_key: r.bundle_key,
        unit_key: r.unit_key,
        observed_level: r.observed_level,
        recommended_level: r.recommended_level,
        confidence: r.confidence,
        evidence_sentence: r.evidence_sentence,
        plain_language_check: r.plain_language_check,
        plain_language_note: r.plain_language_note ?? null,
        escalate: r.escalate ?? false,
      })),
      { onConflict: 'submission_id,unit_key' },
    )
  if (error) throw new Error(error.message)
}

/** Release to the subject. Until this is set the CIT reads nothing. */
export async function releaseSubmission(id: string): Promise<void> {
  const { error } = await supabase()
    .from('submission')
    .update({ released_at: new Date().toISOString() })
    .eq('id', id)
  if (error) throw new Error(error.message)
}

export async function markSubmitted(id: string): Promise<void> {
  const { error } = await supabase()
    .from('submission')
    .update({ submitted_at: new Date().toISOString() })
    .eq('id', id)
  if (error) throw new Error(error.message)
}

// ------------------------------------------------------- head mentor only
//
// Both are gated on `is_head_mentor()`, which carries the aal2 requirement. A
// head mentor whose session has not completed two-factor authentication is
// refused with 42501, and reads nothing anywhere in this module. That will look
// like a bug the first time it happens; it is the rule.

export async function approveSubmission(id: string): Promise<void> {
  const { error } = await supabase().rpc('approve_submission', { _submission_id: id })
  if (error) throw new Error(error.message)
}

export async function returnSubmission(id: string, reason: string): Promise<void> {
  const { error } = await supabase().rpc('return_submission', {
    _submission_id: id,
    _reason: reason,
  })
  if (error) throw new Error(error.message)
}

export async function setApprovalMode(mode: 'approve-all' | 'trust-mentors'): Promise<void> {
  const { error } = await supabase().rpc('set_platform_setting', {
    _key: 'head_mentor_approval_mode',
    _value: mode,
  })
  if (error) throw new Error(error.message)
}

// ###########################################################################
// Spec CDT-04's additions. This is CDT-02's module by ownership, so these live
// here rather than in a second API module: two modules against one schema is the
// two-code-systems failure the Web-App-Build-Protocol records.
// ###########################################################################

export interface ScalePoint {
  level: 0 | 1 | 2 | 3
  label: string
  definition: string
}

export interface UnitForForm {
  unit_key: string
  is_primary: boolean
  statement: string
  category_key: string
  sub_area: string | null
  descriptors: string[]
}

export interface CounterpartyProfile {
  id: string
  full_name: string
  email: string
  org: string
}

/**
 * The 0-3 anchors, from CDT-01's seeded registry. Never retyped into a
 * component: a correction goes into the vault matrix and the seed re-runs, and a
 * hard-coded copy here is a second definition that will drift from the one CBC
 * receives.
 */
export async function listScale(): Promise<ScalePoint[]> {
  const { data, error } = await supabase()
    .from('competency_scale')
    .select('level, label, definition')
    .order('level')
  if (error) throw new Error(error.message)
  return (data ?? []) as ScalePoint[]
}

/**
 * Every unit the form must render for a bundle, with its statement and its
 * component descriptors, in one round trip.
 *
 * `bundle_unit` carries foreign keys to both `assessment_bundle` and
 * `competency_unit`, and `unit_descriptor` to `competency_unit`, so PostgREST can
 * embed two levels down. All four tables read `using (true)`: a CIT must be able
 * to read the instrument they are sitting, so the registry is deliberately not
 * reader-scoped and this is not an over-fetch.
 *
 * Secondaries are included, per decision 4's stated default, and `is_primary`
 * comes back so the form can label them rather than hide them. A secondary
 * observed in passing is evidence that otherwise goes unrecorded.
 */
export async function listUnitsForBundle(bundleKey: string): Promise<UnitForForm[]> {
  const { data, error } = await supabase()
    .from('bundle_unit')
    .select(
      'unit_key, is_primary, competency_unit(statement, category_key, sub_area, ordinal, unit_descriptor(ordinal, text))',
    )
    .eq('bundle_key', bundleKey)
  if (error) throw new Error(error.message)

  type Embedded = {
    unit_key: string
    is_primary: boolean
    competency_unit: {
      statement: string
      category_key: string
      sub_area: string | null
      ordinal: number
      unit_descriptor: { ordinal: number; text: string }[]
    } | null
  }

  return ((data ?? []) as unknown as Embedded[])
    .map((r) => ({
      unit_key: r.unit_key,
      is_primary: r.is_primary,
      statement: r.competency_unit?.statement ?? '',
      category_key: r.competency_unit?.category_key ?? '',
      sub_area: r.competency_unit?.sub_area ?? null,
      ordinal: r.competency_unit?.ordinal ?? 0,
      descriptors: (r.competency_unit?.unit_descriptor ?? [])
        .slice()
        .sort((a, b) => a.ordinal - b.ordinal)
        .map((d) => d.text),
    }))
    // The registry's own order, not the unit_key string order: U9 sorts after U10
    // as text, and a form whose units are out of the matrix's order is a form a
    // consultant cannot check against the paper instrument.
    .sort((a, b) => a.ordinal - b.ordinal)
    .map(({ ordinal: _ordinal, ...unit }) => unit)
}

/**
 * The other party to an assignment: the CIT for a consultant, the consultant for
 * a CIT. Returns null for both "no such profile" and "RLS filtered it", which
 * here means the reader shares no assignment with them.
 *
 * This read is why `20260909120100_profile_counterparty_read.sql` exists. Before
 * it, `profiles` was `using (auth.uid() = id)` and a consultant could not learn
 * the name of the person they were assessing.
 */
export async function getCounterparty(profileId: string): Promise<CounterpartyProfile | null> {
  const { data, error } = await supabase()
    .from('profiles')
    .select('id, full_name, email, org')
    .eq('id', profileId)
    .maybeSingle()
  if (error) throw new Error(error.message)
  return (data ?? null) as CounterpartyProfile | null
}

/** The CIT's enrolment facts a consultant needs before the call. */
export async function getEnrollment(
  profileId: string,
): Promise<{ assessment_language: string | null; note: string; cohort_event_id: string | null } | null> {
  const { data, error } = await supabase()
    .from('cit_enrollment')
    .select('assessment_language, note, cohort_event_id')
    .eq('profile_id', profileId)
    .maybeSingle()
  if (error) throw new Error(error.message)
  return (data ?? null) as { assessment_language: string | null; note: string; cohort_event_id: string | null } | null
}

/**
 * The write-up already filed against an assignment, if the reader may see it.
 *
 * Null is three cases and the page must not distinguish them: none filed, one
 * filed by someone else for the same CIT (a second rater — deliberately blind),
 * and one filed for a CIT who has not had it released. `may_see_submission()`
 * decides, and the difference is not knowable on the wire.
 */
export async function getSubmissionForAssignment(assignmentId: string): Promise<SubmissionRow | null> {
  const { data, error } = await supabase()
    .from('submission')
    .select(SUBMISSION_COLUMNS)
    .eq('assignment_id', assignmentId)
    .maybeSingle()
  if (error) throw new Error(error.message)
  return (data ?? null) as SubmissionRow | null
}

export interface WriteupRating {
  unit_key: string
  observed_level: 0 | 1 | 2 | 3
  recommended_level: 0 | 1 | 2 | 3
  confidence: 'low' | 'medium' | 'high'
  evidence_sentence: string
  plain_language_check: 'yes' | 'partly' | 'no'
  plain_language_note?: string | null
  escalate?: boolean
}

/**
 * File a write-up in ONE call. `20260909120000_writeup_submit.sql`.
 *
 * The reason this is an RPC and not three table writes is that PostgREST gives
 * the client no transaction. Insert `submission`, then `submission_rating`, then
 * `submission_file`, and a failure between the first and second leaves a write-up
 * that exists and says nothing, permanently reachable in the table the head
 * mentor's queue reads.
 *
 * The RPC also holds the coverage gate: a write-up rates every unit in its
 * bundle or it is refused. That check cannot live in this file, because a rule
 * enforced in the browser is a courtesy.
 *
 * `consentRecorded` is required rather than defaulted, all the way down: the
 * column has no default precisely so that absence cannot mean yes.
 */
export async function submitWriteup(args: {
  assignmentId: string
  consentRecorded: boolean
  bodyMd?: string
  strengthNote?: string | null
  growthNote1?: string | null
  growthNote2?: string | null
  contextNote?: string | null
  connectionQuality?: 'good' | 'patchy' | 'poor' | null
  transcriptSource?: 'manual-upload' | 'none'
  ratings: WriteupRating[]
  sourceUrl?: string | null
}): Promise<string> {
  const { data, error } = await supabase().rpc('submit_writeup', {
    _assignment: args.assignmentId,
    _submission: {
      body_md: args.bodyMd ?? '',
      strength_note: args.strengthNote ?? null,
      growth_note_1: args.growthNote1 ?? null,
      growth_note_2: args.growthNote2 ?? null,
      context_note: args.contextNote ?? null,
      connection_quality: args.connectionQuality ?? null,
      consent_recorded: args.consentRecorded,
      transcript_source: args.transcriptSource ?? 'none',
    },
    _ratings: args.ratings,
    _file: args.sourceUrl
      ? { kind: 'writeup', source_url: args.sourceUrl, filename: 'write-up (external document)' }
      : null,
  })
  if (error) throw new Error(error.message)
  return data as string
}
