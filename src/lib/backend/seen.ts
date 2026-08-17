/**
 * Has this browser ever held a portal session?
 *
 * The Collaborative-Data-Protocol rule behind this: an event you were not
 * present for is not an event. Supabase reports a signed-out browser and an
 * expired-while-the-tab-was-closed browser identically — both are `session ===
 * null` — but they are different situations for the person looking at the
 * screen. One is "sign in"; the other is "you were signed in and are not any
 * more", which is the one that otherwise reads as the portal losing their
 * reports.
 *
 * Keyed by nothing and holding nothing: it is a single boolean, not an identity,
 * so it is safe on a shared machine. Cleared on deliberate sign-out, because
 * signing out and coming back should be the cold path.
 */
const KEY = 'obtcdt.portal.had-account'

export function markHadAccount(): void {
  try {
    localStorage.setItem(KEY, '1')
  } catch {
    // Private mode, or storage disabled. The consequence is a slightly worse
    // signed-out message, which is not worth an error path.
  }
}

export function clearHadAccount(): void {
  try {
    localStorage.removeItem(KEY)
  } catch {
    /* see above */
  }
}

export function hadAccount(): boolean {
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
}
