/**
 * Interim clickjacking control for the portal, from spec CDT-00 D3.
 *
 * The site's CSP carries `frame-ancestors 'none'`, and browsers ignore that
 * directive when it arrives in a meta tag. GitHub Pages cannot send response
 * headers, so on the deployed site there is currently no header-delivered
 * protection against the portal being framed by another page. This is the
 * stand-in until CDT-DOMAIN puts Cloudflare in front and the directive becomes
 * real, at which point this file is deleted rather than kept: a defeatable
 * control left in place reads as protection.
 *
 * It does NOT navigate the top frame, which is what the spec assumed and what
 * this build measured as impossible. Chrome requires transient user activation
 * before a cross-origin frame may navigate its top-level browsing context, so
 * `window.top.location.replace()` from a framed page with no click behind it is
 * refused and logged as an unsafe navigation attempt. A frame-buster written
 * that way looks correct in review and does nothing in production.
 *
 * So the control is refusal instead of escape. On a framed portal route the app
 * never mounts; the document is replaced with a plain notice and a link that
 * opens the portal at top level. The click on that link carries the activation
 * the navigation needs, which is the one moment escape is actually permitted.
 * An attacker gains nothing from framing a page that renders no portal UI.
 *
 * Portal routes only. The public pages, and the participant handbook above all,
 * are meant to be shareable and embeddable; refusing to render there would
 * break a legitimate use for no gain.
 *
 * It runs from main.tsx rather than from a portal component on purpose, so it
 * fires on /portal even while `backendEnabled` is false and that path renders
 * the NotFound page. That keeps CDT-00 criterion 4 something a session can
 * demonstrate now instead of deferring it to CDT-04.
 */

const PORTAL_PREFIX = '/portal'

/** A marker the build's browser check looks for. Do not change it silently. */
export const FRAME_REFUSAL_MARKER = 'cdt-frame-refused'

/** Strip the Pages project base (/obt-cdt-site/) off a pathname. */
function routePath(pathname: string, base: string): string {
  const b = base.replace(/\/$/, '')
  const p = b && pathname.startsWith(b) ? pathname.slice(b.length) : pathname
  return p.startsWith('/') ? p : '/' + p
}

export function isPortalRoute(pathname: string, base: string): boolean {
  const p = routePath(pathname, base)
  return p === PORTAL_PREFIX || p.startsWith(PORTAL_PREFIX + '/')
}

export type FrameVerdict = 'top-level' | 'not-portal' | 'refused'

export function guardAgainstFraming(base: string = '/'): FrameVerdict {
  if (typeof window === 'undefined') return 'top-level'
  if (window.top === window.self) return 'top-level'
  if (!isPortalRoute(window.location.pathname, base)) return 'not-portal'

  const href = window.location.href

  // Try the escape anyway. It succeeds when the framing page is same-origin, or
  // when activation happens to be present, and costs nothing when it is not.
  try {
    window.top!.location.replace(href)
  } catch {
    /* cross-origin without activation; the refusal below is the real control */
  }

  // Refuse to render. Written with DOM calls rather than innerHTML so the CSP
  // needs no exception, and styled inline because the stylesheet may not have
  // loaded yet.
  const doc = window.document
  doc.title = 'Cannot be displayed in a frame'
  const root = doc.body || doc.documentElement
  while (root.firstChild) root.removeChild(root.firstChild)

  const box = doc.createElement('main')
  box.setAttribute('data-testid', FRAME_REFUSAL_MARKER)
  box.style.cssText =
    'font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1.25rem;color:#003049'

  const h = doc.createElement('h1')
  h.style.cssText = 'font-size:1.35rem;margin:0 0 .75rem'
  h.textContent = 'This page cannot be shown inside another site'

  const p = doc.createElement('p')
  p.style.cssText = 'margin:0 0 1.25rem'
  p.textContent =
    'The member portal refuses to load in a frame, so that nothing can be laid over it. ' +
    'Open it directly instead.'

  const a = doc.createElement('a')
  a.href = href
  a.target = '_top'
  a.rel = 'noreferrer'
  a.textContent = 'Open the OBT-CDT portal'
  a.style.cssText = 'color:#005cb9;font-weight:600'

  box.append(h, p, a)
  root.appendChild(box)

  return 'refused'
}
