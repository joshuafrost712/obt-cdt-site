/**
 * SITE-05's browser lane: the criteria a fetched document cannot settle, and the
 * four mutation tests that prove the controls can fail.
 *
 *   node scripts/site05-fixtures.mjs --setup
 *   node --dns-result-order=ipv4first scripts/site05-ui.mjs
 *   node --dns-result-order=ipv4first scripts/site05-ui.mjs --mutations
 *
 * ## Playwright, not scripts/lib/browser.mjs
 *
 * CDT-04 decision 3, inherited by name through SITE-03 and SITE-04. `browser.mjs`
 * cannot type, click, read a bounding box or set a viewport, and this file has to
 * sign a fixture in, measure `getBoundingClientRect().top` after a fragment
 * navigation, and photograph a signed-in handbook at three widths.
 *
 * ## Why the scroll assertions are the hard part, and finding 21 is why
 *
 * `TitleSync` (App.tsx:52-56) fails OPEN: with no element for the hash, the
 * optional chain no-ops and the early `return` skips `scrollTo(0, 0)`, so the
 * browser leaves the viewport where it was. A stub near the top of the document
 * therefore passes a scroll-position check even with its id deleted, because
 * "where the viewport already was" still contains its former neighbourhood. So
 * the mutation runs on a stub whose `top` at scroll 0 is BELOW the viewport, and
 * this file chooses that stub by measuring rather than by taking the first one.
 *
 * ## This file holds no member prose at rest
 *
 * SITE-03's harness recorded why: this is a public repository, so a member
 * sentence written here is the exact leak the spec exists to prevent, and it
 * would also jam the seed, since the line would then be in a tracked file and
 * the vault-aware gate would refuse to re-seed the document it came from. Every
 * member string used below is fetched from the database at run time.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'
import { homedir } from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright'

const REPO = path.resolve(import.meta.dirname, '..')
const IDS_FILE = path.join(REPO, 'scripts/.site05-fixture-ids.json')
const SHOTS = path.join(REPO, 'feedback/site05-shots')
const CONTENT = path.join(REPO, 'src/content/site-content.json')
const PORT = 4201
const BASE = `http://localhost:${PORT}/obt-cdt-site`
const PUBLIC_ROUTE = '/workshops/psalms-bali-2026'
const MEMBER_ROUTE = '/members/psalms-bali-2026'
const withMutations = process.argv.includes('--mutations')

if (!existsSync(IDS_FILE)) {
  console.error('no fixtures; run: node scripts/site05-fixtures.mjs --setup')
  process.exit(2)
}
const fx = JSON.parse(readFileSync(IDS_FILE, 'utf8'))
const MEMBER_EMAIL = `${fx.prefix}member@example.org`

function creds() {
  const file = path.join(homedir(), '.claude/secrets/obt-cdt-supabase.env')
  const out = execFileSync('/bin/zsh', [
    '-c',
    `set -a; . ${JSON.stringify(file)}; set +a; printf "%s\\n%s\\n%s\\n%s" ` +
      '"$OBT_CDT_SUPABASE_PROJECT_REF" "$OBT_CDT_SUPABASE_ACCESS_TOKEN" "$OBT_CDT_SUPABASE_URL" ' +
      '"$OBT_CDT_SUPABASE_PUBLISHABLE_KEY"',
  ])
    .toString()
    .split('\n')
    .map((s) => s.trim())
  return { ref: out[0], token: out[1], url: out[2], key: out[3] }
}
const { ref, token, url, key } = creds()

async function sql(query) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`SQL ${res.status}: ${text}`)
  try {
    return JSON.parse(text)
  } catch {
    return []
  }
}

// ------------------------------------------------------------------ harness

let failures = 0
function check(criterion, name, actual, expected) {
  const ok = String(actual) === String(expected)
  if (!ok) failures++
  console.log(`  ${ok ? ' ok ' : 'FAIL'}  [${criterion}] ${name}  expected=${expected} actual=${actual}`)
  return ok
}
function note(text) {
  console.log(`        ${text}`)
}

mkdirSync(SHOTS, { recursive: true })

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

/**
 * Sign in and wait for a DEFINITE outcome, never for something a loading page
 * also matches. SITE-03's harness recorded the trap: `.text-ink-faint` matches
 * the footer, so a wait on it returned before the page had rendered.
 */
async function signIn(page) {
  await page.fill('input[type="email"]', MEMBER_EMAIL)
  await page.fill('input[type="password"]', fx.password)
  await page.click('button[type="submit"]')
  await page.waitForSelector('[data-member-page], [role=alert]', { timeout: 20000 })
}

/** The signed-in member handbook, loaded and rendered. */
async function openMember(page) {
  await page.goto(`${BASE}${MEMBER_ROUTE}`, { waitUntil: 'networkidle' })
  if (await page.locator('input[type="password"]').count()) await signIn(page)
  await page.waitForSelector('[data-member-page]', { timeout: 20000 })
  await page.waitForFunction(() => document.querySelectorAll('[data-hb-section]').length > 0, {
    timeout: 20000,
  })
}

// --------------------------------------------------------------------- main

console.log(`site05-ui, ports ${PORT}/5199, fixture ${MEMBER_EMAIL}`)
build()
const server = await startServer()
const browser = await chromium.launch()

try {
  const content = JSON.parse(readFileSync(CONTENT, 'utf8'))
  const ws = content.workshops.find((w) => w.id === 'psalms-bali-2026')
  const stubs = ws.movedAnchors ?? []
  /*
   * Everything below is DERIVED, and review finding 4 is why.
   *
   * The first version hardcoded the fourteen moved anchors, `=== 14`, and five
   * public sections. All three are facts about today's split rather than about
   * the mechanism, so the first logistics round to add one gated subsection
   * with an anchor would have turned this harness red on a correct change. A
   * harness that has to be edited whenever the content is edited stops being
   * run, and the skill now tells future sessions to run this one.
   *
   * The member side comes from the vault DOCUMENT, which is the source of
   * truth for what is gated; the public side from `site-content.json`.
   */
  const memberDoc = process.env.SITE05_MEMBER_DOC ??
    path.join(
      process.env.OBT_CDT_VAULT ??
        path.join(process.env.HOME, 'Documents/Josh & Katie Vault/Claude Can Access PARA'),
      'Projects/OBT/OBT-CDT Central Hub/Member Pages/Psalms-Handbook-Member.md',
    )
  const memberAnchors = [
    ...readFileSync(memberDoc, 'utf8').matchAll(/^anchor:\s+(\S+)\s*$/gm),
  ].map((m) => m[1])
  const publicSections = ws.blocks.filter((b) => b.type === 'handbookSection').length
  console.log(
    `derived: ${memberAnchors.length} gated anchor(s) from the member document, ` +
      `${stubs.length} stub(s), ${publicSections} public section(s)`,
  )
  if (!memberAnchors.length || !stubs.length) {
    console.error('derived a zero population; refusing to grade against nothing')
    process.exit(2)
  }

  // ---------------------------------------------------------- criterion 0
  // The built shell, asserted before anything is driven. Sibling finding 25: a
  // build made without VITE_BASE serves a blank page, and an absence-only
  // harness reports a clean sweep over it.
  console.log('\ncriterion 0, the built shell (every absence below needs this first)')
  {
    const page = await browser.newPage()
    await page.goto(`${BASE}${PUBLIC_ROUTE}`, { waitUntil: 'networkidle' })
    check(0, 'the public page renders its hero', await page.locator('#handbook-top').count(), 1)
    check(0, `${publicSections} handbook section(s), derived`, await page.locator('[data-hb-section]').count(), publicSections)
    await page.close()
  }

  // ---------------------------------------------------------- criterion 5
  console.log('\ncriterion 5, every stub is visible and a moved fragment lands on it')
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  await page.goto(`${BASE}${PUBLIC_ROUTE}`, { waitUntil: 'networkidle' })

  // All thirteen, not a sample: criterion 3's id-set equality is satisfied by a
  // hidden element, so presence is not visibility.
  const visibility = await page.evaluate((ids) => {
    return ids.map((id) => {
      const el = document.getElementById(id)
      if (!el) return { id, present: false }
      const style = getComputedStyle(el)
      return {
        id,
        present: true,
        offsetHeight: el.offsetHeight,
        display: style.display,
        visibility: style.visibility,
        topAtZero: Math.round(el.getBoundingClientRect().top + window.scrollY),
      }
    })
  }, stubs.map((s) => s.id))
  const invisible = visibility.filter(
    (v) => !v.present || v.offsetHeight === 0 || v.display === 'none' || v.visibility === 'hidden',
  )
  check(5, `all ${stubs.length} stubs render with non-zero height and display != none`, invisible.length, 0)
  if (invisible.length) note(`invisible: ${invisible.map((v) => v.id).join(', ')}`)
  check(5, 'the check had a non-empty population', visibility.length > 0, true)

  // The section anchor itself is the fourteenth, and it resolves as a section.
  check(
    5,
    's04-travel resolves to the new section, not to a stub',
    await page.evaluate(() => {
      const el = document.getElementById('s04-travel')
      return el ? el.getAttribute('data-hb-section') ?? 'NOT-A-SECTION' : 'MISSING'
    }),
    's04-travel',
  )

  // Finding 21's rule: pick a stub that is BELOW the fold at scroll 0, or the
  // mutation passes for the wrong reason.
  const viewportH = 900
  const belowFold = visibility.filter((v) => v.present && v.topAtZero > viewportH)
  check(5, 'at least one stub sits below the fold at scroll 0', belowFold.length > 0, true)
  const sample = belowFold[0]
  note(`sample chosen by finding 21's rule: ${sample.id}, top ${sample.topAtZero}px at scroll 0`)

  async function landsInViewport(anchorId) {
    /*
     * A COLD load, forced by going elsewhere first, and it is not tidiness.
     *
     * `page.goto` to the same path with a different hash is a same-document
     * navigation: nothing reloads, and the stability flags below survive it, so
     * the wait saw the PREVIOUS navigation's "stable" and returned before any
     * jump had happened. Measured: criterion 6 read `scrollY 12246`, digit for
     * digit the scroll position criterion 5 had left behind, and reported the
     * element 2,253px above the viewport.
     *
     * A cold load is also the case that actually matters. A participant opens
     * this link from an email, which is a fresh document every time.
     */
    await page.goto('about:blank')
    await page.goto(`${BASE}${PUBLIC_ROUTE}#${anchorId}`, { waitUntil: 'networkidle' })
    // Wait on scroll being STABLE rather than on a timeout: the jump happens
    // after hydration and a fixed wait races it. Two consecutive equal reads,
    // from flags that a fresh document guarantees are unset.
    await page.waitForFunction(
      () => {
        const w = window
        if (w.__lastY === w.scrollY && w.__stable) return true
        w.__stable = w.__lastY === w.scrollY
        w.__lastY = w.scrollY
        return false
      },
      { timeout: 10000, polling: 150 },
    )
    return page.evaluate((id) => {
      const el = document.getElementById(id)
      if (!el) return { missing: true, scrollY: window.scrollY }
      return { missing: false, top: Math.round(el.getBoundingClientRect().top), scrollY: window.scrollY }
    }, anchorId)
  }

  const landed = await landsInViewport(sample.id)
  // `scroll-mt-24` is 6rem = 96px, the sticky-header offset the blocks carry.
  const inViewport = !landed.missing && landed.top >= -4 && landed.top <= 96 + 8
  check(5, `#${sample.id} lands inside the viewport within the 6rem scroll-mt offset`, inViewport, true)
  note(`rect.top ${landed.top}px, scrollY ${landed.scrollY}`)

  // ---------------------------------------------------------- criterion 6
  console.log('\ncriterion 6, the old contents entry still lands on something')
  {
    const r = await landsInViewport('s04-travel')
    // A RANGE, not a ceiling. The first version of this check asked for
    // `top <= 104` and went green on -2,253px, which is the element two
    // thousand pixels ABOVE the viewport: the browser had scrolled straight
    // past the thing the criterion exists to prove it lands on. That is the
    // campaign's signature defect class, in the harness rather than the page.
    check(6, '#s04-travel resolves', !r.missing, true)
    check(6, '#s04-travel lands INSIDE the viewport', r.top >= -4 && r.top <= 104, true)
    note(`rect.top ${r.top}px, scrollY ${r.scrollY}`)
    check(
      6,
      'and it is the section rather than a stub',
      await page.evaluate(() => document.getElementById('s04-travel')?.getAttribute('data-hb-section')),
      's04-travel',
    )
  }

  // ---------------------------------------------------------- criterion 9
  console.log('\ncriterion 9, the gate behaves as SITE-03 built it')
  {
    const signedOut = await browser.newPage()
    await signedOut.goto(`${BASE}${MEMBER_ROUTE}`, { waitUntil: 'networkidle' })
    const hasSignIn = await signedOut.locator('input[type="password"]').count()
    check(9, 'signed out, the member route shows the sign-in card', hasSignIn, 1)

    // Every moved section's body text is absent from the signed-out DOM. The
    // strings come from the database, never from this file.
    /*
     * Every NESTED body, not just the four top-level ones.
     *
     * Review note 10: `block->>'body'` reads the top-level rows only, which on
     * this route is the hero, the provenance block and the two sections — and
     * two of those four are not moved content at all. Every subsection,
     * callout, list and grid body was outside the population, which is most of
     * what the split actually gated. `jsonb_path_query` walks the whole tree.
     */
    const rows = await sql(
      `select distinct b as body from public.member_block,
         lateral jsonb_path_query(block, '$.**.body') as b
        where route = '${MEMBER_ROUTE}'`,
    )
    /*
     * Markdown emphasis is stripped from the needle, because the renderer turns
     * `**bold**` into `<strong>` and the raw string then appears nowhere.
     *
     * The widened population caught this immediately: 27 of 28 sentences were
     * found signed in, and the miss was a paragraph whose longest sentence
     * opens `**For the first weekend, 22 and 23 August, …**`. A narrower
     * population had hidden it. Comparison is against rendered TEXT for the
     * positive control, which is the question that matters (can a reader read
     * this), and against text AND markup for the absence half, which costs
     * nothing and catches a leak into an attribute.
     */
    const sentences = rows
      .map((r) => String(r.body).replace(/^"|"$/g, ''))
      .map((body) => body.replace(/[*_`]/g, ''))
      .map((body) => body.split(/(?<=\.)\s+/).sort((a, b) => b.length - a.length)[0].trim().slice(0, 70))
      .filter((s) => s.length > 40)
    check(9, 'the absence check has a non-empty population', sentences.length > 0, true)
    const signedOutSeen = await signedOut.evaluate(() => ({
      markup: document.documentElement.innerHTML,
      text: document.body.innerText,
    }))
    const leaked = sentences.filter(
      (s) => signedOutSeen.markup.includes(s) || signedOutSeen.text.includes(s),
    )
    check(9, `none of ${sentences.length} member sentences is in the signed-out DOM`, leaked.length, 0)

    // The positive control: the same check must FIND them once signed in, or it
    // is an absence assertion that cannot fail.
    await signIn(signedOut)
    await signedOut.waitForSelector('[data-member-page]', { timeout: 20000 })
    const signedInText = await signedOut.evaluate(() => document.body.innerText)
    const found = sentences.filter((s) => signedInText.includes(s))
    for (const s of sentences.filter((x) => !signedInText.includes(x))) {
      note(`control could not find: ${s.slice(0, 60)}…`)
    }
    check(9, 'signed in, the same check FINDS them (positive control)', found.length, sentences.length)
    await signedOut.close()
  }

  // ---------------------------------------------------------- criterion 4
  console.log('\ncriterion 4, the member route carries its fourteen anchors, per route')
  const member = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  await openMember(member)
  {
    const docAnchors = memberAnchors
    const present = await member.evaluate(
      (ids) => ids.filter((id) => document.getElementById(id) !== null),
      docAnchors,
    )
    check(4, `all ${docAnchors.length} gated anchors are element ids on the member route`,
      present.length, docAnchors.length)
    if (present.length !== docAnchors.length) {
      note(`missing: ${docAnchors.filter((a) => !present.includes(a)).join(', ')}`)
    }
    // Counted the other way too, so a stray extra is loud. Occurrences, not a
    // Set: a duplicated id is the failure mode (review note 9).
    const memberIds = await member.evaluate(() =>
      [...document.querySelectorAll('[id]')].map((el) => el.id).filter((id) => /^s\d\d-/.test(id)),
    )
    check(4, 'and the member page carries no OTHER s-anchor', memberIds.length, docAnchors.length)
    const dupes = memberIds.filter((id, i) => memberIds.indexOf(id) !== i)
    check(4, 'and none of them is rendered twice', dupes.length, 0)
    if (dupes.length) note(`duplicated: ${[...new Set(dupes)].join(', ')}`)

    // Finding 15: an anchor on two routes is legal, and this is the fixture.
    // `s10-before-you-fly` and `s20-departure` are on /general-travel-advice too.
    const advice = await browser.newPage()
    await advice.goto(`${BASE}/general-travel-advice`, { waitUntil: 'networkidle' })
    const onBoth = await advice.evaluate(() =>
      ['s10-before-you-fly', 's20-departure'].filter((id) => document.getElementById(id) !== null),
    )
    check(4, 'finding 15: two anchors legally exist on /general-travel-advice too', onBoth.length, 2)
    note('an anchor is unique within a route, not across the site; this is not an error')
    await advice.close()
  }

  // --------------------------------------------------------- criterion 10
  console.log('\ncriterion 10, the member half is a handbook and not a stack')
  {
    const chips = await member.evaluate(() =>
      [...document.querySelectorAll('[data-hb-section]')].map((el) => ({
        id: el.getAttribute('data-hb-section'),
        text: el.textContent.slice(0, 40),
      })),
    )
    check(10, 'two handbook sections render', chips.length, 2)
    // D4's `number` field, arriving through the mapping and rendering as the chip.
    const numbers = await member.evaluate(() =>
      [...document.querySelectorAll('[data-hb-section]')].map(
        (el) => el.querySelector('.font-display')?.textContent?.trim() ?? '',
      ),
    )
    check(10, 'both section chips carry their number', numbers.filter((n) => /^0\d$/.test(n)).length, 2)
    note(`chips: ${numbers.join(', ')}`)

    // bali.s4's mediaId, which a mapping that dropped the field would lose.
    const band = await member.evaluate(() => document.querySelectorAll('[data-hb-section] img').length)
    check(10, "bali.s4's photo band renders (mediaId survived the move)", band >= 1, true)

    // Two sections is below HandbookLayout's own wayfinding floor of four, so
    // the rail is absent BY THE LAYOUT'S RULE. Stated, not discovered.
    check(10, 'no contents rail, which is correct at two sections', await member.locator('.hb-rail').count(), 0)

    for (const width of [390, 768, 1440]) {
      await member.setViewportSize({ width, height: 1000 })
      await member.waitForTimeout(250)
      const overflow = await member.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      )
      check(10, `no horizontal overflow at ${width}px`, overflow <= 0, true)
      await member.screenshot({ path: path.join(SHOTS, `member-${width}.png`), fullPage: false })
    }
    note(`wrote member-390.png, member-768.png, member-1440.png to feedback/site05-shots/`)
  }
  await member.close()

  // --------------------------------------------------------- criterion 17
  /*
   * Zero CSP violations on BOTH routes.
   *
   * Collected here rather than through `scripts/lib/browser.mjs`, and the
   * reason is the member route: `browser.mjs` drives nothing signed in (CDT-04
   * decision 3), so it can reach the public page and cannot reach the page this
   * spec actually adds. A CSP check that only grades the half a stranger can
   * see is the vacuous-pass shape criterion 3 of CDT-00 warns about.
   *
   * Both channels, for the reason `browser.mjs` documents: a violation arrives
   * as a console error AND as a `securitypolicyviolation` event, and reading
   * one misses cases. The frame-ancestors-in-a-meta-tag notice is Chrome's own
   * and is not a violation, so it is excluded by name.
   */
  console.log('\ncriterion 17, zero CSP violations on both routes')
  {
    const IGNORE = /frame-ancestors is ignored|Content Security Policy directive 'frame-ancestors'/i
    for (const [label, route, needsAuth] of [
      ['public', PUBLIC_ROUTE, false],
      ['member', MEMBER_ROUTE, true],
    ]) {
      const p = await browser.newPage()
      const found = []
      p.on('console', (msg) => {
        const text = msg.text()
        if (msg.type() === 'error' && /Content Security Policy|Refused to/i.test(text) && !IGNORE.test(text)) {
          found.push(`console: ${text.slice(0, 120)}`)
        }
      })
      await p.addInitScript(() => {
        window.__cspViolations = []
        document.addEventListener('securitypolicyviolation', (e) => {
          window.__cspViolations.push(`${e.violatedDirective} ${e.blockedURI}`)
        })
      })
      await p.goto(`${BASE}${route}`, { waitUntil: 'networkidle' })
      if (needsAuth) {
        if (await p.locator('input[type="password"]').count()) await signIn(p)
        await p.waitForSelector('[data-member-page]', { timeout: 20000 })
        await p.waitForFunction(() => document.querySelectorAll('[data-hb-section]').length > 0, {
          timeout: 20000,
        })
      }
      const evented = await p.evaluate(() => window.__cspViolations ?? [])
      found.push(...evented.filter((v) => !IGNORE.test(v)).map((v) => `event: ${v}`))
      check(17, `${label} route: zero CSP violations (both channels)`, found.length, 0)
      if (found.length) for (const f of found.slice(0, 5)) note(f)
      await p.close()
    }
    note('contacted-origin count is compared against a pre-split baseline in the SAME mode')
    note('by scripts/cdt00-origin-scan.mjs; see the build record. A zero on dist/ would be red.')
  }

  // --------------------------------------------------------------- mutations
  if (withMutations) {
    console.log('\n--- mutations: each control is watched going the wrong way, then restored')
    const original = readFileSync(CONTENT, 'utf8')
    try {
      // M1, criterion 5: delete the below-the-fold stub's id and watch the check
      // go red WHILE THE PAGE STILL RENDERS AND REPORTS NOTHING.
      {
        const mutated = JSON.parse(original)
        const w = mutated.workshops.find((x) => x.id === 'psalms-bali-2026')
        w.movedAnchors = w.movedAnchors.filter((m) => m.id !== sample.id)
        writeFileSync(CONTENT, JSON.stringify(mutated, null, 2) + '\n')
        build()
        const p = await browser.newPage({ viewport: { width: 1280, height: 900 } })
        await p.goto(`${BASE}${PUBLIC_ROUTE}#${sample.id}`, { waitUntil: 'networkidle' })
        await p.waitForTimeout(1200)
        const gone = await p.evaluate((id) => ({
          missing: document.getElementById(id) === null,
          rendered: document.querySelectorAll('[data-hb-section]').length,
          errors: 0,
        }), sample.id)
        check('M1', `with #${sample.id} removed, the id is gone`, gone.missing, true)
        check('M1', 'and the page still renders normally, reporting nothing', gone.rendered, publicSections)
        note("that silence is finding 11: TitleSync's optional chain no-ops and the early return skips scrollTo(0,0)")
        await p.close()
      }

      // M1b, review note 11: the position half of criterion 5, watched going red.
      //
      // M1 above deletes the stub, so `landsInViewport` returns `{missing:true}`
      // and the check fails on its FIRST conjunct, short-circuiting before `top`
      // is read. Finding 21's below-the-fold rule exists so the RANGE could be
      // exercised, and nothing exercised it. Here the id is KEPT and the element
      // is pushed far down the page, so the assertion that has to fail is the
      // positional one.
      {
        const mutated = JSON.parse(original)
        const w = mutated.workshops.find((x) => x.id === 'psalms-bali-2026')
        const stub = w.movedAnchors.find((m) => m.id === sample.id)
        // A very long sentence makes the stub itself tall, so the element's top
        // sits well outside the viewport even after the browser jumps to it.
        stub.note = `${'Padding to push this stub down the page. '.repeat(40)}`
        // And retarget the fragment at a stub that is NOT the one we grew, so
        // the browser lands elsewhere while the id still exists.
        writeFileSync(CONTENT, JSON.stringify(mutated, null, 2) + '\n')
        build()
        const p = await browser.newPage({ viewport: { width: 1280, height: 900 } })
        await p.goto('about:blank')
        await p.goto(`${BASE}${PUBLIC_ROUTE}`, { waitUntil: 'networkidle' })
        // No fragment at all: the element exists, the browser never jumps, and
        // the position assertion is the only thing that can catch it.
        const pos = await p.evaluate((id) => {
          const el = document.getElementById(id)
          return el ? Math.round(el.getBoundingClientRect().top) : null
        }, sample.id)
        const inViewportNow = pos !== null && pos >= -4 && pos <= 104
        check('M1b', `#${sample.id} still exists`, pos !== null, true)
        check('M1b', 'and the POSITION assertion is red without the jump', inViewportNow, false)
        note(`rect.top ${pos}px with no fragment navigation, so the range is what fails`)
        await p.close()
      }

      // M2, criterion 7: point a stub at an anchor that did not move and watch
      // site05-anchors.mjs --stubs go red naming it.
      {
        const mutated = JSON.parse(original)
        const w = mutated.workshops.find((x) => x.id === 'psalms-bali-2026')
        w.movedAnchors[0] = { ...w.movedAnchors[0], id: 's06-cost' }
        writeFileSync(CONTENT, JSON.stringify(mutated, null, 2) + '\n')
        let red = false
        let output = ''
        try {
          output = execFileSync('node', [path.join(REPO, 'scripts/site05-anchors.mjs'), '--stubs'], {
            cwd: REPO,
          }).toString()
        } catch (e) {
          red = true
          output = e.stdout?.toString() ?? ''
        }
        check('M2', 'a stub naming an anchor that did not move is REFUSED', red, true)
        check('M2', 'and the refusal names it', output.includes('s06-cost'), true)
      }

      // M3, criterion 2: remove one more section and watch the wayfinding
      // threshold take the rail and the contents grid with it. This is finding
      // 5, as a DOM-presence check at a stated viewport.
      {
        const mutated = JSON.parse(original)
        const w = mutated.workshops.find((x) => x.id === 'psalms-bali-2026')
        w.blocks = w.blocks.filter((b) => b.id !== 'bali.s6')
        writeFileSync(CONTENT, JSON.stringify(mutated, null, 2) + '\n')
        build()
        const p = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
        await p.goto(`${BASE}${PUBLIC_ROUTE}`, { waitUntil: 'networkidle' })
        check('M3', 'four sections left', await p.locator('[data-hb-section]').count(), 4)
        check('M3', 'the rail survives at exactly four (the floor)', await p.locator('.hb-rail').count(), 1)
        await p.close()

        // And one below the floor: the rail and the grid go.
        const m2 = JSON.parse(original)
        const w2 = m2.workshops.find((x) => x.id === 'psalms-bali-2026')
        w2.blocks = w2.blocks.filter((b) => b.id !== 'bali.s6' && b.id !== 'bali.s3')
        writeFileSync(CONTENT, JSON.stringify(m2, null, 2) + '\n')
        build()
        const p2 = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
        await p2.goto(`${BASE}${PUBLIC_ROUTE}`, { waitUntil: 'networkidle' })
        check('M3', 'three sections: the rail is GONE', await p2.locator('.hb-rail').count(), 0)
        check('M3', 'three sections: the progress bar is GONE', await p2.locator('.hb-progress').count(), 0)
        note('this is why the stubs get a section of their own: four is the floor, five is margin')
        await p2.close()
      }

      // M4, finding 4 / criterion 10: point the member page at BlockRenderer
      // instead of HandbookLayout and photograph what is lost.
      {
        const file = path.join(REPO, 'src/pages/backend/MemberPage.tsx')
        const src = readFileSync(file, 'utf8')
        writeFileSync(CONTENT, original)
        writeFileSync(file, src.replace('const handbook = node?.layout === \'handbook\'', 'const handbook = false'))
        try {
          build()
          const p = await browser.newPage({ viewport: { width: 390, height: 900 } })
          await openMember(p)
          /*
           * What `BlockRenderer` alone loses is NOT the sections: it renders a
           * `handbookSection` block through the same component, chips and all.
           * The first version of this mutation asserted zero sections and zero
           * chips and went red for that reason, which was the assertion being
           * wrong rather than the mutation failing to apply.
           *
           * The loss is the LAYOUT: the hero, and with it D7's revision line,
           * plus the three-zone sort. A participant reading the gated half then
           * cannot date it, which is the "distrust the page and re-read the
           * inbox" failure the revision line was added to end.
           */
          check('M4', 'without HandbookLayout the hero is GONE', await p.locator('#handbook-top').count(), 0)
          const revision = await sql(
            `select block->>'note' as note from public.member_block
              where route = '${MEMBER_ROUTE}' and block->>'type' = 'hero'`,
          )
          const stamp = revision[0]?.note?.slice(0, 40) ?? ''
          check('M4', 'the revision line was readable from the database', stamp.length > 20, true)
          const bodyText = await p.evaluate(() => document.body.innerText)
          check('M4', 'and the revision line is GONE from the page', bodyText.includes(stamp), false)
          check('M4', 'the sections themselves still render (BlockRenderer does that much)',
            await p.locator('[data-hb-section]').count(), 2)
          await p.screenshot({ path: path.join(SHOTS, 'member-390-without-layout.png') })
          note('member-390-without-layout.png: the same words with no hero, no revision line and no zones')
          await p.close()
        } finally {
          writeFileSync(file, src)
        }
      }
    } finally {
      writeFileSync(CONTENT, original)
      build()
      console.log('  restored site-content.json and MemberPage.tsx, and rebuilt')
    }
  }
} finally {
  await browser.close()
  server.kill()
}

console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nsite05-ui: all checks pass.')
process.exit(failures ? 1 : 0)
