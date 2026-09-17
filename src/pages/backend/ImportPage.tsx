import { useCallback, useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { Link } from 'react-router-dom'
import { AuthGate, ErrorNote, L } from './shared'
import { siteLabel } from '../../lib/content/loader'
import { amPortalAdmin } from '../../lib/backend/evalApi'
import {
  importPublicationManual,
  listEvents,
  resolveImportRecipient,
  type PortalEvent,
  type ResolvedRecipient,
} from '../../lib/backend/portalApi'

/**
 * The manual report import. Spec SITE-14, and the SECOND admin-only route in the
 * portal after AttributionsPage.
 *
 * ## The filename is a proof requirement, not a style choice
 *
 * Vite sets no `chunkFileNames` in this repo, so a lazy chunk takes its module's
 * file stem plus a hash. SITE-14's confirm-live proof greps the served index
 * chunk for `assets/ImportPage-<hash>.js` and then greps THAT chunk for
 * `portal.import.title`. Renaming this file to `AdminImportPage.tsx` would make
 * a correctly shipped feature report a count of 0. The spec fixes the name for
 * that reason and the build review checks it.
 *
 * ## What this page is for
 *
 * `publication` has been able to hold a report since August and has had no way
 * to receive one. The reports that predate Honest Eval are per-participant
 * markdown files that already exist, so a paste is the whole transport: no file
 * input, no parser, no conversion step.
 *
 * ## Google Drive is the source of truth, which is why this page reads no path
 *
 * `Final Reports/Final Reports.md` says the vault copies "go stale the moment
 * somebody types in Drive". An import that read a vault path could therefore
 * ship a superseded report to the person it is about and nothing in the schema
 * would notice. So the screen imports what the administrator pastes, and says
 * which document it came from.
 *
 * And one file class must never come through here at all: `<Name> — Source
 * Observations.md` and `Facilitator-Only Observations.md` sit beside the reports
 * and are facilitator-only. Nothing automated distinguishes them from a report
 * except the filename, which is the other reason this page never reads a path.
 *
 * ## Resolve, then confirm, then write
 *
 * The hazard here is not an attacker. It is a well-formed address typed for the
 * wrong person: RLS will faithfully deliver a mis-addressed report to whoever
 * eventually registers with that address, and every access will pass
 * authorization legitimately. SITE-14's brief found that no standard covers it,
 * because the standards give an authorization gate and this needs a correctness
 * gate. The confirm step is that gate, and criterion 14 asserts the first submit
 * writes nothing.
 *
 * ## It is not yet two-factor, and it says so
 *
 * `is_portal_admin()` carries no `aal2` clause, re-measured live in this build.
 * CDT-10 builds the `TwoFactorGate` this page will adopt. **When that lands, the
 * sentence below saying the page is not yet two-factor is deleted in the same
 * edit**, on both this page and AttributionsPage, or they tell an administrator
 * something false.
 */
export default function ImportPage() {
  return (
    <AuthGate title={siteLabel('portal.import.title', 'Import a report')}>
      {(session) => <ImportInner session={session} />}
    </AuthGate>
  )
}

function ImportInner({ session }: { session: Session }) {
  const [isAdmin, setIsAdmin] = useState<boolean | undefined>(undefined)
  const [events, setEvents] = useState<PortalEvent[]>([])
  const [error, setError] = useState('')

  const [email, setEmail] = useState('')
  const [documentId, setDocumentId] = useState('')
  const [title, setTitle] = useState('')
  const [workshopName, setWorkshopName] = useState('')
  const [dateLabel, setDateLabel] = useState('')
  const [eventId, setEventId] = useState('')
  const [bodyMd, setBodyMd] = useState('')

  const [resolved, setResolved] = useState<ResolvedRecipient | null>(null)
  const [busy, setBusy] = useState(false)
  const [importedId, setImportedId] = useState('')

  const load = useCallback(async () => {
    setError('')
    try {
      const admin = await amPortalAdmin()
      setIsAdmin(admin)
      if (!admin) return
      setEvents(await listEvents())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load, session.user.id])

  if (isAdmin === undefined) {
    return <p className="mt-8 text-ink-faint">{siteLabel('portal.import.checking', 'Checking your access…')}</p>
  }

  // The refusal, named rather than hidden behind a redirect, on AttributionsPage's
  // precedent. Criterion 7 asserts no form field exists in this branch.
  if (!isAdmin) {
    return (
      <div className="mt-8 max-w-2xl">
        <L
          as="p"
          id="portal.import.refused"
          fallback="This page is for portal administrators. Your account is not one, so there is nothing here for you to do."
          className="text-ink"
        />
      </div>
    )
  }

  // The report is in. This is a terminal state rather than a cleared form,
  // because "did that work?" is the question an administrator actually has.
  if (importedId) {
    return (
      <div className="mt-8 max-w-2xl" data-site14-imported={importedId}>
        <L
          as="p"
          id="portal.import.done"
          fallback="The report is filed."
          className="text-lg font-semibold text-ink"
        />
        {/* The no-account case is the schema's designed path and not an error
            the administrator should try to fix. Twenty allowlisted people have
            no account, so this is the COMMON outcome while the backfill runs. */}
        {resolved && !resolved.has_account && (
          <L
            as="p"
            id="portal.import.done.unmatched"
            fallback="That person has not registered yet, so the report is waiting for them. It will appear in their portal by itself on the day they sign up, and nobody needs to do anything more."
            className="mt-3 text-sm text-ink-soft"
          />
        )}
        {resolved && resolved.has_account && (
          <L
            as="p"
            id="portal.import.done.matched"
            fallback="That person already has an account, so the report is in their portal now."
            className="mt-3 text-sm text-ink-soft"
          />
        )}
        <button
          type="button"
          className="mt-5 rounded-full border border-brand/40 px-5 py-2.5 text-sm font-semibold text-brand hover:border-accent hover:text-accent"
          data-site14-again
          onClick={() => {
            setImportedId('')
            setResolved(null)
            setEmail('')
            setDocumentId('')
            setTitle('')
            setBodyMd('')
          }}
        >
          {siteLabel('portal.import.again', 'Import another report')}
        </button>
        <Link to="/portal" className="mt-5 ml-4 inline-block text-sm underline">
          {siteLabel('portal.import.back', 'Back to the portal')}
        </Link>
      </div>
    )
  }

  const resolve = async () => {
    setBusy(true)
    setError('')
    try {
      const r = await resolveImportRecipient(email)
      setResolved(r)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const commit = async () => {
    setBusy(true)
    setError('')
    try {
      const id = await importPublicationManual({
        recipientEmail: email,
        documentId,
        title,
        workshopName,
        dateLabel,
        bodyMd,
        eventId: eventId || null,
      })
      setImportedId(id)
    } catch (e) {
      // The database's own message is shown rather than a generic one: every
      // refusal in the function raises a named sentence precisely so the person
      // reading it learns which rule stopped them.
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-8 max-w-3xl" data-site14-import>
      <L
        as="p"
        id="portal.import.intro"
        fallback="Paste a report that was emailed before the portal existed, and the person it is about will be able to read it here for as long as they have an account."
        className="text-ink"
      />

      {/* The source column's comment, made visible. A manual row carries a
          human's word for where it came from and a signed row carries a
          cryptographic claim, and the two must never be indistinguishable.
          Criterion 7 asserts this sentence renders. */}
      <L
        as="p"
        id="portal.import.manual"
        fallback="A report filed here is marked as imported by hand. That is a record of your word for where it came from, not a signed claim from the system that produced it."
        className="mt-4 rounded-lg bg-paper-deep px-4 py-3 text-sm text-ink-soft"
      />

      <L
        as="p"
        id="portal.import.mfa"
        fallback="This page is protected by your password alone. Two-factor protection for administrator screens is not yet switched on for this project."
        className="mt-4 text-sm text-ink-faint"
      />

      {/* Paste from Drive, not from the vault. The vault copies are an archive
          and go stale the moment somebody types in Drive. */}
      <L
        as="p"
        id="portal.import.source"
        fallback="Paste from the Google Drive copy rather than any other, since that is the one people edit. Never paste a source-observations or facilitator-only document: those are not for participants to read."
        className="mt-3 text-sm text-ink-faint"
      />

      {error && <ErrorNote error={error} />}

      <div className="mt-6 space-y-4">
        <Field
          id="site14-email"
          labelId="portal.import.field.email"
          labelFallback="Who the report is for (their email address)"
          value={email}
          onChange={(v) => {
            setEmail(v)
            setResolved(null)
          }}
          disabled={busy}
        />

        <div className="flex flex-wrap gap-4">
          <Field
            id="site14-document"
            labelId="portal.import.field.document"
            labelFallback="Document id (anything that names this report, e.g. the file name)"
            value={documentId}
            onChange={setDocumentId}
            disabled={busy}
          />
          <Field
            id="site14-title"
            labelId="portal.import.field.title"
            labelFallback="Title"
            value={title}
            onChange={setTitle}
            disabled={busy}
          />
        </div>

        <div className="flex flex-wrap gap-4">
          <Field
            id="site14-workshop"
            labelId="portal.import.field.workshop"
            labelFallback="Workshop name"
            value={workshopName}
            onChange={setWorkshopName}
            disabled={busy}
          />
          <Field
            id="site14-date"
            labelId="portal.import.field.date"
            labelFallback="Date label (as it should read on the report)"
            value={dateLabel}
            onChange={setDateLabel}
            disabled={busy}
          />
        </div>

        <div>
          <label className="block text-sm text-ink" htmlFor="site14-event">
            {siteLabel('portal.import.field.event', 'Workshop this belongs to (optional)')}
          </label>
          <select
            id="site14-event"
            className="mt-1 w-full rounded border border-rule bg-paper px-2 py-1 text-sm"
            value={eventId}
            onChange={(e) => setEventId(e.target.value)}
            disabled={busy}
            data-site14-event
          >
            <option value="">{siteLabel('portal.import.field.event.none', 'Not listed')}</option>
            {events.map((ev) => (
              <option key={ev.id} value={ev.id}>
                {ev.title}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-sm text-ink" htmlFor="site14-body">
            {siteLabel('portal.import.field.body', 'The report itself, pasted')}
          </label>
          <textarea
            id="site14-body"
            className="mt-1 h-64 w-full rounded border border-rule bg-paper px-3 py-2 font-mono text-sm"
            value={bodyMd}
            onChange={(e) => setBodyMd(e.target.value)}
            disabled={busy}
            data-site14-body
          />
        </div>
      </div>

      {/* The confirm step. The first submit resolves and writes NOTHING;
          criterion 14 asserts the publication count is unchanged here, and
          mutation 5 removes this branch to prove the assertion can fail. */}
      {!resolved ? (
        <button
          type="button"
          className="mt-6 rounded-full bg-brand px-5 py-2.5 text-sm font-semibold text-white hover:bg-accent disabled:opacity-50"
          disabled={busy || !email.trim()}
          data-site14-resolve
          onClick={() => void resolve()}
        >
          {siteLabel('portal.import.resolve', 'Check who this is for')}
        </button>
      ) : (
        <div className="mt-6 rounded-2xl border border-brand/25 bg-brand-soft/30 p-5" data-site14-confirm>
          <L
            as="p"
            id="portal.import.confirm.title"
            fallback="Check this is the right person before you file the report."
            className="text-sm font-semibold text-ink"
          />

          <p className="mt-2 text-sm text-ink" data-site14-resolved-email>
            {resolved.normalized_email}
          </p>

          {resolved.on_allowlist ? (
            <p className="mt-1 text-sm text-ink-soft" data-site14-resolved-name>
              {resolved.attested_name
                ? `${siteLabel('portal.import.confirm.roster', 'On the participant list as')} ${resolved.attested_name}`
                : siteLabel(
                    'portal.import.confirm.noname',
                    'On the participant list, with no name recorded against it.',
                  )}
            </p>
          ) : (
            <L
              as="p"
              id="portal.import.confirm.offlist"
              fallback="This address is not on the participant list, so the import will be refused. Add it to the list first, or that person could never register to read the report."
              className="mt-1 text-sm text-ink"
            />
          )}

          <p className="mt-1 text-sm text-ink-faint" data-site14-resolved-account>
            {resolved.has_account
              ? siteLabel('portal.import.confirm.account', 'They have an account, so they will see it straight away.')
              : siteLabel(
                  'portal.import.confirm.noaccount',
                  'They have not registered yet. The report will wait for them and appear when they do.',
                )}
          </p>

          <div className="mt-4 flex flex-wrap gap-3">
            <button
              type="button"
              className="rounded-full bg-brand px-5 py-2.5 text-sm font-semibold text-white hover:bg-accent disabled:opacity-50"
              disabled={busy || !documentId.trim() || !bodyMd.trim()}
              data-site14-commit
              onClick={() => void commit()}
            >
              {siteLabel('portal.import.commit', 'File this report')}
            </button>
            <button
              type="button"
              className="rounded-full border border-rule px-5 py-2.5 text-sm disabled:opacity-50"
              disabled={busy}
              data-site14-cancel
              onClick={() => setResolved(null)}
            >
              {siteLabel('portal.import.cancel', 'Not them, go back')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function Field({
  id,
  labelId,
  labelFallback,
  value,
  onChange,
  disabled,
}: {
  id: string
  labelId: string
  labelFallback: string
  value: string
  onChange: (v: string) => void
  disabled: boolean
}) {
  return (
    <div className="min-w-[16rem] flex-1">
      <label className="block text-sm text-ink" htmlFor={id}>
        {siteLabel(labelId, labelFallback)}
      </label>
      <input
        id={id}
        className="mt-1 w-full rounded border border-rule bg-paper px-2 py-1 text-sm"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
      />
    </div>
  )
}
