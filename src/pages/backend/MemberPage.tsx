import { useEffect, useState } from 'react'
import { AuthGate, ErrorNote, L } from './shared'
import { BlockRenderer } from '../../components/blocks/BlockRenderer'
import { HandbookLayout } from '../HandbookPage'
import { getMemberPage, type MemberPageBody } from '../../lib/backend/memberApi'
import { MemberIntro, MemberOutro } from './memberIntros'
import { pageByRoute, siteLabel } from '../../lib/content/loader'
import type { PageDef } from '../../schema/types'

/**
 * One member page: the title comes from the public content layer, the body comes
 * from the database.
 *
 * Spec SITE-03 D6. That split is the whole design. `site-content.json` is
 * inlined into the bundle and prerendered to static HTML, so anything in it is
 * public in four places at once; the route, the title and the nav label are
 * there because the router needs them before a session exists, and nothing else
 * is. The blocks come from `member_block` behind RLS.
 *
 * Program finding 15 records what rendering through `BlockRenderer` does NOT
 * give you: the contents rail, the reading-progress bar, the contents grid and
 * the three-zone sort all live in `HandbookLayout` one level up. A flat register
 * does not need any of it; a 1,891-word handbook does, which is SITE-05
 * finding 4 and why a node declaring `layout: "handbook"` takes the second path
 * below. Without it the member half of the Psalms handbook arrives as a
 * two-thousand-word stack of blocks on a phone, which is the readability
 * failure `docs/HANDBOOK.md` says the layout exists to prevent.
 *
 * Three outcomes, kept distinct as `PortalPage` keeps them: loading, loaded and
 * empty, loaded with blocks. Loaded-and-empty means the seed has not run for
 * this route, and it says exactly that rather than showing a blank page — with
 * one honest caveat, in `memberApi.ts`: an RLS refusal is also an empty read, so
 * this state means "nothing came back", not "nothing exists".
 */
export default function MemberPage({ route, pageId }: { route: string; pageId: string }) {
  const node = pageByRoute(route)
  const handbook = node?.layout === 'handbook'
  return (
    <AuthGate
      title={node?.title ?? siteLabel('portal.member.title', 'Member area')}
      wide={handbook}
    >
      {() => <MemberBody route={route} pageId={pageId} handbook={handbook} />}
    </AuthGate>
  )
}

function MemberBody({
  route,
  pageId,
  handbook,
}: {
  route: string
  pageId: string
  handbook?: boolean
}) {
  const [page, setPage] = useState<MemberPageBody | null | undefined>(undefined)
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true
    setPage(undefined)
    setError('')
    getMemberPage(route)
      .then((p) => alive && setPage(p))
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)))
    return () => {
      alive = false
    }
  }, [route])

  if (error) return <ErrorNote error={error} />
  if (page === undefined) {
    return (
      <L
        as="p"
        className="mt-8 text-ink-faint"
        id="portal.member.loading"
        fallback="Loading this page…"
      />
    )
  }
  if (page === null || page.blocks.length === 0) {
    return (
      <div className="mt-8 rounded-2xl border border-ink/10 bg-white/60 p-6">
        <L
          as="p"
          className="text-sm leading-relaxed text-ink-soft"
          id="portal.member.empty"
          fallback="This page has not been published yet. It is being written; nothing has gone missing."
        />
      </div>
    )
  }

  if (handbook) {
    /*
     * SITE-05 D7. `HandbookLayout` reads exactly two things off the page object,
     * `blocks` and `facts.status`, and everything else off the section blocks
     * themselves — so a page-shaped object is genuinely all it needs, and this
     * synthesises one from `member_page` and its ordered `member_block` rows.
     *
     * `facts` is omitted deliberately: a status badge belongs to a workshop,
     * and the member half is a section of a handbook rather than a workshop of
     * its own.
     *
     * No anchor wrapper here, unlike the flat path below. The handbook blocks
     * stamp their own `anchor` as a DOM id (`HandbookBlocks.tsx:37,110,164,206,
     * 238,282,359,423`), so wrapping them would give every anchor two elements
     * and let a fragment resolve to the wrong one.
     */
    const shaped = { ...(pageByRoute(route) ?? {}), blocks: page.blocks } as PageDef
    return (
      <div data-member-page={pageId}>
        <HandbookLayout page={shaped} />
      </div>
    )
  }

  return (
    <div className="mt-6" data-member-page={pageId}>
      {/* SITE-04 decision 6: the page's own framing copy is a literal-id call
          site in src/, so check-labels.mjs covers it; the rows below are member
          content and come from the database. */}
      <MemberIntro route={route} />
      {page.kicker && (
        <p className="mb-4 text-xs font-semibold uppercase tracking-[0.2em] text-accent-deep">{page.kicker}</p>
      )}
      {page.blocks.map((block) => (
        // The anchor is stamped on the WRAPPER and not by the renderer, which
        // stamps no ids of its own. A block that carries no anchor gets no id,
        // so a fragment that stops resolving is loud rather than silently
        // landing on the wrong section.
        <div key={block.id} id={block.anchor} className="scroll-mt-24">
          <BlockRenderer blocks={[block]} />
        </div>
      ))}
      <MemberOutro route={route} />
    </div>
  )
}
