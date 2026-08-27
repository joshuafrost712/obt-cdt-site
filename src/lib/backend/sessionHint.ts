/**
 * "Is someone signed in?", answered synchronously and without supabase-js.
 *
 * Spec SITE-03 D2. The nav needs a signed-in variant, and `SiteLayout` is in the
 * ENTRY chunk. Importing `useSession` there would pull supabase-js into the
 * entry chunk and break the guarantee CDT-04 measured and CDT-06a asserts: the
 * entry chunk has no static imports at all and supabase-js lives in exactly one
 * lazy chunk. So this module is dependency-free, like `seen.ts` beside it, and
 * reads the session GoTrue has already persisted rather than asking for it.
 *
 * ## This is a hint and not a control, and the distinction is load-bearing
 *
 * A localStorage value is attacker-writable in the attacker's own browser. Every
 * real boundary in this design is elsewhere: RLS on `member_page` and
 * `member_block` decides what the database returns, and `AuthGate` decides what
 * the page renders. Forging this value shows you a nav link to a page that then
 * asks you to sign in. Nothing else.
 *
 * ## Why not render it from the session
 *
 * Because the nav is on every page, including the eleven that never load the
 * portal chunk, and a nav entry that appears half a second after a lazy chunk
 * resolves is worse than one that appears on mount.
 */

/** GoTrue's storage key is `sb-<project ref>-auth-token`; the ref is not ours to assume. */
const KEY_PATTERN = /^sb-.+-auth-token$/

/**
 * Dispatched by `AuthGate` whenever the session resolves or changes.
 *
 * Without it the nav is read once on mount and never again, so signing in leaves
 * the member entry missing until a reload. The `storage` event does not cover
 * this: it fires for OTHER tabs, never for the one that wrote the value. Found
 * by criterion 9 rather than by review, which is what a two-viewport
 * signed-in/signed-out check is for.
 *
 * A DOM event rather than a callback registry, so the entry chunk stays free of
 * anything the portal chunk owns: the listener is in `SiteLayout`, the dispatch
 * is in the lazy chunk, and neither imports the other.
 */
export const SESSION_EVENT = 'obtcdt:session'

export function notifySessionChanged(): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new Event(SESSION_EVENT))
}

/**
 * True when this browser holds an unexpired portal session.
 *
 * Returns false during SSR and whenever storage is unreadable, which is the
 * safe direction: the failure mode is a missing nav link, not a shown one.
 */
export function hasLiveSession(): boolean {
  if (typeof window === 'undefined') return false
  let raw: string | null = null
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key && KEY_PATTERN.test(key)) {
        raw = localStorage.getItem(key)
        break
      }
    }
  } catch {
    // Private mode, or storage disabled.
    return false
  }
  if (!raw) return false

  // supabase-js may store the session as JSON or as `base64-<payload>`. An
  // unreadable-but-present token counts as signed in: GoTrue wrote it, and
  // guessing "signed out" from a format change would silently retire the nav
  // entry the day the library changes its encoding.
  let text = raw
  if (text.startsWith('base64-')) {
    try {
      text = atob(text.slice('base64-'.length))
    } catch {
      return true
    }
  }
  try {
    const parsed = JSON.parse(text) as { expires_at?: number }
    if (typeof parsed.expires_at !== 'number') return true
    return parsed.expires_at * 1000 > Date.now()
  } catch {
    return true
  }
}
