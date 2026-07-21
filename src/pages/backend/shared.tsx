import { useState, type FormEvent, type ReactNode } from 'react'
import { NavLink } from 'react-router-dom'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '../../lib/backend/client'
import { useSession } from '../../lib/backend/useSession'

/**
 * Wraps every backend page: resolves the session, shows the magic-link
 * sign-in card when signed out, and renders the account shell (tabs +
 * sign-out) around the page content when signed in.
 */
export function AuthGate({ title, children }: { title: string; children: (session: Session) => ReactNode }) {
  const { session } = useSession()

  return (
    <div className="mx-auto max-w-3xl px-5 pb-16 pt-12">
      <p className="text-xs font-semibold uppercase tracking-[0.2em] text-clay">Participant area</p>
      <h1 className="mt-2 font-display text-4xl font-semibold tracking-tight text-ink">{title}</h1>

      {session === undefined && <p className="mt-8 text-ink-faint">Checking your session…</p>}
      {session === null && <SignInCard />}
      {session && (
        <>
          <AccountTabs email={session.user.email ?? ''} />
          {children(session)}
        </>
      )}
    </div>
  )
}

function AccountTabs({ email }: { email: string }) {
  const tab = ({ isActive }: { isActive: boolean }) =>
    `rounded-full px-4 py-1.5 text-sm font-medium no-underline ${
      isActive ? 'bg-ink text-paper' : 'text-ink-soft hover:bg-paper-deep'
    }`
  return (
    <div className="mt-6 flex flex-wrap items-center gap-2 border-b border-ink/10 pb-4">
      <NavLink to="/account" end className={tab}>
        Overview
      </NavLink>
      <NavLink to="/events" className={tab}>
        Events
      </NavLink>
      <NavLink to="/certificates" className={tab}>
        Certificates
      </NavLink>
      <span className="ml-auto text-xs text-ink-faint">{email}</span>
      <button
        type="button"
        className="rounded-full border border-ink/20 px-3 py-1 text-xs font-medium text-ink-soft hover:bg-paper-deep"
        onClick={() => void supabase().auth.signOut()}
      >
        Sign out
      </button>
    </div>
  )
}

function SignInCard() {
  const [email, setEmail] = useState('')
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle')

  const send = async (e: FormEvent) => {
    e.preventDefault()
    if (!email.trim() || state === 'sending') return
    setState('sending')
    const { error } = await supabase().auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: window.location.href },
    })
    setState(error ? 'error' : 'sent')
  }

  return (
    <div className="mt-8 max-w-md rounded-2xl border border-ink/10 bg-white/60 p-6">
      <h2 className="font-display text-xl font-semibold text-ink">Sign in</h2>
      <p className="mt-2 text-sm leading-relaxed text-ink-soft">
        Enter the email address you use with the track and we will send you a one-time sign-in link. No password needed.
      </p>
      {state === 'sent' ? (
        <p className="mt-4 rounded-lg bg-teal-soft px-4 py-3 text-sm font-medium text-teal">
          Check your email for the sign-in link, then return to this tab.
        </p>
      ) : (
        <form onSubmit={(e) => void send(e)} className="mt-4 flex flex-col gap-3">
          <label className="text-xs font-semibold uppercase tracking-wide text-ink-faint" htmlFor="signin-email">
            Email address
          </label>
          <input
            id="signin-email"
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="rounded-lg border border-ink/20 bg-white px-3 py-2.5 text-ink outline-none focus:border-clay"
            placeholder="you@example.org"
          />
          <button
            type="submit"
            disabled={state === 'sending'}
            className="rounded-full bg-clay px-5 py-2.5 text-sm font-semibold text-white hover:bg-clay-deep disabled:opacity-50"
          >
            {state === 'sending' ? 'Sending…' : 'Email me a sign-in link'}
          </button>
          {state === 'error' && (
            <p className="text-sm text-clay-deep">That didn't work. Check the address and try again, or contact josh_frost@sil.org.</p>
          )}
        </form>
      )}
    </div>
  )
}

export function ErrorNote({ error }: { error: string }) {
  return <p className="mt-6 rounded-lg bg-clay-soft/50 px-4 py-3 text-sm text-clay-deep">{error}</p>
}

/** "2026-08-24" (+ optional end) → "24 Aug 2026" / "24 Aug – 4 Sep 2026". */
export function shortRange(start: string | null, end: string | null): string {
  const fmt = (iso: string) => {
    const [y, m, d] = iso.split('-').map(Number)
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    return `${d} ${months[m - 1]} ${y}`
  }
  if (!start) return ''
  if (!end || end === start) return fmt(start)
  return `${fmt(start).replace(/ \d{4}$/, '')} – ${fmt(end)}`
}
