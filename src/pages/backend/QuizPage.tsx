/**
 * Spec SITE-19. A review quiz: answer every question, see which were right,
 * retake until all are right, and the completion is recorded.
 *
 * ## The server marks the paper, never this file
 *
 * The page holds the member's picks and nothing else. Whether a pick was right,
 * the score, and the explanation all come back from `submit_quiz_attempt()`, and
 * the marks rendered here are bound to that response: criterion 10 counts the
 * right marks in the DOM against the server's `score`, so a page that guessed
 * or marked everything right could not pass it (mutation 7).
 *
 * ## A retake re-opens every question (decision 2, 2026-10-15)
 *
 * Every radio clears, nothing that was right stays locked, the old marks and
 * explanations leave the screen, and one line keeps the last score. A wrong
 * answer shows "not yet" and a link back to the review, never the right choice
 * (decision 1): the explanation appears only once the member has it right,
 * because Quiz 1's explanations name the letter.
 *
 * ## Every state has words
 *
 * signed-out, loading, unknown, not-started, partly, retaking, submit-failed and
 * complete each render their own `portal.quiz.*` node and carry
 * `data-quiz-state`, so none of them is an empty page (criterion 11).
 *
 * The links back to the review use react-router `Link`, never a raw `href`: the
 * site is served under the Pages base path, and a raw `/members/...` would drop
 * it and land on the 404 page.
 */
import { useCallback, useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { Link, useParams } from 'react-router-dom'
import { siteLabel } from '../../lib/content/loader'
import { useSession } from '../../lib/backend/useSession'
import {
  getCompletion,
  getLastAttempt,
  getPaper,
  getQuiz,
  submitAttempt,
  QuizRefusal,
  type AttemptView,
  type CompletionView,
  type PaperQuestion,
  type QuizMeta,
} from '../../lib/backend/quizApi'
import { AuthGate, ErrorNote, L } from './shared'

const LETTER = ['A', 'B', 'C', 'D', 'E', 'F']

export default function QuizPage() {
  const { quizKey = '' } = useParams()
  const { session } = useSession()
  return (
    <div data-site19-quiz>
      {session === null && (
        <div className="mx-auto max-w-3xl px-5 pt-8" data-quiz-state="signed-out">
          <L
            as="p"
            id="portal.quiz.signed_out"
            fallback="This quiz is for workshop participants. Sign in to take it."
            className="text-ink-soft"
          />
        </div>
      )}
      <AuthGate title={siteLabel('portal.quiz.title', 'Review quiz')}>
        {(s) => <QuizBody session={s} quizKey={quizKey} />}
      </AuthGate>
    </div>
  )
}

type Load =
  | { kind: 'loading' }
  | { kind: 'unknown' }
  | { kind: 'error'; message: string }
  | {
      kind: 'ready'
      quiz: QuizMeta
      paper: PaperQuestion[]
      last: AttemptView | null
      completion: CompletionView | null
    }

function QuizBody({ session, quizKey }: { session: Session; quizKey: string }) {
  const userId = session.user.id
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  // `answering` is true while the radios are open: before the first attempt,
  // and after Retake. False while the last attempt's marks are on screen.
  const [answering, setAnswering] = useState(false)
  const [picks, setPicks] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const quiz = await getQuiz(quizKey)
      if (!quiz) {
        setLoad({ kind: 'unknown' })
        return
      }
      const [paper, last, completion] = await Promise.all([
        getPaper(quizKey),
        getLastAttempt(quizKey, userId),
        getCompletion(quizKey, userId),
      ])
      setLoad({ kind: 'ready', quiz, paper, last, completion })
      setAnswering(last === null && completion === null)
      setPicks({})
    } catch (e: unknown) {
      if (e instanceof QuizRefusal && e.code === 'P0002') {
        setLoad({ kind: 'unknown' })
        return
      }
      setLoad({ kind: 'error', message: e instanceof Error ? e.message : String(e) })
    }
  }, [quizKey, userId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  if (load.kind === 'loading') {
    return (
      <div className="mt-8" data-quiz-state="loading">
        <L as="p" id="portal.quiz.loading" fallback="Loading the quiz…" className="text-ink-faint" />
      </div>
    )
  }
  if (load.kind === 'unknown') {
    return (
      <div className="mt-8" data-quiz-state="unknown">
        <L
          as="p"
          id="portal.quiz.unknown"
          fallback="There is no open quiz at this address. The link may be wrong, or the quiz may have been withdrawn."
          className="text-ink-soft"
        />
        <p className="mt-4">
          <Link to="/portal" className="text-sm font-semibold text-brand hover:text-accent-deep">
            <L id="portal.quiz.to_portal" fallback="Back to your portal" />
          </Link>
        </p>
      </div>
    )
  }
  if (load.kind === 'error') return <ErrorNote error={load.message} />

  const { quiz, paper, last, completion } = load
  const reviewLink = quiz.reviewAnchor ? `${quiz.reviewRoute}#${quiz.reviewAnchor}` : quiz.reviewRoute
  const allPicked = paper.every((q) => picks[q.key])
  const state = completion
    ? 'complete'
    : submitError !== null
      ? 'submit-failed'
      : answering
        ? last
          ? 'retaking'
          : 'not-started'
        : 'partly'

  const submit = async () => {
    setSubmitting(true)
    setSubmitError(null)
    try {
      const result = await submitAttempt(quiz.quizKey, picks)
      const nextCompletion = result.completed ? await getCompletion(quiz.quizKey, userId) : null
      setLoad({ kind: 'ready', quiz, paper, last: result, completion: nextCompletion })
      setAnswering(false)
    } catch (e: unknown) {
      setSubmitError(e instanceof QuizRefusal ? e.message : '')
    } finally {
      setSubmitting(false)
    }
  }

  const retake = () => {
    setPicks({})
    setSubmitError(null)
    setAnswering(true)
  }

  return (
    <div className="mt-8 space-y-6" data-quiz-state={state}>
      <h2 className="font-display text-2xl font-semibold tracking-tight text-ink" data-site19-title>
        {quiz.title}
      </h2>
      <p>
        <Link to={reviewLink} className="text-sm font-semibold text-brand hover:text-accent-deep">
          <L id="portal.quiz.back" fallback="Back to the review" />
        </Link>
      </p>

      <StateNote state={state} last={last} completion={completion} submitError={submitError} />

      <ol className="space-y-5">
        {paper.map((q, i) => {
          const mark = !answering && last ? last.marks[q.key] : undefined
          const explanation = mark?.correct ? (mark.explanation ?? q.explanation) : null
          return (
            <li key={q.key} className="rounded-2xl border border-ink/10 bg-white/60 p-5" data-quiz-question={q.key}>
              <fieldset>
                <legend className="text-base font-semibold leading-snug text-ink">
                  {i + 1}. {q.stem}
                </legend>
                <div className="mt-3 space-y-2">
                  {q.choices.map((c, ci) => {
                    const id = `site19-${q.key}-${c.key}`
                    const checked = answering ? picks[q.key] === c.key : mark?.choiceKey === c.key
                    return (
                      <div key={c.key} className="flex items-start gap-3">
                        <input
                          id={id}
                          type="radio"
                          name={`site19-${q.key}`}
                          value={c.key}
                          checked={checked}
                          disabled={!answering || submitting}
                          onChange={() => setPicks((p) => ({ ...p, [q.key]: c.key }))}
                          className="mt-1 h-4 w-4 shrink-0 accent-brand"
                        />
                        <label htmlFor={id} className="min-w-0 text-sm leading-relaxed text-ink-soft">
                          <span className="font-semibold text-ink">{LETTER[ci]}.</span> {c.label}
                        </label>
                      </div>
                    )
                  })}
                </div>
              </fieldset>
              {mark && (
                <div className="mt-4 border-t border-ink/10 pt-3 text-sm">
                  {mark.correct ? (
                    <p data-quiz-mark="right" className="font-semibold text-brand">
                      <L id="portal.quiz.mark.right" fallback="Right" />
                    </p>
                  ) : (
                    <p data-quiz-mark="not-yet" className="font-semibold text-accent-deep">
                      <L id="portal.quiz.mark.not_yet" fallback="Not yet" />
                      {' · '}
                      <Link to={reviewLink} data-quiz-reread className="font-normal text-brand underline hover:text-accent-deep">
                        <L id="portal.quiz.reread" fallback="Read the review again" />
                      </Link>
                    </p>
                  )}
                  {explanation && (
                    <p data-quiz-explanation className="mt-2 leading-relaxed text-ink-soft">
                      {explanation}
                    </p>
                  )}
                </div>
              )}
            </li>
          )
        })}
      </ol>

      {answering && (
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            data-quiz-submit
            disabled={!allPicked || submitting}
            onClick={() => void submit()}
            className="rounded-full bg-brand px-5 py-2.5 text-sm font-semibold text-white hover:bg-accent-deep disabled:opacity-40"
          >
            {submitting
              ? siteLabel('portal.quiz.submitting', 'Submitting…')
              : siteLabel('portal.quiz.submit', 'Submit my answers')}
          </button>
          {!allPicked && (
            <L as="span" id="portal.quiz.pick_all" fallback="Pick an answer for every question to submit." className="text-sm text-ink-faint" />
          )}
        </div>
      )}
      {!answering && !completion && last && (
        <button
          type="button"
          data-quiz-retake
          onClick={retake}
          className="rounded-full bg-brand px-5 py-2.5 text-sm font-semibold text-white hover:bg-accent-deep"
        >
          {siteLabel('portal.quiz.retake', 'Retake the quiz')}
        </button>
      )}

      <L
        as="p"
        id="portal.quiz.disclosure"
        fallback="Each attempt you submit, the date you complete the quiz and the number of attempts it took are stored, and Joshua can see them by name."
        className="text-xs leading-relaxed text-ink-faint"
      />
    </div>
  )
}

function StateNote({
  state,
  last,
  completion,
  submitError,
}: {
  state: string
  last: AttemptView | null
  completion: CompletionView | null
  submitError: string | null
}) {
  const box = 'rounded-lg px-4 py-3 text-sm leading-relaxed'
  if (state === 'complete' && completion) {
    const date = new Date(completion.completedAt).toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    })
    return (
      <p className={`${box} bg-brand/10 text-ink`} data-quiz-complete>
        {siteLabel('portal.quiz.complete', 'Complete. You answered every question correctly on {date}.').replace('{date}', date)}
      </p>
    )
  }
  if (state === 'submit-failed') {
    return (
      <div className={`${box} bg-accent-soft/50 text-accent-deep`}>
        <L
          as="p"
          id="portal.quiz.submit_failed"
          fallback="Your answers did not reach the server, so nothing was recorded. Your picks are still here; check your connection and submit again."
        />
        {submitError && <p className="mt-1">{submitError}</p>}
      </div>
    )
  }
  if (state === 'partly' && last) {
    return (
      <div className={`${box} bg-paper-deep text-ink`}>
        <p data-quiz-score>
          {siteLabel('portal.quiz.score', '{score} of {total} right.')
            .replace('{score}', String(last.score))
            .replace('{total}', String(last.total))}
        </p>
        <L
          as="p"
          id="portal.quiz.partly"
          fallback="Where a question says not yet, read that part of the review again, then retake the quiz. Every question opens again on a retake."
          className="mt-1 text-ink-soft"
        />
      </div>
    )
  }
  if (state === 'retaking' && last) {
    return (
      <p className={`${box} bg-paper-deep text-ink`} data-quiz-last-score>
        {siteLabel('portal.quiz.last_score', 'Last attempt: {score} of {total}.')
          .replace('{score}', String(last.score))
          .replace('{total}', String(last.total))}
      </p>
    )
  }
  return (
    <L
      as="p"
      id="portal.quiz.not_started"
      fallback="Answer every question, then submit. You will see which answers were right, and you can retake the quiz until every answer is right."
      className="text-ink-soft"
    />
  )
}
