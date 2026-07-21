import { Route, Routes, useLocation } from 'react-router-dom'
import { useEffect } from 'react'
import { getContent } from './lib/content/loader'
import { getRouteMeta } from './lib/meta'
import { SiteLayout } from './components/layout/SiteLayout'
import { HomePage } from './pages/HomePage'
import { ContentPage } from './pages/ContentPage'
import { WorkshopsIndexPage } from './pages/WorkshopsIndexPage'
import { WorkshopPage } from './pages/WorkshopPage'
import { NotFoundPage } from './pages/NotFoundPage'

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
            <Route key={p.id} path={p.route} element={<ContentPage pageId={p.id} />} />
          ))}
        <Route path="/workshops" element={<WorkshopsIndexPage />} />
        <Route path="/workshops/:slug" element={<WorkshopPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </SiteLayout>
  )
}
