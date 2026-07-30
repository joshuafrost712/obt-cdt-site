import { RoundaboutDiagram } from './RoundaboutDiagram'
import type { Block } from '../../schema/types'

/**
 * A static, per-scene instance of the roundabout for screens below lg, where
 * the sticky scrollytelling pane doesn't fit. Each scene shows the figure fixed
 * at its own stage, cropped to the part of the composition that scene is about,
 * so the geometry (and its numerals) renders at a legible size on a phone.
 *
 * No caption and no in-SVG annotations: the scene's kicker and heading sit in
 * the HTML directly above the figure and already name what it shows. The one
 * text gap the crops can't close is the five thread names (their SVG labels
 * would still be ~8px at column width), so the circulating scene carries them
 * as a real HTML legend under the figure instead.
 *
 * Because stage is a constant prop rather than scroll-derived state, these
 * instances prerender at the correct stage — no-JS readers and print get the
 * right picture per scene for free.
 */
const STAGE_VIEW: Record<number, { viewBox: string; className: string }> = {
  // The hero: full composition, faint, as an establishing shot.
  0: { viewBox: '0 0 420 436', className: 'max-w-[340px]' },
  // The lit straight road beside the dormant ring. A road-only crop would be
  // a 1:5.4 strip; keeping the dormant roundabout in frame is also the scene's
  // own argument (the familiar picture, with the alternative waiting).
  1: { viewBox: '24 40 300 356', className: 'max-w-[300px]' },
  // The ring draws in and the entry roads light up: full width, entries and all.
  2: { viewBox: '0 95 420 330', className: 'max-w-[400px]' },
  // Circulating: tight on the ring and its numbered nodes; legend below.
  3: { viewBox: '90 98 240 240', className: 'max-w-[320px]' },
  // The rubric row sits dead centre of the same tight crop.
  4: { viewBox: '90 98 240 240', className: 'max-w-[320px]' },
  // The exit ramp leaves the top right: portrait crop.
  5: { viewBox: '94 4 240 332', className: 'max-w-[270px]' },
  // The outro: everything lit.
  6: { viewBox: '0 0 420 436', className: 'max-w-[360px]' },
}

interface Props {
  stage: number
  count: number
  threads: Block[]
  className?: string
}

export function SceneFigure({ stage, count, threads, className = '' }: Props) {
  const view = STAGE_VIEW[stage] ?? STAGE_VIEW[0]
  // The same mid-scene progress the preview harness uses: at the circulating
  // scene it puts the marker at the top of the ring, in the widest gap between
  // nodes, clear of every numeral.
  const progress = (stage + 0.5) / count
  return (
    <figure aria-hidden="true" className={`ra-static ${className}`}>
      <RoundaboutDiagram
        stage={stage}
        progress={progress}
        compact
        viewBox={view.viewBox}
        className={`mx-auto h-auto w-full ${view.className}`}
      />
      {stage === 3 && threads.length > 0 && (
        <ol className="mx-auto mt-4 grid w-fit grid-cols-1 gap-x-6 gap-y-1 text-sm text-ink-soft sm:grid-cols-2">
          {threads.map((t, i) => (
            <li key={t.id} className="flex items-baseline gap-2">
              <span className="text-xs font-bold text-accent-deep">{i + 1}</span>
              <span>{t.label}</span>
            </li>
          ))}
        </ol>
      )}
    </figure>
  )
}
