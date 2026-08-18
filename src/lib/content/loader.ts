/**
 * Content loader. Keep all access to site content behind this module so the
 * source can change without touching the renderer. The nav, page headings and
 * document titles all resolve from the same nodes, so one edit propagates
 * everywhere the text appears.
 */
import rawContent from '../../content/site-content.json'
import type { PageDef, SiteContent, WorkshopDef } from '../../schema/types'

const content = rawContent as unknown as SiteContent

export function getContent(): SiteContent {
  return content
}

/**
 * Any node edit-in-place can target: a page, a workshop, the site, or a block.
 * A structural view (id + arbitrary fields) so every content interface fits.
 */
export type AnyNode = { id: string } & Record<string, unknown>

export interface NodeRef {
  node: AnyNode
  parents: AnyNode[]
}

/** Depth-first walk over blocks/items in document order. */
function walkNode(node: AnyNode, parents: AnyNode[], visit: (n: AnyNode, parents: AnyNode[]) => void) {
  visit(node, parents)
  for (const key of ['blocks', 'items'] as const) {
    const children = (node as Record<string, unknown>)[key] as AnyNode[] | undefined
    for (const child of children ?? []) walkNode(child, [...parents, node], visit)
  }
}

let indexCache: Map<string, NodeRef> | null = null

export function nodeIndex(): Map<string, NodeRef> {
  if (indexCache) return indexCache
  const map = new Map<string, NodeRef>()
  const roots = [content.site, ...content.pages, ...content.workshops] as unknown as AnyNode[]
  for (const root of roots) walkNode(root, [], (node, parents) => map.set(node.id as string, { node, parents }))
  indexCache = map
  return map
}

export function findNode(id: string): NodeRef | undefined {
  return nodeIndex().get(id)
}

/** A site-level label token (badge text etc.), by node id, with fallback. */
export function siteLabel(id: string, fallback: string): string {
  const node = findNode(id)?.node
  return (node?.label as string | undefined) ?? fallback
}

export function pageByRoute(route: string): PageDef | WorkshopDef | undefined {
  const clean = route !== '/' && route.endsWith('/') ? route.slice(0, -1) : route
  return (
    content.pages.find((p) => p.route === clean) ?? content.workshops.find((w) => w.route === clean)
  )
}

export function pageById(id: string): PageDef | undefined {
  return content.pages.find((p) => p.id === id)
}

export function workshops(): WorkshopDef[] {
  return content.workshops
}

export function workshopBySlug(slug: string): WorkshopDef | undefined {
  return content.workshops.find((w) => w.id === slug)
}

/** Top-of-site navigation, derived from the content so labels single-source. */
export interface NavItem {
  route: string
  label: string
  /** Node id the label derives from, for edit-in-place tagging. */
  nodeId: string
}

/**
 * `navHidden` as well as `hidden`, because a page can be indexed and still not
 * belong in the nav: the Crash Course handbook is reached through the Psalms
 * workshop page, and a nav that grows an entry per workshop-specific document
 * stops being a nav.
 */
export function navItems(): NavItem[] {
  return content.pages
    .filter((p) => !p.hidden && !p.navHidden)
    .map((p) => ({ route: p.route, label: p.navLabel, nodeId: p.id }))
}

/** Every concrete route the site serves; the prerender script walks this. */
export function allRoutes(): string[] {
  return [...content.pages.map((p) => p.route), ...content.workshops.map((w) => w.route)]
}

/**
 * Routes that are prerendered but unlisted: no sitemap entry, noindex in the
 * head, no nav link. The prerender script reads this to decide both.
 *
 * Workshops are included as well as pages. A workshop is never in the top nav
 * anyway, but `hidden` also has to keep it out of the sitemap and put noindex in
 * its head, and reading only `pages` here would have failed silently.
 *
 * `navHidden` deliberately does NOT count here: it withholds the nav entry only.
 */
export function hiddenRoutes(): string[] {
  return [...content.pages, ...content.workshops].filter((p) => p.hidden).map((p) => p.route)
}

/**
 * Routes that no longer exist and redirect to a live one. The prerender script
 * writes a small meta-refresh page for each, so a link already in someone's
 * inbox keeps working.
 */
export function redirects(): Record<string, string> {
  return {
    // The Bali 2026 handbook became part of the Psalms workshop page (2026-07-28).
    '/workshops/psalms-bali-2026/handbook': '/workshops/psalms-bali-2026',
  }
}
