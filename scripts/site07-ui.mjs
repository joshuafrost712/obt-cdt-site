#!/usr/bin/env node
/**
 * SITE-07 lane B: the completed badges render, and the Psalms page's foot names
 * the workshop that comes next.
 *
 *   node scripts/site07-ui.mjs
 *
 * Short by design. This lane creates no accounts, signs nobody in and reads no
 * member content, so tracker findings 11, 36 and 40 do not engage: there are no
 * signed-in screenshots to gitignore and no fixture password to publish. A
 * session that finds itself wanting a signed-in screenshot has left SITE-07.
 *
 * Two campaign rules are structural here rather than remembered.
 *
 * EVERY GEOMETRY ASSERTION STATES A RANGE. Tracker finding 34: a single-sided
 * `top < 640` went green on an element 1,566px ABOVE the viewport, and the same
 * shape went green at -2,253px one spec earlier. `onScreenAboveFold` takes a
 * floor and a ceiling and prints the measured value either way, and the lane
 * scrolls to a known position before measuring.
 *
 * THE LANE RUNS TWICE AND THE SECOND VERDICT IS RECORDED. Tracker finding 35: a
 * harness whose verdict depends on whether it has run before is not a harness.
 * This one mutates nothing, so the second pass is cheap and the point is to
 * prove that rather than to assume it.
 */
import { readFileSync } from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'
import { homedir } from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright'

const REPO = path.resolve(import.meta.dirname, '..')
const CONTENT = path.join(REPO, 'src/content/site-content.json')
const PORT = 4203 // SITE-07's booked dist-preview port
const BASE = `http://localhost:${PORT}/obt-cdt-site`
const PSALMS = '/workshops/psalms-bali-2026'
const INDEX = '/workshops'
const NEW_NAME = 'Legal and Cultic Texts in the Torah'

let failures = 0
let checks = 0

function check(criterion, name, actual, expected) {
  checks++
  const ok = String(actual) === String(expected)
  if (!ok) failures++
  console.log(`  ${ok ? ' ok ' : 'FAIL'}  [${criterion}] ${name}  expected=${expected} actual=${actual}`)
  return ok
}

function note(text) {
  console.log(`        ${text}`)
}

/**
 * A range, never an inequality. `top` must be BELOW the top of the viewport and
 * ABOVE the fold; an element scrolled off the top has a large negative top and
 * passes any one-sided `< ceiling` test, which is exactly how this campaign
 * shipped two green checks on elements two thousand pixels out of sight.
 */
function onScreenAboveFold(criterion, name, top, { floor = 0, ceiling = 640 } = {}) {
  checks++
  const ok = top !== null && top >= floor && top < ceiling
  if (!ok) failures++
  console.log(
    `  ${ok ? ' ok ' : 'FAIL'}  [${criterion}] ${name}  ` +
      `expected ${floor} <= top < ${ceiling}  actual=${top}`,
  )
  return ok
}

function creds() {
  const file = path.join(homedir(), '.claude/secrets/obt-cdt-supabase.env')
  const out = execFileSync('/bin/zsh', [
    '-c',
    `set -a; . ${JSON.stringify(file)}; set +a; printf "%s\\n%s" ` +
      '"$OBT_CDT_SUPABASE_URL" "$OBT_CDT_SUPABASE_PUBLISHABLE_KEY"',
  ])
    .toString()
    .split('\n')
    .map((s) => s.trim())
  return { url: out[0], key: out[1] }
}
const { url, key } = creds()

function build() {
  execFileSync('npm', ['run', 'build'], {
    cwd: REPO,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      VITE_BASE: '/obt-cdt-site/',
      VITE_SITE_ORIGIN: 'https://joshuafrost712.github.io',
      VITE_SUPABASE_URL: url,
      VITE_SUPABASE_PUBLISHABLE_KEY: key,
    },
  })
}

function startServer() {
  const server = spawn('node', [path.join(REPO, 'scripts/serve-dist.mjs'), '--port', String(PORT)], {
    cwd: REPO,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return new Promise((resolve) => {
    const done = () => resolve(server)
    server.stdout.on('data', (d) => {
      if (String(d).includes(String(PORT))) done()
    })
    setTimeout(() => done(), 2500)
  })
}

const content = JSON.parse(readFileSync(CONTENT, 'utf8'))
// No `?? 'Completed'` fallback. A default would mask a deleted node and turn
// criterion 10's label assertion into a comparison of a literal with itself —
// the check would go on passing with the node gone. Stage-6 note 2.
const badgeLabel = content.site.items.find((i) => i.id === 'site.badge.complete')?.label
if (!badgeLabel) {
  console.error('REFUSED: site.badge.complete is not a node in site-content.json.')
  console.error('Criterion 10 asserts the badge renders THAT label; without it there is nothing to assert.')
  process.exit(2)
}

/** One full pass of every criterion. Mutates nothing, so it is safe to repeat. */
async function pass(browser, label) {
  console.log(`\n===== ${label} =====`)

  // ---------------------------------------------------------------- criterion 10
  console.log('\ncriterion 10  the badges render as completed, in a stated range, at two widths')
  for (const width of [1280, 768]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } })
    // A cold load, not a same-document navigation: SITE-05's build found a
    // hash navigation leaving the scroll flags set so the wait returned early.
    await page.goto(`${BASE}${PSALMS}`, { waitUntil: 'networkidle' })
    // Scroll to a KNOWN position before measuring. Finding 34's other half.
    await page.evaluate(() => window.scrollTo(0, 0))
    await page.waitForFunction(() => window.scrollY === 0, { timeout: 10000 })

    const badge = await page.evaluate((wanted) => {
      const el = [...document.querySelectorAll('span, div')].find(
        (e) => e.textContent.trim() === wanted && e.children.length === 0,
      )
      if (!el) return { missing: true }
      const r = el.getBoundingClientRect()
      return {
        missing: false,
        top: Math.round(r.top),
        height: Math.round(r.height),
        text: el.textContent.trim(),
        classes: el.className,
      }
    }, badgeLabel)

    check(10, `[${width}px] the hero badge exists`, !badge.missing, true)
    if (!badge.missing) {
      note(`classes: ${badge.classes}`)
      check(10, `[${width}px] the badge reads the site.badge.complete label`, badge.text, badgeLabel)
      check(10, `[${width}px] the badge has real height`, badge.height > 8, true)
      onScreenAboveFold(10, `[${width}px] the hero badge is on screen and above the fold`, badge.top)
      check(
        10,
        `[${width}px] the badge carries the completed tone`,
        /bg-brand-soft/.test(badge.classes),
        true,
      )
    }

    // Criterion 11's absence half, and its first draft could only ever detect a
    // regression of what this very build removed: the pattern was five literal
    // phrases, four of which had just been deleted. That is tracker finding 38 —
    // a discriminator that is a property of the fixture rather than of the
    // system. The three checks below are properties of the system.
    //
    // (a) The status vocabulary, read from the site's OWN badge nodes rather
    //     than typed here. Whatever the other statuses are called, none of them
    //     may render AS A BADGE on a completed workshop's page.
    //
    //     Scoped to what StatusBadge renders, not to every leaf. The first
    //     version scanned all text and went red on `psalms.cta`'s "being
    //     planned for late 2026 or early 2027" — the words that make up the
    //     `site.badge.planned` label, used as ordinary prose about a different
    //     workshop. A status label is a badge; the same words in a sentence are
    //     a sentence. Comparing a rendered BADGE against the site's own status
    //     vocabulary stays a property of the system either way.
    const statusLabels = Object.fromEntries(
      content.site.items
        .filter((i) => i.id?.startsWith('site.badge.'))
        .map((i) => [i.id, i.label]),
    )
    const otherStatusLabels = Object.entries(statusLabels)
      .filter(([id]) => id !== 'site.badge.complete')
      .map(([, label]) => label)
    const rendered = await page.evaluate(() =>
      [...document.querySelectorAll('[class*="rounded-full"]')]
        .filter(
          (e) =>
            e.children.length === 0 &&
            /uppercase/.test(e.className) &&
            /tracking-wide/.test(e.className),
        )
        .map((e) => e.textContent.trim()),
    )
    note(`status vocabulary, from site.badge.*: ${JSON.stringify(statusLabels)}`)
    note(`badge-shaped elements rendered: ${JSON.stringify(rendered)}`)
    // The population must be non-empty or this proves nothing.
    check(11, `[${width}px] at least one badge-shaped element renders`, rendered.length > 0, true)
    const staleBadges = rendered.filter((t) =>
      otherStatusLabels.some((l) => t.toLowerCase() === l.toLowerCase()),
    )
    for (const t of staleBadges) note(`stale status badge: ${t}`)
    check(11, `[${width}px] no other status label renders as a badge`, staleBadges.length, 0)

    // (b) Every call to action on the page, enumerated. None may target THIS
    //     workshop; the only ones allowed are psalms.cta's, which point at the
    //     series and at expressing interest in a workshop still to come.
    const ctas = await page.evaluate(() =>
      [...document.querySelectorAll('a[href^="mailto:"], a[href*="/workshops/"]')].map((a) => ({
        href: a.getAttribute('href'),
        text: a.textContent.trim().slice(0, 60),
      })),
    )
    for (const c of ctas) note(`cta: ${c.href}  "${c.text}"`)
    const selfTargeting = ctas.filter((c) => /psalms-bali-2026/.test(c.href))
    check(11, `[${width}px] no call to action targets the Psalms workshop itself`, selfTargeting.length, 0)

    // (c) Second-person future tense, by TENSE and not by phrase, in the two
    //     zones where the page speaks in its own voice about the workshop's
    //     status: everything before the first handbook section and everything
    //     after the last. The handbook sections themselves are the document the
    //     participants worked from and are knowingly EXEMPT — but the exempt
    //     population is counted and printed, because an exemption nobody can
    //     see is indistinguishable from a gap. The past-tense pass over the
    //     handbook body is the retrospective content round, tracker open item 12.
    const tense = await page.evaluate(() => {
      const future = /\byou will\b|\byou'll\b|\bwill be able to\b|\bbefore you arrive\b|\byou are going to\b/i
      const sections = [...document.querySelectorAll('[data-hb-section]')]
      const inSection = (el) => sections.some((s) => s.contains(el))
      const leaves = [...document.querySelectorAll('body *')].filter((e) => e.children.length === 0)
      const hits = leaves.filter((e) => future.test(e.textContent))
      return {
        statusZones: hits.filter((e) => !inSection(e)).map((e) => e.textContent.trim().slice(0, 110)),
        exemptCount: hits.filter((e) => inSection(e)).length,
        sectionCount: sections.length,
      }
    })
    note(
      `second-person future: ${tense.exemptCount} match(es) inside ${tense.sectionCount} handbook ` +
        'section(s), knowingly exempt (tracker open item 12, the retrospective round)',
    )
    for (const t of tense.statusZones) note(`future tense in a status zone: ${t}`)
    check(11, `[${width}px] no second-person future tense outside the handbook sections`, tense.statusZones.length, 0)
    check(
      11,
      `[${width}px] the exempt population is non-empty, so the exemption is real and not vacuous`,
      tense.sectionCount > 0,
      true,
    )

    await page.close()
  }

  // ---------------------------------------------------------------- criterion 11
  console.log('\ncriterion 11  the Psalms page names the next workshop at its foot')
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    await page.goto(`${BASE}${PSALMS}`, { waitUntil: 'networkidle' })
    // `data-dfb-node="psalms.cta"` is stamped on the title AND the body, told
    // apart by `data-dfb-field`. The first draft of this lane took
    // querySelector's first match, read the title, and reported that the CTA
    // did not name the next workshop — a harness defect that looked exactly
    // like a page defect. The field is part of the address, not decoration.
    const ctaText = await page.evaluate(() => {
      const parts = [...document.querySelectorAll('[data-dfb-node="psalms.cta"]')].map((e) => [
        e.getAttribute('data-dfb-field'),
        e.textContent.trim(),
      ])
      return Object.fromEntries(parts)
    })
    check(11, 'psalms.cta renders both its title and its body', Object.keys(ctaText).sort().join(','), 'body,title')
    note(`cta title: ${ctaText.title}`)
    note(`cta body:  ${(ctaText.body ?? '').replace(/\s+/g, ' ')}`)
    check(11, 'the CTA body names the next workshop in full', (ctaText.body ?? '').includes(NEW_NAME), true)

    // Scroll the CTA itself to a known position rather than scrolling to the
    // page bottom: a site footer sits below it, so "bottom of document" puts
    // the CTA 724px ABOVE the viewport. The one-sided form of this assertion
    // would have passed on that, which is tracker finding 34 exactly.
    //
    // And the scroll has to SETTLE before it is measured. The site sets
    // `scroll-behavior: smooth`, so measuring in the same evaluate that calls
    // scrollIntoView reads the position the page has not moved to yet: this
    // lane's second draft reported top=12130 on an element that does end up on
    // screen. Wait for scrollY to stop changing, then measure.
    await page.evaluate(() => {
      const el = document.querySelector('[data-dfb-node="psalms.cta"][data-dfb-field="body"]')
      el?.scrollIntoView({ block: 'center', behavior: 'instant' })
    })
    await page.waitForFunction(
      () => {
        const y = window.scrollY
        const settled = window.__site07LastY === y
        window.__site07LastY = y
        return settled
      },
      { timeout: 10000, polling: 120 },
    )
    const ctaTop = await page.evaluate(() => {
      const el = document.querySelector('[data-dfb-node="psalms.cta"][data-dfb-field="body"]')
      return el ? Math.round(el.getBoundingClientRect().top) : null
    })
    onScreenAboveFold(11, 'the CTA body is on screen once scrolled to', ctaTop, {
      floor: 0,
      ceiling: 900,
    })
    await page.close()
  }

  // ----------------------------------------------------------- the index cards
  console.log('\nthe index shows three completed workshops and one marked next')
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    await page.goto(`${BASE}${INDEX}`, { waitUntil: 'networkidle' })
    await page.evaluate(async () => {
      const step = Math.round(window.innerHeight * 0.8)
      for (let y = 0; y < document.body.scrollHeight; y += step) {
        window.scrollTo(0, y)
        await new Promise((r) => setTimeout(r, 60))
      }
      window.scrollTo(0, 0)
    })
    await page.waitForFunction(() => window.scrollY === 0, { timeout: 10000 })

    const badges = await page.evaluate(
      (wanted) =>
        [...document.querySelectorAll('span, div')].filter(
          (e) => e.children.length === 0 && e.textContent.trim() === wanted,
        ).length,
      badgeLabel,
    )
    check('idx', `index cards reading "${badgeLabel}"`, badges, 3)

    const kickers = await page.evaluate(() =>
      [...document.querySelectorAll('body *')]
        .filter((e) => e.children.length === 0 && /·/.test(e.textContent))
        .map((e) => e.textContent.trim())
        .filter((t) => t.length < 60),
    )
    for (const k of kickers) note(`kicker: ${k}`)
    check(
      'idx',
      'a timeline kicker marks workshop 4 as next',
      kickers.some((k) => /^Next ·/.test(k)),
      true,
    )
    check(
      'idx',
      'no kicker still says fully booked',
      kickers.some((k) => /fully booked/i.test(k)),
      false,
    )
    await page.close()
  }
}

// --------------------------------------------------------------------- main

console.log(`site07-ui, dist preview on ${PORT}, badge label ${JSON.stringify(badgeLabel)}`)
build()
const server = await startServer()
const browser = await chromium.launch()

const verdicts = []
try {
  for (const label of ['run 1', 'run 2 (finding 35: the second verdict is the recorded one)']) {
    const before = failures
    await pass(browser, label)
    verdicts.push([label, failures - before])
  }
} finally {
  await browser.close()
  server.kill()
}

console.log('\n===== verdicts =====')
for (const [label, f] of verdicts) console.log(`  ${f === 0 ? ' ok ' : 'FAIL'}  ${label}: ${f} failure(s)`)
console.log(`\n${checks} check(s) across ${verdicts.length} run(s), ${failures} failure(s).`)
process.exit(failures === 0 ? 0 : 1)
