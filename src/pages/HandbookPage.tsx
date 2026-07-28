import { pageById } from '../lib/content/loader'
import { getMedia } from '../lib/media'
import { BlockRenderer } from '../components/blocks/BlockRenderer'
import { StatusBadge } from '../components/blocks/WorkshopFactsPanel'
import { useScrollSpy } from '../components/scrolly/useScrollSpy'
import { Body, Txt } from '../components/text'
import { NotFoundPage } from './NotFoundPage'
import type { Block, PageDef, WorkshopDef } from '../schema/types'

/**
 * The participant handbook layout: a long reference document, not an essay.
 * A photo hero, a reading-progress bar, a sticky contents rail that tracks the
 * section being read on desktop, and a jump grid on mobile.
 *
 * It renders a page OR a workshop. The Bali 2026 handbook is part of the Psalms
 * workshop page rather than a page of its own (2026-07-28), so the layout takes
 * whatever blocks it is given and sorts them into three zones:
 *
 *   intro     — blocks before the first handbookSection. On the merged workshop
 *               page that is the fully-booked notice and the public framing.
 *   sections  — the numbered handbookSections, with the rail and progress bar.
 *   outro     — blocks after the last one, e.g. the closing call to action.
 *
 * Prerendered like every other route, so a participant on airport Wi-Fi gets the
 * whole document as HTML, and it prints to a usable PDF (see the @media print
 * rules in index.css).
 */
export function HandbookLayout({ page }: { page: PageDef | WorkshopDef }) {
  const { blocks } = page
  const hero = blocks.find((b) => b.type === 'hero')
  const nav = blocks.find((b) => b.type === 'sectionNav')
  const sections = blocks.filter((b) => b.type === 'handbookSection')

  const first = blocks.findIndex((b) => b.type === 'handbookSection')
  const last = blocks.reduce((acc, b, i) => (b.type === 'handbookSection' ? i : acc), -1)
  const zoned = (b: Block) => b === hero || b === nav || b.type === 'handbookSection'
  const intro = blocks.filter((b, i) => !zoned(b) && (first === -1 || i < first))
  const outro = blocks.filter((b, i) => !zoned(b) && last !== -1 && i > last)

  const anchors = sections.map((s) => s.anchor ?? s.id)
  const { containerRef, activeId, progress } = useScrollSpy(anchors)
  const status = 'facts' in page ? page.facts.status : undefined

  return (
    <article className="pb-20">
      {hero && <HandbookHero block={hero} status={status} />}

      {intro.length > 0 && (
        <div className="border-b border-ink/10 pb-4">
          <BlockRenderer blocks={intro} />
        </div>
      )}

      {/* Reading progress. Sits directly under the sticky site header. */}
      <div aria-hidden className="hb-progress sticky top-[57px] z-30 h-0.5 bg-ink/[0.07]">
        <div
          className="h-full bg-accent transition-[width] duration-150 ease-out"
          style={{ width: `${Math.round(progress * 100)}%` }}
        />
      </div>

      <div ref={containerRef} className="mx-auto max-w-6xl px-5 lg:grid lg:grid-cols-[15rem_1fr] lg:gap-12">
        {/* Desktop rail. Hidden on mobile, where sectionNav does the same job. */}
        <div className="hb-rail hidden lg:block">
          <nav aria-label="Handbook sections" className="sticky top-24 max-h-[calc(100vh-8rem)] overflow-y-auto py-10">
            <p className="mb-3 text-[0.7rem] font-semibold uppercase tracking-[0.18em] text-ink-faint">Contents</p>
            <ol className="space-y-0.5">
              {sections.map((s) => {
                const anchor = s.anchor ?? s.id
                const active = anchor === activeId
                return (
                  <li key={s.id}>
                    <a
                      href={`#${anchor}`}
                      aria-current={active ? 'true' : undefined}
                      className={`flex items-baseline gap-2.5 rounded-lg px-2.5 py-1.5 text-[0.82rem] leading-snug no-underline transition-colors ${
                        active ? 'bg-ink text-paper' : 'text-ink-soft hover:bg-paper-deep hover:text-ink'
                      }`}
                    >
                      <span
                        className={`font-display text-[0.7rem] tabular-nums ${active ? 'text-brand-light' : 'text-accent-deep'}`}
                      >
                        {s.number}
                      </span>
                      <span>{s.title}</span>
                    </a>
                  </li>
                )
              })}
            </ol>
          </nav>
        </div>

        <div className="min-w-0">
          {nav && (
            <div className="lg:hidden">
              <BlockRenderer blocks={[nav]} />
            </div>
          )}
          <BlockRenderer blocks={sections} />
        </div>
      </div>

      {outro.length > 0 && (
        <div className="mx-auto max-w-6xl border-t border-ink/10 px-5 pt-4">
          <BlockRenderer blocks={outro} />
        </div>
      )}

      {/* Mobile: jump back to the contents grid without scrolling all the way
          up. Appears only once the contents grid itself has scrolled away. */}
      {progress > 0.04 && (
        <a
          href="#handbook-top"
          className="hb-noprint fixed bottom-5 right-5 z-30 rounded-full bg-navy px-4 py-2.5 text-sm font-semibold text-paper no-underline shadow-lg lg:hidden"
        >
          ↑ Contents
        </a>
      )}
    </article>
  )
}

/** A `layout: "handbook"` page that is not a workshop. */
export function HandbookPage({ pageId }: { pageId: string }) {
  const page = pageById(pageId)
  if (!page) return <NotFoundPage />
  return <HandbookLayout page={page} />
}

/**
 * Full-bleed photo hero. The date band lives in `items` as labelToken blocks so
 * the dates are editable content, not markup.
 */
function HandbookHero({ block, status }: { block: Block; status?: WorkshopDef['facts']['status'] }) {
  const media = getMedia(block.mediaId ?? '')
  return (
    <header id="handbook-top" className="hb-hero relative isolate overflow-hidden bg-navy text-paper">
      {media.kind === 'image' && media.src && (
        <img
          src={`${import.meta.env.BASE_URL}${media.src.replace(/^\//, '')}`}
          alt=""
          className="absolute inset-0 -z-10 size-full object-cover"
        />
      )}
      <div aria-hidden className="absolute inset-0 -z-10 bg-gradient-to-br from-navy/92 via-navy/78 to-brand/80" />

      <div className="mx-auto max-w-6xl px-5 pb-12 pt-16 md:pb-16 md:pt-24">
        <div className="flex flex-wrap items-center gap-3">
          <Txt
            node={block}
            field="kicker"
            as="p"
            className="text-xs font-semibold uppercase tracking-[0.24em] text-brand-light"
          />
          {status && <StatusBadge status={status} />}
        </div>
        <Txt
          node={block}
          field="title"
          as="h1"
          className="mt-3 max-w-3xl font-display text-4xl font-medium leading-[1.06] tracking-tight md:text-6xl"
        />
        <Body node={block} className="mt-5 max-w-xl space-y-3 text-[1.05rem] leading-relaxed text-paper/80" />

        <div className="mt-8 flex flex-wrap gap-2.5">
          {(block.items ?? []).map((token) => (
            <span
              key={token.id}
              className="rounded-full border border-paper/25 bg-paper/10 px-4 py-1.5 text-sm font-medium backdrop-blur-sm"
            >
              <Txt node={token} field="label" as="span" />
            </span>
          ))}
        </div>

        {media.credit && <p className="hb-credit mt-9 text-[0.7rem] text-paper/40">{media.credit}</p>}
      </div>
    </header>
  )
}
