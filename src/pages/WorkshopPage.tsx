import { Link, useParams } from 'react-router-dom'
import { workshopBySlug, workshops } from '../lib/content/loader'
import { BlockRenderer } from '../components/blocks/BlockRenderer'
import { StatusBadge, WorkshopFactsPanel } from '../components/blocks/WorkshopFactsPanel'
import { Txt } from '../components/text'
import { NotFoundPage } from './NotFoundPage'

export function WorkshopPage() {
  const { slug } = useParams()
  const workshop = slug ? workshopBySlug(slug) : undefined
  if (!workshop) return <NotFoundPage />

  const siblings = workshops().filter((w) => w.id !== workshop.id)

  return (
    <article className="pb-16">
      <div className="border-b border-ink/10 bg-paper-deep/50">
        <div className="mx-auto max-w-3xl px-5 pb-10 pt-14 md:pb-12 md:pt-20">
          <div className="mb-4 flex items-center gap-3">
            <Link to="/workshops" className="text-xs font-semibold uppercase tracking-[0.2em] text-ink-faint no-underline hover:text-clay">
              Workshops
            </Link>
            <StatusBadge status={workshop.facts.status} size="lg" />
          </div>
          <Txt node={workshop} field="kicker" as="p" className="mb-3 text-xs font-semibold uppercase tracking-[0.2em] text-clay" />
          <Txt node={workshop} field="title" as="h1" className="font-display text-4xl font-semibold tracking-tight text-ink md:text-5xl" />
          <div className="mt-8">
            <WorkshopFactsPanel workshop={workshop} />
          </div>
        </div>
      </div>

      <div className="pt-6">
        <BlockRenderer blocks={workshop.blocks} />
      </div>

      <nav aria-label="Other workshops" className="mx-auto max-w-3xl px-5 pt-10">
        <div className="flex flex-wrap gap-3 border-t border-ink/10 pt-8">
          {siblings.map((w) => (
            <Link
              key={w.id}
              to={w.route}
              className="rounded-full border border-ink/20 px-4 py-2 text-sm font-medium text-ink no-underline hover:border-ink/40 hover:bg-paper-deep"
            >
              <Txt node={w} field="navLabel" as="span" />
            </Link>
          ))}
        </div>
      </nav>
    </article>
  )
}
