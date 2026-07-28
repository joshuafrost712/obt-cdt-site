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
const AccountPage = lazy(() => import('./pages/backend/AccountPage'))
const EventsPage = lazy(() => import('./pages/backend/EventsPage'))
const CertificatesPage = lazy(() => import('./pages/backend/CertificatesPage'))

function Deferred({ children }: { children: ReactNode }) {
  return <Suspense fallback={<p className="mx-auto max-w-3xl px-5 py-16 text-ink-faint">Loading…</p>}>{children}</Suspense>
}

/** Keeps the tab title in sync with the content store on client navigation. */
function TitleSync() {
  const { pathname } = useLocation()
  useEffect(() => {
    document.title = getRouteMeta(pathname).title
    window.scrollTo(0, 0)
  }, [pathname])
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
            <Route path="/account" element={<Deferred><AccountPage /></Deferred>} />
            <Route path="/events" element={<Deferred><EventsPage /></Deferred>} />
            <Route path="/certificates" element={<Deferred><CertificatesPage /></Deferred>} />
          </>
        )}
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </SiteLayout>
  )
}
