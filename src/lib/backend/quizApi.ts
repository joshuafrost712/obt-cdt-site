/**
 * A review quiz, read and submitted. Spec SITE-19.
 *
 * ## The answer key never comes through here before a submission
 *
 * `quiz_question` and `quiz_choice` are revoked from every client role. The
 * paper comes from `quiz_paper()`, whose result columns are a fixed allowlist
 * with no key in it, and whether a pick was right comes back only from
 * `submit_quiz_attempt()`, for the picks the member made. An explanation is
 * part of the key (Quiz 1's explanations name the letter), so the server sends
 * one only for a question this member has already answered correctly.
 *
 * ## The reads name their subject
 *
 * `quiz_attempt` and `quiz_completion` are owner-only under RLS, but the queries
 * still filter `.eq('profile_id', userId)`, as program finding 37 requires of
 * any page that says "your": a policy widened later must not put someone else's
 * row on this screen.
 */
import { supabase } from './client'

export interface QuizMeta {
  quizKey: string
  title: string
  reviewRoute: string
  reviewAnchor: string | null
}

export interface PaperChoice {
  key: string
  label: string
}

export interface PaperQuestion {
  key: string
  stem: string
  /** Non-null only for a question this member has already answered correctly. */
  explanation: string | null
  choices: PaperChoice[]
}

export interface Mark {
  choiceKey: string
  correct: boolean
  explanation: string | null
}

export interface AttemptView {
  attemptNo: number
  score: number
  total: number
  marks: Record<string, Mark>
}

export interface CompletionView {
  completedAt: string
  attemptsToComplete: number
}

/** A refusal from the server, kept apart from a network failure. */
export class QuizRefusal extends Error {
  readonly code: string
  constructor(message: string, code: string) {
    super(message)
    this.code = code
  }
}

/** The quiz, or `null` when no open quiz has this key. */
export async function getQuiz(quizKey: string): Promise<QuizMeta | null> {
  const res = await supabase()
    .from('quiz')
    .select('quiz_key, title, review_route, review_anchor')
    .eq('quiz_key', quizKey)
    .maybeSingle()
  if (res.error) throw new Error(res.error.message)
  if (!res.data) return null
  return {
    quizKey: res.data.quiz_key as string,
    title: res.data.title as string,
    reviewRoute: res.data.review_route as string,
    reviewAnchor: (res.data.review_anchor as string | null) ?? null,
  }
}

interface PaperRow {
  question_key: string
  question_position: number
  stem: string
  choice_key: string
  choice_position: number
  label: string
  explanation: string | null
}

export async function getPaper(quizKey: string): Promise<PaperQuestion[]> {
  const res = await supabase().rpc('quiz_paper', { _quiz_key: quizKey })
  if (res.error) throw new QuizRefusal(res.error.message, res.error.code ?? '')
  const byKey = new Map<string, PaperQuestion>()
  for (const row of (res.data ?? []) as PaperRow[]) {
    let q = byKey.get(row.question_key)
    if (!q) {
      q = { key: row.question_key, stem: row.stem, explanation: row.explanation, choices: [] }
      byKey.set(row.question_key, q)
    }
    q.choices.push({ key: row.choice_key, label: row.label })
  }
  // Rows arrive ordered by question then choice position; a Map keeps that.
  return [...byKey.values()]
}

interface StoredMark {
  question_key: string
  choice_key: string
  correct: boolean
}

/** The member's latest attempt, or `null` before the first. */
export async function getLastAttempt(quizKey: string, userId: string): Promise<AttemptView | null> {
  const res = await supabase()
    .from('quiz_attempt')
    .select('attempt_no, score, total, result')
    .eq('quiz_key', quizKey)
    .eq('profile_id', userId)
    .order('attempt_no', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (res.error) throw new Error(res.error.message)
  if (!res.data) return null
  const marks: Record<string, Mark> = {}
  for (const m of (res.data.result ?? []) as StoredMark[]) {
    // The stored attempt carries no explanation; the page takes it from the
    // paper, which the server already filtered to questions answered right.
    marks[m.question_key] = { choiceKey: m.choice_key, correct: m.correct, explanation: null }
  }
  return {
    attemptNo: res.data.attempt_no as number,
    score: res.data.score as number,
    total: res.data.total as number,
    marks,
  }
}

export async function getCompletion(quizKey: string, userId: string): Promise<CompletionView | null> {
  const res = await supabase()
    .from('quiz_completion')
    .select('completed_at, attempts_to_complete')
    .eq('quiz_key', quizKey)
    .eq('profile_id', userId)
    .maybeSingle()
  if (res.error) throw new Error(res.error.message)
  if (!res.data) return null
  return {
    completedAt: res.data.completed_at as string,
    attemptsToComplete: res.data.attempts_to_complete as number,
  }
}

interface SubmitRow {
  attempt_no: number
  score: number
  total: number
  completed: boolean
  question_key: string
  choice_key: string
  correct: boolean
  explanation: string | null
}

export interface SubmitResult extends AttemptView {
  completed: boolean
}

export async function submitAttempt(quizKey: string, picks: Record<string, string>): Promise<SubmitResult> {
  const answers = Object.entries(picks).map(([question_key, choice_key]) => ({ question_key, choice_key }))
  const res = await supabase().rpc('submit_quiz_attempt', { _quiz_key: quizKey, _answers: answers })
  if (res.error) throw new QuizRefusal(res.error.message, res.error.code ?? '')
  const rows = (res.data ?? []) as SubmitRow[]
  if (rows.length === 0) throw new Error('The server returned no result for this attempt.')
  const marks: Record<string, Mark> = {}
  for (const r of rows) {
    marks[r.question_key] = { choiceKey: r.choice_key, correct: r.correct, explanation: r.explanation }
  }
  return {
    attemptNo: rows[0].attempt_no,
    score: rows[0].score,
    total: rows[0].total,
    completed: rows[0].completed,
    marks,
  }
}
