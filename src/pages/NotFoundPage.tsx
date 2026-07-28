import { Link } from 'react-router-dom'

export function NotFoundPage() {
  return (
    <div className="mx-auto max-w-3xl px-5 py-24 text-center">
      <p className="text-xs font-semibold uppercase tracking-[0.2em] text-accent-deep">404</p>
      <h1 className="mt-2 font-display text-4xl font-semibold text-ink">This page doesn't exist</h1>
      <p className="mt-4 text-ink-soft">The address may have changed. Everything on the site is reachable from the home page.</p>
      <Link
        to="/"
        className="mt-8 inline-block rounded-full bg-brand px-5 py-2.5 text-sm font-semibold text-white no-underline hover:bg-accent"
      >
        Back to the start
      </Link>
    </div>
  )
}
