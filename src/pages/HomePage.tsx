import { pageById } from '../lib/content/loader'
import { getMedia } from '../lib/media'
import { BlockRenderer, Cta } from '../components/blocks/BlockRenderer'
import { RoundaboutDiagram } from '../components/scrolly/RoundaboutDiagram'
import { SceneFigure } from '../components/scrolly/SceneFigure'
import { useSceneProgress } from '../components/scrolly/useSceneProgress'
import { useReveal } from '../components/scrolly/useReveal'
import { Body, Txt } from '../components/text'
import { NotFoundPage } from './NotFoundPage'
import type { Block } from '../schema/types'

/**
 * The home page is a scroll-driven visual essay on the roundabout model. The
 * scene copy lives in the content store as `scene` blocks. On lg+ a sticky
 * RoundaboutDiagram advances with the active scene; without JS it stays at
 * stage 0, a faint but complete composition. Below lg each scene carries its
 * own static SceneFigure at that scene's stage, which needs no JS at all.
 */
export function HomePage() {
  const page = pageById('home')
  if (!page) return <NotFoundPage />

  const hero = page.blocks.find((b) => b.type === 'hero')
  const scenes = page.blocks.filter((b) => b.type === 'scene')
  const rest = page.blocks.filter((b) => b.type !== 'hero' && b.type !== 'scene')

  return (
    <article>
      {hero && <Hero block={hero} />}
      <Essay scenes={scenes} />
      <BlockRenderer blocks={rest} />
    </article>
  )
}

/**
 * The home hero wears the handbook hero's treatment (full-bleed photograph under
 * a navy-to-brand wash) rather than the flat navy it had before 2026-07-29, since
 * that photo layer is most of what made the handbook page look richer than the
 * rest of the site.
 *
 * It stays its own component rather than reusing `HandbookHero`: its `items` are
 * CTAs, and the handbook hero renders items as label chips.
 */
function Hero({ block }: { block: Block }) {
  const ref = useReveal<HTMLDivElement>()
  const media = getMedia(block.mediaId ?? '')
  return (
    <section className="hb-hero relative isolate overflow-hidden bg-navy text-paper">
      {media.kind === 'image' && media.src && (
        <img
          src={`${import.meta.env.BASE_URL}${media.src.replace(/^\//, '')}`}
          alt=""
          className="absolute inset-0 -z-10 size-full object-cover"
        />
      )}
      <div aria-hidden className="absolute inset-0 -z-10 bg-gradient-to-br from-navy/92 via-navy/78 to-brand/80" />
      <div ref={ref} className="reveal mx-auto flex max-w-6xl flex-col justify-center px-5 pb-20 pt-20 md:min-h-[82vh] md:pb-28 md:pt-24">
        <Txt node={block} field="kicker" as="p" className="text-xs font-semibold uppercase tracking-[0.24em] text-brand-light" />
        <Txt
          node={block}
          field="title"
          as="h1"
          className="mt-4 max-w-3xl font-display text-5xl font-medium leading-[1.05] tracking-tight md:text-7xl"
        />
        <Body node={block} className="mt-6 max-w-xl space-y-4 text-lg leading-relaxed text-paper/75" />
        <div className="mt-9 flex flex-wrap gap-3">
          {(block.items ?? []).map((cta) => (
            <Cta key={cta.id} block={cta} onDark />
          ))}
        </div>
        <p aria-hidden className="mt-16 hidden animate-bounce text-sm text-paper/40 md:block">
          ↓ scroll
        </p>
        {media.credit && <p className="hb-credit mt-8 text-[0.7rem] text-paper/40">{media.credit}</p>}
      </div>
    </section>
  )
}

function Essay({ scenes }: { scenes: Block[] }) {
  const { containerRef, stage, progress } = useSceneProgress()

  // The figure annotates itself from the essay's own copy: the active scene's
  // kicker becomes the caption the leader line points with, and the five thread
  // names ride on the circulating scene as labelToken children. Neither is
  // hardcoded in the diagram, so both stay editable in place.
  const note = scenes[stage]?.kicker
  const threads = scenes.flatMap((s) => (s.items ?? []).filter((i) => i.type === 'labelToken'))

  return (
    <section ref={containerRef} className="relative bg-paper">
      <div className="mx-auto max-w-6xl gap-12 px-5 lg:grid lg:grid-cols-[1fr_1.05fr] xl:gap-16">
        {/* Desktop: full sticky diagram pane. Below lg each scene carries its
            own static figure instead (SceneFigure), so there is no sticky bar
            competing with the text on a phone. */}
        <div className="hidden lg:block">
          <div className="sticky top-24 flex h-[calc(100vh-8rem)] items-center">
            <RoundaboutDiagram
              stage={stage}
              progress={progress}
              threads={threads}
              note={note}
              className="h-auto w-full max-w-[420px] xl:max-w-[500px]"
            />
          </div>
        </div>

        <div>
          {scenes.map((scene, i) => (
            <Scene key={scene.id} scene={scene} index={i} count={scenes.length} threads={threads} />
          ))}
        </div>
      </div>
    </section>
  )
}

function Scene({ scene, index, count, threads }: { scene: Block; index: number; count: number; threads: Block[] }) {
  const ref = useReveal<HTMLDivElement>()
  return (
    <div data-scene className="py-12 md:py-16 lg:flex lg:min-h-[92vh] lg:items-center lg:py-14">
      <div
        ref={ref}
        className="reveal md:grid md:grid-cols-[minmax(0,1fr)_minmax(240px,300px)] md:items-center md:gap-10 lg:block"
      >
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-ink-faint">
            <span className="text-accent-deep">{String(index + 1).padStart(2, '0')}</span> / {String(count).padStart(2, '0')}
          </p>
          <Txt node={scene} field="kicker" as="p" className="mt-4 text-xs font-semibold uppercase tracking-[0.18em] text-brand" />
          <Txt node={scene} field="title" as="h2" className="mt-2 font-display text-3xl font-semibold tracking-tight text-ink md:text-4xl" />
          <Body node={scene} className="mt-5 max-w-xl space-y-4 text-[1.05rem] leading-relaxed text-ink-soft" />
        </div>
        <SceneFigure stage={index} count={count} threads={threads} className="mt-8 md:mt-0 lg:hidden" />
      </div>
    </div>
  )
}
