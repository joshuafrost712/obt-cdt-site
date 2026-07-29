import { Link } from 'react-router-dom'
import type { Block } from '../../schema/types'
import { Body, Txt } from '../text'
import { ImageSlot } from './ImageSlot'
import { useReveal } from '../scrolly/useReveal'
import {
  Callout,
  Checklist,
  GlanceGrid,
  HandbookSection,
  HandbookTimeline,
  LinkGrid,
  PlainList,
  SectionNav,
  Subsection,
} from './HandbookBlocks'

/**
 * Renders a list of content blocks. Every text element is tagged (via Txt/Body)
 * for the devfeedback edit-in-place layer. Home-essay 'scene' blocks are NOT
 * handled here — the HomePage renders those inside the scrollytelling shell.
 *
 * Handbook block types are delegated to HandbookBlocks; they live in their own
 * file because they carry a different visual contract (a reference document,
 * not an essay) but must share this renderer so nesting and edit-in-place work.
 */
/**
 * `nested` means "already inside something that owns the column width" — a
 * handbookSection. Handbook leaf blocks are written container-free so they can
 * sit inside that column; used at the top level of an ordinary page they need
 * the same Section wrapper every other block gets.
 */
export function BlockRenderer({ blocks, nested = false }: { blocks: Block[]; nested?: boolean }) {
  return (
    <>
      {blocks.map((block) => (
        <BlockView key={block.id} block={block} nested={nested} />
      ))}
    </>
  )
}

const HANDBOOK_LEAF = new Set(['subsection', 'callout', 'checklist', 'list', 'glanceGrid', 'linkGrid'])

function BlockView({ block, nested }: { block: Block; nested: boolean }) {
  if (!nested && HANDBOOK_LEAF.has(block.type)) {
    return (
      <section className="py-4">
        <Section>
          <BlockView block={block} nested />
        </Section>
      </section>
    )
  }
  switch (block.type) {
    case 'prose':
      return <Prose block={block} nested={nested} />
    case 'quote':
      return <Quote block={block} nested={nested} />
    case 'statRow':
      return <StatRow block={block} nested={nested} />
    case 'cardGrid':
      return <CardGrid block={block} nested={nested} />
    case 'threadCard':
      return <ThreadCard block={block} index={0} />
    case 'timeline':
      // Inside a handbook section the column width is already owned, and the
      // handbook timeline also reads glanceGrid's item fields, so a dated grid
      // can become a spine without renaming nodes.
      return nested ? <HandbookTimeline block={block} /> : <Timeline block={block} />
    case 'imageSlot':
      return <ImageSlot block={block} nested={nested} />
    case 'rubricScale':
      return <RubricScale block={block} nested={nested} />
    case 'ctaGroup':
      return <CtaGroup block={block} nested={nested} />
    case 'handbookSection':
      return <HandbookSection block={block} />
    case 'subsection':
      return <Subsection block={block} />
    case 'callout':
      return <Callout block={block} />
    case 'checklist':
      return <Checklist block={block} />
    case 'list':
      return <PlainList block={block} />
    case 'glanceGrid':
      return <GlanceGrid block={block} />
    case 'linkGrid':
      return <LinkGrid block={block} />
    case 'sectionNav':
      return <SectionNav block={block} />
    default:
      return null
  }
}

function Section({ children, wide = false }: { children: React.ReactNode; wide?: boolean }) {
  const ref = useReveal<HTMLDivElement>()
  return (
    <div ref={ref} className={`reveal mx-auto px-5 ${wide ? 'max-w-5xl' : 'max-w-3xl'}`}>
      {children}
    </div>
  )
}

/**
 * The column wrapper a top-level block needs and a nested one must not have.
 *
 * Inside a `handbookSection` the section already owns the column width and the
 * scroll reveal, so wrapping again would narrow the text twice over and stack a
 * second reveal on one that has already fired. Since the site went
 * handbook-first (2026-07-29) the marketing blocks have to work in both
 * positions, so the choice lives here rather than in six components.
 */
function Frame({
  nested,
  wide = false,
  pad = 'py-8',
  children,
}: {
  nested: boolean
  wide?: boolean
  pad?: string
  children: React.ReactNode
}) {
  if (nested) return <div className="mt-6">{children}</div>
  return (
    <section className={pad}>
      <Section wide={wide}>{children}</Section>
    </section>
  )
}

/**
 * A block's heading, at the level its position calls for. Nested, it sits under
 * a handbookSection's h2, so it is an h3 at `Subsection`'s scale; at the top
 * level of an ordinary page it is the page's own h2.
 */
function Heading({ block, nested }: { block: Block; nested: boolean }) {
  return (
    <Txt
      node={block}
      field="title"
      as={nested ? 'h3' : 'h2'}
      className={
        nested
          ? 'font-display text-xl font-semibold text-ink'
          : 'font-display text-3xl font-semibold tracking-tight text-ink'
      }
    />
  )
}

/**
 * A kicker is furniture over a big title. Over a nested block's xl h3 it reads
 * as a heading level smaller than the headings beneath it, which is why handbook
 * leaf blocks carry exactly one heading line (see HandbookBlocks). So nested
 * blocks drop theirs.
 */
function Kicker({ block, nested }: { block: Block; nested: boolean }) {
  if (nested) return null
  return (
    <Txt
      node={block}
      field="kicker"
      as="p"
      className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-accent-deep"
    />
  )
}

function Prose({ block, nested }: { block: Block; nested: boolean }) {
  return (
    <Frame nested={nested}>
      <Kicker block={block} nested={nested} />
      <Heading block={block} nested={nested} />
      <Body
        node={block}
        className={
          nested
            ? 'mt-2 max-w-2xl space-y-3 text-[0.98rem] leading-relaxed text-ink-soft'
            : 'mt-4 space-y-4 text-[1.05rem] leading-relaxed text-ink-soft'
        }
      />
    </Frame>
  )
}

function Quote({ block, nested }: { block: Block; nested: boolean }) {
  return (
    <Frame nested={nested} pad="py-10">
      <figure className="rounded-2xl border-l-4 border-accent bg-paper-deep/70 px-7 py-6">
        <blockquote>
          {/* Caveat, the one place SIL's handwriting face earns its keep. It
              runs small for its point size, hence the step up. */}
          <Txt
            node={block}
            field="body"
            as="p"
            className={`font-script leading-snug text-ink ${nested ? 'text-2xl' : 'text-2xl md:text-3xl'}`}
          />
        </blockquote>
        <figcaption>
          <Txt node={block} field="attribution" as="p" className="mt-3 text-sm font-medium text-ink-faint" />
        </figcaption>
      </figure>
    </Frame>
  )
}

export function StatRow({ block, nested = false }: { block: Block; nested?: boolean }) {
  return (
    <Frame nested={nested} wide pad="py-10">
      <div className={`grid gap-4 sm:grid-cols-2 ${nested ? 'lg:grid-cols-2' : 'lg:grid-cols-4'}`}>
        {(block.items ?? []).map((stat) => (
          <div key={stat.id} className="rounded-2xl bg-navy px-6 py-6 text-paper">
            <Txt node={stat} field="value" as="p" className="font-display text-4xl font-semibold text-brand-light" />
            <Txt node={stat} field="label" as="p" className="mt-1.5 text-sm font-medium leading-snug text-paper/85" />
            <Txt node={stat} field="note" as="p" className="mt-2 text-xs leading-relaxed text-paper/55" />
          </div>
        ))}
      </div>
    </Frame>
  )
}

function CardGrid({ block, nested }: { block: Block; nested: boolean }) {
  const threads = (block.items ?? []).every((c) => c.type === 'threadCard')
  return (
    <Frame nested={nested} wide>
      <Kicker block={block} nested={nested} />
      <Heading block={block} nested={nested} />
      <Body node={block} className="mt-3 max-w-2xl space-y-3 leading-relaxed text-ink-soft" />
      <div
        className={`grid gap-5 ${nested ? 'mt-4' : 'mt-8'} ${
          threads && !nested ? 'md:grid-cols-2 lg:grid-cols-3' : 'md:grid-cols-2'
        }`}
      >
        {(block.items ?? []).map((card, i) =>
          card.type === 'threadCard' ? (
            <ThreadCard key={card.id} block={card} level={cardLevel(block, nested)} index={i} />
          ) : (
            <div key={card.id} className="rounded-2xl border border-ink/10 bg-white/60 p-6">
              <Txt
                node={card}
                field="title"
                as={cardLevel(block, nested)}
                className="font-display text-xl font-semibold text-ink"
              />
              <Body node={card} className="mt-2.5 space-y-3 text-[0.95rem] leading-relaxed text-ink-soft" />
              <Txt node={card} field="note" as="p" className="mt-3 text-xs font-medium uppercase tracking-wide text-accent-deep" />
            </div>
          ),
        )}
      </div>
    </Frame>
  )
}

/**
 * What heading a card inside a grid should be, which depends on whether the grid
 * itself rendered one.
 *
 * A page conversion can promote a grid's title onto the handbookSection above it
 * and leave the grid title-less (that is how /threads and /get-involved are
 * built). When that happens the cards sit directly under the section's h2, so
 * they are h3; a grid that kept its own h3 puts its cards at h4. Hardcoding h4
 * for anything nested skipped a level in both of those pages.
 */
function cardLevel(grid: Block, nested: boolean): 'h3' | 'h4' {
  return nested && grid.title ? 'h4' : 'h3'
}

function ThreadCard({ block, index, level = 'h3' }: { block: Block; index: number; level?: 'h3' | 'h4' }) {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-ink/10 bg-white/60 p-6">
      <span aria-hidden className="font-display absolute -right-2 -top-5 text-[5.5rem] font-semibold leading-none text-accent/10">
        {index + 1}
      </span>
      <Txt node={block} field="kicker" as="p" className="text-xs font-semibold uppercase tracking-[0.18em] text-brand" />
      <Txt node={block} field="title" as={level} className="mt-1 font-display text-xl font-semibold text-ink" />
      <Body node={block} className="mt-2.5 space-y-3 text-[0.95rem] leading-relaxed text-ink-soft" />
    </div>
  )
}

function Timeline({ block }: { block: Block }) {
  return (
    <section className="py-8">
      <Section>
        <Txt node={block} field="kicker" as="p" className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-accent-deep" />
        <Txt node={block} field="title" as="h2" className="font-display text-3xl font-semibold tracking-tight text-ink" />
        <ol className="mt-8 space-y-0 border-l-2 border-accent-soft pl-6">
          {(block.items ?? []).map((item) => (
            <li key={item.id} className="relative pb-8 last:pb-0">
              <span aria-hidden className="absolute -left-[31px] top-1.5 size-3 rounded-full border-2 border-accent bg-paper" />
              <Txt node={item} field="kicker" as="p" className="text-xs font-semibold uppercase tracking-wide text-ink-faint" />
              <Txt node={item} field="title" as="h3" className="mt-0.5 font-display text-lg font-semibold text-ink" />
              <Body node={item} className="mt-1.5 space-y-2 text-[0.95rem] leading-relaxed text-ink-soft" />
            </li>
          ))}
        </ol>
      </Section>
    </section>
  )
}

export function RubricScale({ block, nested = false }: { block: Block; nested?: boolean }) {
  return (
    <Frame nested={nested} wide>
      <Kicker block={block} nested={nested} />
      <Heading block={block} nested={nested} />
      <Body node={block} className="mt-3 max-w-2xl space-y-3 leading-relaxed text-ink-soft" />
      <ol className={`grid gap-4 md:grid-cols-4 ${nested ? 'mt-4' : 'mt-8'}`}>
        {(block.items ?? []).map((step) => (
          <li key={step.id} className="rounded-2xl border border-ink/10 bg-white/60 p-5">
            <Txt node={step} field="value" as="p" className="font-display text-3xl font-semibold text-brand" />
            <Txt node={step} field="label" as="p" className="mt-1 text-sm font-semibold text-ink" />
            <Txt node={step} field="body" as="p" className="mt-2 text-[0.85rem] leading-relaxed text-ink-soft" />
          </li>
        ))}
      </ol>
    </Frame>
  )
}

export function CtaGroup({ block, nested = false }: { block: Block; nested?: boolean }) {
  return (
    <Frame nested={nested} pad="py-10">
      <Txt
        node={block}
        field="title"
        as={nested ? 'h3' : 'h2'}
        className={`font-display font-semibold tracking-tight text-ink ${nested ? 'text-xl' : 'text-2xl'}`}
      />
      <Body node={block} className="mt-2 space-y-2 leading-relaxed text-ink-soft" />
      <div className="mt-5 flex flex-wrap gap-3">
        {(block.items ?? []).map((cta) => (
          <Cta key={cta.id} block={cta} />
        ))}
      </div>
    </Frame>
  )
}

export function Cta({ block, onDark = false }: { block: Block; onDark?: boolean }) {
  const primary = block.variant !== 'ghost'
  const ghost = onDark
    ? 'border border-paper/35 text-paper hover:border-paper/70 hover:bg-paper/10'
    : 'border border-ink/20 text-ink hover:border-ink/40 hover:bg-paper-deep'
  const className = `inline-block rounded-full px-5 py-2.5 text-sm font-semibold no-underline transition-colors ${
    // SIL blue at rest, orange on hover: their own link behaviour, and blue
    // clears AA with white text where their orange does not.
    primary ? 'bg-brand text-white hover:bg-accent' : ghost
  }`
  const label = <Txt node={block} field="label" as="span" />
  if (block.href) {
    return (
      <a href={block.href} className={className}>
        {label}
      </a>
    )
  }
  return (
    <Link to={block.route ?? '/'} className={className}>
      {label}
    </Link>
  )
}
