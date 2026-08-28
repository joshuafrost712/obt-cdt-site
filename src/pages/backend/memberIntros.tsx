import type { ReactElement } from 'react'
import { L } from './shared'

/**
 * A member page's own framing copy, keyed by route.
 *
 * Spec SITE-04 decision 6. A member `PageDef` carries `blocks: []` and SITE-03's
 * structural gate checks that first, and `PageDef` has no other field that can
 * hold a content node, so "a node on the public PageDef" named no place that
 * exists. The strings live here instead, as LITERAL ids passed to `L`, which is
 * also the only shape that makes the `check-labels.mjs` claim true: its Pass A
 * covers a node when a `.tsx` file names its id as a string literal, not because
 * the node sits on a page.
 *
 * What may go here and what may not. These four sentences are about the page,
 * not in it: they describe what a register is and how to treat its links. The
 * ROWS are member content and come from `member_block`. Nothing route-specific
 * about a base, a date or a person belongs in this file, because this file is
 * inlined into a public bundle exactly like the rest of `src/`.
 */
const INTROS: Record<string, () => ReactElement> = {
  '/members/materials': () => (
    <div className="mt-6 space-y-3">
      <L
        as="p"
        className="text-base leading-relaxed text-ink-soft"
        id="portal.materials.intro"
        fallback="Everything the workshops taught from, and the applications the track runs on, in one place."
      />
      <L
        as="p"
        className="text-sm leading-relaxed text-ink-faint"
        id="portal.materials.access"
        fallback="Every row says what you need to get in, because a link does not."
      />
    </div>
  ),
}

const OUTROS: Record<string, () => ReactElement> = {
  '/members/materials': () => (
    <div className="mt-10 space-y-3 rounded-2xl border border-ink/10 bg-white/60 p-6">
      <L
        as="p"
        className="text-sm leading-relaxed text-ink-soft"
        id="portal.materials.forwarding"
        fallback="Please do not forward these links. A file that opens for anyone with the link opens for anyone who is ever sent it."
      />
      <L
        as="p"
        className="text-sm leading-relaxed text-ink-soft"
        id="portal.materials.wrong"
        fallback="If a link does not open for you, or opens something other than what it says, write to Joshua."
      />
    </div>
  ),
}

export function MemberIntro({ route }: { route: string }) {
  const Intro = INTROS[route]
  return Intro ? <Intro /> : null
}

export function MemberOutro({ route }: { route: string }) {
  const Outro = OUTROS[route]
  return Outro ? <Outro /> : null
}
