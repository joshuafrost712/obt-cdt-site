import { useEffect, useState } from 'react'
import { AuthGate, ErrorNote, L } from './shared'
import { BlockRenderer } from '../../components/blocks/BlockRenderer'
import { getMemberPage, type MemberPageBody } from '../../lib/backend/memberApi'
import { MemberIntro, MemberOutro } from './memberIntros'
import { pageByRoute, siteLabel } from '../../lib/content/loader'

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
 * the three-zone sort all live in `HandbookLayout` one level up. A real member
 * handbook composes a page-shaped object and renders through that instead, which
 * SITE-05 prices. This page does not need it.
 *
 * Three outcomes, kept distinct as `PortalPage` keeps them: loading, loaded and
 * empty, loaded with blocks. Loaded-and-empty means the seed has not run for
 * this route, and it says exactly that rather than showing a blank page — with
 * one honest caveat, in `memberApi.ts`: an RLS refusal is also an empty read, so
 * this state means "nothing came back", not "nothing exists".
 */
export default function MemberPage({ route, pageId }: { route: string; pageId: string }) {
  const node = pageByRoute(route)
  return (
    <AuthGate title={node?.title ?? siteLabel('portal.member.title', 'Member area')}>
      {() => <MemberBody route={route} pageId={pageId} />}
    </AuthGate>
  )
}

function MemberBody({ route, pageId }: { route: string; pageId: string }) {
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
