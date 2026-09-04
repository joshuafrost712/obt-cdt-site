import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import type { Session } from '@supabase/supabase-js'
import { AuthGate, ErrorNote, L } from './shared'
import { siteLabel } from '../../lib/content/loader'
import { myRounds, type RoundListEntry } from '../../lib/backend/evalApi'

/**
 * The rounds a participant is in. Spec SITE-02 D1.
 *
 * ## Three states, keyed on what the participant owes
 *
 * Open and unfiled, open and filed, and closed with their own answers still
 * readable. A closed round is not removed from the list, and that is rubric row
 * 5's whole point: an evaluation a participant can never re-read has collected
 * data rather than helped anyone reflect.
 *
 * ## Why the list comes from `evaluation_participant`
 *
 * `workshop_evaluation_round` is readable by any signed-in member, so a list
 * built from it would show a Crash Course alumnus the Psalms round and let them
 * file into its aggregate. SITE-02's review found that hole and SITE-01 built
 * `evaluation_participant` to close it, with a matching refusal inside
 * `submit_evaluation()`. The read names its subject rather than trusting RLS to
 * return exactly the caller's rows: `participant_read_own` is `profile_id =
 * auth.uid() OR is_head_mentor() OR is_portal_admin()`, so for the two oversight
 * roles it returns a superset and this list would show them everybody's
 * memberships. See the note at the top of `evalApi.ts`.
 */
export default function EvaluationsPage() {
  return (
    <AuthGate title={siteLabel('portal.eval.list.title', 'Your workshop evaluations')}>
      {(session) => <RoundList session={session} />}
    </AuthGate>
  )
}

function RoundList({ session }: { session: Session }) {
  const [rows, setRows] = useState<RoundListEntry[] | undefined>(undefined)
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true
    ;(async () => {
      const data = await myRounds(session.user.id)
      if (!alive) return
      setRows(data)
    })().catch((e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)))
    return () => {
      alive = false
    }
  }, [session.user.id])

  if (error) return <div data-eval-error><ErrorNote error={error} /></div>
  if (rows === undefined) {
    return (
      <L as="p" className="mt-8 text-ink-faint" id="portal.eval.list.loading" fallback="Loading your evaluations…" />
    )
  }
  if (rows.length === 0) {
    return (
      <div className="mt-8 rounded-2xl border border-ink/10 bg-white/60 p-6" data-eval-empty>
        <L
          as="p"
          className="text-sm leading-relaxed text-ink-soft"
          id="portal.eval.list.empty"
          fallback="You are not in an evaluation round yet. When a workshop you attended opens one, it appears here, and it stays here afterwards so you can read back what you wrote."
        />
      </div>
    )
  }

  return (
    <div className="mt-8 flex flex-col gap-4" data-eval-list>
      <L
        as="p"
        className="max-w-2xl text-sm leading-relaxed text-ink-soft"
        id="portal.eval.list.intro"
        fallback="What you write here is yours to keep. You can come back and read it whenever you like, including after the round has closed."
      />
      {rows.map((r) => (
        <RoundCard key={r.round.round_key} row={r} />
      ))}
    </div>
  )
}

/** "2026-09-11T23:59:59+08:00" → "11 Sep 2026". Local, because a deadline is local. */
export function closeLabel(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

function RoundCard({ row }: { row: RoundListEntry }) {
  const filed = row.response?.state === 'submitted'
  const state = row.open ? (filed ? 'open-filed' : 'open-unfiled') : 'closed'

  return (
    <div
      className="rounded-2xl border border-ink/10 bg-white/60 p-5"
      data-eval-round={row.round.round_key}
      data-eval-state={state}
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="font-display text-lg font-semibold text-ink" data-eval-round-name>
          {row.round.display_name}
        </h2>
        {state === 'open-unfiled' && (
          <L
            className="rounded-full bg-accent-soft px-2.5 py-0.5 text-xs font-semibold text-accent-deep"
            id="portal.eval.list.state.unfiled"
            fallback="Not yet filed"
          />
        )}
        {state === 'open-filed' && (
          <L
            className="rounded-full bg-brand-soft px-2.5 py-0.5 text-xs font-semibold text-brand"
            id="portal.eval.list.state.filed"
            fallback="Filed — you can still change it"
          />
        )}
        {state === 'closed' && (
          <L
            className="rounded-full bg-paper-deep px-2.5 py-0.5 text-xs font-medium text-ink-soft"
            id="portal.eval.list.state.closed"
            fallback="Closed"
          />
        )}
      </div>

      <p className="mt-1 text-xs text-ink-faint" data-eval-close={row.round.closes_at}>
        {row.open
          ? `${siteLabel('portal.eval.list.closes', 'Open until')} ${closeLabel(row.round.closes_at)}`
          : `${siteLabel('portal.eval.list.closed-on', 'Closed on')} ${closeLabel(row.round.closes_at)}`}
      </p>

      <div className="mt-4">
        <Link
          to={`/portal/e/${encodeURIComponent(row.round.round_key)}`}
          className="inline-block rounded-full bg-brand px-5 py-2.5 text-sm font-semibold text-white hover:bg-accent"
          data-eval-open
        >
          <L
            id={
              state === 'open-unfiled'
                ? 'portal.eval.list.cta.fill'
                : state === 'open-filed'
                  ? 'portal.eval.list.cta.revise'
                  : 'portal.eval.list.cta.read'
            }
            fallback={
              state === 'open-unfiled'
                ? 'Fill this in'
                : state === 'open-filed'
                  ? 'Read or change your answers'
                  : 'Read what you wrote'
            }
          />
        </Link>
      </div>
    </div>
  )
}
