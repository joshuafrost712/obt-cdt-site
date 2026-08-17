import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { lazy, Suspense, useEffect, type ReactNode } from 'react'
import { getContent, redirects } from './lib/content/loader'
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
        {pages
          .filter((p) => p.route !== '/' && p.route !== '/workshops')
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
            <Route path="/portal" element={<Deferred><PortalPage /></Deferred>} />
            <Route path="/portal/r/:reportId" element={<Deferred><PortalReportPage /></Deferred>} />
          </>
        )}
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </SiteLayout>
  )
}
