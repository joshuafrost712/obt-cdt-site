import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import type { Session } from '@supabase/supabase-js'
import { AuthGate, ErrorNote, L } from './shared'
import { siteLabel } from '../../lib/content/loader'
import {
  listMyAssignments,
  listBundles,
  listMySubmissions,
  getCounterparty,
  type AssignmentRow,
  type AssessmentBundle,
  type SubmissionRow,
  type CounterpartyProfile,
} from '../../lib/backend/assessApi'

/**
 * The consultant's queue. Spec CDT-04 D2.
 *
 * ## All seven states have a home
 *
 * The first draft of the spec had two date-keyed sections and a three-way page
 * branch, which left `returned` with nowhere to go, sank `held` into
 * "Scheduled", and offered a Confirm-date button on a `cancelled` assignment.
 * `returned` is the state the approval loop produces, so a queue that cannot
 * show it is a queue that loses work the head mentor asked for.
 *
 * So the sections are keyed on what the consultant OWES, not on whether a date
 * exists: needs a date (proposed), coming up (scheduled), owes a write-up (held
 * and returned), finished (submitted and closed), cancelled. Every row also
 * carries its own state word, because a section is a grouping and not a status.
 *
 * ## The arithmetic counts work that is still ahead
 *
 * The commitment figure is recomputed from `assessment_bundle`'s three minute
 * columns, never stored, and it counts:
 *
 *   * proposed, scheduled and held at prep + meeting + write-up, the whole job;
 *   * returned at write-up minutes only, because the meeting already happened
 *     and only the revision is ahead;
 *   * submitted, closed and cancelled at nothing.
 *
 * A total that includes finished work is worse than no total: a consultant
 * planning their week against it plans for hours they do not owe.
 */
export default function AssignmentsPage() {
  return (
    <AuthGate title={siteLabel('portal.assess.consultant.queue.title', 'Your assessment sessions')}>
      {(session) => <Queue session={session} />}
    </AuthGate>
  )
}

type Loaded = {
  assignments: AssignmentRow[]
  bundles: Map<string, AssessmentBundle>
  submissions: Map<string, SubmissionRow>
  people: Map<string, CounterpartyProfile>
}

/** Sections in the order a consultant should read them: owed first, done last. */
const SECTIONS: { key: string; node: string; fallback: string; noteNode?: string; noteFallback?: string; states: AssignmentRow['state'][] }[] = [
  {
    key: 'writeup',
    node: 'portal.assess.consultant.queue.section.writeup',
    fallback: 'Waiting on your write-up',
    noteNode: 'portal.assess.consultant.queue.section.writeup.note',
    noteFallback: 'File these while the conversation is still fresh.',
    states: ['held', 'returned'],
  },
  {
    key: 'undated',
    node: 'portal.assess.consultant.queue.section.undated',
    fallback: 'Waiting on a date',
    noteNode: 'portal.assess.consultant.queue.section.undated.note',
    noteFallback: 'Agree a time with the CIT, then confirm it here.',
    states: ['proposed'],
  },
  { key: 'dated', node: 'portal.assess.consultant.queue.section.dated', fallback: 'Coming up', states: ['scheduled'] },
  { key: 'done', node: 'portal.assess.consultant.queue.section.done', fallback: 'Finished', states: ['submitted', 'closed'] },
  { key: 'cancelled', node: 'portal.assess.consultant.queue.section.cancelled', fallback: 'Cancelled', states: ['cancelled'] },
]

export const STATE_NODE: Record<AssignmentRow['state'], { id: string; fallback: string }> = {
  proposed: { id: 'portal.assess.consultant.queue.state.proposed', fallback: 'Needs a date' },
  scheduled: { id: 'portal.assess.consultant.queue.state.scheduled', fallback: 'Scheduled' },
  held: { id: 'portal.assess.consultant.queue.state.held', fallback: 'Held, not yet written up' },
  submitted: { id: 'portal.assess.consultant.queue.state.submitted', fallback: 'Filed' },
  returned: { id: 'portal.assess.consultant.queue.state.returned', fallback: 'Sent back to you' },
  closed: { id: 'portal.assess.consultant.queue.state.closed', fallback: 'Closed' },
  cancelled: { id: 'portal.assess.consultant.queue.state.cancelled', fallback: 'Cancelled' },
}

/** Minutes still owed on one assignment. Never stored; always recomputed. */
export function minutesAhead(a: AssignmentRow, b: AssessmentBundle | undefined): number {
  if (!b) return 0
  if (a.state === 'proposed' || a.state === 'scheduled' || a.state === 'held') {
    return b.prep_minutes + b.minutes + b.writeup_minutes
  }
  if (a.state === 'returned') return b.writeup_minutes
  return 0
}

export function whenLabel(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  return d.toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function Queue({ session }: { session: Session }) {
  const [data, setData] = useState<Loaded | undefined>(undefined)
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true
    ;(async () => {
      // No client-side filter on any of these: RLS is the filter. A consultant
      // gets their own assignments because `may_see_assignment()` says so, and a
      // second rule here could only disagree with the server's and hide it.
      // The first read after sign-in is the one that can come back 401 "JWT
      // issued at future"; assessApi retries that class once. See retryIfTooNew.
      const assignments = await listMyAssignments()
      const [bundles, submissions] = await Promise.all([listBundles(), listMySubmissions()])
      const others = [
        ...new Set(
          assignments.map((a) =>
            a.consultant_profile_id === session.user.id ? a.subject_profile_id : a.consultant_profile_id,
          ),
        ),
      ]
      const people = new Map<string, CounterpartyProfile>()
      for (const id of others) {
        const p = await getCounterparty(id)
        if (p) people.set(id, p)
      }
      if (!alive) return
      setData({
        assignments,
        bundles: new Map(bundles.map((b) => [b.bundle_key, b])),
        submissions: new Map(submissions.map((s) => [s.assignment_id, s])),
        people,
      })
    })().catch((e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)))
    return () => {
      alive = false
    }
  }, [session.user.id])

  if (error) return <div data-cdt-error><ErrorNote error={error} /></div>
  if (data === undefined) {
    return (
      <L
        as="p"
        className="mt-8 text-ink-faint"
        id="portal.assess.consultant.queue.loading"
        fallback="Loading your sessions…"
      />
    )
  }

  if (data.assignments.length === 0) {
    return (
      <div className="mt-8 rounded-2xl border border-ink/10 bg-white/60 p-6" data-cdt-empty>
        <L
          as="p"
          className="text-sm leading-relaxed text-ink-soft"
          id="portal.assess.consultant.queue.empty"
          fallback="You have no assessment sessions yet. When one is assigned to you it appears here, with the date and the units it covers."
        />
      </div>
    )
  }

  const totalMinutes = data.assignments.reduce(
    (sum, a) => sum + minutesAhead(a, data.bundles.get(a.bundle_key)),
    0,
  )
  const hours = Math.round((totalMinutes / 60) * 10) / 10

  return (
    <div className="mt-8 flex flex-col gap-10">
      <section className="rounded-2xl border border-ink/10 bg-white/60 p-5">
        <div className="flex flex-wrap items-baseline gap-x-3">
          <L
            className="text-xs font-semibold uppercase tracking-wide text-ink-faint"
            id="portal.assess.consultant.queue.commitment.label"
            fallback="Still ahead"
          />
          <span className="font-display text-2xl font-semibold text-ink" data-cdt-total-hours={hours}>
            {hours}
          </span>
          <L
            className="text-sm text-ink-soft"
            id="portal.assess.consultant.queue.commitment.hours"
            fallback="hours"
          />
        </div>
        <L
          as="p"
          className="mt-2 text-xs leading-relaxed text-ink-faint"
          id="portal.assess.consultant.queue.commitment.note"
          fallback="Prep, meeting and write-up time for the sessions you have not filed yet. Finished and cancelled sessions are not counted."
        />
      </section>

      {SECTIONS.map((s) => {
        const rows = data.assignments.filter((a) => s.states.includes(a.state))
        if (rows.length === 0) return null
        return (
          <section key={s.key} data-cdt-section={s.key}>
            <L as="h2" className="font-display text-lg font-semibold text-ink" id={s.node} fallback={s.fallback} />
            {s.noteNode && (
              <L as="p" className="mt-1 text-xs text-ink-faint" id={s.noteNode} fallback={s.noteFallback ?? ''} />
            )}
            <ul className="mt-3 flex flex-col gap-2">
              {rows.map((a) => (
                <Row
                  key={a.id}
                  assignment={a}
                  bundle={data.bundles.get(a.bundle_key)}
                  submission={data.submissions.get(a.id)}
                  person={data.people.get(
                    a.consultant_profile_id === session.user.id ? a.subject_profile_id : a.consultant_profile_id,
                  )}
                />
              ))}
            </ul>
          </section>
        )
      })}
    </div>
  )
}

function Row({
  assignment,
  bundle,
  submission,
  person,
}: {
  assignment: AssignmentRow
  bundle: AssessmentBundle | undefined
  submission: SubmissionRow | undefined
  person: CounterpartyProfile | undefined
}) {
  const state = STATE_NODE[assignment.state]
  return (
    <li data-cdt-state={assignment.state} data-cdt-assignment={assignment.id}>
      <Link
        to={`/portal/a/${assignment.id}`}
        className="block rounded-xl border border-ink/10 bg-white/60 px-4 py-3 no-underline hover:bg-paper-deep"
      >
        {/* The CIT name, the occasion and the date, in that order and first, so
            they are inside the top 200px on a 390px screen. Criterion 10. */}
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="font-medium text-ink">
            {person?.full_name || siteLabel('portal.assess.consultant.queue.cit.unknown', 'Name not available')}
          </span>
          <span className="text-sm text-ink-soft">{bundle?.name ?? assignment.bundle_key}</span>
          {assignment.scheduled_at ? (
            <span className="text-xs text-ink-faint">{whenLabel(assignment.scheduled_at)}</span>
          ) : (
            <L
              className="text-xs text-ink-faint"
              id="portal.assess.consultant.assignment.meta.undated"
              fallback="No date agreed yet"
            />
          )}
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-2">
          {/* One word per closed vocabulary, never one status chip. Rubric row 4. */}
          <L
            className="rounded-full bg-paper-deep px-2 py-0.5 text-xs text-ink-soft"
            id={state.id}
            fallback={state.fallback}
          />
          <L
            className="rounded-full bg-paper-deep px-2 py-0.5 text-xs text-ink-soft"
            id={
              assignment.rating_role === 'second'
                ? 'portal.assess.consultant.queue.role.second'
                : 'portal.assess.consultant.queue.role.primary'
            }
            fallback={assignment.rating_role === 'second' ? 'Second rating' : 'Primary rating'}
          />
          {submission && (
            <span className="rounded-full bg-paper-deep px-2 py-0.5 text-xs text-ink-soft" data-cdt-approval={submission.approval_state}>
              {submission.approval_state}
            </span>
          )}
          {submission && (
            <span
              className="rounded-full bg-paper-deep px-2 py-0.5 text-xs text-ink-soft"
              data-cdt-release={submission.released_at ? 'released' : 'not-released'}
            >
              {submission.released_at ? 'released to the CIT' : 'not released yet'}
            </span>
          )}
          {assignment.meeting_language && (
            <span className="text-xs text-ink-faint">{assignment.meeting_language}</span>
          )}
        </div>

        {/* `returned` carries the reason. Without it the consultant sees that
            something came back and not what to change. */}
        {assignment.state === 'returned' && submission?.return_reason && (
          <p className="mt-2 rounded-lg bg-accent-soft/40 px-3 py-2 text-xs leading-relaxed text-accent-deep">
            <L
              className="font-semibold"
              id="portal.assess.consultant.queue.returned.reason"
              fallback="Why it came back"
            />
            {': '}
            <span data-cdt-return-reason>{submission.return_reason}</span>
          </p>
        )}
      </Link>
    </li>
  )
}
