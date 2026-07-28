import { Link } from 'react-router-dom'
import type { Block } from '../../schema/types'
import { getMedia } from '../../lib/media'
import { Body, Txt } from '../text'
import { useReveal } from '../scrolly/useReveal'
import { BlockRenderer } from './BlockRenderer'

/**
 * Blocks used only by the participant handbook layout (see HandbookPage and
 * docs/HANDBOOK.md). BlockRenderer delegates the handbook block types here, so
 * every text field keeps its Txt/Body tagging and stays editable in place.
 *
 * The handbook has one design job the marketing pages don't: it must stay
 * readable when a third of it is still unconfirmed. Hence `callout` variants
 * that make a gap look tracked rather than forgotten.
 */

/* ---------------------------------------------------------------- section */

/**
 * One numbered handbook section: scroll anchor, number chip, optional
 * photo band, then nested child blocks. `data-hb-section` is what the rail's
 * scroll spy watches.
 */
export function HandbookSection({ block }: { block: Block }) {
  const ref = useReveal<HTMLDivElement>()
  const media = block.mediaId ? getMedia(block.mediaId) : null
  const anchor = block.anchor ?? block.id

  return (
    <section id={anchor} data-hb-section={anchor} className="hb-section scroll-mt-24 border-t border-ink/10 py-12 first:border-t-0 md:py-16">
      <div ref={ref} className="reveal">
        <div className="flex items-baseline gap-3">
          <Txt
            node={block}
            field="number"
            as="span"
            className="font-display text-sm font-semibold tabular-nums text-accent-deep"
          />
          <Txt
            node={block}
            field="kicker"
            as="span"
            className="text-xs font-semibold uppercase tracking-[0.18em] text-ink-faint"
          />
        </div>
        <Txt
          node={block}
          field="title"
          as="h2"
          className="mt-2 font-display text-3xl font-semibold tracking-tight text-ink md:text-4xl"
        />
        <Body node={block} className="mt-4 max-w-2xl space-y-4 text-[1.05rem] leading-relaxed text-ink-soft" />

        {media?.kind === 'image' && media.src && (
          <figure className="hb-band mt-7 overflow-hidden rounded-2xl">
            <div className="relative">
              <img
                src={`${import.meta.env.BASE_URL}${media.src.replace(/^\//, '')}`}
                alt={media.alt}
                loading="lazy"
                className="size-full object-cover"
                style={{ aspectRatio: media.aspect }}
              />
              {/* Duotone wash: keeps openly-licensed photography inside the
                  site's palette so it reads as designed, not dropped in.
                  `variant: "plain"` opts out, for a photo whose subject is
                  people's faces — the wash flattens exactly what carries it. */}
              {block.variant !== 'plain' && <div aria-hidden className="hb-duotone absolute inset-0" />}
            </div>
            <figcaption className="mt-2 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <Txt node={block} field="caption" as="span" className="min-w-0 text-sm text-ink-faint" />
              {media.credit && <span className="hb-credit text-xs text-ink-faint/75">{media.credit}</span>}
            </figcaption>
          </figure>
        )}

        {block.items && block.items.length > 0 && (
          <div className="mt-2">
            <BlockRenderer blocks={block.items} nested />
          </div>
        )}
      </div>
    </section>
  )
}

/* ------------------------------------------------------------ subsection */

/**
 * A headed paragraph inside a handbook section. Deliberately container-free:
 * the section already owns the column width, and `prose` would nest a second
 * max-width wrapper inside it.
 *
 * `anchor` gives the subsection a fragment id. The 2026-07-28 restructure folded
 * 21 sections into 5, and each old section survives as a subsection carrying its
 * old anchor, so `#s08-travel` and friends still land where a participant expects.
 */
export function Subsection({ block }: { block: Block }) {
  return (
    <div id={block.anchor} className={`mt-6${block.anchor ? ' scroll-mt-24' : ''}`}>
      <Txt
        node={block}
        field="kicker"
        as="p"
        className="mb-1 text-xs font-semibold uppercase tracking-[0.18em] text-accent-deep"
      />
      <Txt node={block} field="title" as="h3" className="font-display text-xl font-semibold text-ink" />
      <Body node={block} className="mt-2 max-w-2xl space-y-3 text-[0.98rem] leading-relaxed text-ink-soft" />
    </div>
  )
}

/* --------------------------------------------------------------- callout */

const CALLOUT: Record<string, { wrap: string; chip: string; label: string }> = {
  'action-required': {
    wrap: 'border-accent/35 bg-accent/[0.07]',
    chip: 'bg-accent-deep text-white',
    label: 'Action required',
  },
  'coming-soon': {
    wrap: 'border-ink/12 bg-paper-deep/70',
    chip: 'bg-ink/10 text-ink-soft',
    label: 'Coming soon',
  },
  note: {
    wrap: 'border-brand/30 bg-brand-soft/45',
    chip: 'bg-brand text-white',
    label: 'Good to know',
  },
  thanks: {
    wrap: 'border-brand-light/40 bg-brand-light/[0.09]',
    chip: 'bg-brand-light text-navy',
    label: 'Thank you',
  },
}

/** A status panel. `label` overrides the variant's default chip text. */
export function Callout({ block }: { block: Block }) {
  const tone = CALLOUT[block.variant ?? 'note'] ?? CALLOUT.note
  const pulse = block.variant === 'action-required' ? 'hb-pulse' : ''
  return (
    <aside className={`mt-6 rounded-2xl border px-6 py-5 ${tone.wrap}`}>
      <p className={`inline-block rounded-full px-3 py-1 text-[0.7rem] font-semibold uppercase tracking-[0.14em] ${tone.chip} ${pulse}`}>
        <span data-dfb-node={block.id} data-dfb-field="label">
          {block.label ?? tone.label}
        </span>
      </p>
      <Txt node={block} field="title" as="p" className="mt-3 font-display text-lg font-semibold leading-snug text-ink" />
      <Body node={block} className="mt-2 space-y-2 text-[0.95rem] leading-relaxed text-ink-soft" />
    </aside>
  )
}

/* ------------------------------------------------------------- checklist */

/** Ticked cards. Each item carries a `label` and optional `body`. */
export function Checklist({ block }: { block: Block }) {
  return (
    <div id={block.anchor} className={`mt-6${block.anchor ? ' scroll-mt-24' : ''}`}>
      <Txt
        node={block}
        field="kicker"
        as="p"
        className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-accent-deep"
      />
      <Txt node={block} field="title" as="h3" className="font-display text-xl font-semibold text-ink" />
      <Body node={block} className="mt-2 max-w-2xl space-y-2 text-[0.95rem] leading-relaxed text-ink-soft" />
      <ul className="mt-4 grid gap-2.5 sm:grid-cols-2">
        {(block.items ?? []).map((item) => (
          <li key={item.id} className="flex gap-3 rounded-xl border border-ink/10 bg-white/60 px-4 py-3">
            <span aria-hidden className="mt-0.5 shrink-0 text-accent-deep">
              ✓
            </span>
            <span>
              <Txt node={item} field="label" as="span" className="text-[0.95rem] font-medium leading-snug text-ink" />
              <Body node={item} className="mt-1 space-y-1 text-[0.85rem] leading-relaxed text-ink-faint" />
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/* ------------------------------------------------------------------ list */

/**
 * A quiet bulleted list. Same shape as `checklist` without the ticks and cards.
 *
 * It exists because a tick is a highlighting device: it says "you must do this
 * and then confirm you did". Thirteen ticked lists in one document taught the
 * reader to ignore all of them (feedback, 2026-07-28). Ticks now belong only to
 * lists a participant genuinely works through; everything else is a `list`.
 *
 * `variant: "numbered"` renders an ordered list. Use it where the sequence or
 * the count is the point, as with the Indonesian entry requirements, which a
 * participant works down item by item and needs to be able to refer to by
 * number (feedback, 2026-07-28).
 */
export function PlainList({ block }: { block: Block }) {
  const numbered = block.variant === 'numbered'
  const Tag = numbered ? 'ol' : 'ul'
  const marker = numbered
    ? 'list-decimal marker:font-semibold marker:tabular-nums'
    : 'list-disc'
  return (
    <div id={block.anchor} className={`mt-6${block.anchor ? ' scroll-mt-24' : ''}`}>
      <Txt
        node={block}
        field="kicker"
        as="p"
        className="mb-1 text-xs font-semibold uppercase tracking-[0.18em] text-accent-deep"
      />
      <Txt node={block} field="title" as="h3" className="font-display text-xl font-semibold text-ink" />
      <Body node={block} className="mt-2 max-w-2xl space-y-2 text-[0.95rem] leading-relaxed text-ink-soft" />
      <Tag
        className={`mt-3 max-w-2xl space-y-1.5 pl-5 font-body text-[0.98rem] leading-relaxed text-ink-soft marker:text-accent-deep ${marker}`}
      >
        {(block.items ?? []).map((item) => (
          <li key={item.id}>
            {/* A label with a body under it is a heading for that body, so it
                takes the darker weight. A label on its own is the content. */}
            <Txt node={item} field="label" as="span" className={item.body ? 'font-medium text-ink' : undefined} />
            <Body node={item} className="mt-0.5 space-y-1 text-[0.88rem] leading-relaxed text-ink-faint" />
          </li>
        ))}
      </Tag>
    </div>
  )
}

/* -------------------------------------------------------- handbookTimeline */

/**
 * A dated spine. Same item fields as a `glanceGrid` (kicker / value / label /
 * body) so a grid can become a timeline without renaming a single node field,
 * but read as one sequence rather than five separate cards.
 *
 * The trip dates were a card grid until 2026-07-28, when Joshua pointed out that
 * a sequence of days is a timeline: the cards made five equal-weight facts out
 * of what is actually one line through three weeks.
 */
export function HandbookTimeline({ block }: { block: Block }) {
  return (
    <div id={block.anchor} className={`mt-6${block.anchor ? ' scroll-mt-24' : ''}`}>
      <Txt
        node={block}
        field="kicker"
        as="p"
        className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-accent-deep"
      />
      <Txt node={block} field="title" as="h3" className="font-display text-xl font-semibold text-ink" />
      <Body node={block} className="mt-2 max-w-2xl space-y-2 text-[0.95rem] leading-relaxed text-ink-soft" />
      <ol className="mt-5 max-w-2xl border-l-2 border-brand/25 pl-6">
        {(block.items ?? []).map((item) => (
          <li key={item.id} className="relative pb-7 last:pb-0">
            <span
              aria-hidden
              className="absolute -left-[31px] top-1 size-3 rounded-full border-2 border-brand bg-paper"
            />
            <Txt
              node={item}
              field="kicker"
              as="p"
              className="text-xs font-semibold uppercase tracking-[0.14em] text-ink-faint"
            />
            <p className="mt-0.5 flex flex-wrap items-baseline gap-x-3">
              <Txt node={item} field="value" as="span" className="font-display text-lg font-semibold text-ink" />
              <Txt node={item} field="label" as="span" className="text-sm font-medium text-accent-deep" />
            </p>
            <Body node={item} className="mt-1.5 space-y-2 text-[0.93rem] leading-relaxed text-ink-soft" />
          </li>
        ))}
      </ol>
    </div>
  )
}

/* ------------------------------------------------------------ glanceGrid */

/**
 * Cards from `items` (kicker / value / label / body). `variant: "rows"` renders
 * the same items as a label-and-value fact table instead, which is what the
 * venue and contact sections want.
 *
 * `variant: "people"` is the rows table with the left column set as a name
 * rather than a field label: sentence case, display face, full size. A person's
 * name in small caps reads as a form field, and the facilitator credits are
 * meant to read name, then role, then qualification (feedback, 2026-07-28).
 */
export function GlanceGrid({ block }: { block: Block }) {
  const people = block.variant === 'people'
  const rows = people || block.variant === 'rows'
  return (
    <div id={block.anchor} className={`mt-6${block.anchor ? ' scroll-mt-24' : ''}`}>
      <Txt
        node={block}
        field="kicker"
        as="p"
        className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-accent-deep"
      />
      <Txt node={block} field="title" as="h3" className="font-display text-xl font-semibold text-ink" />
      <Body node={block} className="mt-2 max-w-2xl space-y-2 text-[0.95rem] leading-relaxed text-ink-soft" />

      {rows ? (
        <dl className="mt-4 divide-y divide-ink/10 rounded-2xl border border-ink/10 bg-white/60 px-6 py-2">
          {(block.items ?? []).map((item) => (
            <div
              key={item.id}
              className={`grid gap-1 py-3.5 sm:gap-6 ${people ? 'sm:grid-cols-[11rem_1fr]' : 'sm:grid-cols-[9rem_1fr]'}`}
            >
              <dt>
                <Txt
                  node={item}
                  field="label"
                  as="span"
                  className={
                    people
                      ? 'font-display text-base font-semibold text-ink'
                      : 'text-xs font-semibold uppercase tracking-wide text-ink-faint'
                  }
                />
              </dt>
              <dd>
                <Txt
                  node={item}
                  field="value"
                  as="span"
                  className={people ? 'font-medium text-brand' : 'font-medium text-ink'}
                />
                <Body node={item} className="mt-1 space-y-1 text-[0.9rem] leading-relaxed text-ink-soft" />
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {(block.items ?? []).map((item) => (
            <div
              key={item.id}
              className="rounded-2xl border border-ink/10 bg-white/60 p-5 transition-colors hover:border-accent/40"
            >
              <Txt
                node={item}
                field="kicker"
                as="p"
                className="text-[0.7rem] font-semibold uppercase tracking-[0.16em] text-brand"
              />
              <Txt node={item} field="value" as="p" className="mt-1 font-display text-2xl font-semibold text-ink" />
              <Txt node={item} field="label" as="p" className="mt-0.5 text-sm font-medium text-accent-deep" />
              <Body node={item} className="mt-2 space-y-2 text-[0.9rem] leading-relaxed text-ink-soft" />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/* -------------------------------------------------------------- linkGrid */

const external = (href?: string) => !!href && !href.startsWith('mailto:') && !href.startsWith('#')

/** Resource cards. Each item has `label`, optional `body`/`note`, and href or route. */
export function LinkGrid({ block }: { block: Block }) {
  return (
    <div id={block.anchor} className={`mt-6${block.anchor ? ' scroll-mt-24' : ''}`}>
      <Txt
        node={block}
        field="kicker"
        as="p"
        className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-accent-deep"
      />
      <Txt node={block} field="title" as="h3" className="font-display text-xl font-semibold text-ink" />
      <Body node={block} className="mt-2 max-w-2xl space-y-2 text-[0.95rem] leading-relaxed text-ink-soft" />
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {(block.items ?? []).map((item) => {
          const href = item.href ?? item.route
          const inner = (
            <>
              <span className="flex items-baseline justify-between gap-3">
                <Txt node={item} field="label" as="span" className="font-display text-lg font-semibold text-ink" />
                {href && (
                  <span aria-hidden className="shrink-0 text-accent-deep transition-transform group-hover:translate-x-0.5">
                    {external(item.href) ? '↗' : '→'}
                  </span>
                )}
              </span>
              <Body node={item} className="mt-1.5 space-y-1.5 text-[0.9rem] leading-relaxed text-ink-soft" />
              <Txt
                node={item}
                field="note"
                as="span"
                className="mt-2.5 block text-[0.75rem] font-medium uppercase tracking-wide text-ink-faint"
              />
            </>
          )
          const shell = 'group block rounded-2xl border border-ink/10 bg-white/60 p-5 no-underline transition-colors'
          // An internal `route` has to go through react-router: the site is
          // served from a base path on Pages, and a raw <a href="/x"> would
          // drop it and 404.
          if (item.route && !item.href) {
            return (
              <Link key={item.id} to={item.route} className={`${shell} hover:border-accent/45 hover:bg-white`}>
                {inner}
              </Link>
            )
          }
          return href ? (
            <a
              key={item.id}
              href={href}
              {...(external(item.href) ? { target: '_blank', rel: 'noreferrer noopener' } : {})}
              className={`${shell} hover:border-accent/45 hover:bg-white`}
            >
              {inner}
            </a>
          ) : (
            <div key={item.id} className={shell}>
              {inner}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------ sectionNav */

/**
 * The contents grid at the top of the handbook. Reads the same section list the
 * rail uses; on a phone this is the primary way to jump around.
 */
export function SectionNav({ block }: { block: Block }) {
  return (
    <nav aria-label="Handbook contents" className="hb-contents py-8">
      <Txt
        node={block}
        field="kicker"
        as="p"
        className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-accent-deep"
      />
      <Txt node={block} field="title" as="h2" className="font-display text-2xl font-semibold text-ink" />
      <ol className="mt-5 grid gap-x-6 gap-y-1 sm:grid-cols-2">
        {(block.items ?? []).map((item) => (
          <li key={item.id}>
            <a
              href={`#${item.anchor ?? ''}`}
              className="group flex items-baseline gap-3 border-b border-ink/[0.07] py-2.5 no-underline"
            >
              <span className="font-display text-xs font-semibold tabular-nums text-accent-deep">{item.number}</span>
              <Txt
                node={item}
                field="label"
                as="span"
                className="text-[0.95rem] text-ink-soft transition-colors group-hover:text-accent-deep"
              />
            </a>
          </li>
        ))}
      </ol>
    </nav>
  )
}
