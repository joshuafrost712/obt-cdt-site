import { useState, type ReactNode } from 'react'
import { Link, NavLink } from 'react-router-dom'
import { getContent, navItems, siteLabel } from '../../lib/content/loader'
import { backendEnabled } from '../../lib/backend/config'
import { Txt } from '../text'
import { DevFeedbackMount } from './DevFeedbackMount'

export function SiteLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen flex flex-col">
      <SiteHeader />
      <main className="flex-1">{children}</main>
      <SiteFooter />
      <DevFeedbackMount />
    </div>
  )
}

function SiteHeader() {
  const [open, setOpen] = useState(false)
  const site = getContent().site
  const items = navItems()

  return (
    <header className="sticky top-0 z-40 border-b border-ink/10 bg-paper/90 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center gap-6 px-5 py-3">
        <Link to="/" className="flex items-baseline gap-2 no-underline" onClick={() => setOpen(false)}>
          <span aria-hidden className="inline-block size-3.5 translate-y-px rounded-full border-[3px] border-accent" />
          <Txt node={site} field="title" as="span" className="font-display text-lg font-semibold tracking-tight text-ink" />
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
              to="/account"
              className={({ isActive }) =>
                `rounded-full border px-3.5 py-1.5 text-sm font-medium no-underline transition-colors ${
                  isActive ? 'border-ink bg-ink text-paper' : 'border-ink/20 text-ink-soft hover:bg-paper-deep hover:text-ink'
                }`
              }
            >
              <span data-dfb-node="site.nav.account" data-dfb-field="label">
                {siteLabel('site.nav.account', 'My Account')}
              </span>
            </NavLink>
          )}
        </nav>
        <button
          type="button"
          className="ml-auto rounded-md border border-ink/15 px-3 py-1.5 text-sm font-medium text-ink md:hidden"
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
              to="/account"
              onClick={() => setOpen(false)}
              className={({ isActive }) =>
                `block rounded-lg px-3 py-2.5 text-base font-medium no-underline ${
                  isActive ? 'bg-ink text-paper' : 'text-ink-soft'
                }`
              }
            >
              <span data-dfb-node="site.nav.account" data-dfb-field="label">
                {siteLabel('site.nav.account', 'My Account')}
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
