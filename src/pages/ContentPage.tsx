import { pageById } from '../lib/content/loader'
import { BlockRenderer } from '../components/blocks/BlockRenderer'
import { Txt } from '../components/text'
import { NotFoundPage } from './NotFoundPage'
import type { PageDef, WorkshopDef } from '../schema/types'

export function PageHeader({ page }: { page: PageDef | WorkshopDef }) {
  return (
    <div className="border-b border-ink/10 bg-paper-deep/50">
      <div className="mx-auto max-w-3xl px-5 pb-10 pt-14 md:pb-14 md:pt-20">
        <Txt node={page} field="kicker" as="p" className="mb-3 text-xs font-semibold uppercase tracking-[0.2em] text-accent-deep" />
        <Txt node={page} field="title" as="h1" className="font-display text-4xl font-semibold tracking-tight text-ink md:text-5xl" />
      </div>
    </div>
  )
}

/** Generic content page: header + block stream, entirely from the content store. */
export function ContentPage({ pageId }: { pageId: string }) {
  const page = pageById(pageId)
  if (!page) return <NotFoundPage />
  return (
    <article className="pb-16">
      <PageHeader page={page} />
      <div className="pt-6">
        <BlockRenderer blocks={page.blocks} />
      </div>
    </article>
  )
}
