import type { Block } from '../../schema/types'

/**
 * The roundabout: one hand-authored SVG, a pure function of {stage, progress}.
 * Scene mapping (see the home essay content):
 *   0 hero — faint full composition
 *   1 the straight road — linear road lit, roundabout dormant
 *   2 enter the roundabout — ring draws in, entry roads light up
 *   3 circulating: five threads — thread nodes named, one marker laps the ring
 *   4 measuring progress — rubric ticks highlight
 *   5 the exit — exit ramp lights, road dims
 *   6 outro — everything lit
 *
 * The figure annotates itself. A reader met "training is usually drawn as a
 * straight road" with no way to tell which part of the picture was the road
 * (feedback, 2026-07-29), so each scene that has one specific subject now names
 * it: a caption with a leader line and an arrowhead pointing at the thing. The
 * caption text is the scene's own kicker, passed in from the essay content, so
 * the reader sees the same two or three words in the column and on the figure.
 *
 * Still aria-hidden. The essay carries the meaning for anyone not looking at it;
 * these labels are there so that a reader who *is* looking is not guessing.
 */
interface Props {
  stage: number
  progress: number
  /**
   * The five thread names, as labelToken children of the "circulating" scene.
   * Content, not markup — they are the same five threads the /threads page names.
   */
  threads?: Block[]
  /** The active scene's kicker, used as the figure's caption. */
  note?: string
  /**
   * Compact drops the caption/leader annotation and the thread-name labels,
   * whose type would be illegible at small render sizes. The numerals and the
   * centre label stay: the per-scene crops (SceneFigure) render them large
   * enough to read.
   */
  compact?: boolean
  /**
   * The viewBox is a prop so a static per-scene instance can crop to the part
   * of the figure its scene is about. Default is the full composition.
   */
  viewBox?: string
  className?: string
}

const CX = 210
const CY = 218
const R = 92
const RING_C = 2 * Math.PI * R

/** Entry roads: five approaches, angles in degrees (0 = east, CCW positive). */
const ENTRIES = [148, 195, 242, 289, 25]

function polar(angleDeg: number, radius: number): [number, number] {
  const a = (angleDeg * Math.PI) / 180
  return [CX + radius * Math.cos(a), CY - radius * Math.sin(a)]
}

/**
 * Where the caption sits and what it points at, per stage. Stages 0, 3 and 6 are
 * absent on purpose: the hero and the outro show the whole composition rather
 * than one part of it, and on the circulating scene the five thread labels are
 * already the annotation. A sixth label there would be clutter.
 */
const NOTE: Record<number, { at: [number, number]; to: [number, number]; anchor: 'start' | 'middle' | 'end' }> = {
  1: { at: [96, 30], to: [75, 62], anchor: 'start' },
  2: { at: [300, 92], to: [266, 126], anchor: 'end' },
  4: { at: [210, 158], to: [210, 196], anchor: 'middle' },
  5: { at: [252, 96], to: [292, 60], anchor: 'end' },
}

/**
 * A straight leader line with an arrowhead at the target end. Straight, because
 * every other connector in this figure is a straight road and a lone bezier
 * would read as a different vocabulary.
 */
function Leader({ from, to }: { from: [number, number]; to: [number, number] }) {
  const [x1, y1] = from
  const [x2, y2] = to
  const deg = (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI
  return (
    <g stroke="var(--color-ink-faint)" strokeWidth="1.4" fill="none" strokeLinecap="round">
      <line x1={x1} y1={y1} x2={x2} y2={y2} />
      <path d="M -6 -3.4 L 0 0 L -6 3.4" transform={`translate(${x2} ${y2}) rotate(${deg})`} strokeLinejoin="round" />
    </g>
  )
}

/** Small type over a busy figure needs a halo or it sits in the noise. */
const HALO = {
  stroke: 'var(--color-paper)',
  strokeWidth: 3.6,
  paintOrder: 'stroke' as const,
  strokeLinejoin: 'round' as const,
}

export function RoundaboutDiagram({
  stage,
  progress,
  threads = [],
  note,
  compact = false,
  viewBox = '0 0 420 436',
  className = 'h-auto w-full max-w-[420px]',
}: Props) {
  const on = (from: number, to = 99) => stage >= from && stage <= to
  const dim = (active: boolean, lit = 1, faded = 0.14) => (active ? lit : faded)

  // The ring "draws" across scene 2 and stays.
  const ringOffset = stage >= 2 ? 0 : RING_C
  // The marker laps the ring: two full turns across the essay, so it is always
  // visibly moving without ever racing.
  const orbit = progress * 720
  const annotation = compact ? undefined : NOTE[stage]

  return (
    <svg viewBox={viewBox} aria-hidden="true" className={className}>
      {/* ---- the straight road (the old assumption) ---- */}
      <g className="ra-part" style={{ opacity: stage <= 1 ? (stage === 1 ? 1 : 0.35) : 0.1 }}>
        <line x1="60" y1="416" x2="60" y2="24" stroke="var(--color-ink-faint)" strokeWidth="26" strokeLinecap="round" opacity="0.25" />
        <line x1="60" y1="404" x2="60" y2="36" stroke="var(--color-paper)" strokeWidth="2.5" strokeDasharray="10 12" />
        {[352, 268, 184, 100].map((y, i) => (
          <g key={y}>
            <circle cx="92" cy={y} r="4" fill="var(--color-ink-faint)" />
            <line x1="78" y1={y} x2="88" y2={y} stroke="var(--color-ink-faint)" strokeWidth="2" />
            <text x="102" y={y + 4} fontSize="11" fill="var(--color-ink-faint)" fontFamily="var(--font-sans)">
              {['1', '2', '3', '4'][i]}
            </text>
          </g>
        ))}
      </g>

      {/* ---- entry roads ----
          Full brightness on scene 2, where entering is the point, then back to a
          murmur so the thread labels on scene 3 have clear ground to sit on. */}
      <g className="ra-part" style={{ opacity: stage < 2 ? 0.12 : stage === 2 ? 1 : 0.3 }}>
        {ENTRIES.map((angle, i) => {
          const [x1, y1] = polar(angle, 200)
          const [x2, y2] = polar(angle, R + 14)
          return (
            <g key={angle}>
              <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="var(--color-ink-soft)" strokeWidth="14" strokeLinecap="round" opacity="0.28" />
              {/* CSS pulse rather than SMIL: SMIL ignores prefers-reduced-motion,
                  and a static per-scene instance would run it for the page's life. */}
              <circle
                cx={x1}
                cy={y1}
                r="5.5"
                fill={on(2) ? 'var(--color-brand)' : 'var(--color-ink-faint)'}
                className={stage === 2 ? 'ra-pulse' : undefined}
                style={stage === 2 ? { animationDelay: `${i * 0.3}s` } : undefined}
              />
            </g>
          )
        })}
      </g>

      {/* ---- the roundabout ring ---- */}
      <g className="ra-part" style={{ opacity: stage >= 2 ? 1 : 0.15 }}>
        <circle cx={CX} cy={CY} r={R} fill="none" stroke="var(--color-accent-soft)" strokeWidth="24" opacity="0.5" />
        <circle
          cx={CX}
          cy={CY}
          r={R}
          fill="none"
          stroke="var(--color-accent)"
          strokeWidth="5"
          strokeLinecap="round"
          strokeDasharray={RING_C}
          strokeDashoffset={ringOffset}
          className="ra-part"
          transform={`rotate(-90 ${CX} ${CY})`}
        />
        <circle cx={CX} cy={CY} r={R - 34} fill="var(--color-paper-deep)" opacity="0.9" />
        <circle cx={CX} cy={CY} r={R - 34} fill="none" stroke="var(--color-accent)" strokeWidth="1.5" opacity="0.5" />
      </g>

      {/* ---- five thread nodes on the ring ---- */}
      <g className="ra-part" style={{ opacity: dim(on(3)) }}>
        {ENTRIES.map((angle, i) => {
          const [x, y] = polar(angle, R)
          return (
            <g key={angle}>
              <circle cx={x} cy={y} r="12" fill="var(--color-paper)" stroke="var(--color-accent)" strokeWidth="2.5" />
              <text x={x} y={y + 4} fontSize="11" fontWeight="700" textAnchor="middle" fill="var(--color-accent-deep)" fontFamily="var(--font-sans)">
                {i + 1}
              </text>
            </g>
          )
        })}
      </g>

      {/* ---- thread names ----
          Five anonymous dots used to orbit here. A reader could not tell what
          they stood for and read them as decoration (feedback, 2026-07-29), so
          the ring now says which thread each node is. Placed radially just
          outside the ring, anchored away from the centre so the text runs
          outward into open space. */}
      {!compact && threads.length > 0 && (
        <g className="ra-part" style={{ opacity: stage === 3 ? 1 : stage > 3 ? 0.4 : 0 }}>
          {ENTRIES.map((angle, i) => {
            const label = threads[i]?.label
            if (!label) return null
            const [x, y] = polar(angle, R + 24)
            const left = angle > 90 && angle < 270
            return (
              <text
                key={angle}
                x={x}
                y={y + 3.5}
                fontSize="10.5"
                fontWeight="600"
                textAnchor={left ? 'end' : 'start'}
                fill="var(--color-ink-soft)"
                fontFamily="var(--font-sans)"
                {...HALO}
              >
                {label}
              </text>
            )
          })}
        </g>
      )}

      {/* ---- the circulating marker ----
          One marker, not five dots: the claim is that a person keeps moving and
          passes every thread, and five identical dots said nothing a reader
          could name.

          Rotated with the SVG transform attribute, which takes its centre of
          rotation explicitly. The old CSS `transform`/`transformOrigin` pair on
          this group inherited .ra-part's 0.8s transform transition, so a
          rotation rewritten on every scroll frame was being eased on every
          frame: the group lagged and wobbled off centre, which is the drift that
          was reported. Nothing here transitions transform now. */}
      <g className="ra-part" style={{ opacity: dim(on(3), 1, 0) }}>
        <g transform={`rotate(${orbit} ${CX} ${CY})`}>
          {/* A short trailing arc reads as travel rather than as a stray dot. */}
          <circle
            cx={CX}
            cy={CY}
            r={R}
            fill="none"
            stroke="var(--color-brand-light)"
            strokeWidth="5"
            strokeLinecap="round"
            strokeDasharray={`${RING_C * 0.055} ${RING_C}`}
            strokeDashoffset={RING_C * 0.055}
            opacity="0.4"
            transform={`rotate(-90 ${CX} ${CY})`}
          />
          <circle cx={CX} cy={CY - R} r="7" fill="var(--color-brand-light)" stroke="var(--color-paper)" strokeWidth="2.5" />
        </g>
      </g>

      {/* ---- rubric ticks (scene 4) ----
          Only on scene 4. They used to linger at 0.35 afterwards, which put four
          ghost circles directly behind the "OBT consulting" centre label on
          scenes 5 and 6 and made the middle of the figure unreadable. */}
      <g className="ra-part" style={{ opacity: stage === 4 ? 1 : 0 }}>
        {[0, 1, 2, 3].map((n) => (
          <g key={n}>
            <circle cx={CX - 36 + n * 24} cy={CY} r="9" fill={n <= 2 ? 'var(--color-brand)' : 'var(--color-paper)'} stroke="var(--color-brand)" strokeWidth="2" />
            <text
              x={CX - 36 + n * 24}
              y={CY + 3.5}
              fontSize="10"
              fontWeight="700"
              textAnchor="middle"
              fill={n <= 2 ? 'var(--color-paper)' : 'var(--color-brand)'}
              fontFamily="var(--font-sans)"
            >
              {n}
            </text>
          </g>
        ))}
      </g>
      {/* center label when not in rubric scene */}
      <g className="ra-part" style={{ opacity: stage === 4 ? 0 : stage >= 2 ? 1 : 0.2 }}>
        <text x={CX} y={CY - 2} fontSize="12" fontWeight="600" textAnchor="middle" fill="var(--color-ink-soft)" fontFamily="var(--font-sans)">
          OBT
        </text>
        <text x={CX} y={CY + 14} fontSize="12" fontWeight="600" textAnchor="middle" fill="var(--color-ink-soft)" fontFamily="var(--font-sans)">
          consulting
        </text>
      </g>

      {/* ---- the exit ramp ---- */}
      <g className="ra-part" style={{ opacity: dim(on(5), 1, 0.12) }}>
        {(() => {
          const [x1, y1] = polar(68, R + 12)
          const [x2, y2] = polar(62, 196)
          return (
            <>
              <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="var(--color-brand)" strokeWidth="14" strokeLinecap="round" opacity="0.3" />
              <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="var(--color-brand)" strokeWidth="4" strokeLinecap="round" />
              <g transform={`translate(${x2} ${y2 - 14})`}>
                <circle r="16" fill="var(--color-brand)" />
                <path d="M -5 0 L 1 0 M -1.5 -4 L 3 0 L -1.5 4" stroke="var(--color-paper)" strokeWidth="2.5" fill="none" strokeLinecap="round" strokeLinejoin="round" transform="rotate(-52)" />
              </g>
            </>
          )
        })()}
      </g>

      {/* ---- the caption, pointing at this scene's subject ---- */}
      {annotation && note && (
        <g key={stage} className="ra-note">
          {/* Start the leader below the baseline so it does not clip the text. */}
          <Leader from={[annotation.at[0], annotation.at[1] + 6]} to={annotation.to} />
          <text
            x={annotation.at[0]}
            y={annotation.at[1]}
            fontSize="11"
            fontWeight="600"
            textAnchor={annotation.anchor}
            fill="var(--color-ink)"
            fontFamily="var(--font-sans)"
            {...HALO}
          >
            {note}
          </text>
        </g>
      )}
    </svg>
  )
}
