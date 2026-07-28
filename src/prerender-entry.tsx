/**
 * SSR entry for the build-time prerender (scripts/prerender.mjs). Renders the
 * app for one route and returns the HTML plus that route's metadata. Never
 * shipped to the browser. Keep this file free of anything that touches
 * window/localStorage/IndexedDB at module scope.
 */
import { StrictMode } from 'react'
import { renderToString } from 'react-dom/server'
import { StaticRouter } from 'react-router'
import App from './App'
import { getRouteMeta } from './lib/meta'
import { allRoutes, hiddenRoutes as unlistedRoutes, redirects as movedRoutes } from './lib/content/loader'

export function render(url: string): { html: string; title: string; description: string } {
  // Same basename as the client BrowserRouter, so hrefs match at hydration.
  // StaticRouter only matches locations that INCLUDE the basename, so prefix it.
  const base = import.meta.env.BASE_URL
  const location = base.replace(/\/$/, '') + url
  const html = renderToString(
    <StrictMode>
      <StaticRouter basename={base} location={location}>
        <App />
      </StaticRouter>
    </StrictMode>,
  )
  const meta = getRouteMeta(url)
  return { html, ...meta }
}

export function routes(): string[] {
  return allRoutes()
}

/** Prerendered but unlisted: noindex in the head, no sitemap entry. */
export function hiddenRoutes(): string[] {
  return unlistedRoutes()
}

/** Retired route → live route. The prerender writes a meta-refresh page for each. */
export function redirects(): Record<string, string> {
  return movedRoutes()
}
