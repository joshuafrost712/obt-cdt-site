import { useCallback, useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { AuthGate, ErrorNote, L } from './shared'
import { siteLabel } from '../../lib/content/loader'
import {
  amPortalAdmin,
  attributionHistory,
  attributionQueue,
  detachResponse,
  resolveResponse,
  type AttributionHistoryRow,
  type AttributionRow,
} from '../../lib/backend/evalApi'

/**
 * The attribution queue. Spec SITE-08 D7, and the FIRST admin-only route in
 * the portal.
 *
 * ## What this page is for
 *
 * The round-1 covering message told a cohort that naming themselves on the
 * form buys that "these answers can follow you into the portal later". The
 * form collected an optional name and no address, so the only route from a
 * typed name to an account is a person reading it and deciding. This is that
 * person's screen.
 *
 * ## Three sections, keyed on what is owed
 *
 * `matched` first because it is the fastest to clear, then `ambiguous`, then
 * `unmatched`. That order follows `AssignmentsPage.tsx:22-31`'s measured
 * lesson that sections key on what is owed rather than on what is tidy.
 *
 * ## A matched row is a SUGGESTION and never a decision already made
 *
 * The failure mode of this page is an administrator clicking down a pre-sorted
 * list and treating the bucket as an answer. So a matched row says, in its own
 * copy, that the name matched the roster and that nothing has been attached.
 * Criterion 5 asserts the system half of that — `profile_id` is still null
 * after the queue is read — and the sentence is the human half.
 *
 * ## The gate is a refusal sentence, not a redirect
 *
 * A route that 404s teaches nothing and a redirect to `/portal` looks like a
 * bug. The client can discover whether it is an administrator, because
 * `portal_admin` grants `SELECT` to `authenticated` and `is_portal_admin()` is
 * executable by it (both measured), which is what makes an honest refusal
 * possible here.
 *
 * ## It is not yet two-factor, and it says so
 *
 * `is_portal_admin()` carries no `aal2` clause on this project and cannot
 * acquire one until `20260821120000_admin_mfa.sql` applies, which needs an
 * enrolled factor. CDT-10 builds the `TwoFactorGate` this page will adopt,
 * taking `portal_admin` as its predicate prop. **When that lands, the sentence
 * below saying the page is not yet two-factor is deleted in the same edit**, or
 * this page tells an administrator something false.
 */
export default function AttributionsPage() {
  return (
    <AuthGate title={siteLabel('portal.attrib.title', 'Attribute evaluation responses')}>
      {(session) => <AttributionsInner session={session} />}
    </AuthGate>
  )
}

function AttributionsInner({ session }: { session: Session }) {
  const [isAdmin, setIsAdmin] = useState<boolean | undefined>(undefined)
  const [rows, setRows] = useState<AttributionRow[] | undefined>(undefined)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setError('')
    try {
      const admin = await amPortalAdmin()
      setIsAdmin(admin)
      if (!admin) return
      setRows(await attributionQueue())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load, session.user.id])

  if (isAdmin === undefined) {
    return <p className="mt-8 text-ink-faint">{siteLabel('portal.attrib.checking', 'Checking your access…')}</p>
  }

  // The refusal, named rather than hidden behind a redirect.
  if (!isAdmin) {
    return (
      <div className="mt-8 max-w-2xl">
        <L
          as="p"
          id="portal.attrib.refused"
          fallback="This page is for portal administrators. Your account is not one, so there is nothing here for you to do."
          className="text-ink"
        />
      </div>
    )
  }

  const section = (bucket: AttributionRow['bucket']) => (rows ?? []).filter((r) => r.bucket === bucket)

  return (
    <div className="mt-8 max-w-4xl">
      <L
        as="p"
        id="portal.attrib.intro"
        fallback="Each response below was imported from a Google Form and is not yet attached to anybody's account. The name shown is exactly what that person typed. Attaching a response lets its author re-read it in the portal, forever."
        className="text-ink"
      />
      <L
        as="p"
        id="portal.attrib.mfa"
        fallback="This page is protected by your password alone. Two-factor protection for administrator screens is not yet switched on for this project."
        className="mt-4 text-sm text-ink-faint"
      />

      {error && <ErrorNote error={error} />}

      <QueueSection
        bucket="matched"
        rows={section('matched')}
        titleId="portal.attrib.matched.title"
        titleFallback="The typed name matches one person on the roster"
        emptyId="portal.attrib.matched.empty"
        emptyFallback="No response's typed name matches exactly one name on the roster."
        noteId="portal.attrib.matched.note"
        noteFallback="A match is a suggestion, not a decision. Nothing here has been attached to anybody, and nothing will be until you choose a name and attach it."
        onDone={load}
      />
      <QueueSection
        bucket="ambiguous"
        rows={section('ambiguous')}
        titleId="portal.attrib.ambiguous.title"
        titleFallback="The typed name matches more than one person"
        emptyId="portal.attrib.ambiguous.empty"
        emptyFallback="No response's typed name matches more than one name on the roster."
        noteId="portal.attrib.ambiguous.note"
        noteFallback="Two roster entries normalise to this name. Pick the person you believe wrote it, or mark it as unidentifiable."
        onDone={load}
      />
      <QueueSection
        bucket="unmatched"
        rows={section('unmatched')}
        titleId="portal.attrib.unmatched.title"
        titleFallback="No match, or no name given"
        emptyId="portal.attrib.unmatched.empty"
        emptyFallback="Every response with a name or a blank has been decided."
        noteId="portal.attrib.unmatched.note"
        noteFallback="These typed a name that matches nobody on the roster, or left the name blank. A blank one can never be traced by any means; if you cannot identify it, mark it so and say why."
        onDone={load}
      />
    </div>
  )
}

function QueueSection({
  bucket,
  rows,
  titleId,
  titleFallback,
  emptyId,
  emptyFallback,
  noteId,
  noteFallback,
  onDone,
}: {
  bucket: AttributionRow['bucket']
  rows: AttributionRow[]
  titleId: string
  titleFallback: string
  emptyId: string
  emptyFallback: string
  noteId: string
  noteFallback: string
  onDone: () => Promise<void>
}) {
  return (
    <section className="mt-10" data-attrib-section={bucket}>
      <L as="h2" id={titleId} fallback={titleFallback} className="text-lg font-semibold text-ink" />
      <L as="p" id={noteId} fallback={noteFallback} className="mt-1 text-sm text-ink-faint" />

      {/* Program finding 47: a zero is a result the operator has to see, so an
          empty section renders its own sentence rather than a blank region.
          Criterion 17 asserts this per section. */}
      {rows.length === 0 ? (
        <L
          as="p"
          id={emptyId}
          fallback={emptyFallback}
          className="mt-4 rounded border border-rule bg-paper-alt px-4 py-3 text-sm text-ink-faint"
        />
      ) : (
        <ul className="mt-4 space-y-4">
          {rows.map((r) => (
            <QueueRow key={r.responseId} row={r} onDone={onDone} />
          ))}
        </ul>
      )}
    </section>
  )
}

function QueueRow({ row, onDone }: { row: AttributionRow; onDone: () => Promise<void> }) {
  const [choice, setChoice] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [history, setHistory] = useState<AttributionHistoryRow[] | undefined>(undefined)

  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    setError('')
    try {
      await fn()
      await onDone()
    } catch (e) {
      // The database's own message is shown rather than a generic one: every
      // refusal in D4 raises a named message precisely so the person reading
      // it learns which rule stopped them.
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const attachable = row.candidates.filter((c) => c.profileId)

  return (
    <li className="rounded border border-rule bg-paper p-4" data-attrib-row={row.responseId}>
      <p className="text-sm text-ink-faint">
        {row.roundDisplayName} · {new Date(row.submittedAt).toLocaleDateString()}
      </p>

      {/* The name EXACTLY as typed, in quotation marks, so an administrator can
          see a nickname or a stray address for what it is. */}
      <p className="mt-1 text-ink" data-attrib-typed={row.responseId}>
        {row.typedName ? `“${row.typedName}”` : siteLabel('portal.attrib.noname', 'No name given')}
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <select
          className="rounded border border-rule bg-paper px-2 py-1 text-sm"
          value={choice}
          onChange={(e) => setChoice(e.target.value)}
          aria-label={siteLabel('portal.attrib.picker', 'Choose the person who wrote this')}
          data-attrib-picker={row.responseId}
          disabled={busy}
        >
          <option value="">{siteLabel('portal.attrib.picker', 'Choose the person who wrote this')}</option>
          {/* The candidate's full name here is the ATTESTED name from
              member_allowlist, never profiles.full_name. Criterion 5's
              mutation (b) and criterion 17 both assert this string. */}
          {attachable.map((c) => (
            <option key={c.profileId} value={c.profileId as string}>
              {c.fullName ? `${c.fullName} · ${c.email}` : c.email}
            </option>
          ))}
        </select>

        <button
          type="button"
          className="rounded bg-ink px-3 py-1 text-sm text-paper disabled:opacity-50"
          disabled={busy || !choice}
          data-attrib-attach={row.responseId}
          onClick={() => run(() => resolveResponse({ responseId: row.responseId, profileId: choice, reason }))}
        >
          {siteLabel('portal.attrib.attach', 'Attach to this person')}
        </button>
      </div>

      {/* An on-roster address with no account is shown rather than omitted,
          because an administrator needs to tell "not on the roster" from "on
          the roster and never registered". It cannot be attached to. */}
      {row.candidates.length > attachable.length && (
        <L
          as="p"
          id="portal.attrib.noaccount"
          fallback="Some people on the roster have never signed in, so they cannot be chosen here yet. They will appear once they register."
          className="mt-2 text-xs text-ink-faint"
        />
      )}

      <div className="mt-3">
        <label className="block text-xs text-ink-faint" htmlFor={`reason-${row.responseId}`}>
          {siteLabel('portal.attrib.reason', 'Why (required to mark this unidentifiable)')}
        </label>
        <input
          id={`reason-${row.responseId}`}
          className="mt-1 w-full rounded border border-rule bg-paper px-2 py-1 text-sm"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          disabled={busy}
          data-attrib-reason={row.responseId}
        />
      </div>

      <div className="mt-3 flex flex-wrap gap-3">
        <button
          type="button"
          className="rounded border border-rule px-3 py-1 text-sm disabled:opacity-50"
          disabled={busy || !reason.trim()}
          data-attrib-unattributable={row.responseId}
          onClick={() => run(() => resolveResponse({ responseId: row.responseId, profileId: null, reason }))}
        >
          {siteLabel('portal.attrib.unattributable', 'Cannot be identified')}
        </button>

        <button
          type="button"
          className="text-sm text-ink-faint underline"
          disabled={busy}
          data-attrib-history={row.responseId}
          onClick={() =>
            run(async () => {
              setHistory(await attributionHistory(row.responseId))
            })
          }
        >
          {siteLabel('portal.attrib.history', 'History')}
        </button>
      </div>

      {error && <ErrorNote error={error} />}

      {history && (
        <div className="mt-3 border-t border-rule pt-3" data-attrib-historylist={row.responseId}>
          {history.length === 0 ? (
            <L
              as="p"
              id="portal.attrib.history.empty"
              fallback="Nothing has been decided about this response yet."
              className="text-xs text-ink-faint"
            />
          ) : (
            <ul className="space-y-1 text-xs text-ink-faint">
              {history.map((h) => (
                <li key={h.id}>
                  {new Date(h.at).toLocaleString()} · {h.action}
                  {h.subjectEmail ? ` → ${h.subjectEmail}` : ''} · {h.actorEmail}
                  {h.reason ? ` · ${h.reason}` : ''}
                </li>
              ))}
            </ul>
          )}
          {/* Detach lives here rather than in the row, because a correction is
              not part of the ordinary pass down the list. It refuses a portal
              filing and an open round. */}
          <button
            type="button"
            className="mt-2 text-xs text-ink-faint underline disabled:opacity-50"
            disabled={busy || !reason.trim()}
            data-attrib-detach={row.responseId}
            onClick={() => run(() => detachResponse({ responseId: row.responseId, reason }))}
          >
            {siteLabel('portal.attrib.detach', 'Detach this response (needs a reason above)')}
          </button>
        </div>
      )}
    </li>
  )
}
