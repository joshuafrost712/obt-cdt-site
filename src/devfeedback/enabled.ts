/**
 * Dev-feedback gate. The in-app feedback tools (highlight → comment, the
 * comment manager, "send batch to Claude") are a development affordance, NOT a
 * feature for real users. They mount only when this returns true:
 *
 *   - any `vite dev` build (import.meta.env.DEV) — always on locally; or
 *   - any build where localStorage['cdt.dev'] === '1'. This is the reliable
 *     way to reach the tools in a DEPLOYED build (e.g. on a phone): open the
 *     site once with `?dev=1` in the URL and they stay on for good on that
 *     device. `?dev=0` turns them back off.
 *
 * Production for users leaves the flag unset, so the tools never appear.
 */
export const DEV_FLAG_KEY = 'cdt.dev'

/**
 * Apply a `?dev=1` / `?dev=0` URL switch to the persisted flag. Bookmarking
 * `<site-url>?dev=1` is the dependable, cross-device way to turn the tools on.
 */
function applyUrlOverride(): void {
  try {
    const q = new URLSearchParams(window.location.search).get('dev')
    if (q === '1') localStorage.setItem(DEV_FLAG_KEY, '1')
    else if (q === '0') localStorage.removeItem(DEV_FLAG_KEY)
  } catch {
    /* no window/localStorage — ignore */
  }
}

export function isFeedbackEnabled(): boolean {
  applyUrlOverride()
  if (import.meta.env.DEV) return true
  try {
    return localStorage.getItem(DEV_FLAG_KEY) === '1'
  } catch {
    return false
  }
}
