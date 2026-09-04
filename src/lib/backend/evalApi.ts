/**
 * The evaluation's data surface. Spec SITE-02.
 *
 * SITE-01 built the schema; this module reads it and calls its one write path.
 * Three rules from `portalApi.ts` and `assessApi.ts` carry over unchanged, and
 * they are what make a module this thin safe:
 *
 * **The reads name their subject, and that is NOT the client-side filter the
 * doctrine forbids.** `portalApi.ts` and `assessApi.ts` say RLS is the filter and
 * a second rule in the browser can only disagree with it. That is right where the
 * policy returns exactly the caller's rows, and it is FALSE here for two roles:
 * `response_read_own` is `profile_id = auth.uid() OR is_head_mentor() OR
 * is_portal_admin()`, so for the head mentor and the portal administrator — and
 * Joshua is the administrator — RLS returns a SUPERSET. Measured, not assumed:
 * `is_portal_admin()` carries no `aal2` clause on this project.
 *
 * Without naming the subject, `getMyAnswers`'s `.maybeSingle()` matches every
 * participant's response for those two and errors, `myRounds` lists other
 * people's memberships, and on a round with exactly one response `ClosedView`
 * would render somebody else's answers under "What you wrote". So these reads
 * pass `profileId` and say `.eq('profile_id', profileId)`. That is not a second
 * access rule — RLS still decides what may be returned — it is the query saying
 * whose answers it wants, which a page titled "your evaluation" has to do.
 *
 * **A denied read and a missing row are indistinguishable.** Postgres returns
 * 200 with an empty result for a row RLS filtered, not an error. Every read here
 * that can come back empty says so in its own return type, and the pages render
 * a real sentence for the empty case rather than "not found".
 *
 * **Writes that carry a rule go through the RPC.** `submit_evaluation()` is the
 * ONLY write path — `authenticated` holds `SELECT` and nothing else on the three
 * participant tables (SITE-01 finding 5, and its build measured that RLS is a
 * second, independent lock behind the grant). So the completeness gate in the
 * form is a courtesy and the database is the rule.
 *
 * ## What this module does NOT do, and it is a rule rather than an omission
 *
 * It never calls `evaluation_summary()`, `evaluation_comments()` or
 * `evaluation_answers_feed()`. Those are the facilitator surface, and program
 * finding 31 is binding here: a suppression rule is only as strong as the set of
 * reads it is defended across, and the one way to falsify the disclosure panel
 * from this side is to fetch an ungrouped total beside per-group counts and
 * rebuild by subtraction what the database refused to publish.
 */
import { supabase } from './client'
import { retryIfTooNew } from './retry'

// ---------------------------------------------------------------- row types

export type RoundState = 'draft' | 'open' | 'closed'
export type ResponseState = 'draft' | 'submitted'

/** `choice` and `rating_choice` are answered with a rating; everything else with text. */
export type AnswerShape = 'text' | 'scale'

export interface RoundRow {
  round_key: string
  workshop_key: string
  display_name: string
  opens_at: string
  closes_at: string
  state: RoundState
}

export interface ItemRow {
  round_key: string
  item_key: string
  day: number
  part: string
  kind: string
  title: string
  facilitator: string
  ordinal: number
}

export interface QuestionRow {
  round_key: string
  question_key: string
  ordinal: number
  kind: string
  required: boolean
  prompt: string
  answer_shape: AnswerShape
  absence_allowed: boolean
}

export interface GroupRow {
  group_key: string
  label: string
  ordinal: number
}

export interface ResponseRow {
  id: string
  round_key: string
  respondent_group: string | null
  state: ResponseState
  source: string
  submitted_at: string | null
}

export interface RatingRow {
  response_id: string
  item_key: string
  attended: boolean
  rating: number | null
  comment: string | null
}

export interface AnswerRow {
  response_id: string
  question_key: string
  answer_shape: AnswerShape
  body: string | null
  attended: boolean | null
  rating: number | null
}

/** One row on `/portal/evaluations`. */
export interface RoundListEntry {
  round: RoundRow
  response: ResponseRow | null
  /** Derived from the round's own window, never from `state` alone. */
  open: boolean
}

export interface Instrument {
  round: RoundRow
  items: ItemRow[]
  questions: QuestionRow[]
  groups: GroupRow[]
}

export interface MyAnswers {
  response: ResponseRow | null
  ratings: RatingRow[]
  answers: AnswerRow[]
}

/** What the round-2 panel can say about a participant's earlier round. */
export type EarlierState =
  | {
      kind: 'answers'
      roundKey: string
      displayName: string
      answers: AnswerRow[]
      /** 'manual' means the row came from the Google Form import, never the portal. */
      source: string
    }
  /** They were never on that round's participant list. */
  | { kind: 'not-in-round'; roundKey: string; displayName: string }
  /** They were on the list and nothing of theirs is readable. See the note below. */
  | { kind: 'nothing-readable'; roundKey: string; displayName: string }
  /** There is no earlier round at all — this is the first. */
  | { kind: 'no-earlier-round' }

// ------------------------------------------------------------------- reads

/**
 * A round is open when NOW is inside its window and its state says so, which is
 * exactly `evaluation_round_is_open()`'s rule in SQL. It is recomputed here
 * rather than read, because the list renders three states and a stale flag would
 * offer someone a form the RPC then refuses.
 */
export function roundIsOpen(r: RoundRow): boolean {
  const now = Date.now()
  return r.state === 'open' && Date.parse(r.opens_at) <= now && now <= Date.parse(r.closes_at)
}

/**
 * The rounds this participant is in, newest first.
 *
 * `evaluation_participant` is the source, not `workshop_evaluation_round`, and
 * that is finding 2's whole point: rounds are readable by every signed-in member,
 * so listing from them would show a crash-course alumnus the Psalms round and let
 * them file into its aggregate.
 */
export async function myRounds(profileId: string): Promise<RoundListEntry[]> {
  return retryIfTooNew(async () => {
    const mine = await supabase()
      .from('evaluation_participant')
      .select('round_key, workshop_evaluation_round(round_key, workshop_key, display_name, opens_at, closes_at, state)')
      .eq('profile_id', profileId)
    if (mine.error) throw new Error(mine.error.message)

    const rounds = (mine.data ?? [])
      .map((r) => (r as unknown as { workshop_evaluation_round: RoundRow | null }).workshop_evaluation_round)
      .filter((r): r is RoundRow => r !== null)
    if (rounds.length === 0) return []

    const responses = await supabase()
      .from('evaluation_response')
      .select('id, round_key, respondent_group, state, source, submitted_at')
      .eq('profile_id', profileId)
    if (responses.error) throw new Error(responses.error.message)
    const byRound = new Map((responses.data ?? []).map((r) => [r.round_key as string, r as ResponseRow]))

    return rounds
      .sort((a, b) => b.opens_at.localeCompare(a.opens_at))
      .map((round) => ({
        round,
        response: byRound.get(round.round_key) ?? null,
        open: roundIsOpen(round),
      }))
  })
}

/** The round's own row, or null when the caller is not in it / it does not exist. */
export async function getRound(roundKey: string): Promise<RoundRow | null> {
  const res = await supabase()
    .from('workshop_evaluation_round')
    .select('round_key, workshop_key, display_name, opens_at, closes_at, state')
    .eq('round_key', roundKey)
    .maybeSingle()
  if (res.error) throw new Error(res.error.message)
  return (res.data as RoundRow | null) ?? null
}

/** True when this participant is on the named round's list. */
export async function amInRound(roundKey: string, profileId: string): Promise<boolean> {
  const res = await supabase()
    .from('evaluation_participant')
    .select('round_key')
    .eq('round_key', roundKey)
    .eq('profile_id', profileId)
  if (res.error) throw new Error(res.error.message)
  return (res.data ?? []).length > 0
}

/**
 * Everything the form renders: the round, its active items and questions, and the
 * audience groups.
 *
 * Items are ordered by `(day, ordinal)` and NOT by `ordinal` alone. `ordinal`
 * restarts at 1 on each day in `Session-Map.md`, so ordering by it interleaves
 * five days into one scrambled list — and the form pages BY day, so the ordering
 * is what decides which card lands on which step.
 */
export async function getInstrument(roundKey: string): Promise<Instrument | null> {
  return retryIfTooNew(async () => {
    const round = await getRound(roundKey)
    if (!round) return null

    const [items, questions, groups] = await Promise.all([
      supabase()
        .from('evaluation_item')
        .select('round_key, item_key, day, part, kind, title, facilitator, ordinal')
        .eq('round_key', roundKey)
        .eq('active', true)
        .order('day', { ascending: true })
        .order('ordinal', { ascending: true }),
      supabase()
        .from('evaluation_question')
        .select('round_key, question_key, ordinal, kind, required, prompt, answer_shape, absence_allowed')
        .eq('round_key', roundKey)
        .eq('active', true)
        .order('ordinal', { ascending: true }),
      supabase()
        .from('evaluation_respondent_group')
        .select('group_key, label, ordinal')
        .order('ordinal', { ascending: true }),
    ])
    for (const r of [items, questions, groups]) if (r.error) throw new Error(r.error.message)

    return {
      round,
      items: (items.data ?? []) as ItemRow[],
      questions: (questions.data ?? []) as QuestionRow[],
      groups: (groups.data ?? []) as GroupRow[],
    }
  })
}

/**
 * This participant's own response to a round, with its ratings and answers.
 *
 * Readable after the round closes, always: that is rubric row 5 and it is the one
 * policy SITE-01 did not scope by the round's state.
 */
export async function getMyAnswers(roundKey: string, profileId: string): Promise<MyAnswers> {
  return retryIfTooNew(async () => {
    const res = await supabase()
      .from('evaluation_response')
      .select('id, round_key, respondent_group, state, source, submitted_at')
      .eq('round_key', roundKey)
      .eq('profile_id', profileId)
      .maybeSingle()
    if (res.error) throw new Error(res.error.message)
    const response = (res.data as ResponseRow | null) ?? null
    if (!response) return { response: null, ratings: [], answers: [] }

    const [ratings, answers] = await Promise.all([
      supabase()
        .from('evaluation_item_rating')
        .select('response_id, item_key, attended, rating, comment')
        .eq('response_id', response.id),
      supabase()
        .from('evaluation_answer')
        .select('response_id, question_key, answer_shape, body, attended, rating')
        .eq('response_id', response.id),
    ])
    for (const r of [ratings, answers]) if (r.error) throw new Error(r.error.message)

    return {
      response,
      ratings: (ratings.data ?? []) as RatingRow[],
      answers: (answers.data ?? []) as AnswerRow[],
    }
  })
}

/**
 * What the round-2 read-back can honestly say about this participant's earlier
 * round in the same workshop.
 *
 * ## The discriminator is participation, because it is the only one that is
 * readable
 *
 * The spec asked for two different empty sentences: "you joined for the second
 * week only", and "your Bali answers exist and could not be attached to you".
 * Measured against the schema as built, **a client cannot tell those apart from
 * the response tables**: an unattached response carries `profile_id is null`, the
 * policy is `profile_id = auth.uid()`, and RLS returns zero rows for it exactly
 * as it does for a response that was never filed. Both are an empty read, which
 * is the campaign's own "RLS denial is silent filtering" rule arriving on the one
 * screen where guessing wrong is worst.
 *
 * `evaluation_participant` IS readable, own rows, so it is the discriminator:
 *
 *   * not on the earlier round's list  → they were not in that round.
 *   * on the list, nothing readable    → either they did not answer, or they
 *                                        answered the Google Form which
 *                                        collected no address (program finding
 *                                        28, true of the WHOLE Bali round). The
 *                                        sentence names both, because that is
 *                                        what is true, and it never tells
 *                                        somebody they joined late.
 */
export async function getEarlierAnswers(round: RoundRow, profileId: string): Promise<EarlierState> {
  return retryIfTooNew(async () => {
    const earlier = await supabase()
      .from('workshop_evaluation_round')
      .select('round_key, workshop_key, display_name, opens_at, closes_at, state')
      .eq('workshop_key', round.workshop_key)
      .lt('opens_at', round.opens_at)
      .order('opens_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (earlier.error) throw new Error(earlier.error.message)
    const prev = (earlier.data as RoundRow | null) ?? null
    if (!prev) return { kind: 'no-earlier-round' }

    const inRound = await amInRound(prev.round_key, profileId)
    if (!inRound) {
      return { kind: 'not-in-round', roundKey: prev.round_key, displayName: prev.display_name }
    }

    const mine = await getMyAnswers(prev.round_key, profileId)
    if (!mine.response || mine.answers.length === 0) {
      return { kind: 'nothing-readable', roundKey: prev.round_key, displayName: prev.display_name }
    }
    return {
      kind: 'answers',
      roundKey: prev.round_key,
      displayName: prev.display_name,
      answers: mine.answers,
      source: mine.response.source,
    }
  })
}

// ------------------------------------------------------------------- write

export interface RatingPayload {
  item_key: string
  attended: boolean
  rating: number | null
  comment: string | null
}

export interface AnswerPayload {
  question_key: string
  body: string | null
  attended: boolean | null
  rating: number | null
}

/**
 * The one call. Everything lands or nothing does, because PostgREST gives the
 * client no transaction and a form that writes a response, then its ratings, then
 * its answers over three round trips can leave a half-filed evaluation behind.
 *
 * `attended: false` carries a NULL rating and never a zero. A zero would sit
 * inside the 1-to-5 range's arithmetic and drag every mean toward the floor with
 * nobody able to see it happening; the database refuses it, and this is the layer
 * that must not send it.
 */
export async function submitEvaluation(args: {
  roundKey: string
  respondentGroup: string
  ratings: RatingPayload[]
  answers: AnswerPayload[]
  finish?: boolean
}): Promise<string> {
  const res = await retryIfTooNew(() =>
    Promise.resolve(
      supabase().rpc('submit_evaluation', {
        _round_key: args.roundKey,
        _respondent_group: args.respondentGroup,
        _ratings: args.ratings,
        _answers: args.answers,
        _finish: args.finish ?? true,
      }),
    ).then((r) => {
      if (r.error) throw new Error(r.error.message)
      return r
    }),
  )
  return res.data as string
}
