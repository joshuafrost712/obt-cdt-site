import type { Block } from '../../schema/types'
import { getMedia } from '../../lib/media'
import { Txt } from '../text'

const HUES: Record<string, string> = {
  accent: 'from-accent/85 via-brand-light/70 to-accent-deep/90',
  brand: 'from-brand/90 via-brand/60 to-navy/90',
  ink: 'from-navy via-navy-soft to-ink',
}

/**
 * An image slot bound to a media-manifest entry. Placeholder entries render as
 * designed gradient panels (with the slot label, so reviewers know what photo
 * belongs there); real entries render the photo with alt text, a fixed aspect
 * ratio (no layout shift), and a credit line.
 */
export function ImageSlot({ block, framed = true }: { block: Block; framed?: boolean }) {
  const media = getMedia(block.mediaId ?? '')
  const panel =
    media.kind === 'image' && media.src ? (
      <img
        src={`${import.meta.env.BASE_URL}${media.src.replace(/^\//, '')}`}
        alt={media.alt}
        loading="lazy"
        className="size-full object-cover"
        style={{ aspectRatio: media.aspect }}
      />
    ) : (
      <div
        role="img"
        aria-label={media.alt || media.placeholder?.label || 'Placeholder image'}
        className={`flex items-end bg-gradient-to-br p-5 ${HUES[media.placeholder?.hue ?? 'ink']}`}
        style={{ aspectRatio: media.aspect }}
      >
        <span className="rounded-full bg-black/25 px-3 py-1 text-xs font-medium tracking-wide text-white/90">
          {media.placeholder?.label ?? 'Image'}
        </span>
      </div>
    )

  if (!framed) return panel

  return (
    // hb-band so the print stylesheet drops it along with the handbook's photo
    // bands. The Psalms page is a document participants print; a full-page
    // photograph on paper is wasted ink either way.
    <figure className="hb-band mx-auto max-w-5xl px-5 py-8">
      <div className="overflow-hidden rounded-2xl">{panel}</div>
      <figcaption className="mt-2.5 flex items-baseline justify-between gap-4">
        <Txt node={block} field="caption" as="span" className="text-sm text-ink-faint" />
        {media.credit && <span className="text-xs text-ink-faint/80">{media.credit}</span>}
      </figcaption>
    </figure>
  )
}
