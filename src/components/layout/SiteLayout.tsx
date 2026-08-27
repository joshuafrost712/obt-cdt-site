import { useEffect, useState, type ReactNode } from 'react'
import { Link, NavLink } from 'react-router-dom'
import { getContent, navItems, siteLabel } from '../../lib/content/loader'
import { backendEnabled } from '../../lib/backend/config'
import { hasLiveSession, SESSION_EVENT } from '../../lib/backend/sessionHint'
import { Txt } from '../text'
import { DevFeedbackMount } from './DevFeedbackMount'
import { MovedAnchors } from './MovedAnchors'

export function SiteLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen flex flex-col">
      <SiteHeader />
      <main className="flex-1">
        {children}
        {/* Spec SITE-03 D6. One call site, so a moved fragment keeps its id
            whatever page component is rendering above it. */}
        <MovedAnchors />
      </main>
      <SiteFooter />
      <DevFeedbackMount />
    </div>
  )
}

function SiteHeader() {
  const [open, setOpen] = useState(false)
  // Resolved after mount, never during render. The prerendered HTML is the
  // signed-out nav for everyone, so reading storage during the first render
  // would be a hydration mismatch on every page of the site.
  const [signedIn, setSignedIn] = useState(false)
  useEffect(() => {
    const read = () => setSignedIn(backendEnabled && hasLiveSession())
    read()
    // `storage` alone is not enough: it fires for other tabs and never for the
    // one that signed in, so the nav would stay wrong until a reload.
    window.addEventListener(SESSION_EVENT, read)
    window.addEventListener('storage', read)
    return () => {
      window.removeEventListener(SESSION_EVENT, read)
      window.removeEventListener('storage', read)
    }
  }, [])
  const site = getContent().site
  const items = navItems({ signedIn })

  return (
    <header className="sticky top-0 z-40 border-b border-ink/10 bg-paper/90 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center gap-3 px-5 py-3 md:gap-6">
        {/* min-w-0 + truncate: the full title is wider than a 375px phone, and a
            wrapped header breaks the sticky offsets keyed to its one-line height. */}
        <Link to="/" className="flex min-w-0 items-baseline gap-2 no-underline" onClick={() => setOpen(false)}>
          <span aria-hidden className="inline-block size-3.5 shrink-0 translate-y-px rounded-full border-[3px] border-accent" />
          <Txt
            node={site}
            field="title"
            as="span"
            className="truncate font-display text-base font-semibold tracking-tight text-ink sm:text-lg"
          />
        </Link>
        <nav aria-label="Site" className="ml-auto hidden items-center gap-1 md:flex">
          {items.map((item) => (
            <NavLink
              key={item.route}
              to={item.route}
              end={item.route === '/'}
              className={({ isActive }) =>
                `rounded-full px-3.5 py-1.5 text-sm font-medium no-underline transition-colors ${
                  isActive ? 'bg-ink text-paper' : 'text-ink-soft hover:bg-paper-deep hover:text-ink'
                }`
              }
            >
              <span data-dfb-node={item.nodeId} data-dfb-field="navLabel">
                {item.label}
              </span>
            </NavLink>
          ))}
          {backendEnabled && (
            <NavLink
              to="/portal"
              className={({ isActive }) =>
                `rounded-full border px-3.5 py-1.5 text-sm font-medium no-underline transition-colors ${
                  isActive ? 'border-ink bg-ink text-paper' : 'border-ink/20 text-ink-soft hover:bg-paper-deep hover:text-ink'
                }`
              }
            >
              <span data-dfb-node="site.nav.portal" data-dfb-field="label">
                {siteLabel('site.nav.portal', 'Member portal')}
              </span>
            </NavLink>
          )}
        </nav>
        <button
          type="button"
          className="ml-auto shrink-0 rounded-md border border-ink/15 px-3 py-1.5 text-sm font-medium text-ink md:hidden"
          aria-expanded={open}
          aria-label="Toggle menu"
          onClick={() => setOpen((v) => !v)}
        >
          Menu
        </button>
      </div>
      {open && (
        <nav aria-label="Site" className="border-t border-ink/10 px-5 pb-4 pt-2 md:hidden">
          {items.map((item) => (
            <NavLink
              key={item.route}
              to={item.route}
              end={item.route === '/'}
              onClick={() => setOpen(false)}
              className={({ isActive }) =>
                `block rounded-lg px-3 py-2.5 text-base font-medium no-underline ${
                  isActive ? 'bg-ink text-paper' : 'text-ink-soft'
                }`
              }
            >
              <span data-dfb-node={item.nodeId} data-dfb-field="navLabel">
                {item.label}
              </span>
            </NavLink>
          ))}
          {backendEnabled && (
            <NavLink
              to="/portal"
              onClick={() => setOpen(false)}
              className={({ isActive }) =>
                `block rounded-lg px-3 py-2.5 text-base font-medium no-underline ${
                  isActive ? 'bg-ink text-paper' : 'text-ink-soft'
                }`
              }
            >
              <span data-dfb-node="site.nav.portal" data-dfb-field="label">
                {siteLabel('site.nav.portal', 'Member portal')}
              </span>
            </NavLink>
          )}
        </nav>
      )}
    </header>
  )
}

function SiteFooter() {
  const site = getContent().site
  return (
    <footer className="bg-navy text-paper">
      <div className="mx-auto max-w-6xl px-5 py-12">
        <div className="flex flex-col gap-8 md:flex-row md:items-end md:justify-between">
          <div className="max-w-md">
            <Txt node={site} field="title" as="p" className="font-display text-xl font-semibold" />
            <Txt node={site} field="tagline" as="p" className="mt-2 text-sm leading-relaxed text-paper/70" />
          </div>
          <a
            href="mailto:josh_frost@sil.org"
            className="inline-block rounded-full bg-brand px-5 py-2.5 text-sm font-semibold text-white no-underline transition-colors hover:bg-accent"
          >
            josh_frost@sil.org
          </a>
        </div>
        <Txt node={site} field="footerNote" as="p" className="mt-10 border-t border-paper/15 pt-6 text-xs leading-relaxed text-paper/50" />
      </div>
    </footer>
  )
}
