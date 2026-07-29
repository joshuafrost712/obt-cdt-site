import { Link } from 'react-router-dom'
import { pageByRoute, workshops } from '../lib/content/loader'
import { BlockRenderer } from '../components/blocks/BlockRenderer'
import { StatusBadge, formatDateRange } from '../components/blocks/WorkshopFactsPanel'
import { Txt } from '../components/text'
import { PageHeader } from './ContentPage'
import { HandbookHero } from './HandbookPage'
import { NotFoundPage } from './NotFoundPage'

export function WorkshopsIndexPage() {
  const page = pageByRoute('/workshops')
  if (!page) return <NotFoundPage />

  // This page cannot simply become `layout: "handbook"`: its cards are generated
  // from the workshops list, not from content blocks, so the handbook layout
  // would render a page with no workshops on it. It takes the hero instead and
  // keeps the grid (2026-07-29).
  const hero = page.blocks.find((b) => b.type === 'hero')
  const rest = page.blocks.filter((b) => b !== hero)

  return (
    <article className="pb-16">
      {hero ? <HandbookHero block={hero} /> : <PageHeader page={page} />}

      <section className="mx-auto max-w-5xl px-5 pt-10">
        <div className="grid gap-5 md:grid-cols-3">
          {workshops().map((w) => (
            <Link
              key={w.id}
              to={w.route}
              className="group flex flex-col rounded-2xl border border-ink/10 bg-white/60 p-6 no-underline transition-shadow hover:shadow-lg"
            >
              <StatusBadge status={w.facts.status} />
              <Txt
                node={w}
                field="title"
                as="h2"
                className="mt-3 font-display text-2xl font-semibold tracking-tight text-ink group-hover:text-accent-deep"
              />
              <p className="mt-2 text-sm font-medium text-ink-soft">{w.facts.location}</p>
              <p className="text-sm text-ink-faint">{w.facts.dateLabel ?? formatDateRange(w.facts.startDate, w.facts.endDate)}</p>
              <Txt node={w} field="metaDescription" as="p" className="mt-3 text-sm leading-relaxed text-ink-soft" />
            </Link>
          ))}
        </div>
      </section>

      <div className="pt-6">
        <BlockRenderer blocks={rest} />
      </div>
    </article>
  )
}
