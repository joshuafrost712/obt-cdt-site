import type { WorkshopDef } from '../../schema/types'
import { siteLabel } from '../../lib/content/loader'

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]

/** "2026-08-24" + "2026-09-04" → "24 August – 4 September 2026". */
export function formatDateRange(startDate: string, endDate: string): string {
  const [sy, sm, sd] = startDate.split('-').map(Number)
  const [ey, em, ed] = endDate.split('-').map(Number)
  const start = `${sd} ${MONTHS[sm - 1]}`
  const end = `${ed} ${MONTHS[em - 1]} ${ey}`
  if (sy !== ey) return `${start} ${sy} – ${end}`
  if (sm === em) return `${sd}–${ed} ${MONTHS[sm - 1]} ${sy}`
  return `${start} – ${end}`
}

export function StatusBadge({ status, size = 'md' }: { status: WorkshopDef['facts']['status']; size?: 'md' | 'lg' }) {
  const label =
    status === 'complete'
      ? siteLabel('site.badge.complete', 'Completed')
      : status === 'fully-booked'
        ? siteLabel('site.badge.fully-booked', 'Fully booked')
        : siteLabel('site.badge.planned', 'Planned')
  const tone =
    status === 'complete'
      ? 'bg-brand-soft text-brand'
      : status === 'fully-booked'
        ? 'bg-accent-deep text-white'
        : 'bg-paper-deep text-ink-soft'
  const pad = size === 'lg' ? 'px-4 py-1.5 text-sm' : 'px-3 py-1 text-xs'
  return <span className={`inline-block rounded-full font-semibold uppercase tracking-wide ${tone} ${pad}`}>{label}</span>
}

/** The at-a-glance facts strip on a workshop page. */
export function WorkshopFactsPanel({ workshop }: { workshop: WorkshopDef }) {
  const { facts } = workshop
  const rows = [
    [siteLabel('site.facts.genre', 'Genre'), facts.genre],
    [siteLabel('site.facts.location', 'Location'), facts.location],
    [siteLabel('site.facts.dates', 'Dates'), facts.dateLabel ?? formatDateRange(facts.startDate, facts.endDate)],
  ]
  return (
    <dl className="grid gap-x-8 gap-y-4 rounded-2xl border border-ink/10 bg-white/60 px-6 py-5 sm:grid-cols-3">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt className="text-xs font-semibold uppercase tracking-wide text-ink-faint">{label}</dt>
          <dd className="mt-1 font-medium text-ink">{value}</dd>
        </div>
      ))}
    </dl>
  )
}
