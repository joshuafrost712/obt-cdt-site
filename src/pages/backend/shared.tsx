import { useEffect, useState, type ElementType, type FormEvent, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '../../lib/backend/client'
import { useSession } from '../../lib/backend/useSession'
import { siteLabel } from '../../lib/content/loader'
import { classifySignInError, SIGNIN_ERROR_NODE } from '../../lib/backend/signinErrors'
import { clearHadAccount, hadAccount, markHadAccount } from '../../lib/backend/seen'
import { notifySessionChanged } from '../../lib/backend/sessionHint'

/**
 * Wraps every portal page: resolves the session, shows the sign-in card when
 * signed out, and renders the member shell around the page content.
 *
 * Four states, four different sentences. "Checking", "you were signed in and
 * are not now", "sign in", and (inside the pages) "nothing here yet" are
 * genuinely different situations, and collapsing any of them into a blank panel
 * is the failure the Collaborative-Data-Protocol calls absence-is-not-a-status.
 */
/**
 * `compact` trims the page chrome above the content, and it exists for a measured
 * reason rather than a stylistic one.
 *
 * CDT-04's criterion 10 requires the CIT's name, the occasion and the date inside
 * the first 200px at a 390px viewport, because a consultant opens an assignment
 * from an email on a phone and the first thing they need is who, what and when.
 * Measured on 2026-08-21 with the default chrome: 262px. The sticky site header
 * is 57px of that and is not negotiable, but the kicker is decoration on a page
 * reached from a direct link, and a 4xl heading reading "Assessment session" says
 * less than the name directly beneath it.
 *
 * So a compact page drops the kicker and shrinks the heading. Every other portal
 * page keeps the full chrome: this is one page's answer to one measurement, not a
 * redesign of the portal.
 */
export function AuthGate({
  title,
  compact,
  children,
}: {
  title: string
  compact?: boolean
  children: (session: Session) => ReactNode
}) {
  const { session } = useSession()

  useEffect(() => {
    if (session) markHadAccount()
    // Spec SITE-03. The nav's signed-in variant is read by `SiteLayout`, which
    // is in the entry chunk and must never import supabase-js. This is the one
    // place a session change is already observed, so it is the one place that
    // tells the shell. Dispatched on sign-out too, which is what retires the
    // member entry without a reload.
    notifySessionChanged()
  }, [session])

  return (
    <div className={`mx-auto max-w-3xl px-5 pb-16 ${compact ? 'pt-5' : 'pt-12'}`}>
      {!compact && (
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-accent-deep">
          {siteLabel('portal.kicker', 'For enrolled participants')}
        </p>
      )}
      <h1
        className={
          compact
            ? 'font-display text-xl font-semibold tracking-tight text-ink'
            : 'mt-2 font-display text-4xl font-semibold tracking-tight text-ink'
        }
      >
        {title}
      </h1>

      {session === undefined && (
        <p className="mt-8 text-ink-faint">{siteLabel('portal.checking', 'Checking your session…')}</p>
      )}
      {session === null && <SignInCard returning={hadAccount()} />}
      {session && (
        <>
          <MemberBar email={session.user.email ?? ''} compact={compact} />
          {children(session)}
        </>
      )}
    </div>
  )
}

function MemberBar({ email, compact }: { email: string; compact?: boolean }) {
  return (
    <div
      className={`flex flex-wrap items-center gap-3 border-b border-ink/10 ${
        compact ? 'mt-3 pb-2' : 'mt-6 pb-4'
      }`}
    >
      <span className="text-xs text-ink-faint">{email}</span>
      <button
        type="button"
        className="ml-auto rounded-full border border-ink/20 px-3 py-1 text-xs font-medium text-ink-soft hover:bg-paper-deep"
        onClick={() => {
          clearHadAccount()
          void supabase().auth.signOut()
        }}
      >
        {siteLabel('portal.signout', 'Sign out')}
      </button>
    </div>
  )
}

type Mode = 'signin' | 'register' | 'reset'
type Status = 'idle' | 'working' | 'registered' | 'reset-sent' | 'error'

function SignInCard({ returning }: { returning: boolean }) {
  const [mode, setMode] = useState<Mode>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [status, setStatus] = useState<Status>('idle')
  const [errorText, setErrorText] = useState('')

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!email.trim() || status === 'working') return
    setStatus('working')
    setErrorText('')
    const addr = email.trim().toLowerCase()

    if (mode === 'reset') {
      const { error } = await supabase().auth.resetPasswordForEmail(addr, {
        // A stable path, never window.location.href: a deep link carries a
        // report id and the project's redirect allowlist matches by pattern.
        redirectTo: `${window.location.origin}${import.meta.env.BASE_URL}portal`,
      })
      // Deliberately uniform: see the note on registration below.
      if (error && classifySignInError(error.message) === 'email-rate-limit') {
        setErrorText(siteLabel(SIGNIN_ERROR_NODE['email-rate-limit'], 'Too many emails have been sent in the last hour. Please try again later.'))
        setStatus('error')
      } else {
        setStatus('reset-sent')
      }
      return
    }

    if (mode === 'register') {
      const { error } = await supabase().auth.signUp({ email: addr, password })
      if (error) {
        const kind = classifySignInError(error.message)
        // `not-on-list` is folded into the SAME message as success on purpose.
        // The site's standing content rule is that participation is not public
        // (no participant names or addresses anywhere, aggregates only), so a
        // form that answers "yes, that person is in the cohort" is a disclosure
        // dressed as a validation message. The uniform copy still tells someone
        // who is genuinely not on the list what to do, so nobody is stranded.
        if (kind === 'not-on-list') {
          setStatus('registered')
          return
        }
        setErrorText(
          kind === 'other'
            ? error.message
            : siteLabel(SIGNIN_ERROR_NODE[kind], 'That did not work. Please try again.'),
        )
        setStatus('error')
        return
      }
      setStatus('registered')
      return
    }

    const { error } = await supabase().auth.signInWithPassword({ email: addr, password })
    if (error) {
      const kind = classifySignInError(error.message)
      setErrorText(
        kind === 'other'
          ? error.message
          : siteLabel(SIGNIN_ERROR_NODE[kind], 'That did not work. Please try again.'),
      )
      setStatus('error')
      return
    }
    markHadAccount()
  }

  if (status === 'registered') {
    return (
      <Panel>
        <p className="rounded-lg bg-brand-soft px-4 py-3 text-sm font-medium text-brand">
          {siteLabel(
            'portal.signin.registered',
            'If that address is on the OBT-CDT list, a confirmation email is on its way. If nothing arrives, contact the track administrator.',
          )}
        </p>
      </Panel>
    )
  }

  if (status === 'reset-sent') {
    return (
      <Panel>
        <p className="rounded-lg bg-brand-soft px-4 py-3 text-sm font-medium text-brand">
          {siteLabel(
            'portal.signin.reset-sent',
            'If that address has a portal account, a password reset link is on its way.',
          )}
        </p>
      </Panel>
    )
  }

  return (
    <Panel>
      <h2 className="font-display text-xl font-semibold text-ink">
        {mode === 'register'
          ? siteLabel('portal.signin.heading.register', 'Create your account')
          : mode === 'reset'
            ? siteLabel('portal.signin.heading.reset', 'Reset your password')
            : siteLabel('portal.signin.heading', 'Sign in')}
      </h2>

      <p className="mt-2 text-sm leading-relaxed text-ink-soft">
        {returning && mode === 'signin'
          ? siteLabel('portal.signin.returning', 'Your session has ended. Sign in again to see your reports.')
          : siteLabel('portal.signin.body', 'Use the email address you gave when you registered for the track.')}
      </p>

      <form onSubmit={(e) => void submit(e)} className="mt-4 flex flex-col gap-3">
        <label className="text-xs font-semibold uppercase tracking-wide text-ink-faint" htmlFor="portal-email">
          {siteLabel('portal.signin.email', 'Email address')}
        </label>
        <input
          id="portal-email"
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="rounded-lg border border-ink/20 bg-white px-3 py-2.5 text-ink outline-none focus:border-accent"
          placeholder="you@example.org"
        />

        {mode !== 'reset' && (
          <>
            <label className="text-xs font-semibold uppercase tracking-wide text-ink-faint" htmlFor="portal-password">
              {siteLabel('portal.signin.password', 'Password')}
            </label>
            <input
              id="portal-password"
              type="password"
              required
              minLength={8}
              autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="rounded-lg border border-ink/20 bg-white px-3 py-2.5 text-ink outline-none focus:border-accent"
            />
          </>
        )}

        <button
          type="submit"
          disabled={status === 'working'}
          className="rounded-full bg-brand px-5 py-2.5 text-sm font-semibold text-white hover:bg-accent disabled:opacity-50"
        >
          {status === 'working'
            ? siteLabel('portal.signin.working', 'Working…')
            : mode === 'register'
              ? siteLabel('portal.signin.cta.register', 'Create account')
              : mode === 'reset'
                ? siteLabel('portal.signin.cta.reset', 'Email me a reset link')
                : siteLabel('portal.signin.cta', 'Sign in')}
        </button>

        {status === 'error' && <p className="text-sm text-accent-deep">{errorText}</p>}
      </form>

      <div className="mt-4 flex flex-wrap gap-4 text-xs text-ink-faint">
        {mode !== 'signin' && (
          <button type="button" className="underline" onClick={() => { setMode('signin'); setStatus('idle') }}>
            {siteLabel('portal.signin.switch.signin', 'Back to sign in')}
          </button>
        )}
        {mode !== 'register' && (
          <button type="button" className="underline" onClick={() => { setMode('register'); setStatus('idle') }}>
            {siteLabel('portal.signin.switch.register', 'I need to create an account')}
          </button>
        )}
        {mode !== 'reset' && (
          <button type="button" className="underline" onClick={() => { setMode('reset'); setStatus('idle') }}>
            {siteLabel('portal.signin.switch.reset', 'I forgot my password')}
          </button>
        )}
      </div>
    </Panel>
  )
}

function Panel({ children }: { children: ReactNode }) {
  return <div className="mt-8 max-w-md rounded-2xl border border-ink/10 bg-white/60 p-6">{children}</div>
}

export function ErrorNote({ error }: { error: string }) {
  return <p className="mt-6 rounded-lg bg-accent-soft/50 px-4 py-3 text-sm text-accent-deep">{error}</p>
}

/**
 * A content-layer label, rendered AND tagged for edit-in-place. CDT-04 decision 1.
 *
 * `siteLabel()` alone returns a bare string, so a portal page built on it puts
 * text on screen that highlight-to-edit cannot reach: `SelectionLayer.tsx:52-53`
 * resolves a selection through `dataset.dfbNode` and `dataset.dfbField`, and
 * before this component no `portal.*` node carried either. The public site has
 * had this everywhere since it was built (`src/components/text.tsx:37`); this is
 * the same two attributes for the id-plus-fallback call shape the portal uses.
 *
 * Use `siteLabel()` directly only where a string cannot carry attributes: a
 * `placeholder`, an `aria-label`, or a prop like `AuthGate`'s `title`.
 */
export function L({
  id,
  fallback,
  as,
  className,
}: {
  id: string
  fallback: string
  as?: ElementType
  className?: string
}) {
  const Tag: ElementType = as ?? 'span'
  return (
    <Tag className={className} data-dfb-node={id} data-dfb-field="label">
      {siteLabel(id, fallback)}
    </Tag>
  )
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
