import { Link } from 'react-router-dom'
import { pageById } from '../lib/content/loader'
import { getMedia } from '../lib/media'
import { BlockRenderer } from '../components/blocks/BlockRenderer'
import { useScrollSpy } from '../components/scrolly/useScrollSpy'
import { Body, Txt } from '../components/text'
import { NotFoundPage } from './NotFoundPage'
import type { Block } from '../schema/types'

/**
 * The participant handbook layout: a long reference document, not an essay.
 * A photo hero, a reading-progress bar, a sticky contents rail that tracks the
 * section being read on desktop, and a jump grid on mobile.
 *
 * Prerendered like every other route, so a participant on airport Wi-Fi gets the
 * whole document as HTML, and it prints to a usable PDF (see the @media print
 * rules in index.css).
 */
export function HandbookPage({ pageId }: { pageId: string }) {
  const page = pageById(pageId)
  if (!page) return <NotFoundPage />

  const hero = page.blocks.find((b) => b.type === 'hero')
  const nav = page.blocks.find((b) => b.type === 'sectionNav')
  const sections = page.blocks.filter((b) => b.type === 'handbookSection')
  const anchors = sections.map((s) => s.anchor ?? s.id)
  const { containerRef, activeId, progress } = useScrollSpy(anchors)

  return (
    <article className="pb-20">
      {hero && <HandbookHero block={hero} />}

      {/* Reading progress. Sits directly under the sticky site header. */}
      <div aria-hidden className="hb-progress sticky top-[57px] z-30 h-0.5 bg-ink/[0.07]">
        <div
          className="h-full bg-clay transition-[width] duration-150 ease-out"
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
                      <span className={`font-display text-[0.7rem] tabular-nums ${active ? 'text-gold' : 'text-clay/60'}`}>
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

          <p className="hb-noprint mt-12 border-t border-ink/10 pt-8 text-sm text-ink-faint">
            <Link to="/workshops/psalms-bali-2026" className="text-clay">
              Back to the Psalms workshop
            </Link>
          </p>
        </div>
      </div>

      {/* Mobile: jump back to the contents grid without scrolling all the way
          up. Appears only once the contents grid itself has scrolled away. */}
      {progress > 0.04 && (
        <a
          href="#handbook-top"
          className="hb-noprint fixed bottom-5 right-5 z-30 rounded-full bg-night px-4 py-2.5 text-sm font-semibold text-paper no-underline shadow-lg lg:hidden"
        >
          ↑ Contents
        </a>
      )}
    </article>
  )
}

/**
 * Full-bleed photo hero. The date band lives in `items` as labelToken blocks so
 * the dates are editable content, not markup.
 */
function HandbookHero({ block }: { block: Block }) {
  const media = getMedia(block.mediaId ?? '')
  return (
    <header id="handbook-top" className="hb-hero relative isolate overflow-hidden bg-night text-paper">
      {media.kind === 'image' && media.src && (
        <img
          src={`${import.meta.env.BASE_URL}${media.src.replace(/^\//, '')}`}
          alt=""
          className="absolute inset-0 -z-10 size-full object-cover"
        />
      )}
      <div aria-hidden className="absolute inset-0 -z-10 bg-gradient-to-br from-night/92 via-night/78 to-clay-deep/80" />

      <div className="mx-auto max-w-6xl px-5 pb-12 pt-16 md:pb-16 md:pt-24">
        <Link
          to="/workshops/psalms-bali-2026"
          className="text-[0.7rem] font-semibold uppercase tracking-[0.2em] text-paper/70 no-underline hover:text-gold"
        >
          ← Psalms workshop
        </Link>
        <Txt node={block} field="kicker" as="p" className="mt-6 text-xs font-semibold uppercase tracking-[0.24em] text-gold" />
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
