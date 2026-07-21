/**
 * The roundabout: one hand-authored SVG, a pure function of {stage, progress}.
 * Scene mapping (see the home essay content):
 *   0 hero — faint full composition
 *   1 the straight road — linear road lit, roundabout dormant
 *   2 enter the roundabout — ring draws in, entry roads light up
 *   3 circulating: five threads — thread nodes + evidence dots orbit
 *   4 measuring progress — rubric ticks highlight
 *   5 the exit — exit ramp lights, road dims
 *   6 outro — everything lit
 * Decorative only (aria-hidden): the essay text carries all meaning. CSS
 * transitions (class ra-part) animate between stages; reduced-motion users get
 * instant states.
 */
interface Props {
  stage: number
  progress: number
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

export function RoundaboutDiagram({ stage, progress }: Props) {
  const on = (from: number, to = 99) => stage >= from && stage <= to
  const dim = (active: boolean, lit = 1, faded = 0.14) => (active ? lit : faded)

  // The ring "draws" across scene 2 and stays.
  const ringOffset = stage >= 2 ? 0 : RING_C
  // Evidence dots orbit the ring from scene 3 on; progress keeps them moving.
  const orbit = progress * 220

  return (
    <svg viewBox="0 0 420 436" aria-hidden="true" className="h-auto w-full max-w-[420px]">
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

      {/* ---- entry roads ---- */}
      <g className="ra-part" style={{ opacity: dim(on(2), 1, stage < 2 ? 0.12 : 1) }}>
        {ENTRIES.map((angle, i) => {
          const [x1, y1] = polar(angle, 200)
          const [x2, y2] = polar(angle, R + 14)
          return (
            <g key={angle} className="ra-part" style={{ opacity: stage === 2 ? 1 : 0.75 }}>
              <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="var(--color-ink-soft)" strokeWidth="14" strokeLinecap="round" opacity="0.28" />
              <circle cx={x1} cy={y1} r="5.5" fill={on(2) ? 'var(--color-teal)' : 'var(--color-ink-faint)'}>
                {on(2, 3) && <animate attributeName="r" values="5.5;7;5.5" dur={`${2 + i * 0.3}s`} repeatCount="indefinite" />}
              </circle>
            </g>
          )
        })}
      </g>

      {/* ---- the roundabout ring ---- */}
      <g className="ra-part" style={{ opacity: stage >= 2 ? 1 : 0.15 }}>
        <circle cx={CX} cy={CY} r={R} fill="none" stroke="var(--color-clay-soft)" strokeWidth="24" opacity="0.5" />
        <circle
          cx={CX}
          cy={CY}
          r={R}
          fill="none"
          stroke="var(--color-clay)"
          strokeWidth="5"
          strokeLinecap="round"
          strokeDasharray={RING_C}
          strokeDashoffset={ringOffset}
          className="ra-part"
          transform={`rotate(-90 ${CX} ${CY})`}
        />
        <circle cx={CX} cy={CY} r={R - 34} fill="var(--color-paper-deep)" opacity="0.9" />
        <circle cx={CX} cy={CY} r={R - 34} fill="none" stroke="var(--color-clay)" strokeWidth="1.5" opacity="0.5" />
      </g>

      {/* ---- five thread nodes on the ring ---- */}
      <g className="ra-part" style={{ opacity: dim(on(3)) }}>
        {ENTRIES.map((angle, i) => {
          const [x, y] = polar(angle, R)
          return (
            <g key={angle}>
              <circle cx={x} cy={y} r="12" fill="var(--color-paper)" stroke="var(--color-clay)" strokeWidth="2.5" />
              <text x={x} y={y + 4} fontSize="11" fontWeight="700" textAnchor="middle" fill="var(--color-clay-deep)" fontFamily="var(--font-sans)">
                {i + 1}
              </text>
            </g>
          )
        })}
      </g>

      {/* ---- evidence dots circulating ---- */}
      <g
        className="ra-part"
        style={{ opacity: dim(on(3)), transform: `rotate(${orbit}deg)`, transformOrigin: `${CX}px ${CY}px` }}
      >
        {[30, 105, 170, 250, 320].map((angle, i) => {
          const [x, y] = polar(angle, R - 18)
          return <circle key={angle} cx={x} cy={y} r={3.5 + (i % 3)} fill="var(--color-gold)" />
        })}
      </g>

      {/* ---- rubric ticks (scene 4) ---- */}
      <g className="ra-part" style={{ opacity: dim(stage === 4, 1, stage > 4 ? 0.35 : 0) }}>
        {[0, 1, 2, 3].map((n) => (
          <g key={n}>
            <circle cx={CX - 36 + n * 24} cy={CY} r="9" fill={n <= 2 ? 'var(--color-teal)' : 'var(--color-paper)'} stroke="var(--color-teal)" strokeWidth="2" />
            <text
              x={CX - 36 + n * 24}
              y={CY + 3.5}
              fontSize="10"
              fontWeight="700"
              textAnchor="middle"
              fill={n <= 2 ? 'var(--color-paper)' : 'var(--color-teal)'}
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
              <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="var(--color-teal)" strokeWidth="14" strokeLinecap="round" opacity="0.3" />
              <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="var(--color-teal)" strokeWidth="4" strokeLinecap="round" />
              <g transform={`translate(${x2} ${y2 - 14})`}>
                <circle r="16" fill="var(--color-teal)" />
                <path d="M -5 0 L 1 0 M -1.5 -4 L 3 0 L -1.5 4" stroke="var(--color-paper)" strokeWidth="2.5" fill="none" strokeLinecap="round" strokeLinejoin="round" transform="rotate(-52)" />
              </g>
            </>
          )
        })()}
      </g>
    </svg>
  )
}
