// Spec CDT-00 criteria 3, 4, 5 and 11: load the built site in a real browser
// and report CSP violations, the frame-buster's behaviour, LCP, and screenshots.
//
// Runs against whatever `--url` serves, so the same script grades the local
// dist and the deployed bundle. It does not build anything; run
// `scripts/serve-dist.mjs` first.
//
// Usage:
//   node scripts/cdt00-browser-check.mjs --url http://localhost:4183/obt-cdt-site/ \
//        --label after --out /path/to/artifacts [--expect-portal]
//
// --expect-portal makes the /portal check fail when the portal is not routed,
// which is criterion 3's rule: a CSP check that renders NotFoundPage passes
// vacuously and is worse than no check.

import { mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'
import { launch, visit, shoot } from './lib/browser.mjs'

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}
const flag = (name) => process.argv.includes(`--${name}`)

const BASE = arg('url', 'http://localhost:4183/obt-cdt-site/').replace(/\/$/, '') + '/'
const LABEL = arg('label', 'run')
const OUT = arg('out', path.join(process.cwd(), 'cdt00-artifacts'))
const expectPortal = flag('expect-portal')
// Screenshots of the 1440px home page take minutes; skip them when re-running
// the fast checks.
const skipShots = flag('skip-shots')

const PAGES = [
  { name: 'home', url: '' },
  { name: 'handbook', url: 'workshops/psalms-bali-2026/' },
  { name: 'dev', url: 'dev/' },
  { name: 'portal', url: 'portal' },
]

// The handbook is roughly 22,000px tall, so it is photographed one section deep
// rather than whole: criterion 5 asks for "one handbook section". #s14-meals is
// chosen because it carries body copy, bold runs, a heading and a link card, so
// three of the four families appear in one frame.
const SHOTS = [
  { name: 'home-1440', url: '', width: 1440, fullPage: true },
  { name: 'home-390', url: '', width: 390, fullPage: true },
  {
    name: 'handbook-1440',
    url: 'workshops/psalms-bali-2026/',
    width: 1440,
    height: 1100,
    fullPage: false,
    anchor: '#s14-meals',
  },
  {
    name: 'handbook-390',
    url: 'workshops/psalms-bali-2026/',
    width: 390,
    height: 1100,
    fullPage: false,
    anchor: '#s14-meals',
  },
]

await mkdir(OUT, { recursive: true })
const browser = await launch()
console.log(`browser: ${browser.version.Browser}`)
console.log(`target:  ${BASE}`)
console.log(`label:   ${LABEL}\n`)

let failures = 0
const report = { label: LABEL, base: BASE, browser: browser.version.Browser, pages: {}, lcp: {} }

// --- Criterion 3: zero CSP violations on four routes -------------------------
console.log('CSP violations, per route')
for (const p of PAGES) {
  const r = await visit(browser, BASE + p.url, { settle: 1800, scroll: true })
  const external = r.requests.filter(
    (u) => /^https?:\/\//.test(u) && !u.startsWith(new URL(BASE).origin),
  )
  report.pages[p.name] = {
    violations: r.violations,
    notices: r.notices,
    consoleErrors: r.consoleErrors,
    fontRequests: r.requests.filter((u) => u.endsWith('.woff2')).map((u) => u.split('/').pop()),
    externalRequests: [...new Set(external)],
    title: r.title,
    lcp: r.lcp,
    rendered: r.bodyText.slice(0, 120).replace(/\s+/g, ' '),
  }
  const bad = r.violations.length
  console.log(
    `  ${p.name.padEnd(9)} violations=${bad}  expected-notices=${r.notices.length}  ` +
      `external-requests=${new Set(external).size}  fonts=${r.requests.filter((u) => u.endsWith('.woff2')).length}`,
  )
  for (const v of r.violations) console.log(`      ! ${v.text.slice(0, 160)}`)
  for (const u of new Set(external)) console.log(`      → ${u}`)
  if (bad) failures++

  if (p.name === 'portal') {
    const isNotFound = /not found|page not found/i.test(r.bodyText) || /Not Found/i.test(r.title)
    if (expectPortal && isNotFound) {
      console.log('      FAIL portal rendered NotFoundPage; this check would pass vacuously')
      failures++
    } else if (!expectPortal && isNotFound) {
      console.log('      SKIP portal is not routed (backendEnabled false). Criterion 3 is')
      console.log('           incomplete by design, not passing. See D0 blocker.')
      report.pages.portal.vacuous = true
    }
  }
}

// --- Criterion 4: the frame-buster ------------------------------------------
//
// The framing page is served over HTTP from a DIFFERENT PORT, which makes it a
// different origin and therefore the real clickjacking scenario. An earlier
// version of this check used a file:// parent, where Chrome will not let an
// http: child navigate the top document at all, so the check reported "no bust"
// for a reason that had nothing to do with the site.
console.log('\nFrame-buster (criterion 4)')
// A deployed URL has no port, so fall back to a fixed one. The attacker page
// only has to be a DIFFERENT ORIGIN from the site; localhost against
// joshuafrost712.github.io is comfortably that.
const sitePort = Number(new URL(BASE).port)
const attackerPort = Number.isFinite(sitePort) && sitePort ? sitePort + 100 : 4383
const framePage = (target) =>
  `<!doctype html><meta charset=utf-8><title>attacker page</title>
   <h1>attacker page</h1>
   <iframe src="${target}" width=700 height=400></iframe>`

const attacker = createServer((req, res) => {
  const target = req.url === '/home' ? BASE : BASE + 'portal'
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(framePage(target))
})
await new Promise((r) => attacker.listen(attackerPort, r))
const attackerOrigin = `http://localhost:${attackerPort}`
console.log(`  attacker origin: ${attackerOrigin} (cross-origin to ${new URL(BASE).origin})`)

report.frameBuster = {}
for (const [name, urlPath] of [
  ['portal', '/portal'],
  ['home', '/home'],
]) {
  const r = await visit(browser, attackerOrigin + urlPath, { settle: 3500, frames: true })
  const escaped = r.href.startsWith(new URL(BASE).origin)
  const child = r.childFrames[0] || { url: '(none)', title: '', text: '', marker: false }
  report.frameBuster[name] = {
    topHrefAfter: r.href,
    escaped,
    childUrl: child.url,
    childTitle: child.title,
    childRefused: Boolean(child.marker),
    childTextHead: (child.text || '').slice(0, 100).replace(/\s+/g, ' '),
  }
  console.log(`  framing ${name.padEnd(7)} top=${r.href}`)
  console.log(`           framed document: "${child.title}"`)
  console.log(`           first words: ${(child.text || '(empty)').slice(0, 70).replace(/\s+/g, ' ')}`)

  if (name === 'portal') {
    // Either outcome is a pass: escaping the frame, or refusing to render in it.
    // Refusal is what current Chrome actually permits without user activation.
    if (escaped) console.log('    PASS the portal replaced the top document')
    else if (child.marker) console.log('    PASS the portal refused to render inside the frame')
    else {
      console.log('    FAIL the portal rendered normally inside a cross-origin frame')
      failures++
    }
  } else {
    if (escaped) {
      console.log('    FAIL a public page broke out of the frame; the guard is too broad')
      failures++
    } else if (child.marker) {
      console.log('    FAIL a public page refused to render; the guard is too broad')
      failures++
    } else {
      console.log('    PASS the home page rendered in the frame (public pages stay shareable)')
    }
  }
}
await new Promise((r) => attacker.close(r))
await writeFile(
  path.join(OUT, `frame-test-${LABEL}.html`),
  framePage(BASE + 'portal') + '\n<!-- served from a second port during the run -->\n',
)

// --- Criterion 11: LCP ------------------------------------------------------
console.log('\nLCP (criterion 11), median of 3 loads')
for (const p of PAGES.slice(0, 2)) {
  const runs = []
  for (let i = 0; i < 3; i++) {
    const r = await visit(browser, BASE + p.url, { settle: 2200 })
    runs.push(r.lcp)
  }
  runs.sort((a, b) => a - b)
  report.lcp[p.name] = { runs, median: runs[1] }
  console.log(`  ${p.name.padEnd(9)} ${runs.join(' / ')} ms   median ${runs[1]} ms`)
}

// --- Criterion 5: screenshots ----------------------------------------------
console.log('\nScreenshots (criterion 5)')
if (skipShots) console.log('  skipped (--skip-shots)')
for (const s of skipShots ? [] : SHOTS) {
  const png = await shoot(browser, BASE + s.url, {
    width: s.width,
    height: s.height ?? 900,
    fullPage: s.fullPage !== false,
    anchor: s.anchor ?? null,
  })
  const file = path.join(OUT, `${s.name}-${LABEL}.png`)
  await writeFile(file, png)
  console.log(`  ${path.basename(file)}  ${(png.length / 1024).toFixed(0)} KB`)
}

await writeFile(path.join(OUT, `report-${LABEL}.json`), JSON.stringify(report, null, 2))
await browser.close()

console.log(`\nartifacts in ${OUT}`)
console.log(failures ? `FAILURES: ${failures}` : 'no CSP violations and no failed checks')
process.exit(failures ? 1 : 0)
