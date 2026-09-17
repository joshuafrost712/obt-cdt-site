import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { AuthGate, ErrorNote } from './shared'
import { listMyReports, type PortalReportRow } from '../../lib/backend/portalApi'
import { amPortalAdmin } from '../../lib/backend/evalApi'
import { siteLabel } from '../../lib/content/loader'

/**
 * The member's list of reports, grouped by workshop.
 *
 * Three outcomes are shown differently on purpose: still loading, loaded and
 * empty, and loaded with rows. Most accounts will legitimately be empty for a
 * while — everyone on the sign-up sheet can sign in, but only people who have
 * attended a workshop have reports — so "empty" is a normal state that has to
 * read as reassurance rather than as a failure.
 */
export default function PortalPage() {
  return (
    <AuthGate title={siteLabel('portal.title', 'Member portal')}>
      {() => (
        <>
          <EvaluationsLink />
          <AccountLink />
          <ReportList />
        </>
      )}
    </AuthGate>
  )
}

/**
 * The way in to `/portal/evaluations`. Spec SITE-02.
 *
 * It is here rather than in the site nav because program finding 25 measured the
 * signed-in bar at nine entries already clipping at 768px, and this is a portal
 * surface rather than a member page. Without it the evaluation is reachable only
 * from a link in the covering email, and a participant who signs in first — most
 * of them — lands on an empty report list with no way to their own round.
 *
 * It is unconditional on purpose. Asking whether this member is in any round
 * would be a second query on every portal load to hide a link whose own page
 * already says, in a sentence, that there is nothing yet.
 */
function EvaluationsLink() {
  return (
    <div className="mt-8 rounded-2xl border border-brand/25 bg-brand-soft/30 p-5" data-portal-evaluations>
      <p className="text-sm leading-relaxed text-ink">
        {siteLabel(
          'portal.list.evaluations.body',
          'If you have been to a workshop, this is where you say how it went, and where you can read back what you said.',
        )}
      </p>
      <Link
        to="/portal/evaluations"
        className="mt-3 inline-block rounded-full bg-brand px-5 py-2.5 text-sm font-semibold text-white hover:bg-accent"
      >
        {siteLabel('portal.list.evaluations.cta', 'Your workshop evaluations')}
      </Link>
    </div>
  )
}

/**
 * The way in to `/portal/account`. Spec SITE-12, on SITE-02's precedent above.
 *
 * A card rather than a nav entry, for the reason EvaluationsLink gives: program
 * finding 25 measured the signed-in bar at nine entries clipping at 768px, and
 * `navItems()` builds that bar from `content.pages`, which a `/portal/*` route
 * is not in.
 *
 * SITE-12 D4 names the gap this leaves rather than hiding it: a member who
 * follows a covering-email link straight to `/portal/evaluations` never passes
 * `/portal` and never sees this card. The fix is one link in `MemberBar`, which
 * lives in `shared.tsx` — a file SITE-09 owns for the length of its row, so it
 * is handed to that spec's re-review rather than taken here.
 */
function AccountLink() {
  return (
    <div className="mt-8 rounded-2xl border border-ink/10 bg-white/60 p-5" data-portal-account>
      <p className="text-sm leading-relaxed text-ink">
        {siteLabel(
          'portal.account.card.body',
          'Your name is how the portal addresses you, and it comes from the OBT-CDT participant list. Change it here if it is wrong, or if you would rather be called something else.',
        )}
      </p>
      <Link
        to="/portal/account"
        className="mt-3 inline-block rounded-full border border-brand/40 px-5 py-2.5 text-sm font-semibold text-brand hover:border-accent hover:text-accent"
      >
        {siteLabel('portal.account.card.cta', 'Your name and details')}
      </Link>
    </div>
  )
}

function ReportList() {
  const [rows, setRows] = useState<PortalReportRow[] | undefined>(undefined)
  const [isAdmin, setIsAdmin] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true
    listMyReports()
      .then((r) => alive && setRows(r))
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)))
    // Spec SITE-14 criterion 7. This is a SECOND query on every portal load, for
    // all 22 members, to make one sentence conditional — and D4 names it as an
    // accepted cost rather than leaving a later reader to find it. Admin-ness
    // cannot be derived from the rows already fetched, because LIST_COLUMNS does
    // not select `profile_id`; widening it would send every row's profile id to
    // every client to save a call, trading a query for a disclosure.
    amPortalAdmin()
      .then((a) => alive && setIsAdmin(a))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  if (error) return <ErrorNote error={error} />
  if (rows === undefined) {
    return <p className="mt-8 text-ink-faint">{siteLabel('portal.list.loading', 'Loading your reports…')}</p>
  }

  if (rows.length === 0) {
    return (
      <div className="mt-8 rounded-2xl border border-ink/10 bg-white/60 p-6">
        <p className="text-sm leading-relaxed text-ink-soft">
          {siteLabel(
            'portal.list.empty',
            'You are on the OBT-CDT list. Reports appear here after a workshop you attend, once they have been sent to you.',
          )}
        </p>
      </div>
    )
  }

  // Group by workshop, preserving the newest-first order the query returned.
  const groups: { name: string; rows: PortalReportRow[] }[] = []
  for (const row of rows) {
    const name = row.workshop_name || siteLabel('portal.list.ungrouped', 'Other')
    const last = groups[groups.length - 1]
    if (last && last.name === name) last.rows.push(row)
    else groups.push({ name, rows: [row] })
  }

  return (
    <div className="mt-8 flex flex-col gap-8">
      {/* Spec SITE-14 criterion 7. The read policy on `publication` ends in `or
          is_portal_admin()` with NO match_state, visibility or recipient_role
          filter, and listMyReports() adds none either, so an administrator's
          list is every report in the portal and not their own. It says "every"
          rather than "every matched" for that reason: rows for people who have
          not registered yet will be the common case while the backfill runs.
          Asserted in both directions, present for an admin and absent for a
          member, so a node that rendered unconditionally would fail. */}
      {isAdmin && (
        <p
          className="rounded-2xl border border-brand/25 bg-brand-soft/30 px-4 py-3 text-sm text-ink-soft"
          data-site14-admin-note
        >
          {siteLabel(
            'portal.list.admin_note',
            'You are a portal administrator, so this list shows every report in the portal, including ones filed for people who have not registered yet. It is not only yours.',
          )}
        </p>
      )}
      {groups.map((group) => (
        <section key={group.name}>
          <h2 className="font-display text-lg font-semibold text-ink">{group.name}</h2>
          <ul className="mt-3 flex flex-col gap-2">
            {group.rows.map((row) => (
              <li key={row.id}>
                <Link
                  to={`/portal/r/${row.id}`}
                  className="flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-xl border border-ink/10 bg-white/60 px-4 py-3 no-underline hover:bg-paper-deep"
                >
                  <span className="font-medium text-ink">{row.title || row.subject}</span>
                  {row.date_label && <span className="text-xs text-ink-faint">{row.date_label}</span>}
                  {row.superseded_by && (
                    <span className="rounded-full bg-paper-deep px-2 py-0.5 text-xs text-ink-soft">
                      {siteLabel('portal.list.superseded', 'A later version was sent')}
                    </span>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}
