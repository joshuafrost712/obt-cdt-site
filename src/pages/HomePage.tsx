import { pageById } from '../lib/content/loader'
import { BlockRenderer, Cta } from '../components/blocks/BlockRenderer'
import { RoundaboutDiagram } from '../components/scrolly/RoundaboutDiagram'
import { useSceneProgress } from '../components/scrolly/useSceneProgress'
import { useReveal } from '../components/scrolly/useReveal'
import { Body, Txt } from '../components/text'
import { NotFoundPage } from './NotFoundPage'
import type { Block } from '../schema/types'

/**
 * The home page is a scroll-driven visual essay on the roundabout model. The
 * scene copy lives in the content store as `scene` blocks; the sticky
 * RoundaboutDiagram advances with the active scene. Everything renders
 * complete without JS — the diagram then simply shows its final state.
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

function Hero({ block }: { block: Block }) {
  const ref = useReveal<HTMLDivElement>()
  return (
    <section className="bg-navy text-paper">
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
      </div>
    </section>
  )
}

function Essay({ scenes }: { scenes: Block[] }) {
  const { containerRef, stage, progress } = useSceneProgress()

  return (
    <section ref={containerRef} className="relative bg-paper">
      {/* Mobile: compact sticky diagram pinned under the header. */}
      <div className="sticky top-[57px] z-10 border-b border-ink/10 bg-paper/95 py-2 backdrop-blur lg:hidden">
        <div className="mx-auto w-44">
          <RoundaboutDiagram stage={stage} progress={progress} />
        </div>
      </div>

      <div className="mx-auto max-w-6xl gap-12 px-5 lg:grid lg:grid-cols-[1fr_1.05fr]">
        {/* Desktop: full sticky diagram pane. */}
        <div className="hidden lg:block">
          <div className="sticky top-24 flex h-[calc(100vh-8rem)] items-center">
            <RoundaboutDiagram stage={stage} progress={progress} />
          </div>
        </div>

        <div>
          {scenes.map((scene, i) => (
            <Scene key={scene.id} scene={scene} index={i} count={scenes.length} />
          ))}
        </div>
      </div>
    </section>
  )
}

function Scene({ scene, index, count }: { scene: Block; index: number; count: number }) {
  const ref = useReveal<HTMLDivElement>()
  return (
    <div data-scene className="flex min-h-[70vh] items-center py-14 lg:min-h-[92vh]">
      <div ref={ref} className="reveal">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-ink-faint">
          <span className="text-accent-deep">{String(index + 1).padStart(2, '0')}</span> / {String(count).padStart(2, '0')}
        </p>
        <Txt node={scene} field="kicker" as="p" className="mt-4 text-xs font-semibold uppercase tracking-[0.18em] text-brand" />
        <Txt node={scene} field="title" as="h2" className="mt-2 font-display text-3xl font-semibold tracking-tight text-ink md:text-4xl" />
        <Body node={scene} className="mt-5 max-w-xl space-y-4 text-[1.05rem] leading-relaxed text-ink-soft" />
      </div>
    </div>
  )
}
