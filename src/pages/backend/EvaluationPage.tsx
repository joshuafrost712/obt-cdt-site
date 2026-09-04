import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import type { Session } from '@supabase/supabase-js'
import { AuthGate, ErrorNote, L } from './shared'
import { Area, Choice, FieldCard, type ChoiceOption } from './formFields'
import { DISCLOSURE } from './evalDisclosure'
import { siteLabel } from '../../lib/content/loader'
import { getMedia } from '../../lib/media'
import { makeDraftStore } from '../../lib/backend/localDraft'
import {
  getEarlierAnswers,
  getInstrument,
  getMyAnswers,
  roundIsOpen,
  submitEvaluation,
  type AnswerPayload,
  type AnswerRow,
  type EarlierState,
  type Instrument,
  type ItemRow,
  type MyAnswers,
  type QuestionRow,
  type RatingPayload,
} from '../../lib/backend/evalApi'

/**
 * The participant's evaluation. Spec SITE-02 D2, D2a, D3 to D7.
 *
 * ## The ask was that it be better than a Google Form, and that is D2a
 *
 * Not an adjective. Six checkable properties, and every one of them is here:
 * paged by day rather than one scroll, a progress figure at every step, the size
 * of the job stated before it starts, the scale as full-width rows at narrow
 * widths, one column at 390px, and a register that reads as an invitation.
 *
 * ## The scale is a contract and this file does not own it
 *
 * The six choice strings, the sentence above the first card and the five comment
 * prompts all render from `portal.eval.scale.*` / `portal.eval.prompt.*` nodes
 * that `build_eval_nodes.py` writes from `Question-Set.md`. A hard-coded option
 * list would let Joshua reword scale point 2 in the contract while the portal
 * kept the old wording and the integer stayed 2 — the portal instrument silently
 * diverging from the Google Form on the one column the campaign exists to
 * protect (finding 4).
 *
 * ## The comment prompt is chosen by the item's kind, exhaustively
 *
 * Five kinds, five prompts. An item whose kind has no prompt is a REFUSAL, not a
 * fallback: SITE-00 defines five and this spec's first draft carried three, and a
 * silent default would have shown a closing ceremony a prompt asking how well it
 * taught, which is the category error the `kind` column exists to prevent.
 */
export default function EvaluationPage() {
  const { roundKey = '' } = useParams()
  return (
    <AuthGate title={siteLabel('portal.eval.form.title', 'Your evaluation')} compact>
      {(session) => <Evaluation key={roundKey} roundKey={decodeURIComponent(roundKey)} session={session} />}
    </AuthGate>
  )
}

// --------------------------------------------------------------- the draft

interface EvalDraftBody {
  step: number
  group: string
  /** `choice` is '1'..'5' or 'absent'; nothing is preselected. */
  ratings: Record<string, { choice?: string; comment?: string }>
  answers: Record<string, { body?: string; choice?: string }>
}

/**
 * Keyed on the round key, which names no person: `psalms-bali-2026:w1` is the
 * same string in everybody's browser, and the store is device-local anyway.
 */
const draftStore = makeDraftStore<EvalDraftBody>('site02.eval.', 1)

// ------------------------------------------------------------- the controls

const ABSENT = 'absent'

/**
 * The six points, written down once. Their WORDS come from
 * `portal.eval.scale.*`, which `build_eval_nodes.py` writes from
 * `Question-Set.md`; the ids and the integers are structure and live here.
 *
 * The fallbacks are the contract's own strings so that a node deleted by
 * accident degrades to the right words rather than to a number, and
 * `check-labels.mjs` pass A holds every one of these ids to an existing node.
 */
const SCALE: { value: string; node: string; fallback: string }[] = [
  { value: '1', node: 'portal.eval.scale.1', fallback: 'Well below average' },
  { value: '2', node: 'portal.eval.scale.2', fallback: 'Somewhat below average' },
  { value: '3', node: 'portal.eval.scale.3', fallback: 'About average' },
  { value: '4', node: 'portal.eval.scale.4', fallback: 'Somewhat above average' },
  { value: '5', node: 'portal.eval.scale.5', fallback: 'Well above average' },
  { value: ABSENT, node: 'portal.eval.scale.absent', fallback: "I wasn't there" },
]

/**
 * `absence_allowed` comes from the question's own generated column, so a
 * `choice` question (round 2's rating of the fortnight) offers five and a
 * `rating_choice` offers six. A null rating is expected in one and impossible in
 * the other, which is exactly the distinction `Question-Set.md` draws.
 */
function scaleOptions(withAbsence: boolean): ChoiceOption[] {
  return withAbsence ? SCALE : SCALE.filter((s) => s.value !== ABSENT)
}

/**
 * One scale point's words, for reading a filed answer back.
 *
 * Written as a filter-and-map rather than a lookup because the id has to be a
 * literal that `check-labels.mjs` can see: `siteLabel(\`portal.eval.scale.${n}\`)`
 * is an id assembled at runtime, which pass B refuses by design and which would
 * otherwise let a missing node render a bare integer forever.
 */
function ScaleWord({ value }: { value: string }) {
  return (
    <>
      {SCALE.filter((s) => s.value === value).map((s) => (
        <L key={s.value} id={s.node} fallback={s.fallback} />
      ))}
    </>
  )
}

const PROMPT_NODE: Record<string, { node: string; fallback: string }> = {
  devotional: { node: 'portal.eval.prompt.devotional', fallback: 'Anything you want to say about this one?' },
  session: { node: 'portal.eval.prompt.session', fallback: 'Anything you want to say about this one?' },
  practicum: { node: 'portal.eval.prompt.practicum', fallback: 'Anything you want to say about this afternoon?' },
  workblock: { node: 'portal.eval.prompt.workblock', fallback: 'Was this enough time, and did you have what you needed?' },
  ceremony: { node: 'portal.eval.prompt.ceremony', fallback: 'Anything you want to say about it?' },
}

/**
 * Refuses rather than falling back. Criterion 7: an unmatched kind fails, because
 * a silent default is how three prompts passed for five.
 */
export function promptFor(kind: string): { node: string; fallback: string } {
  const p = PROMPT_NODE[kind]
  if (!p) {
    throw new Error(
      `No comment prompt for item kind "${kind}". Question-Set.md's prompt table ` +
        `defines ${Object.keys(PROMPT_NODE).join(', ')}; add the kind there and re-run ` +
        'scripts/build_eval_nodes.py rather than adding a fallback here.',
    )
  }
  return p
}

// ------------------------------------------------------- the completeness gate

/**
 * Mirrors `submit_evaluation()`'s refusals exactly, so the File button is
 * disabled rather than the submit being refused after 44 inputs.
 *
 * FOUR refusals, not the two the spec named: the RPC also refuses a caller with
 * no respondent group and an unknown one, both of which arrived with SITE-01's
 * R1 after this spec was frozen. The database remains the rule — criterion 8
 * loosens this function and watches the refusal happen anyway.
 */
export function evalComplete(
  inst: Instrument,
  draft: EvalDraftBody,
): { ok: boolean; ratedItems: number; missing: string[] } {
  const missing: string[] = []
  if (!draft.group || !inst.groups.some((g) => g.group_key === draft.group)) missing.push('group')

  let ratedItems = 0
  for (const item of inst.items) {
    if (draft.ratings[item.item_key]?.choice) ratedItems++
    else missing.push(`item:${item.item_key}`)
  }
  for (const q of inst.questions) {
    if (!q.required) continue
    const a = draft.answers[q.question_key]
    const answered = q.answer_shape === 'scale' ? !!a?.choice : (a?.body ?? '').trim().length > 0
    if (!answered) missing.push(`question:${q.question_key}`)
  }
  return { ok: missing.length === 0, ratedItems, missing }
}

function toPayload(inst: Instrument, draft: EvalDraftBody): { ratings: RatingPayload[]; answers: AnswerPayload[] } {
  const ratings: RatingPayload[] = []
  for (const item of inst.items) {
    const v = draft.ratings[item.item_key]
    if (!v?.choice) continue
    const absent = v.choice === ABSENT
    ratings.push({
      item_key: item.item_key,
      attended: !absent,
      // Never a zero. A zero sits inside the 1-to-5 arithmetic and drags every
      // mean toward the floor with nobody able to see it happening.
      rating: absent ? null : Number(v.choice),
      comment: (v.comment ?? '').trim() || null,
    })
  }
  const answers: AnswerPayload[] = []
  for (const q of inst.questions) {
    const a = draft.answers[q.question_key]
    if (q.answer_shape === 'scale') {
      if (!a?.choice) continue
      const absent = a.choice === ABSENT
      answers.push({ question_key: q.question_key, body: null, attended: !absent, rating: absent ? null : Number(a.choice) })
    } else {
      const body = (a?.body ?? '').trim()
      if (!body) continue
      answers.push({ question_key: q.question_key, body, attended: null, rating: null })
    }
  }
  return { ratings, answers }
}

/** An already-filed response seeds the form, so a revision is edited and not retyped. */
function seedFromExisting(mine: MyAnswers): Omit<EvalDraftBody, 'step'> {
  const ratings: EvalDraftBody['ratings'] = {}
  for (const r of mine.ratings) {
    ratings[r.item_key] = { choice: r.attended ? String(r.rating ?? '') : ABSENT, comment: r.comment ?? '' }
  }
  const answers: EvalDraftBody['answers'] = {}
  for (const a of mine.answers) {
    answers[a.question_key] =
      a.answer_shape === 'scale'
        ? { choice: a.attended === false ? ABSENT : a.rating === null ? '' : String(a.rating) }
        : { body: a.body ?? '' }
  }
  return { group: mine.response?.respondent_group ?? '', ratings, answers }
}

// ------------------------------------------------------------------- the page

type Loaded = { inst: Instrument; mine: MyAnswers; earlier: EarlierState }

function Evaluation({ roundKey, session }: { roundKey: string; session: Session }) {
  const [data, setData] = useState<Loaded | undefined | null>(undefined)
  const [error, setError] = useState('')
  /**
   * Bumped by the completion panel's "Read what I wrote". A react-router `Link`
   * to the route you are already on does not remount anything, so the first
   * version of that link left the participant looking at the thank-you panel
   * forever — the one promise D6 makes that nothing else keeps. Re-reading and
   * remounting is also correct rather than merely working: the form has to be
   * seeded from what actually landed, not from the state that was submitted.
   */
  const [reload, setReload] = useState(0)

  useEffect(() => {
    let alive = true
    ;(async () => {
      const inst = await getInstrument(roundKey)
      if (!inst) {
        if (alive) setData(null)
        return
      }
      const [mine, earlier] = await Promise.all([getMyAnswers(roundKey), getEarlierAnswers(inst.round)])
      if (!alive) return
      setData({ inst, mine, earlier })
    })().catch((e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)))
    return () => {
      alive = false
    }
  }, [roundKey, session.user.id, reload])

  if (error) return <div data-eval-error><ErrorNote error={error} /></div>
  if (data === undefined) {
    return <L as="p" className="mt-8 text-ink-faint" id="portal.eval.form.loading" fallback="Loading the evaluation…" />
  }
  // Not an error and not "not found": a round exists but is not this
  // participant's, or has not been seeded. An RLS refusal is the same empty read,
  // so the sentence says what the reader can act on rather than what happened.
  if (data === null) {
    return (
      <div className="mt-8 rounded-2xl border border-ink/10 bg-white/60 p-6" data-eval-missing>
        <L
          as="p"
          className="text-sm leading-relaxed text-ink-soft"
          id="portal.eval.form.missing"
          fallback="This evaluation is not in your record. If you were expecting it, ask the track administrator to check that you are on the list for this round."
        />
        <Link className="mt-4 inline-block text-sm font-semibold text-brand underline" to="/portal/evaluations">
          <L id="portal.eval.form.back" fallback="Back to your evaluations" />
        </Link>
      </div>
    )
  }
  return <Form key={reload} loaded={data} onRead={() => setReload((r) => r + 1)} />
}

function Form({ loaded, onRead }: { loaded: Loaded; onRead: () => void }) {
  const { inst, mine, earlier } = loaded
  const open = roundIsOpen(inst.round)
  const roundKey = inst.round.round_key

  const days = useMemo(() => [...new Set(inst.items.map((i) => i.day))].sort((a, b) => a - b), [inst.items])
  /** Step 0 is the disclosure and the audience question; the last step is the written questions. */
  const lastStep = days.length + 1

  const onDisk = useMemo(() => draftStore.load(roundKey), [roundKey])
  const [restorePrompt, setRestorePrompt] = useState(onDisk !== null && open)
  const [draft, setDraft] = useState<EvalDraftBody>(() => ({ step: 0, ...seedFromExisting(mine) }))
  const [savedAt, setSavedAt] = useState<string | null>(onDisk?.savedAt ?? null)
  const [saveFailed, setSaveFailed] = useState(false)
  const [working, setWorking] = useState(false)
  const [filed, setFiled] = useState(false)
  const [error, setError] = useState('')
  const firstRender = useRef(true)

  // Autosave. The first render is skipped so that merely opening the page does
  // not write an empty draft over a real one.
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false
      return
    }
    if (!open) return
    const ok = draftStore.save(roundKey, draft)
    setSaveFailed(!ok)
    if (ok) setSavedAt(new Date().toISOString())
  }, [roundKey, draft, open])

  const gate = evalComplete(inst, draft)
  const step = Math.min(draft.step, lastStep)
  const setStep = (n: number) => setDraft((d) => ({ ...d, step: Math.max(0, Math.min(lastStep, n)) }))

  const file = async () => {
    setWorking(true)
    setError('')
    try {
      const { ratings, answers } = toPayload(inst, draft)
      await submitEvaluation({ roundKey, respondentGroup: draft.group, ratings, answers })
      // Only now. Never report a state change that did not persist.
      draftStore.clear(roundKey)
      setFiled(true)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setWorking(false)
    }
  }

  if (filed) return <CompletionPanel onRead={onRead} />

  if (!open) return <ClosedView inst={inst} mine={mine} />

  return (
    <section className="mt-6" id="site02-eval" data-eval-step={step} data-eval-round={roundKey}>
      <h2 className="font-display text-lg font-semibold text-ink" data-eval-round-name>
        {inst.round.display_name}
      </h2>

      <ProgressBar step={step} lastStep={lastStep} gate={gate} total={inst.items.length} savedAt={savedAt} />

      {saveFailed && (
        <L
          as="p"
          className="mt-2 rounded-lg bg-accent-soft/50 px-3 py-2 text-xs text-accent-deep"
          id="portal.eval.draft.failed"
          fallback="This browser refused to save your draft. Finish in one sitting if you can, or keep your notes somewhere else as well."
        />
      )}

      {restorePrompt && (
        <div className="mt-4 rounded-2xl border border-brand/30 bg-brand-soft/40 p-4" id="site02-restore">
          <L
            as="p"
            className="text-sm text-ink"
            id="portal.eval.draft.restore.heading"
            fallback="There is an unfinished evaluation for this round on this device."
          />
          <div className="mt-3 flex flex-wrap gap-3">
            <button
              type="button"
              id="site02-restore-yes"
              className="rounded-full bg-brand px-4 py-2 text-xs font-semibold text-white hover:bg-accent"
              onClick={() => {
                const d = draftStore.load(roundKey)
                if (d) setDraft({ step: d.step, group: d.group, ratings: d.ratings, answers: d.answers })
                setRestorePrompt(false)
              }}
            >
              <L id="portal.eval.draft.restore.cta" fallback="Pick up where I left off" />
            </button>
            <button
              type="button"
              id="site02-restore-no"
              className="rounded-full border border-ink/20 px-4 py-2 text-xs font-medium text-ink-soft hover:bg-paper-deep"
              onClick={() => {
                draftStore.clear(roundKey)
                setSavedAt(null)
                setRestorePrompt(false)
              }}
            >
              <L id="portal.eval.draft.restore.discard" fallback="Start again" />
            </button>
          </div>
        </div>
      )}

      {step === 0 && (
        <IntroStep
          inst={inst}
          earlier={earlier}
          group={draft.group}
          onGroup={(v) => setDraft((d) => ({ ...d, group: v }))}
        />
      )}

      {step > 0 && step < lastStep && (
        <DayStep
          day={days[step - 1]}
          first={step === 1}
          items={inst.items.filter((i) => i.day === days[step - 1])}
          draft={draft}
          setDraft={setDraft}
        />
      )}

      {step === lastStep && (
        <QuestionStep inst={inst} earlier={earlier} draft={draft} setDraft={setDraft} />
      )}

      <div className="mt-8 flex flex-wrap items-center gap-3 border-t border-ink/10 pt-5">
        {step > 0 && (
          <button
            type="button"
            id="site02-back"
            className="rounded-full border border-ink/20 px-5 py-2.5 text-sm font-medium text-ink-soft hover:bg-paper-deep"
            onClick={() => setStep(step - 1)}
          >
            <L id="portal.eval.nav.back" fallback="Back" />
          </button>
        )}
        {step < lastStep && (
          <button
            type="button"
            id="site02-next"
            className="rounded-full bg-brand px-6 py-2.5 text-sm font-semibold text-white hover:bg-accent"
            onClick={() => setStep(step + 1)}
          >
            <L id="portal.eval.nav.next" fallback="Next" />
          </button>
        )}
        {step === lastStep && (
          <button
            type="button"
            id="site02-file"
            disabled={working || !gate.ok}
            className="rounded-full bg-brand px-6 py-3 text-sm font-semibold text-white hover:bg-accent disabled:opacity-50"
            onClick={() => void file()}
            data-eval-missing-count={gate.missing.length}
          >
            <L
              id={working ? 'portal.eval.nav.filing' : 'portal.eval.nav.file'}
              fallback={working ? 'Filing…' : 'File my evaluation'}
            />
          </button>
        )}
      </div>

      {step === lastStep && !gate.ok && (
        <L
          as="p"
          className="mt-3 text-xs text-ink-faint"
          id="portal.eval.nav.incomplete"
          fallback="A few things are still blank. The marked questions have to be answered before this can be filed."
        />
      )}

      {error && (
        <div id="site02-file-error" className="mt-4">
          <L
            as="p"
            className="text-sm text-accent-deep"
            id="portal.eval.file.error"
            fallback="That was not filed, and nothing is lost: your answers are still on this device."
          />
          <ErrorNote error={error} />
        </div>
      )}
    </section>
  )
}

// ------------------------------------------------------------------- pieces

function ProgressBar({
  step,
  lastStep,
  gate,
  total,
  savedAt,
}: {
  step: number
  lastStep: number
  gate: { ratedItems: number }
  total: number
  savedAt: string | null
}) {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs" data-eval-progress>
      <L className="font-semibold uppercase tracking-wide text-ink-faint" id="portal.eval.progress.label" fallback="Rated" />
      <span className="font-medium text-ink" data-eval-rated={`${gate.ratedItems}/${total}`}>
        {gate.ratedItems}/{total}
      </span>
      <span className="text-ink-faint" data-eval-steps={`${step + 1}/${lastStep + 1}`}>
        {`${siteLabel('portal.eval.progress.step', 'Step')} ${step + 1}/${lastStep + 1}`}
      </span>
      <span className="text-ink-faint" data-eval-draft-state={savedAt ? 'saved' : 'never'}>
        {savedAt
          ? siteLabel('portal.eval.draft.saved', 'Saved on this device')
          : siteLabel('portal.eval.draft.never', 'Not saved yet')}
      </span>
    </div>
  )
}

/**
 * `imported` renders on two readable facts, never a guess: an earlier response
 * this participant can read that came in from the form, or membership of an
 * earlier round with nothing of theirs readable at all — which is program
 * finding 28's state and is true of the whole Bali round.
 */
export function showsImportedSentence(earlier: EarlierState): boolean {
  if (earlier.kind === 'answers') return earlier.source === 'manual'
  return earlier.kind === 'nothing-readable'
}

function DisclosurePanel({ earlier }: { earlier: EarlierState }) {
  const imported = showsImportedSentence(earlier)
  const rows = DISCLOSURE.filter((r) => r.when === 'always' || imported)
  return (
    <div className="mt-6 rounded-2xl border border-ink/10 bg-white/60 p-5" id="site02-disclosure">
      <L
        as="h3"
        className="font-display text-base font-semibold text-ink"
        id="portal.eval.disclosure.heading"
        fallback="Who sees what you write"
      />
      <ul className="mt-3 flex list-disc flex-col gap-2 pl-5">
        {rows.map((r) => (
          <li key={r.node} className="text-sm leading-relaxed text-ink-soft" data-disclosure={r.node}>
            <L id={r.node} fallback={r.fallback} />
          </li>
        ))}
      </ul>
      <L
        as="p"
        className="mt-3 text-xs leading-relaxed text-ink-faint"
        id="portal.eval.disclosure.word"
        fallback="The word for this is unattributed, not anonymous. The difference is the last point above, and it is real."
      />
    </div>
  )
}

function IntroStep({
  inst,
  earlier,
  group,
  onGroup,
}: {
  inst: Instrument
  earlier: EarlierState
  group: string
  onGroup: (v: string) => void
}) {
  const required = inst.questions.filter((q) => q.required).length
  return (
    <div>
      <L
        as="p"
        className="mt-5 max-w-2xl text-sm leading-relaxed text-ink-soft"
        id="portal.eval.intro.body"
        fallback="This is your account of the workshop, and it is yours to keep. Write as much or as little as you like; the parts people find most useful afterwards are the sentences, not the numbers."
      />

      {/* The size of the job, counted from the instrument rather than guessed.
          Question-Set.md is explicit that until a real fill has been timed the
          honest thing is to give the counts and say nothing about minutes, so
          this says what it can measure. */}
      <p className="mt-3 max-w-2xl text-sm leading-relaxed text-ink-soft" data-eval-size>
        {`${siteLabel('portal.eval.intro.size', 'What is ahead:')} ${inst.items.length} ${siteLabel(
          'portal.eval.intro.size.items',
          'sessions to rate',
        )}, ${required} ${siteLabel('portal.eval.intro.size.questions', 'questions that need an answer')}.`}
      </p>
      <L
        as="p"
        className="mt-1 max-w-2xl text-xs leading-relaxed text-ink-faint"
        id="portal.eval.intro.pace"
        fallback="It is split into steps, one per day, and it saves as you go. You can stop and come back."
      />

      <DisclosurePanel earlier={earlier} />

      <div className="mt-6">
        <Choice
          name="site02-group"
          testId="group"
          labelId="portal.eval.group.prompt"
          fallback="Which of these describes your part in the workshop?"
          helpId="portal.eval.group.help"
          helpFallback="Your ratings are read alongside the others in your group, so the numbers stay comparable."
          value={group}
          onChange={onGroup}
          layout="rows"
          required
          // The labels are the DATABASE's, seeded from Question-Set.md's own
          // table by `seed_evaluation_instrument.py`, so they are already
          // contract-driven and carry no content node of their own.
          options={inst.groups.map((g) => ({ value: g.group_key, text: g.label }))}
        />
      </div>

      <L
        as="p"
        className="mt-4 max-w-2xl text-xs leading-relaxed text-ink-faint"
        id="portal.eval.draft.device-note"
        fallback="Your answers are held in this browser on this device until you file them. They are not on the server, they do not follow you to another device, and clearing your browser data removes them."
      />
    </div>
  )
}

function DayStep({
  day,
  first,
  items,
  draft,
  setDraft,
}: {
  day: number
  first: boolean
  items: ItemRow[]
  draft: EvalDraftBody
  setDraft: (fn: (d: EvalDraftBody) => EvalDraftBody) => void
}) {
  return (
    <div className="mt-5">
      <h3 className="font-display text-base font-semibold text-ink" data-eval-day={day}>
        {`${siteLabel('portal.eval.day', 'Day')} ${day}`}
      </h3>

      {/* Above the FIRST card, and only there. Criterion 3 measures its offset at
          390 by 844, because a sentence that decides what the scale means is
          worth nothing below the fold. */}
      {first && (
        <L
          as="p"
          className="mt-2 max-w-2xl rounded-lg bg-brand-soft/40 px-4 py-3 text-sm leading-relaxed text-ink"
          id="portal.eval.scale.note"
          fallback="Average means about what you would expect from a good session in this series, not the middle of a scale of quality. A 3 is not a complaint."
        />
      )}

      <div className="mt-4 flex flex-col gap-4">
        {items.map((item) => {
          // The refusal runs here and the id is read from the table below it.
          // Both are deliberate: `promptFor` is what makes an unmatched kind
          // fail instead of falling back, and `check-labels.mjs` pass B refuses
          // an id that arrives from a function call, because such an id is not
          // written down anywhere pass A can see it.
          promptFor(item.kind)
          const v = draft.ratings[item.item_key] ?? {}
          return (
            <FieldCard
              key={item.item_key}
              anchor={item.item_key}
              heading={
                <>
                  <span className="font-display text-base font-semibold text-ink">{item.title}</span>
                  {item.facilitator && <span className="text-xs text-ink-faint">{item.facilitator}</span>}
                </>
              }
            >
              <Choice
                name={`rate-${item.item_key}`}
                testId={`rate-${item.item_key}`}
                labelId="portal.eval.item.rate"
                fallback="How was it?"
                value={v.choice ?? ''}
                onChange={(choice) =>
                  setDraft((d) => ({ ...d, ratings: { ...d.ratings, [item.item_key]: { ...v, choice } } }))
                }
                options={scaleOptions(true)}
                layout="rows"
                required
              />
              <Area
                id={`site02-c-${item.item_key}`}
                labelId={PROMPT_NODE[item.kind].node}
                fallback={PROMPT_NODE[item.kind].fallback}
                value={v.comment ?? ''}
                onChange={(comment) =>
                  setDraft((d) => ({ ...d, ratings: { ...d.ratings, [item.item_key]: { ...v, comment } } }))
                }
                rows={2}
              />
            </FieldCard>
          )
        })}
      </div>
    </div>
  )
}

function QuestionStep({
  inst,
  earlier,
  draft,
  setDraft,
}: {
  inst: Instrument
  earlier: EarlierState
  draft: EvalDraftBody
  setDraft: (fn: (d: EvalDraftBody) => EvalDraftBody) => void
}) {
  const earlierByKey = new Map<string, AnswerRow>(
    earlier.kind === 'answers' ? earlier.answers.map((a) => [a.question_key, a]) : [],
  )
  /** A question continues when the same key was asked in the earlier round. */
  const continuing = inst.questions.filter((q) => earlierByKey.has(q.question_key))

  return (
    <div className="mt-5">
      <L
        as="h3"
        className="font-display text-base font-semibold text-ink"
        id="portal.eval.questions.heading"
        fallback="And then the whole of it"
      />

      {earlier.kind !== 'no-earlier-round' && (
        <EarlierPanel earlier={earlier} hasContinuing={continuing.length > 0} />
      )}

      <div className="mt-4 flex flex-col gap-5">
        {inst.questions.map((q) => (
          <QuestionField
            key={q.question_key}
            q={q}
            earlier={earlierByKey.get(q.question_key) ?? null}
            earlierName={earlier.kind === 'answers' ? earlier.displayName : ''}
            draft={draft}
            setDraft={setDraft}
          />
        ))}
      </div>
    </div>
  )
}

function EarlierPanel({ earlier, hasContinuing }: { earlier: EarlierState; hasContinuing: boolean }) {
  if (earlier.kind === 'answers') {
    if (!hasContinuing) return null
    // The attribute goes on a wrapper, not on `L`. `L` takes id, fallback, as and
    // className and forwards nothing else, so `data-earlier` on it was silently
    // dropped and the criterion that looks for it found nothing — caught by that
    // criterion, which is what it is for.
    return (
      <div className="mt-2 max-w-2xl" data-earlier="answers">
        <L
          as="p"
          className="text-sm leading-relaxed text-ink-soft"
          id="portal.eval.earlier.have"
          fallback="Where you answered the same question last time, what you wrote then is shown beside it. It is there to think against, not to repeat."
        />
      </div>
    )
  }
  if (earlier.kind === 'not-in-round') {
    return (
      <div className="mt-2 max-w-2xl" data-earlier="not-in-round">
        <L
          as="p"
          className="text-sm leading-relaxed text-ink-soft"
          id="portal.eval.earlier.late"
          fallback="You were not on the list for the earlier round, so there is nothing from it to show you here. This one stands on its own."
        />
      </div>
    )
  }
  // `nothing-readable`. Two situations, one sentence, and it is true of both: a
  // participant who did not answer, and a participant whose Google Form answers
  // could not be attached to any account because the form collected no address.
  // Telling this reader they joined late would be false in the one place the
  // campaign's reflective promise lives.
  return (
    <div className="mt-2 max-w-2xl" data-earlier="nothing-readable">
      <L
        as="p"
        className="text-sm leading-relaxed text-ink-soft"
        id="portal.eval.earlier.unattached"
        fallback="Nothing from the earlier round is filed under your account. That round ran on a Google Form which did not collect email addresses, so if you answered it, those answers could not be attached to you and cannot be shown here. They still count in the totals."
      />
    </div>
  )
}

function QuestionField({
  q,
  earlier,
  earlierName,
  draft,
  setDraft,
}: {
  q: QuestionRow
  earlier: AnswerRow | null
  earlierName: string
  draft: EvalDraftBody
  setDraft: (fn: (d: EvalDraftBody) => EvalDraftBody) => void
}) {
  const a = draft.answers[q.question_key] ?? {}
  const patch = (v: { body?: string; choice?: string }) =>
    setDraft((d) => ({ ...d, answers: { ...d.answers, [q.question_key]: { ...a, ...v } } }))

  return (
    <div data-eval-question={q.question_key}>
      {earlier && (earlier.body || earlier.rating !== null) && (
        <div className="mb-2 rounded-lg border-l-4 border-brand/40 bg-paper-deep/60 px-4 py-3" data-eval-readback={q.question_key}>
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
            {`${siteLabel('portal.eval.readback.label', 'What you wrote in')} ${earlierName}`}
          </p>
          <p className="mt-1 whitespace-pre-line text-sm leading-relaxed text-ink-soft" data-eval-readback-body>
            {earlier.body ?? `${siteLabel('portal.eval.readback.rating', 'You rated it')} ${earlier.rating}`}
          </p>
        </div>
      )}

      {/* The prompt is the DATABASE's, seeded from Question-Set.md, so it is
          rendered and never mirrored into a content node: Joshua edits the
          contract and re-seeds, and the two cannot drift because there is only
          one of them. The control below it carries the generic label. */}
      <p className="text-sm leading-relaxed text-ink" data-eval-prompt={q.question_key}>
        {q.prompt}
      </p>

      <div className="mt-2">
        {q.answer_shape === 'scale' ? (
          <Choice
            name={`q-${q.question_key}`}
            testId={`q-${q.question_key}`}
            labelId="portal.eval.question.rate"
            fallback="Your rating"
            value={a.choice ?? ''}
            onChange={(choice) => patch({ choice })}
            options={scaleOptions(q.absence_allowed)}
            layout="rows"
            required={q.required}
          />
        ) : (
          <Area
            id={`site02-q-${q.question_key}`}
            labelId="portal.eval.question.write"
            fallback="Your answer"
            value={a.body ?? ''}
            onChange={(body) => patch({ body })}
            rows={q.kind === 'short_text' ? 2 : 4}
            required={q.required}
          />
        )}
      </div>
    </div>
  )
}

// ------------------------------------------------------------ closed and done

function ClosedView({ inst, mine }: { inst: Instrument; mine: MyAnswers }) {
  const byItem = new Map(mine.ratings.map((r) => [r.item_key, r]))
  const byQuestion = new Map(mine.answers.map((a) => [a.question_key, a]))

  if (!mine.response) {
    return (
      <div className="mt-8 rounded-2xl border border-ink/10 bg-white/60 p-6" data-eval-closed-empty>
        <L
          as="p"
          className="text-sm leading-relaxed text-ink-soft"
          id="portal.eval.closed.empty"
          fallback="This round has closed and nothing is filed under your account for it."
        />
        <Link className="mt-4 inline-block text-sm font-semibold text-brand underline" to="/portal/evaluations">
          <L id="portal.eval.form.back" fallback="Back to your evaluations" />
        </Link>
      </div>
    )
  }

  return (
    <section className="mt-6" data-eval-closed id="site02-eval">
      <h2 className="font-display text-lg font-semibold text-ink" data-eval-round-name>
        {inst.round.display_name}
      </h2>
      <L
        as="p"
        className="mt-2 max-w-2xl text-sm leading-relaxed text-ink-soft"
        id="portal.eval.closed.intro"
        fallback="This round has closed, so it can no longer be changed. What you wrote stays here for you to read whenever you like."
      />

      <div className="mt-6 flex flex-col gap-3">
        {inst.items.map((item) => {
          const r = byItem.get(item.item_key)
          if (!r) return null
          return (
            <div key={item.item_key} className="rounded-xl border border-ink/10 bg-white/60 p-4" data-eval-past-item={item.item_key}>
              <p className="font-display text-sm font-semibold text-ink">{item.title}</p>
              <p className="mt-1 text-sm text-ink-soft" data-eval-past-rating={r.attended ? String(r.rating) : ABSENT}>
                <ScaleWord value={r.attended ? String(r.rating) : ABSENT} />
              </p>
              {r.comment && (
                <p className="mt-2 whitespace-pre-line text-sm leading-relaxed text-ink" data-eval-past-comment>
                  {r.comment}
                </p>
              )}
            </div>
          )
        })}

        {inst.questions.map((q) => {
          const a = byQuestion.get(q.question_key)
          if (!a) return null
          return (
            <div key={q.question_key} className="rounded-xl border border-ink/10 bg-white/60 p-4" data-eval-past-question={q.question_key}>
              <p className="text-sm font-medium text-ink-soft">{q.prompt}</p>
              <p className="mt-1 whitespace-pre-line text-sm leading-relaxed text-ink" data-eval-past-answer>
                {a.answer_shape === 'scale' ? (
                  <ScaleWord value={a.attended === false ? ABSENT : String(a.rating)} />
                ) : (
                  (a.body ?? '')
                )}
              </p>
            </div>
          )
        })}
      </div>

      <Link className="mt-6 inline-block text-sm font-semibold text-brand underline" to="/portal/evaluations">
        <L id="portal.eval.form.back" fallback="Back to your evaluations" />
      </Link>
    </section>
  )
}

/**
 * The ending. D6.
 *
 * The image is one of the 16 self-hosted files, so no origin is added and the CSP
 * is untouched. Its credit renders because every entry in the manifest is CC BY
 * or CC BY-SA and the credit is a licence term rather than a courtesy. There is
 * no animation at all here, which is the cheapest way to satisfy
 * `prefers-reduced-motion` completely.
 */
export const COMPLETION_MEDIA = 'bali-gamelan'

function CompletionPanel({ onRead }: { onRead: () => void }) {
  const media = getMedia(COMPLETION_MEDIA)
  return (
    <section className="mt-6" id="site02-done" data-eval-complete>
      {media.kind === 'image' && media.src && (
        <figure className="overflow-hidden rounded-2xl">
          <img
            src={`${import.meta.env.BASE_URL}${media.src}`}
            alt={media.alt}
            className="w-full object-cover"
            style={{ aspectRatio: media.aspect }}
            data-eval-image
          />
          {media.credit && (
            <figcaption className="mt-1 text-[11px] text-ink-faint" data-eval-credit>
              {media.credit}
            </figcaption>
          )}
        </figure>
      )}

      <L
        as="h2"
        className="mt-6 font-display text-2xl font-semibold text-ink"
        id="portal.eval.done.heading"
        fallback="That is filed. Thank you."
      />
      <L
        as="p"
        className="mt-3 max-w-2xl text-sm leading-relaxed text-ink-soft"
        id="portal.eval.done.body"
        fallback="Your facilitators read these before they plan the next workshop, and the written answers are the part they argue about. What you said about the afternoons decides how much time the next cohort gets with their translation teams."
      />
      <L
        as="p"
        className="mt-2 max-w-2xl text-sm leading-relaxed text-ink-soft"
        id="portal.eval.done.when"
        fallback="You will hear what changed in the note that goes out before the next workshop opens."
      />

      <div className="mt-6 flex flex-wrap gap-3">
        <button
          type="button"
          onClick={onRead}
          className="rounded-full bg-brand px-5 py-2.5 text-sm font-semibold text-white hover:bg-accent"
          data-eval-done-own
        >
          <L id="portal.eval.done.own" fallback="Read what I wrote" />
        </button>
        <Link
          to="/portal"
          className="rounded-full border border-ink/20 px-5 py-2.5 text-sm font-medium text-ink-soft hover:bg-paper-deep"
          data-eval-done-portal
        >
          <L id="portal.eval.done.portal" fallback="Back to the portal" />
        </Link>
      </div>
    </section>
  )
}
