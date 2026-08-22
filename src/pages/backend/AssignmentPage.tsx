import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import type { Session } from '@supabase/supabase-js'
import { AuthGate, ErrorNote, L } from './shared'
import { siteLabel } from '../../lib/content/loader'
import { STATE_NODE, whenLabel } from './AssignmentsPage'
import { WriteupForm } from './WriteupForm'
import {
  getAssignment,
  getCounterparty,
  getEnrollment,
  getSubmissionForAssignment,
  listBundles,
  listRatings,
  listScale,
  listUnitsForBundle,
  updateAssignmentSchedule,
  type AssignmentRow,
  type AssessmentBundle,
  type CounterpartyProfile,
  type ScalePoint,
  type SubmissionRatingRow,
  type SubmissionRow,
  type UnitForForm,
} from '../../lib/backend/assessApi'

/**
 * One assessment session. Spec CDT-04 D3.
 *
 * ## It branches on WHO is looking, not only on state
 *
 * `may_see_assignment()` admits the subject as well as the consultant, so a CIT
 * holding their own link loads this page. A page that branched on
 * `assignment.state` alone would show them the consultant's prep view with a
 * working Confirm-date control, and a write-up form for their own assessment.
 *
 * Until `20260909120000_writeup_submit.sql` shipped this session, the database
 * would also have ACCEPTED their date write: the column grant is to
 * `authenticated` as a whole and the update policy read `may_see_assignment(id)`.
 * The branch below is the UI half; the policy is the enforcement, and a UI that
 * merely hides a control is not a boundary.
 *
 * ## The deep link needs no return-to machinery
 *
 * `AuthGate` is an inline gate, not a redirect: it renders the sign-in card in
 * place when `session === null` and the children at the same route once a session
 * exists. So `/portal/a/:assignmentId` from an email works for a signed-out
 * visitor with nothing added here. The URL is the opaque uuid, never a
 * name-derived slug, and it is the permanent anchor: once an invitation carries
 * it the shape cannot change.
 */
export default function AssignmentPage() {
  return (
    <AuthGate
      compact
      title={siteLabel('portal.assess.consultant.assignment.title', 'Assessment session')}
    >
      {(session) => <One session={session} />}
    </AuthGate>
  )
}

interface Loaded {
  assignment: AssignmentRow | null
  bundle: AssessmentBundle | undefined
  units: UnitForForm[]
  scale: ScalePoint[]
  person: CounterpartyProfile | null
  enrollment: { assessment_language: string | null; note: string; cohort_event_id: string | null } | null
  submission: SubmissionRow | null
  ratings: SubmissionRatingRow[]
}

function One({ session }: { session: Session }) {
  const { assignmentId = '' } = useParams()
  const [data, setData] = useState<Loaded | undefined>(undefined)
  const [error, setError] = useState('')
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    let alive = true
    ;(async () => {
      // Null covers "no such assignment" and "one exists and RLS filtered it",
      // and the page must not distinguish them: the difference is not knowable on
      // the wire, and pretending otherwise leaks whether a row exists.
      const assignment = await getAssignment(assignmentId)
      if (!assignment) {
        if (alive) {
          setData({
            assignment: null,
            bundle: undefined,
            units: [],
            scale: [],
            person: null,
            enrollment: null,
            submission: null,
            ratings: [],
          })
        }
        return
      }
      const isConsultant = assignment.consultant_profile_id === session.user.id
      const otherId = isConsultant ? assignment.subject_profile_id : assignment.consultant_profile_id
      const [bundles, units, scale, person, submission] = await Promise.all([
        listBundles(),
        listUnitsForBundle(assignment.bundle_key),
        listScale(),
        getCounterparty(otherId),
        getSubmissionForAssignment(assignment.id),
      ])
      const enrollment = await getEnrollment(assignment.subject_profile_id)
      const ratings = submission ? await listRatings(submission.id) : []
      if (!alive) return
      setData({
        assignment,
        bundle: bundles.find((b) => b.bundle_key === assignment.bundle_key),
        units,
        scale,
        person,
        enrollment,
        submission,
        ratings,
      })
    })().catch((e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)))
    return () => {
      alive = false
    }
  }, [assignmentId, session.user.id, reloadKey])

  if (error) return <ErrorNote error={error} />
  if (data === undefined) {
    return (
      <L
        as="p"
        className="mt-8 text-ink-faint"
        id="portal.assess.consultant.assignment.loading"
        fallback="Loading this session…"
      />
    )
  }

  const back = (
    <Link to="/portal/assignments" className="mt-8 inline-block text-sm text-brand">
      <L id="portal.assess.consultant.assignment.back" fallback="Back to your sessions" />
    </Link>
  )

  if (!data.assignment) {
    return (
      <>
        <Panel>
          <L
            as="p"
            className="text-sm leading-relaxed text-ink-soft"
            id="portal.assess.consultant.absence.not-yours"
            fallback="This session is not on your list. If you were expecting it, ask the track administrator to check who it is assigned to."
          />
        </Panel>
        {back}
      </>
    )
  }

  const a = data.assignment
  const isConsultant = a.consultant_profile_id === session.user.id
  const isSubject = a.subject_profile_id === session.user.id

  return (
    <>
      <Facts data={data} isConsultant={isConsultant} />

      {isConsultant && (
        <ConsultantView data={data} onChanged={() => setReloadKey((k) => k + 1)} />
      )}

      {/* The subject's read-only view. No Confirm-date control and no form; the
          policy refuses the write in any case. */}
      {!isConsultant && isSubject && (
        <>
          <Panel>
            <L
              as="h2"
              className="font-display text-lg font-semibold text-ink"
              id="portal.assess.consultant.assignment.readonly.heading"
              fallback="This session is about you"
            />
            <L
              as="p"
              className="mt-2 text-sm leading-relaxed text-ink-soft"
              id="portal.assess.consultant.assignment.readonly.body"
              fallback="This page shows what has been arranged. Your consultant fills in the rating, and you see it once it has been released to you."
            />
          </Panel>
          {/* A filed-but-unreleased write-up reads as an absence to the CIT,
              because `may_see_submission()` returns nothing until released_at is
              set. Saying so beats an empty panel that reads as a bug. */}
          {!data.submission && (
            <Panel>
              <L
                as="p"
                className="text-sm leading-relaxed text-ink-soft"
                id="portal.assess.consultant.absence.unreleased"
                fallback="Your consultant has filed this write-up. You see it once it has been checked and released to you."
              />
            </Panel>
          )}
        </>
      )}

      {back}
    </>
  )
}

function Panel({ children }: { children: React.ReactNode }) {
  return <div className="mt-8 rounded-2xl border border-ink/10 bg-white/60 p-6">{children}</div>
}

function Fact({ labelId, fallback, value }: { labelId: string; fallback: string; value: string }) {
  if (!value) return null
  return (
    <div>
      <L as="dt" className="text-xs font-semibold uppercase tracking-wide text-ink-faint" id={labelId} fallback={fallback} />
      <dd className="mt-0.5 text-sm text-ink">{value}</dd>
    </div>
  )
}

/** The facts a consultant needs before the call, above everything else. */
function Facts({ data, isConsultant }: { data: Loaded; isConsultant: boolean }) {
  const a = data.assignment
  if (!a) return null
  const state = STATE_NODE[a.state]
  return (
    <div className="mt-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-display text-2xl font-semibold text-ink" data-cdt-counterparty>
          {data.person?.full_name || siteLabel('portal.assess.consultant.queue.cit.unknown', 'Name not available')}
        </span>
        <span className="text-sm text-ink-soft">{data.bundle?.name ?? a.bundle_key}</span>
        <span className="text-xs text-ink-faint">
          {a.scheduled_at
            ? whenLabel(a.scheduled_at)
            : siteLabel('portal.assess.consultant.assignment.meta.undated', 'No date agreed yet')}
        </span>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <L className="rounded-full bg-paper-deep px-2 py-0.5 text-xs text-ink-soft" id={state.id} fallback={state.fallback} />
        <L
          className="rounded-full bg-paper-deep px-2 py-0.5 text-xs text-ink-soft"
          id={a.rating_role === 'second' ? 'portal.assess.consultant.queue.role.second' : 'portal.assess.consultant.queue.role.primary'}
          fallback={a.rating_role === 'second' ? 'Second rating' : 'Primary rating'}
        />
        {data.submission && (
          <span className="rounded-full bg-paper-deep px-2 py-0.5 text-xs text-ink-soft" data-cdt-approval={data.submission.approval_state}>
            {data.submission.approval_state}
          </span>
        )}
        {data.submission && (
          <span
            className="rounded-full bg-paper-deep px-2 py-0.5 text-xs text-ink-soft"
            data-cdt-release={data.submission.released_at ? 'released' : 'not-released'}
          >
            {data.submission.released_at ? 'released to the CIT' : 'not released yet'}
          </span>
        )}
      </div>

      <dl className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-3">
        <Fact
          labelId="portal.assess.consultant.assignment.meta.format"
          fallback="Format"
          value={data.bundle?.format ?? ''}
        />
        <Fact
          labelId="portal.assess.consultant.assignment.meta.language"
          fallback="Meeting language"
          value={
            a.meeting_language ??
            siteLabel('portal.assess.consultant.assignment.meta.language.unknown', 'Not set')
          }
        />
        <Fact
          labelId="portal.assess.consultant.assignment.meta.units"
          fallback="Units rated"
          value={String(data.units.length)}
        />
        <Fact
          labelId="portal.assess.consultant.assignment.meta.prep"
          fallback="Prep"
          value={
            data.bundle
              ? `${data.bundle.prep_minutes} ${siteLabel('portal.assess.consultant.assignment.meta.minutes', 'minutes')}`
              : ''
          }
        />
        <Fact
          labelId="portal.assess.consultant.assignment.meta.meeting"
          fallback="Meeting"
          value={
            data.bundle
              ? `${data.bundle.minutes} ${siteLabel('portal.assess.consultant.assignment.meta.minutes', 'minutes')}`
              : ''
          }
        />
        <Fact
          labelId="portal.assess.consultant.assignment.meta.writeup"
          fallback="Write-up"
          value={
            data.bundle
              ? `${data.bundle.writeup_minutes} ${siteLabel('portal.assess.consultant.assignment.meta.minutes', 'minutes')}`
              : ''
          }
        />
        {isConsultant && (
          <Fact
            labelId="portal.assess.consultant.assignment.meta.assessment-language"
            fallback="The CIT's assessment language"
            value={data.enrollment?.assessment_language ?? ''}
          />
        )}
        {isConsultant && (
          <Fact
            labelId="portal.assess.consultant.assignment.meta.basis"
            fallback="Why you were assigned"
            value={a.qualification_basis}
          />
        )}
      </dl>

      {a.subject_l1 !== null && (
        <L
          as="p"
          className="mt-3 text-xs text-ink-faint"
          id={a.subject_l1 ? 'portal.assess.consultant.assignment.meta.l1.yes' : 'portal.assess.consultant.assignment.meta.l1.no'}
          fallback={a.subject_l1 ? "This is the CIT's first language" : "Not the CIT's first language"}
        />
      )}
    </div>
  )
}

function ConsultantView({ data, onChanged }: { data: Loaded; onChanged: () => void }) {
  const a = data.assignment
  if (!a) return null

  // A second rater is blind to the primary's write-up by design, and the sentence
  // exists so an empty panel does not read as a bug. It sits OUTSIDE the state
  // branch: the first draft put it inside held/returned, so it disappeared the
  // moment the second rater filed, which is exactly when they are most likely to
  // wonder where the other rating is. Criterion 8 also asserts the wire read
  // returns zero rows, because a panel keyed on `rating_role` would say the right
  // words even if the read had succeeded.
  const secondNote =
    a.rating_role === 'second' ? (
      <Panel>
        <L
          as="p"
          className="text-sm leading-relaxed text-ink-soft"
          id="portal.assess.consultant.absence.second-blind"
          fallback="You are the second rater on this session. The first rating is hidden from you until you have filed yours, so that your judgement is independent."
        />
      </Panel>
    ) : null

  if (a.state === 'cancelled') {
    return (
      <Panel>
        <L
          as="h2"
          className="font-display text-lg font-semibold text-ink"
          id="portal.assess.consultant.assignment.cancelled.heading"
          fallback="This session was cancelled"
        />
        <L
          as="p"
          className="mt-2 text-sm leading-relaxed text-ink-soft"
          id="portal.assess.consultant.assignment.cancelled.body"
          fallback="Nothing is owed on it. If that looks wrong, ask the track administrator."
        />
      </Panel>
    )
  }

  if (a.state === 'proposed' || a.state === 'scheduled') {
    return (
      <>
        {secondNote}
        <ScheduleCard assignment={a} onChanged={onChanged} />
      </>
    )
  }

  if (a.state === 'held' || a.state === 'returned') {
    return (
      <>
        {secondNote}
        {a.state === 'returned' && (
          <Panel>
            <L
              as="h2"
              className="font-display text-lg font-semibold text-ink"
              id="portal.assess.consultant.assignment.returned.heading"
              fallback="Sent back for revision"
            />
            <L
              as="p"
              className="mt-2 text-sm leading-relaxed text-ink-soft"
              id="portal.assess.consultant.assignment.returned.body"
              fallback="The head mentor has asked for a change. Revise the ratings below and file again."
            />
            {data.submission?.return_reason && (
              <p className="mt-3 rounded-lg bg-accent-soft/40 px-3 py-2 text-sm text-accent-deep" data-cdt-return-reason>
                {data.submission.return_reason}
              </p>
            )}
          </Panel>
        )}

        <WriteupForm
          assignment={a}
          units={data.units}
          scale={data.scale}
          existing={data.submission}
          existingRatings={data.ratings}
          onFiled={onChanged}
        />
      </>
    )
  }

  // submitted or closed: the read-back view.
  return (
    <>
      {secondNote}
      <Panel>
      <L
        as="h2"
        className="font-display text-lg font-semibold text-ink"
        id={
          a.state === 'closed'
            ? 'portal.assess.consultant.assignment.closed.heading'
            : 'portal.assess.consultant.assignment.filed.heading'
        }
        fallback={a.state === 'closed' ? 'This session is closed' : 'What you filed'}
      />
      {a.state === 'submitted' && (
        <L
          as="p"
          className="mt-2 text-sm leading-relaxed text-ink-soft"
          id="portal.assess.consultant.assignment.filed.note"
          fallback="Filed and waiting on the head mentor. You can see it here; the CIT sees it once it has been released."
        />
      )}
      {data.submission && (
        <div className="mt-4 flex flex-col gap-3">
          <ReadBack label="portal.assess.consultant.form.body.label" fallback="How the session went" value={data.submission.body_md} />
          <ReadBack label="portal.assess.consultant.form.strength.label" fallback="One thing they did well" value={data.submission.strength_note ?? ''} />
          <ReadBack label="portal.assess.consultant.form.growth1.label" fallback="First thing to grow" value={data.submission.growth_note_1 ?? ''} />
          <ReadBack label="portal.assess.consultant.form.growth2.label" fallback="Second thing to grow" value={data.submission.growth_note_2 ?? ''} />
          <ReadBack label="portal.assess.consultant.form.context.label" fallback="Anything that affected the session" value={data.submission.context_note ?? ''} />
          <table className="mt-2 w-full text-left text-xs">
            <tbody>
              {data.ratings.map((r) => (
                <tr key={r.unit_key} className="border-t border-ink/10" data-cdt-rating={r.unit_key}>
                  <th scope="row" className="py-1.5 pr-3 font-medium text-ink">{r.unit_key}</th>
                  <td className="py-1.5 pr-3 text-ink-soft">{r.observed_level} → {r.recommended_level}</td>
                  <td className="py-1.5 pr-3 text-ink-faint">{r.confidence}</td>
                  <td className="py-1.5 text-ink-soft">{r.evidence_sentence}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </Panel>
    </>
  )
}

function ReadBack({ label, fallback, value }: { label: string; fallback: string; value: string }) {
  if (!value) return null
  return (
    <div>
      <L as="p" className="text-xs font-semibold uppercase tracking-wide text-ink-faint" id={label} fallback={fallback} />
      <p className="mt-0.5 whitespace-pre-wrap text-sm text-ink">{value}</p>
    </div>
  )
}

function ScheduleCard({ assignment, onChanged }: { assignment: AssignmentRow; onChanged: () => void }) {
  // `datetime-local` wants "YYYY-MM-DDTHH:mm" in local time, and an ISO string
  // with a zone is rejected silently (the field just stays empty).
  const toLocal = (iso: string | null) => {
    if (!iso) return ''
    const d = new Date(iso)
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
  }
  const [when, setWhen] = useState(toLocal(assignment.scheduled_at))
  const [url, setUrl] = useState(assignment.meeting_url ?? '')
  const [working, setWorking] = useState(false)
  const [error, setError] = useState('')

  const save = async (nextState?: 'scheduled' | 'held') => {
    setWorking(true)
    setError('')
    try {
      await updateAssignmentSchedule(assignment.id, {
        scheduled_at: when ? new Date(when).toISOString() : null,
        meeting_url: url || null,
        ...(nextState ? { state: nextState } : {}),
      })
      onChanged()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setWorking(false)
    }
  }

  return (
    <Panel>
      <L
        as="h2"
        className="font-display text-lg font-semibold text-ink"
        id="portal.assess.consultant.assignment.confirm.heading"
        fallback="Confirm the date"
      />
      <L
        as="p"
        className="mt-2 text-sm leading-relaxed text-ink-soft"
        id="portal.assess.consultant.assignment.confirm.body"
        fallback="Put in the time you agreed with the CIT. You can change it until the session is held."
      />
      <div className="mt-4 flex flex-col gap-3">
        <label className="text-xs font-semibold uppercase tracking-wide text-ink-faint" htmlFor="cdt-when">
          <L id="portal.assess.consultant.assignment.confirm.date" fallback="Date and time" />
        </label>
        <input
          id="cdt-when"
          type="datetime-local"
          value={when}
          onChange={(e) => setWhen(e.target.value)}
          className="rounded-lg border border-ink/20 bg-white px-3 py-2.5 text-ink outline-none focus:border-accent"
        />
        <label className="text-xs font-semibold uppercase tracking-wide text-ink-faint" htmlFor="cdt-url">
          <L id="portal.assess.consultant.assignment.confirm.url" fallback="Meeting link" />
        </label>
        <input
          id="cdt-url"
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          className="rounded-lg border border-ink/20 bg-white px-3 py-2.5 text-ink outline-none focus:border-accent"
        />
        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            id="cdt-save-date"
            disabled={working || !when}
            onClick={() => void save(assignment.state === 'proposed' ? 'scheduled' : undefined)}
            className="rounded-full bg-brand px-5 py-2.5 text-sm font-semibold text-white hover:bg-accent disabled:opacity-50"
          >
            <L
              id={
                working
                  ? 'portal.assess.consultant.assignment.confirm.working'
                  : 'portal.assess.consultant.assignment.confirm.cta'
              }
              fallback={working ? 'Saving…' : 'Save the date'}
            />
          </button>
          {assignment.state === 'scheduled' && (
            <button
              type="button"
              id="cdt-mark-held"
              disabled={working}
              onClick={() => void save('held')}
              className="rounded-full border border-ink/20 px-5 py-2.5 text-sm font-medium text-ink-soft hover:bg-paper-deep disabled:opacity-50"
            >
              <L id="portal.assess.consultant.assignment.mark-held.cta" fallback="The session happened" />
            </button>
          )}
        </div>
        {error && <ErrorNote error={error} />}
      </div>
    </Panel>
  )
}
