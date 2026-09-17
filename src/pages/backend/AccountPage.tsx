/**
 * Spec SITE-12. The member's own name and organisation, on one routed screen.
 *
 * This file REPLACES the dormant account page rather than routing it. That page
 * rendered an `evaluations` table this project does not have, called a helper
 * that selected a `role` column this project does not have, and wrote every
 * string as a JSX literal against a rubric that requires content nodes. Its
 * evaluations half is not carried over: `/portal/evaluations` is SITE-02's
 * surface and already exists. See SITE-12 D3.
 *
 * ## The address is text, and that is the spec's central safety property
 *
 * `profiles.email` is the key the whole member gate is keyed to: the allowlist
 * matches on it, `handle_new_portal_user()` normalises it, and every RLS path
 * reaches the member through it. A member cannot change it, so this screen does
 * not offer a control that implies they can. It is rendered as text with NO
 * input bound to it, and criterion 5 asserts that structurally over every input,
 * textarea and contenteditable on the page rather than by checking one id, so a
 * second address field added later is caught too. The database agrees
 * independently: `authenticated` holds a column-level UPDATE grant on
 * `full_name` and `org` and on nothing else (criterion 6).
 *
 * ## The read names its own subject
 *
 * `getProfile` filters `.eq('id', session.user.id)`. That is not belt-and-braces
 * over RLS: `may_see_profile()` returns true for the owner, assignment
 * counterparties, the head mentor AND the portal administrator, so a bare select
 * returns every row the caller may see. An administrator opening this screen
 * would see a colleague's name in a field labelled as their own. Criterion 4's
 * administrator arm is the assertion, and mutation 2 is what proves it can fail.
 *
 * ## No re-authentication before the edit, deliberately
 *
 * ASVS V6.2 asks for it on a sensitive account change, meaning one that alters
 * who can get in: password, email, an MFA factor. Neither field here has any
 * bearing on access, and the field that does is unwritable by the member. SITE-12
 * D7 records this as a decision rather than leaving it as an omission.
 */
import { useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { Link } from 'react-router-dom'
import { getProfile, updateProfile, type Profile } from '../../lib/backend/api'
import { siteLabel } from '../../lib/content/loader'
import { AuthGate, ErrorNote } from './shared'

export default function AccountPage() {
  return (
    <AuthGate title={siteLabel('portal.account.title', 'Your name and details')}>
      {(session) => <AccountBody session={session} />}
    </AuthGate>
  )
}

function AccountBody({ session }: { session: Session }) {
  const [profile, setProfile] = useState<Profile | null | undefined>(undefined)
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true
    getProfile(session.user.id)
      .then((p) => alive && setProfile(p))
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)))
    return () => {
      alive = false
    }
  }, [session.user.id])

  if (error) return <ErrorNote error={error} />
  if (profile === undefined) {
    return <p className="mt-8 text-ink-faint">{siteLabel('portal.account.loading', 'Loading your details…')}</p>
  }

  return (
    <div className="mt-8 space-y-8" data-site12-account>
      <ProfileForm session={session} profile={profile} />
      <p>
        <Link to="/portal" className="text-sm font-semibold text-brand hover:text-accent">
          {siteLabel('portal.account.back', 'Back to your portal')}
        </Link>
      </p>
    </div>
  )
}

function ProfileForm({ session, profile }: { session: Session; profile: Profile | null }) {
  const [name, setName] = useState(profile?.full_name ?? '')
  const [org, setOrg] = useState(profile?.org ?? '')
  const [saved, setSaved] = useState({ name: profile?.full_name ?? '', org: profile?.org ?? '' })
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')

  const dirty = name.trim() !== saved.name || org.trim() !== saved.org

  const save = async () => {
    setState('saving')
    try {
      const next = { full_name: name.trim(), org: org.trim() }
      await updateProfile(session.user.id, next)
      setSaved({ name: next.full_name, org: next.org })
      setName(next.full_name)
      setOrg(next.org)
      setState('saved')
    } catch {
      setState('error')
    }
  }

  return (
    <section className="rounded-2xl border border-ink/10 bg-white/60 p-6">
      <div className="space-y-6">
        <Field
          id="site12-name"
          label={siteLabel('portal.account.name.label', 'Your name')}
          hint={siteLabel(
            'portal.account.name.hint',
            'This is the name the portal greets you by. It started from the participant list your address was checked against.',
          )}
          value={name}
          onChange={(v) => {
            setName(v)
            setState('idle')
          }}
        />
        <Field
          id="site12-org"
          label={siteLabel('portal.account.org.label', 'Where you work')}
          hint={siteLabel(
            'portal.account.org.hint',
            'Optional. Only four people can read this: you, anyone you are paired with on an assignment, the head mentor and the portal administrator. Nobody else, and nowhere public.',
          )}
          value={org}
          onChange={(v) => {
            setOrg(v)
            setState('idle')
          }}
        />

        {/*
          The address. Text, never a field: see the file header and criterion 5.
          `data-site12-email` is how the lane finds it structurally; the assertion
          is that no editable control carries this value, not that this element
          exists by name.
        */}
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
            {siteLabel('portal.account.email.label', 'Your email address')}
          </p>
          <p className="mt-1 text-sm text-ink" data-site12-email>
            {session.user.email}
          </p>
          <p className="mt-1 text-xs leading-relaxed text-ink-faint">
            {siteLabel(
              'portal.account.email.hint',
              'This is the address your account and the participant list are both keyed to, so it is not something you can change here. Email us if it needs to move.',
            )}
          </p>
        </div>
      </div>

      <div className="mt-6 flex items-center gap-3">
        <button
          type="button"
          disabled={!dirty || state === 'saving'}
          onClick={() => void save()}
          data-site12-save
          className="rounded-full bg-brand px-5 py-2.5 text-sm font-semibold text-white hover:bg-accent disabled:opacity-40"
        >
          {state === 'saving'
            ? siteLabel('portal.account.saving', 'Saving…')
            : siteLabel('portal.account.save', 'Save')}
        </button>
        {state === 'saved' && (
          <span className="text-sm font-medium text-brand" data-site12-saved>
            {siteLabel('portal.account.saved', 'Saved.')}
          </span>
        )}
        {state === 'error' && (
          <span className="text-sm text-accent-deep">
            {siteLabel('portal.account.error', 'That did not save. Try again, and tell us if it keeps happening.')}
          </span>
        )}
      </div>
    </section>
  )
}

function Field({
  id,
  label,
  hint,
  value,
  onChange,
}: {
  id: string
  label: string
  hint: string
  value: string
  onChange: (v: string) => void
}) {
  return (
    <div>
      <label htmlFor={id} className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
        {label}
      </label>
      <input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full rounded-lg border border-ink/20 bg-white px-3 py-2 text-sm text-ink outline-none focus:border-accent"
      />
      <p className="mt-1 text-xs leading-relaxed text-ink-faint">{hint}</p>
    </div>
  )
}
