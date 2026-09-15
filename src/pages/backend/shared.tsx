import { useEffect, useState, type ElementType, type FormEvent, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '../../lib/backend/client'
import { useSession } from '../../lib/backend/useSession'
import { siteLabel } from '../../lib/content/loader'
import { classifySignInError, SIGNIN_ERROR_NODE } from '../../lib/backend/signinErrors'
import { clearHadAccount, hadAccount, markHadAccount } from '../../lib/backend/seen'
import { notifySessionChanged } from '../../lib/backend/sessionHint'
import { clearRecovery } from '../../lib/backend/recovery'
import { PASSWORD_MIN_LENGTH } from '../../lib/backend/passwordPolicy'

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
/**
 * `wide` hands the full page width to the children and lets them own the
 * heading, and it exists for the same kind of reason `compact` does.
 *
 * Spec SITE-05 D7. A member handbook renders through `HandbookLayout`, whose
 * hero is full-bleed and whose reading column is `max-w-4xl`. Inside this
 * component's own `max-w-3xl` clamp the hero becomes a 48rem band inset in a
 * white page, and the document reads narrower signed in than the same document
 * read on the public page. So a wide page keeps the signed-out and checking
 * states in the panel, where a sign-in card belongs, and renders the signed-in
 * children unclamped with only the member bar in a container of its own.
 */
export function AuthGate({
  title,
  compact,
  wide,
  children,
}: {
  title: string
  compact?: boolean
  wide?: boolean
  children: (session: Session) => ReactNode
}) {
  const { session, recovery } = useSession()

  useEffect(() => {
    if (session) markHadAccount()
    // Spec SITE-03. The nav's signed-in variant is read by `SiteLayout`, which
    // is in the entry chunk and must never import supabase-js. This is the one
    // place a session change is already observed, so it is the one place that
    // tells the shell. Dispatched on sign-out too, which is what retires the
    // member entry without a reload.
    notifySessionChanged()
  }, [session])

  // The signed-out and checking states are a panel in both modes: a sign-in
  // card the width of the viewport is not a better sign-in card.
  const panel = (body: ReactNode) => (
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
      {body}
    </div>
  )

  if (session === undefined) {
    return panel(
      <p className="mt-8 text-ink-faint">{siteLabel('portal.checking', 'Checking your session…')}</p>,
    )
  }
  if (session === null) return panel(<SignInCard returning={hadAccount()} />)

  // Spec SITE-09 c1. A reset link hands back a real session, so without this the
  // person lands in the member shell and no screen ever sets a password — the
  // defect the audit measured on 2026-09-10.
  //
  // It sits INSIDE the gate rather than at one mount point because `App.tsx`
  // mounts a gate per route (review finding B1). Every portal route therefore
  // shows this form until the password is set, which is what makes criterion 1a
  // true across a reload and a nav rather than only on first paint.
  //
  // `wide` is deliberately ignored: a wide page hands the layout to its
  // children, and the children are exactly what must not render yet.
  if (recovery) return panel(<RecoveryCard />)

  if (wide) {
    return (
      <div className="pb-16">
        <div className="mx-auto max-w-6xl px-5 pt-5">
          <MemberBar email={session.user.email ?? ''} compact />
        </div>
        {children(session)}
      </div>
    )
  }

  return panel(
    <>
      <MemberBar email={session.user.email ?? ''} compact={compact} />
      {children(session)}
    </>,
  )
}

/**
 * The new-password form, shown to a browser that arrived through a reset link.
 *
 * Spec SITE-09 c1. Three things here are criteria rather than choices.
 *
 * `updateUser` is the whole point: the old flow emailed a link, signed the
 * person in, and never called it, so the password never changed. Criterion 2
 * proves the change against `encrypted_password` rather than `updated_at`,
 * because consuming the token moves `updated_at` anyway.
 *
 * GoTrue's `LogoutAllExceptMe` fires on a password change, so the sentence about
 * other devices is a description of what happens, not a courtesy. Criterion 3a
 * asserts the other session row is actually gone.
 *
 * Both inputs carry `PASSWORD_MIN_LENGTH` and the mismatch is caught before any
 * network call (criterion 5), which is what keeps a person out of the raw
 * server error that finding 65 describes.
 */
function RecoveryCard() {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [status, setStatus] = useState<'idle' | 'working' | 'done' | 'error'>('idle')
  const [errorText, setErrorText] = useState('')

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (status === 'working') return

    // Both checks run before any network call, per criterion 5. Length first:
    // a person who typed two different short passwords should be told the thing
    // they can fix without retyping both.
    if (password.length < PASSWORD_MIN_LENGTH) {
      setErrorText(
        siteLabel(
          'portal.recovery.tooshort',
          'That password is too short. Please use at least the number of characters shown.',
        ),
      )
      setStatus('error')
      return
    }
    if (password !== confirm) {
      setErrorText(
        siteLabel(
          'portal.recovery.mismatch',
          'Those two passwords are not the same. Please type the same one twice.',
        ),
      )
      setStatus('error')
      return
    }

    setStatus('working')
    setErrorText('')
    const { error } = await supabase().auth.updateUser({ password })
    if (error) {
      setErrorText(error.message)
      setStatus('error')
      return
    }
    // Cleared only on success. A failed attempt leaves the person in recovery,
    // which is where they still are.
    clearRecovery()
    // The nav suppresses the member entries while in recovery, so it has to be
    // told the moment that ends; otherwise they stay missing until a reload.
    notifySessionChanged()
    setStatus('done')
  }

  if (status === 'done') {
    return (
      <div className="mt-8" data-portal-state="recovery-done">
        <p className="text-ink">
          {siteLabel('portal.recovery.done', 'Your password is set. You can sign in with it on any device.')}
        </p>
      </div>
    )
  }

  return (
    // The discriminator criterion 1 asserts on. `MemberBar` carries no data
    // attribute today, so the lane proves the member shell is absent by finding
    // this instead of by failing to find that.
    <div className="mt-8" data-portal-state="recovery">
      {/* The panel's own <h1> is the page's title ("Member portal"), which does
          not say what this screen is for. This heading does, and it is also the
          string criterion 13 greps for in the served chunks. */}
      <h2 className="font-display text-2xl font-semibold tracking-tight text-ink">
        {siteLabel('portal.recovery.heading', 'Set a new password')}
      </h2>
      <p className="mt-2 text-ink-soft">
        {siteLabel(
          'portal.recovery.body',
          'Choose a password you have not used before. Signing in on your other devices will need the new one.',
        )}
      </p>
      <form onSubmit={(e) => void submit(e)} className="mt-4 flex flex-col gap-3">
        <label
          className="text-xs font-semibold uppercase tracking-wide text-ink-faint"
          htmlFor="portal-recovery-password"
        >
          {siteLabel('portal.recovery.password', 'New password')}
        </label>
        <input
          id="portal-recovery-password"
          type="password"
          required
          minLength={PASSWORD_MIN_LENGTH}
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="rounded-lg border border-ink/20 bg-white px-3 py-2.5 text-ink outline-none focus:border-accent"
        />

        <label
          className="text-xs font-semibold uppercase tracking-wide text-ink-faint"
          htmlFor="portal-recovery-confirm"
        >
          {siteLabel('portal.recovery.confirm', 'New password again')}
        </label>
        <input
          id="portal-recovery-confirm"
          type="password"
          required
          minLength={PASSWORD_MIN_LENGTH}
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          className="rounded-lg border border-ink/20 bg-white px-3 py-2.5 text-ink outline-none focus:border-accent"
        />

        <button
          type="submit"
          disabled={status === 'working'}
          className="rounded-full bg-brand px-5 py-2.5 text-sm font-semibold text-white hover:bg-accent disabled:opacity-50"
        >
          {status === 'working'
            ? siteLabel('portal.recovery.working', 'Saving…')
            : siteLabel('portal.recovery.cta', 'Save the new password')}
        </button>
      </form>

      {status === 'error' && <ErrorNote error={errorText} />}

      {/* Criterion 6: leaving without setting a password must be possible, and
          must clear the flag, or the browser is stuck on this form forever. */}
      <button
        type="button"
        className="mt-4 text-xs font-medium text-ink-soft underline hover:text-ink"
        onClick={() => {
          clearRecovery()
          clearHadAccount()
          void supabase().auth.signOut()
        }}
      >
        {siteLabel('portal.recovery.leave', 'Not now')}
      </button>
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
              minLength={PASSWORD_MIN_LENGTH}
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
