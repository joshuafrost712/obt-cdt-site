/**
 * Content loader. Keep all access to site content behind this module so the
 * source can change without touching the renderer. The nav, page headings and
 * document titles all resolve from the same nodes, so one edit propagates
 * everywhere the text appears.
 */
import rawContent from '../../content/site-content.json'
import type { MovedAnchor, PageDef, SiteContent, WorkshopDef } from '../../schema/types'

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
export function navItems({ signedIn = false }: { signedIn?: boolean } = {}): NavItem[] {
  return content.pages
    .filter((p) => !p.hidden && !p.navHidden)
    // A member page's entry is shown only to someone who could open it. The
    // route and the label are public either way (SITE-03 decision 4); this is
    // courtesy, not a control, and SiteLayout is the one call site.
    .filter((p) => p.access !== 'member' || signedIn)
    .map((p) => ({ route: p.route, label: p.navLabel, nodeId: p.id }))
}

/**
 * Every PUBLIC route the site serves; the prerender script walks exactly this
 * list, so a member route returned here would get a directory in `dist/` with
 * its body rendered into the HTML.
 *
 * Spec SITE-03. Dropping a route from here is necessary and nowhere near
 * sufficient: `App.tsx` maps `content.pages` directly and `/workshops/:slug` is
 * a pattern, so two more controls sit beside this one. See `PageDef.access`.
 */
export function allRoutes(): string[] {
  return [
    ...content.pages.filter((p) => p.access !== 'member').map((p) => p.route),
    ...content.workshops.filter((w) => w.access !== 'member').map((w) => w.route),
  ]
}

/**
 * The mirror of `allRoutes()`: routes whose body lives in the portal database
 * behind RLS. Registered client-side only, served by the 404 shell, never
 * prerendered and never in the sitemap.
 *
 * These two functions partition the content routes, which is what lets the
 * build gate assert per route by name rather than comparing two counts that
 * both derive from the same source and therefore move together.
 */
export function memberRoutes(): string[] {
  return [
    ...content.pages.filter((p) => p.access === 'member').map((p) => p.route),
    ...content.workshops.filter((w) => w.access === 'member').map((w) => w.route),
  ]
}

/**
 * Fragments that have moved off this route and behind the gate, if any.
 *
 * Keyed by route rather than by node so the one call site (`SiteLayout`) needs
 * no knowledge of which page component is rendering.
 */
export function movedAnchorsFor(route: string): MovedAnchor[] {
  return pageByRoute(route)?.movedAnchors ?? []
}

/** Every member node, page or workshop. What the build gate iterates. */
export function memberNodes(): (PageDef | WorkshopDef)[] {
  return [
    ...content.pages.filter((p) => p.access === 'member'),
    ...content.workshops.filter((w) => w.access === 'member'),
  ]
}

/**
 * The member nodes that get a gated route of their own: PAGES ONLY.
 *
 * A member WORKSHOP is refused rather than re-rendered, and the asymmetry is
 * deliberate. A workshop node carries `facts` — dates, location, status — that
 * the index cards and the facts panel render and that no member page component
 * knows about, so routing one here would publish a half-rendered workshop. More
 * to the point, nobody needs the shape: SITE-05 keeps `/workshops/psalms-bali-2026`
 * public and moves its specifics to a member PAGE. `access: 'member'` on a
 * workshop therefore means "this workshop is not published", enforced by
 * `WorkshopPage`'s own refusal, which is the only door a route PATTERN can have.
 *
 * This corrects SITE-03 D2's "a member workshop is registered through the member
 * path instead"; the build record says why.
 */
export function memberPages(): PageDef[] {
  return content.pages.filter((p) => p.access === 'member')
}

/**
 * Routes that are prerendered but unlisted: no sitemap entry, noindex in the
 * head, no nav link. The prerender script reads this to decide both.
 *
 * `hidden` IS NOISE-SUPPRESSION AND NOT ACCESS CONTROL, and this comment exists
 * because that was assumed to be stronger than it is (program finding 2). The
 * HTML is still built, still in `dist/`, still in the public repository and
 * still served to anyone holding the URL: `/general-travel-advice` carries
 * `hidden: true` today and is fetchable by a stranger. To keep a body private,
 * use `access: 'member'`, which is a different mechanism entirely.
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
