/**
 * Build-time prerender. Runs after `vite build` (client → dist/) and
 * `vite build --ssr src/prerender-entry.tsx --outDir dist-ssr`. For every
 * route in the content store it renders real HTML into dist/<route>/index.html
 * with per-page <title>/<meta>/OG tags, then emits sitemap.xml and robots.txt.
 * GitHub Pages therefore serves crawlable pages; 404.html stays the plain app
 * shell so unknown paths still client-render the NotFound page.
 *
 * Pages marked `hidden` in the content store are still prerendered (so a
 * participant with the link gets real HTML, printable and readable without JS)
 * but get noindex and no sitemap entry.
 */
import { mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(root, 'dist')

const { render, routes, hiddenRoutes, redirects } = await import(
  pathToFileURL(join(root, 'dist-ssr', 'prerender-entry.js')).href
)

const template = readFileSync(join(dist, 'index.html'), 'utf8')

// 404.html is the UN-prerendered shell: unknown paths client-render NotFound.
copyFileSync(join(dist, 'index.html'), join(dist, '404.html'))

// Absolute-URL prefix for canonical/OG/sitemap. VITE_SITE_ORIGIN is the bare
// origin (no trailing slash); VITE_BASE is the Pages project path.
const origin = process.env.VITE_SITE_ORIGIN || 'https://joshuafrost712.github.io'
const base = process.env.VITE_BASE || '/'
const site = origin + base.replace(/\/$/, '')

const esc = (s) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;')

const routeList = routes()
const unlisted = new Set(hiddenRoutes())
for (const route of routeList) {
  const { html, title, description } = render(route)
  const canonical = site + (route === '/' ? '/' : route + '/')
  const head = [
    `<meta name="description" content="${esc(description)}" />`,
    ...(unlisted.has(route) ? [`<meta name="robots" content="noindex, nofollow" />`] : []),
    `<link rel="canonical" href="${canonical}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:title" content="${esc(title)}" />`,
    `<meta property="og:description" content="${esc(description)}" />`,
    `<meta property="og:url" content="${canonical}" />`,
  ].join('\n    ')
  const page = template
    .replace(/<title>.*?<\/title>/, `<title>${esc(title)}</title>`)
    .replace('<!--app-head-->', head)
    .replace('<!--app-html-->', html)
  const outDir = route === '/' ? dist : join(dist, ...route.split('/').filter(Boolean))
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, 'index.html'), page)
}

// Retired routes. A link that has already gone out by email has to keep
// working, so each one gets a real page: meta refresh for browsers, canonical
// and noindex for crawlers, and a visible link for anyone with JS off or a
// refresh they can't follow.
for (const [from, to] of Object.entries(redirects())) {
  const target = base.replace(/\/$/, '') + to + '/'
  const page = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="refresh" content="0; url=${target}" />
    <meta name="robots" content="noindex, nofollow" />
    <link rel="canonical" href="${site + to + '/'}" />
    <title>Moved · OBT Consultant Development Track</title>
  </head>
  <body>
    <p>This page has moved. <a href="${target}">Continue to the Psalms workshop and handbook</a>.</p>
  </body>
</html>
`
  const outDir = join(dist, ...from.split('/').filter(Boolean))
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, 'index.html'), page)
}

// Developer-version entry: opening <site>/dev/ turns the review tools on for
// this device (same as ?dev=1) and lands on the home page. Memorable link for
// Josh & reviewers; not in the sitemap or nav.
const devEntry = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="robots" content="noindex" />
    <title>OBT-CDT · developer version</title>
    <script>
      try { localStorage.setItem('cdt.dev', '1') } catch (e) {}
      location.replace('${base}')
    </script>
  </head>
  <body>
    <p>Turning on review tools… <a href="${base}">Continue to the site</a>.</p>
  </body>
</html>
`
mkdirSync(join(dist, 'dev'), { recursive: true })
writeFileSync(join(dist, 'dev', 'index.html'), devEntry)

const sitemap = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  ...routeList
    .filter((r) => !unlisted.has(r))
    .map((r) => `  <url><loc>${site + (r === '/' ? '/' : r + '/')}</loc></url>`),
  '</urlset>',
  '',
].join('\n')
writeFileSync(join(dist, 'sitemap.xml'), sitemap)
writeFileSync(join(dist, 'robots.txt'), `User-agent: *\nAllow: /\n\nSitemap: ${site}/sitemap.xml\n`)

console.log(
  `prerendered ${routeList.length} routes → dist/ (${unlisted.size} unlisted, ` +
    `${Object.keys(redirects()).length} redirected)`,
)
