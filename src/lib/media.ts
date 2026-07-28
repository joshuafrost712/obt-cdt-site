/**
 * Media manifest access. Every image slot on the site references an entry here
 * by id. While the Wycliffe/SIL image repository is pending, entries render as
 * designed placeholder panels; swapping in a real photo is a manifest edit
 * (kind → "image", src → file in public/media/), never a component change.
 * See docs/MEDIA.md for the swap procedure and the consent rule.
 */
import manifest from '../content/media-manifest.json'

export interface MediaEntry {
  kind: 'placeholder' | 'image'
  alt: string
  /** CSS aspect-ratio value, e.g. "16/9". */
  aspect: string
  placeholder?: { style: 'gradient' | 'ring' | 'weave'; hue: 'accent' | 'brand' | 'ink'; label: string }
  src?: string | null
  credit?: string | null
}

const entries = manifest as Record<string, MediaEntry>

const MISSING: MediaEntry = {
  kind: 'placeholder',
  alt: '',
  aspect: '16/9',
  placeholder: { style: 'gradient', hue: 'ink', label: 'Image slot' },
}

export function getMedia(id: string): MediaEntry {
  return entries[id] ?? MISSING
}
