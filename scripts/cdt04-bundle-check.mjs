/**
 * CDT-04 criterion 13: nothing the portal needs leaked into the main bundle or
 * the prerender.
 *
 *   npm run build && node scripts/cdt04-bundle-check.mjs
 *
 * ## The criterion's own premise had to be corrected, and this is where it is said
 *
 * CDT-04 criterion 13 asks for "the Supabase project URL and the `supabase-js`
 * client-info string asserted absent from the entry chunk", citing the program
 * doc's measurement that the deployed bundle "contains zero occurrences of
 * `supabase.co`".
 *
 * That measurement was taken while the deploy variables were UNSET. CDT-00 D0 set
 * them on 2026-08-21, so `src/lib/backend/config.ts` now reads a real
 * `VITE_SUPABASE_URL` at build time in order to compute `backendEnabled`, and
 * Vite inlines it. The URL is therefore in the entry chunk BY DESIGN and cannot
 * be otherwise: `docs/PORTAL.md` records that both the URL and the publishable
 * key ship in the JS bundle, carry the `anon` role, and are exactly what a
 * visitor's browser already holds. Asserting their absence would be asserting
 * that the portal is switched off.
 *
 * So the substantive guarantees, which are the ones that were ever really at
 * stake, are checked instead:
 *
 *   1. `supabase-js` itself is NOT in the entry chunk. It is a 208K dependency and
 *      the whole point of the lazy portal routes is that a visitor reading the
 *      Bali handbook never downloads it.
 *   2. The entry chunk does not statically import any portal chunk, so the code
 *      splitting is real rather than nominal.
 *   3. No prerendered HTML file mentions the project OUTSIDE the generated CSP
 *      meta tag. Inside it is required; anywhere else would mean a portal render
 *      leaked into a static page.
 *   4. The HTML file count matches routes + hidden + redirects + 404 + dev.
 *
 * A grep for `assessApi` or a page module name is deliberately absent: Rollup
 * renames both, so such a grep cannot fail and would certify nothing.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import path from 'node:path'

const REPO = path.resolve(import.meta.dirname, '..')
const DIST = path.join(REPO, 'dist')
const ASSETS = path.join(DIST, 'assets')

if (!existsSync(ASSETS)) {
  console.error('no dist/assets; run npm run build first')
  process.exit(2)
}

let failures = 0
function check(name, actual, expected) {
  const ok = String(actual) === String(expected)
  if (!ok) failures++
  console.log(`  ${ok ? ' ok ' : 'FAIL'}  ${name}  expected=${expected} actual=${actual}`)
}

function htmlFiles(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) htmlFiles(p, out)
    else if (e.name.endsWith('.html')) out.push(p)
  }
  return out
}

const js = readdirSync(ASSETS).filter((f) => f.endsWith('.js'))
const entryName = js.find((f) => /^index-.*\.js$/.test(f))
if (!entryName) {
  console.error('could not find the entry chunk (assets/index-*.js)')
  process.exit(2)
}
const entry = readFileSync(path.join(ASSETS, entryName), 'utf8')

console.log(`criterion 13, against dist/assets/${entryName}`)

// 1. supabase-js is not in the entry chunk.
const MARKERS = ['supabase-js', 'X-Client-Info', 'gotrue']
for (const m of MARKERS) {
  check(`the entry chunk does not contain "${m}"`, entry.split(m).length - 1, 0)
}
const holders = js.filter((f) => {
  const src = readFileSync(path.join(ASSETS, f), 'utf8')
  return MARKERS.some((m) => src.includes(m))
})
check('exactly one lazy chunk carries supabase-js', holders.length, 1)
check('and it is not the entry chunk', holders.includes(entryName), false)
console.log(`        supabase-js lives in assets/${holders[0]}`)

// 2. The entry chunk statically imports no portal chunk.
const statics = [...entry.matchAll(/from"\.\/([A-Za-z0-9_.-]+\.js)"/g)].map((m) => m[1])
const portalish = statics.filter((f) => /Portal|Assignment|Writeup|assess|shared/i.test(f))
check('the entry chunk statically imports no portal chunk', portalish.length, 0)
console.log(`        entry static imports: ${statics.length === 0 ? '(none)' : statics.join(', ')}`)

// 3. No HTML file mentions the project outside the CSP meta tag.
// Excise the CSP meta tag and search what is left, rather than testing a
// character window around each hit. The policy names the project twice, over
// https and wss, and the second sits far enough past the attribute name that a
// proximity test called it a leak — a false positive that would have been
// "fixed" by widening the window until it stopped complaining.
const project = /lvzwmzqqvbnurumygcnt|supabase\.co/g
const CSP_TAG = /<meta[^>]+http-equiv=["']Content-Security-Policy["'][^>]*>/gi
let outside = 0
const files = htmlFiles(DIST)
for (const f of files) {
  const txt = readFileSync(f, 'utf8')
  const tags = txt.match(CSP_TAG) ?? []
  if (tags.length !== 1) {
    outside++
    console.log(`        ${path.relative(DIST, f)} carries ${tags.length} CSP meta tags, expected 1`)
    continue
  }
  const rest = txt.replace(CSP_TAG, '')
  for (const m of rest.matchAll(project)) {
    outside++
    const ctx = rest.slice(Math.max(0, m.index - 80), m.index + 60)
    console.log(`        outside the CSP in ${path.relative(DIST, f)}: …${ctx}…`)
  }
}
check('no project reference in any HTML file outside the CSP meta tag', outside, 0)

// 4. The HTML file count is accounted for, term by term, rather than asserted.
const ssr = path.join(REPO, 'dist-ssr/prerender-entry.js')
if (existsSync(ssr)) {
  const mod = await import(ssr)
  const routes = mod.allRoutes?.() ?? mod.routes?.() ?? []
  const reds = Object.keys(mod.redirects?.() ?? {})
  // +2 is 404.html and dev/index.html, both written by prerender.mjs and neither
  // a content route.
  const expected = routes.length + reds.length + 2
  check(
    `html files = routes(${routes.length}) + redirects(${reds.length}) + 404 + dev`,
    files.length,
    expected,
  )
} else {
  console.log('  note  dist-ssr is absent, so the file-count term check was skipped; run the full build')
  failures++
}

console.log(failures ? `\ncriterion 13 FAILED: ${failures}` : '\ncriterion 13: all checks pass.')
process.exit(failures ? 1 : 0)
