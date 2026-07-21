/**
 * Per-route document metadata, resolved from the content store so the browser
 * tab title, the prerendered <title>, and the page heading all share a source.
 */
import { getContent, pageByRoute } from './content/loader'

export interface RouteMeta {
  title: string
  description: string
}

export function getRouteMeta(route: string): RouteMeta {
  const site = getContent().site
  const page = pageByRoute(route)
  if (!page) return { title: site.title, description: site.tagline }
  // The home page IS the site, so it carries the plain site title.
  const title = page.route === '/' ? site.title : `${page.title} · ${site.title}`
  return { title, description: page.metaDescription }
}
