import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { lazy, Suspense, useEffect, type ReactNode } from 'react'
import { getContent, memberPages, redirects } from './lib/content/loader'
import { getRouteMeta } from './lib/meta'
import { backendEnabled } from './lib/backend/config'
import { SiteLayout } from './components/layout/SiteLayout'
import { HomePage } from './pages/HomePage'
import { ContentPage } from './pages/ContentPage'
import { WorkshopsIndexPage } from './pages/WorkshopsIndexPage'
import { WorkshopPage } from './pages/WorkshopPage'
import { HandbookPage } from './pages/HandbookPage'
import { NotFoundPage } from './pages/NotFoundPage'

// Participant-area pages: lazy chunks so supabase-js never touches the main
// bundle or the SSR prerender. Routes exist only when the backend flag is on.
//
// AccountPage / EventsPage / CertificatesPage are deliberately NOT routed. They
// were written against `supabase/schema.sql`'s fresh-project design (profiles
// with a role column, registrations, evaluations, certificates), and the live
// portal project has none of those tables — so routing them would show a
// participant a raw PostgREST "table not found" inside the sign-in shell. The
// files stay, with a DORMANT header, because docs/PHASE-2-BACKEND.md is a memo
// people read and a memo describing deleted files becomes archaeology.
const PortalPage = lazy(() => import('./pages/backend/PortalPage'))
const PortalReportPage = lazy(() => import('./pages/backend/PortalReportPage'))
// Spec CDT-04. `/portal/a/:assignmentId` is the PERMANENT anchor: once an
// invitation email carries it the shape cannot change, so the id is the opaque
// uuid from `assignment.id` and never a name-derived slug. The queue lives at
// /portal/assignments rather than at /portal, because /portal is the member's
// report list and a consultant is usually also a member.
const AssignmentsPage = lazy(() => import('./pages/backend/AssignmentsPage'))
const AssignmentPage = lazy(() => import('./pages/backend/AssignmentPage'))
// Spec SITE-03. One component for every member route: the body comes from
// `member_page` / `member_block` behind RLS, not from site-content.json, so the
// route is all that distinguishes one from another.
const MemberPage = lazy(() => import('./pages/backend/MemberPage'))

function Deferred({ children }: { children: ReactNode }) {
  return <Suspense fallback={<p className="mx-auto max-w-3xl px-5 py-16 text-ink-faint">Loading…</p>}>{children}</Suspense>
}

/**
 * Keeps the tab title in sync with the content store on client navigation, and
 * owns scroll position across it.
 *
 * The hash check is load-bearing. Participants hold deep links into the Bali
 * handbook (`#s08-travel` and 20 others) in email, and the browser's own jump to
 * the anchor happens before React mounts: an unconditional scrollTo(0, 0) here
 * undid it on every one of them, landing the reader at the top of a 20-page
 * document instead.
 */
function TitleSync() {
  const { pathname, hash } = useLocation()
  useEffect(() => {
    document.title = getRouteMeta(pathname).title
    if (hash) {
      document.getElementById(decodeURIComponent(hash.slice(1)))?.scrollIntoView()
      return
    }
    window.scrollTo(0, 0)
  }, [pathname, hash])
  return null
}

export default function App() {
  const { pages } = getContent()
  return (
    <SiteLayout>
      <TitleSync />
      <Routes>
        <Route path="/" element={<HomePage />} />
        {/* `p.access !== 'member'` is a control and not tidiness (SITE-03
            finding 3). This map is what actually registers a content page:
            App.tsx never reads allRoutes(), so dropping a member route from
            that list removes its prerendered directory and leaves this
            registration standing. The member route below would then be the
            SECOND match for the same path, and the tie resolves in tree order
            to this one — the ungated component. Criterion 4 removes this filter
            and watches the sign-in card disappear. */}
        {pages
          .filter((p) => p.route !== '/' && p.route !== '/workshops')
          .filter((p) => p.access !== 'member')
          .map((p) => (
            <Route
              key={p.id}
              path={p.route}
              element={p.layout === 'handbook' ? <HandbookPage pageId={p.id} /> : <ContentPage pageId={p.id} />}
            />
          ))}
        {/* Retired routes. The prerender writes a static meta-refresh page for
            each; these handle the same URLs during client-side navigation. */}
        {Object.entries(redirects()).map(([from, to]) => (
          <Route key={from} path={from} element={<Navigate replace to={to} />} />
        ))}
        <Route path="/workshops" element={<WorkshopsIndexPage />} />
        <Route path="/workshops/:slug" element={<WorkshopPage />} />
        {backendEnabled && (
          <>
            {/* Member routes. Registered only with the backend on, because a
                member page with no way to sign in is a permanent spinner; with
                the flag off these paths fall through to the 404 below, which is
                the same answer a stranger gets. */}
            {memberPages().map((p) => (
              <Route
                key={p.id}
                path={p.route}
                element={<Deferred><MemberPage route={p.route} pageId={p.id} /></Deferred>}
              />
            ))}
            <Route path="/portal" element={<Deferred><PortalPage /></Deferred>} />
            <Route path="/portal/r/:reportId" element={<Deferred><PortalReportPage /></Deferred>} />
            <Route path="/portal/assignments" element={<Deferred><AssignmentsPage /></Deferred>} />
            <Route path="/portal/a/:assignmentId" element={<Deferred><AssignmentPage /></Deferred>} />
          </>
        )}
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </SiteLayout>
  )
}
