import { useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import {
  getProfile,
  listMyEvaluations,
  updateProfile,
  type EvaluationRow,
  type Profile,
} from '../../lib/backend/api'
import { AuthGate, ErrorNote } from './shared'

export default function AccountPage() {
  return <AuthGate title="My account">{(session) => <AccountBody session={session} />}</AuthGate>
}

function AccountBody({ session }: { session: Session }) {
  const [profile, setProfile] = useState<Profile | null>(null)
  const [evals, setEvals] = useState<EvaluationRow[] | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true
    Promise.all([getProfile(session.user.id), listMyEvaluations(session.user.id)])
      .then(([p, e]) => {
        if (!alive) return
        setProfile(p)
        setEvals(e)
      })
      .catch((err) => alive && setError(String(err.message ?? err)))
    return () => {
      alive = false
    }
  }, [session.user.id])

  if (error) return <ErrorNote error={error} />

  return (
    <div className="mt-8 space-y-10">
      <ProfileCard userId={session.user.id} profile={profile} />
      <EvaluationsSection evals={evals} />
    </div>
  )
}

function ProfileCard({ userId, profile }: { userId: string; profile: Profile | null }) {
  const [name, setName] = useState<string | null>(null)
  const [org, setOrg] = useState<string | null>(null)
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')

  if (!profile) return <p className="text-ink-faint">Loading your profile…</p>

  const nameValue = name ?? profile.full_name
  const orgValue = org ?? profile.org
  const dirty = nameValue !== profile.full_name || orgValue !== profile.org

  const save = async () => {
    setState('saving')
    try {
      await updateProfile(userId, { full_name: nameValue.trim(), org: orgValue.trim() })
      profile.full_name = nameValue.trim()
      profile.org = orgValue.trim()
      setState('saved')
    } catch {
      setState('error')
    }
  }

  return (
    <section className="rounded-2xl border border-ink/10 bg-white/60 p-6">
      <h2 className="font-display text-xl font-semibold text-ink">Profile</h2>
      <p className="mt-1 text-sm text-ink-soft">Your name appears on evaluations and printed certificates exactly as written here.</p>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <label className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
          Full name
          <input
            value={nameValue}
            onChange={(e) => {
              setName(e.target.value)
              setState('idle')
            }}
            className="mt-1 w-full rounded-lg border border-ink/20 bg-white px-3 py-2 text-sm font-normal normal-case tracking-normal text-ink outline-none focus:border-accent"
          />
        </label>
        <label className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
          Organization
          <input
            value={orgValue}
            onChange={(e) => {
              setOrg(e.target.value)
              setState('idle')
            }}
            className="mt-1 w-full rounded-lg border border-ink/20 bg-white px-3 py-2 text-sm font-normal normal-case tracking-normal text-ink outline-none focus:border-accent"
          />
        </label>
      </div>
      <div className="mt-4 flex items-center gap-3">
        <button
          type="button"
          disabled={!dirty || state === 'saving'}
          onClick={() => void save()}
          className="rounded-full bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-accent disabled:opacity-40"
        >
          {state === 'saving' ? 'Saving…' : 'Save profile'}
        </button>
        {state === 'saved' && <span className="text-sm font-medium text-brand">Saved.</span>}
        {state === 'error' && <span className="text-sm text-accent-deep">Could not save; try again.</span>}
      </div>
    </section>
  )
}

function EvaluationsSection({ evals }: { evals: EvaluationRow[] | null }) {
  if (!evals) return <p className="text-ink-faint">Loading your evaluations…</p>

  if (evals.length === 0) {
    return (
      <section>
        <h2 className="font-display text-2xl font-semibold text-ink">My evaluations</h2>
        <p className="mt-3 max-w-xl text-sm leading-relaxed text-ink-soft">
          No evaluations are in your record yet. After each workshop, verified evaluation evidence is added here and
          reviewed with your mentor.
        </p>
      </section>
    )
  }

  const byCompetency = new Map<string, EvaluationRow[]>()
  for (const e of evals) {
    const key = e.ksas?.competency ?? 'Other'
    byCompetency.set(key, [...(byCompetency.get(key) ?? []), e])
  }

  return (
    <section>
      <h2 className="font-display text-2xl font-semibold text-ink">My evaluations</h2>
      <p className="mt-2 max-w-xl text-sm leading-relaxed text-ink-soft">
        Evidence recorded by workshop facilitators, grouped by competency. Scores use the 0 to 3 scale and are weighed
        by your mentor; they are evidence toward certification, not a verdict.
      </p>
      <div className="mt-6 space-y-6">
        {[...byCompetency.entries()].map(([competency, rows]) => (
          <div key={competency} className="rounded-2xl border border-ink/10 bg-white/60 p-5">
            <h3 className="font-display text-lg font-semibold text-ink">{competency}</h3>
            <ul className="mt-3 space-y-3">
              {rows.map((e) => (
                <li key={e.id} className="flex gap-4 border-t border-ink/5 pt-3 first:border-t-0 first:pt-0">
                  <span
                    aria-label={`Score ${e.score} of 3`}
                    className="mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-brand font-display text-base font-semibold text-white"
                  >
                    {e.score}
                  </span>
                  <div>
                    <p className="text-sm font-semibold text-ink">{e.ksas?.label ?? e.ksas?.id}</p>
                    {e.note && <p className="mt-0.5 text-sm leading-relaxed text-ink-soft">{e.note}</p>}
                    <p className="mt-1 text-xs text-ink-faint">
                      {[e.evaluator, e.occasion].filter(Boolean).join(' · ')}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  )
}
