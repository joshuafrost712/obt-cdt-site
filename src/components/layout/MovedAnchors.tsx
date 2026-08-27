import { Link, useLocation } from 'react-router-dom'
import { movedAnchorsFor } from '../../lib/content/loader'

/**
 * Stubs for fragments that used to be on this page and now sit behind the gate.
 *
 * Spec SITE-03 D6, the anchor hook. A fragment never reaches a server: a
 * participant clicking `…/psalms-bali-2026#s13-accommodation` from an email sends
 * the server only the path, and the browser then looks for an element with that
 * id. If the section moved and nothing carries the id, the reader lands at the
 * top of a long page with no explanation and no idea whether they are even in
 * the right place. So the id stays here, on one line that says what left.
 *
 * Rendered from `SiteLayout` rather than from the four page components, because
 * the id has to exist whatever kind of page the fragment used to be on, and one
 * call site is one thing to keep true.
 *
 * `TitleSync` in App.tsx does the jump for a client-side navigation and the
 * browser does it for a cold load; both need the element present, which is why
 * this renders eagerly and is not collapsed behind a details element.
 *
 * SITE-05 owns applying this to the fourteen anchors its split actually moves.
 * Nothing on the site declares `movedAnchors` today, and this component renders
 * nothing when it is absent, which is why criterion 10 exercises it by mutation:
 * a "this section has moved" note on a live page that nothing has moved off is a
 * sentence that is not true.
 */
export function MovedAnchors() {
  const { pathname } = useLocation()
  const moved = movedAnchorsFor(pathname)
  if (moved.length === 0) return null

  return (
    <section aria-label="Sections that have moved" className="mx-auto max-w-3xl px-5 pb-16 pt-4">
      <div className="border-t border-ink/10 pt-8">
        {moved.map((anchor) => (
          <div
            key={anchor.id}
            id={anchor.id}
            data-moved-anchor={anchor.id}
            // scroll-mt clears the sticky header, which is the same offset the
            // handbook's own sections use.
            className="scroll-mt-24 border-l-2 border-brand/30 py-3 pl-4"
          >
            <p className="text-sm leading-relaxed text-ink-soft">{anchor.note}</p>
            <Link
              to={anchor.to}
              className="mt-1 inline-block text-sm font-semibold text-accent-deep no-underline hover:underline"
            >
              Sign in to read it
            </Link>
          </div>
        ))}
      </div>
    </section>
  )
}
