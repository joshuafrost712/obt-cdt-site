/**
 * "Is this browser in the middle of setting a new password?"
 *
 * Spec SITE-09, contract c1. The reset link signs a person in and hands them a
 * session like any other. Without this flag the portal is indistinguishable
 * from a normal signed-in portal, which is the defect the audit measured on
 * 2026-09-10: the link worked, the email arrived, and no screen ever set a
 * password.
 *
 * ## Why this is persisted and not React state
 *
 * SITE-09's stage-6 review, finding B1, and it is the finding that would have
 * cost the build session. Three things are true at once:
 *
 *   1. auth-js parses the URL fragment, emits `PASSWORD_RECOVERY` ONCE, and
 *      clears the fragment. A second read of `location.hash` finds nothing.
 *   2. `App.tsx` mounts a SEPARATE `AuthGate` per route, so React state in one
 *      gate does not exist in the next one.
 *   3. `SiteLayout` reads the stored token through `hasLiveSession()`, so the
 *      member nav renders regardless of what any gate believes.
 *
 * Together those mean a nav click, a reload, or a reopened tab would land the
 * person in the member shell with no password set: the original defect, one
 * interaction away. So the flag outlives the event, the component and the
 * route, and criterion 1a asserts exactly that across a reload and a nav.
 *
 * ## This is a hint, not a control
 *
 * Same standing as `sessionHint.ts` beside it. A person who clears this value
 * in their own browser reaches a portal they are already signed into by a link
 * GoTrue itself validated. They gain nothing they did not already have; they
 * only skip being asked to set a password. Every real boundary is elsewhere:
 * RLS decides what the database returns, and `updateUser` needs the live
 * session GoTrue minted. What this flag protects is the PERSON, not the data,
 * by making sure the one thing they came to do is the one thing on screen.
 */
const KEY = 'obtcdt.portal.recovery'

export function markRecovery(): void {
  try {
    localStorage.setItem(KEY, '1')
  } catch {
    // Private mode, or storage disabled. The consequence is that the recovery
    // form does not survive a reload, so the person sees the member shell and
    // must click the emailed link again. Worse, but not wrong, and not worth an
    // error path in front of someone who is already locked out.
  }
}

export function clearRecovery(): void {
  try {
    localStorage.removeItem(KEY)
  } catch {
    /* see above */
  }
}

export function inRecovery(): boolean {
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
}
