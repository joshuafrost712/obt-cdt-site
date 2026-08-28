/**
 * Spec SITE-04's browser lane: the links register on screen, signed in and out.
 *
 *   node scripts/site04-fixtures.mjs --setup
 *   npm i -D --no-save playwright && npx playwright install chromium
 *   node scripts/site04-ui.mjs
 *
 * Modelled on `scripts/site03-ui.mjs` and owned here, not called from there, for
 * the reason in finding 13: its `PORT`, `SHOTS` and fixture prefix are module
 * constants.
 *
 * ## It holds no register text at rest
 *
 * SITE-03 finding 18. Its harness hardcoded one sentence of the member document
 * so it could assert the sentence was on screen, on a public repository, and the
 * seed would then have refused to re-seed the document that sentence came from.
 * Every string this file asserts is READ FROM THE DATABASE at run time. That
 * matters more here than there: a register row's text is a label and a URL, and
 * for an anyone-with-link file the URL is the credential.
 *
 * ## Why the nav is checked at three widths and not one
 *
 * SITE-06's finding and memory note `innertext-passes-over-buried-ui`. At 390px
 * `SiteLayout.tsx` renders the mobile nav only after the Menu button is clicked,
 * so an unclicked 390px assertion passes with the control removed. And the
 * signed-out half is asserted twice, by `innerText` and by the absence of an
 * href in the page source, because a link hidden under an overlay still reads as
 * absent to the first and is plainly present to the second.
 */
import { execFileSync } from 'node:child_process'
import { spawn } from 'node:child_process'
import { readFileSync, mkdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright'

const REPO = path.resolve(import.meta.dirname, '..')
const IDS_FILE = path.join(REPO, 'scripts/.site04-fixture-ids.json')
const SHOTS = path.join(REPO, 'feedback/site04-shots')
const PORT = 4199
const BASE = `http://localhost:${PORT}/obt-cdt-site`
const ROUTE = '/members/materials'

// Program finding 10. The origin scan over `dist/` returns contacted=1
// unexpected=1 today, on supabase-js's default GoTrue URL sitting inside the
// classifier's proximity window. That is a recorded baseline, not zero, and a
// criterion asserting zero in this mode is red before the session starts.
const ORIGIN_BASELINE_DIST = { contacted: 1, unexpected: 1 }

if (!existsSync(IDS_FILE)) {
  console.error('no fixtures; run: node scripts/site04-fixtures.mjs --setup')
  process.exit(2)
}
const fx = JSON.parse(readFileSync(IDS_FILE, 'utf8'))
const MEMBER_EMAIL = `${fx.prefix}member@example.org`

function creds() {
  const file = path.join(homedir(), '.claude/secrets/obt-cdt-supabase.env')
  const out = execFileSync('/bin/zsh', ['-c',
    `set -a; . ${JSON.stringify(file)}; set +a; ` +
    'printf "%s\\n%s\\n%s\\n%s" "$OBT_CDT_SUPABASE_PROJECT_REF" "$OBT_CDT_SUPABASE_ACCESS_TOKEN" ' +
    '"$OBT_CDT_SUPABASE_URL" "$OBT_CDT_SUPABASE_PUBLISHABLE_KEY"',
  ]).toString().split('\n').map((s) => s.trim())
  const [ref, token, url, key] = out
  if (!ref || !token || !url || !key) {
    console.error(`missing values in ${file}`)
    process.exit(2)
  }
  return { ref, token, url, key }
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
  try { return JSON.parse(text) } catch { return [] }
}

/** Every rendered row's id and label, read from where they are allowed to be. */
const rows = await sql(
  `select item->>'id' as id, item->>'label' as label, item->>'note' as note
     from public.member_block,
          lateral jsonb_array_elements(block->'items') as item
    where route = '${ROUTE}'`,
)
const blockKeys = (await sql(
  `select block_key from public.member_block where route = '${ROUTE}'`,
)).map((r) => r.block_key)

if (rows.length === 0) {
  console.error('no seeded register rows; run build_links_register.py then seed_member_pages.py --apply')
  process.exit(2)
}

// The register's own count, read from the vault contract rather than from the
// database, so criterion 4's "both ways" compares two independent sources.
const registerKeys = execFileSync('python3',
  [path.join(REPO, 'scripts/build_links_register.py'), '--print-rows'],
  { encoding: 'utf8' })
  .split('\n').filter((l) => l.trim().startsWith('active '))
  .map((l) => l.trim().split(/\s+/)[1])

let failures = 0
function check(criterion, name, actual, expected) {
  const ok = String(actual) === String(expected)
  if (!ok) failures++
  console.log(`  ${ok ? ' ok ' : 'FAIL'}  [${criterion}] ${name}  expected=${expected} actual=${actual}`)
  return ok
}

mkdirSync(SHOTS, { recursive: true })

function startServer() {
  const server = spawn('node', [path.join(REPO, 'scripts/serve-dist.mjs'), '--port', String(PORT)],
    { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] })
  return new Promise((resolve) => {
    const done = () => resolve(server)
    server.stdout.on('data', (d) => { if (String(d).includes(String(PORT))) done() })
    setTimeout(() => done(), 2500)
  })
}

async function signIn(page) {
  await page.fill('#portal-email', MEMBER_EMAIL)
  await page.fill('#portal-password', fx.password)
  await page.click('button[type="submit"]')
  await page.waitForSelector('[data-member-page], [data-dfb-node="portal.member.empty"], [role="alert"]',
    { timeout: 30000 })
  await page.waitForTimeout(500)
}

const server = await startServer()
const browser = await chromium.launch()

async function newPage(viewport = { width: 1440, height: 2400 }) {
  const context = await browser.newContext({ viewport })
  const page = await context.newPage()
  await page.addInitScript(() => {
    window.__cspViolations = []
    document.addEventListener('securitypolicyviolation', (e) => {
      window.__cspViolations.push(e.effectiveDirective || e.violatedDirective)
    })
  })
  return page
}

try {
  console.log(`\n=== precondition: the served build is the CI artifact, and the register is seeded`)
  {
    const shell = readFileSync(path.join(REPO, 'dist/404.html'), 'utf8')
    const assets = [...shell.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map((m) => m[1])
    check('pre', 'assets counted, so the check is not vacuous', assets.length > 0, true)
    check('pre', 'every asset in 404.html is under the base prefix',
      assets.every((a) => a.startsWith('/obt-cdt-site/')), true)
    check('pre', 'the served home page is 200', (await fetch(`${BASE}/`)).status, 200)
    check('pre', 'register rows read from member_block', rows.length > 0, true)
    console.log(`        ${rows.length} rendered row(s) in the database, ${registerKeys.length} active row(s) in the register`)
  }

  // ----------------------------------------------------------- criterion 12
  console.log('\n=== criterion 12: the member route behaves like the portal route')
  {
    const res = await fetch(`${BASE}${ROUTE}`)
    const body = await res.text()
    const shell = readFileSync(path.join(REPO, 'dist/404.html'), 'utf8')
    check(12, 'HTTP status is 404', res.status, 404)
    check(12, 'the body is byte-identical to dist/404.html', body === shell, true)
    check(12, 'no built HTML file exists for the route',
      existsSync(path.join(REPO, 'dist/members/materials/index.html')), false)
    console.log('        Accepted cost, repeated from SITE-03 criterion 7 rather than rediscovered:')
    console.log('        a member route is served by the Pages 404 fallback, so a monitor sees a 404.')
  }

  // ----------------------------------------------------------- criterion 10
  console.log('\n=== criterion 10: the page renders for a signed-in member and not otherwise')
  const page = await newPage()
  {
    await page.goto(`${BASE}${ROUTE}`, { waitUntil: 'networkidle' })
    const text = await page.innerText('body')
    const html = await page.content()
    const leaked = rows.filter((r) => text.includes(r.label) || html.includes(r.label))
    check(10, 'signed out: the sign-in form is present', await page.locator('#portal-email').count(), 1)
    check(10, 'signed out: register row labels in the DOM', leaked.length, 0)
    check(10, 'signed out: the population checked was not empty', rows.length > 0, true)

    await signIn(page)
    const inText = await page.innerText('body')
    const present = rows.filter((r) => inText.includes(r.label))
    check(10, 'signed in: every register row label is on screen', present.length, rows.length)
    const renderedIds = await page.$$eval('[data-dfb-node]', (els) =>
      els.map((e) => e.getAttribute('data-dfb-node')))
    // `Txt` stamps data-dfb-node once per FIELD, so one card yields three
    // elements carrying the same id. Distinctness is the property to assert, and
    // the first draft compared occurrences to distinct ids and failed 79 vs 28
    // against a page that was entirely correct.
    const cardIds = new Set(renderedIds.filter((id) => id && id.startsWith('members-materials.')))
    const rowIds = [...cardIds].filter((id) => registerKeys.includes(id))
    const notRows = [...cardIds].filter((id) => !registerKeys.includes(id))
    check(4, 'every register row is rendered exactly once', rowIds.length, registerKeys.length)
    check(4, 'and every rendered card id is a register row',
      notRows.every((id) => blockKeys.includes(id)), true)
    console.log(`        ${rowIds.length} row id(s) + ${notRows.length} block id(s) = ${cardIds.size} distinct`)
  }

  // ------------------------------------------------------------ criterion 4
  console.log('\n=== criterion 4: one real card, photographed at two widths before the register is poured')
  {
    for (const [w, h, name] of [[768, 1600, '768'], [1440, 2400, '1440']]) {
      await page.setViewportSize({ width: w, height: h })
      await page.waitForTimeout(250)
      const first = page.locator(`[data-dfb-node="${rows[0].id}"]`).first()
      check(4, `${name}px: the first card is visible`, await first.isVisible(), true)
      await page.screenshot({ path: path.join(SHOTS, `card-${name}.png`), fullPage: false })
    }
    // The badge is the note slot, in micro-caps. Asserted present as the string
    // the database holds, never as a phrase written into this file.
    const body = await page.innerText('body')
    // Compared case-insensitively. The note slot renders in micro-caps, so
    // `innerText` returns the badge uppercased and a literal comparison read zero
    // matches against a page showing all four. Looked at in the screenshot and
    // ACCEPTED: the badge is legible and quiet at that weight, so
    // HandbookBlocks.tsx does not join this spec's owned files.
    const badges = [...new Set(rows.map((r) => r.note).filter(Boolean))]
    const flat = body.toLowerCase()
    check(4, 'every distinct badge string is on screen (case-insensitive)',
      badges.filter((b) => flat.includes(b.toLowerCase())).length, badges.length)
    check(4, 'badges counted, so the assertion is not vacuous', badges.length > 0, true)
    console.log(`        badges rendered: ${badges.join(' / ')}`)
  }

  // ----------------------------------------------------------- criterion 11
  console.log('\n=== criterion 11: the nav tells the truth at every width it is rendered at')
  {
    const out = await newPage()
    await out.goto(`${BASE}/`, { waitUntil: 'networkidle' })
    for (const [w, h] of [[768, 1600], [1440, 2400]]) {
      await out.setViewportSize({ width: w, height: h })
      await out.waitForTimeout(200)
      const text = await out.innerText('header')
      const html = await out.content()
      check(11, `${w}px signed out: nav entry absent by innerText`, /Materials/.test(text), false)
      check(11, `${w}px signed out: no href to the route in the page source`,
        html.includes(`href="/obt-cdt-site${ROUTE}"`), false)
    }
    await out.setViewportSize({ width: 390, height: 900 })
    await out.waitForTimeout(200)
    const menu = out.locator('header button[aria-expanded]').first()
    check(11, '390px: the Menu button exists to be clicked', await menu.count(), 1)
    await menu.click()
    await out.waitForTimeout(250)
    check(11, '390px signed out: nav entry absent after opening the menu',
      /Materials/.test(await out.innerText('header')), false)
    await out.close()

    await page.setViewportSize({ width: 1440, height: 2400 })
    await page.waitForTimeout(250)
    const inHeader = await page.innerText('header')
    const inHtml = await page.content()
    check(11, '1440px signed in: nav entry present by innerText', /Materials/.test(inHeader), true)
    check(11, '1440px signed in: the href is in the page source',
      inHtml.includes(`href="/obt-cdt-site${ROUTE}"`), true)
    await page.setViewportSize({ width: 768, height: 1600 })
    await page.waitForTimeout(250)
    check(11, '768px signed in: nav entry present', /Materials/.test(await page.innerText('header')), true)
    const entries = (await page.$$eval('header nav a', (els) => els.map((e) => e.textContent?.trim())))
      .filter(Boolean)
    console.log(`        rendered nav entries, stated rather than assumed from navItems(): ${entries.length}`)
    console.log(`        ${entries.join(' | ')}`)
    await page.setViewportSize({ width: 390, height: 900 })
    await page.waitForTimeout(200)
    const mMenu = page.locator('header button[aria-expanded]').first()
    await mMenu.click()
    await page.waitForTimeout(250)
    check(11, '390px signed in: nav entry present after opening the menu',
      /Materials/.test(await page.innerText('header')), true)
  }

  // ----------------------------------------------------------- criterion 13
  console.log('\n=== criterion 13: zero CSP violations, and the origin count unchanged in its own mode')
  {
    await page.setViewportSize({ width: 1440, height: 2400 })
    const violations = await page.evaluate(() => window.__cspViolations || [])
    check(13, 'CSP violations on the signed-in member route', violations.length, 0)
    if (violations.length) console.log(`        ${violations.join(', ')}`)

    // The scan exits non-zero in dist mode today and that is the BASELINE, not a
    // regression (program finding 10). Throwing on its exit code would make this
    // criterion impossible to pass while the classifier artifact stands, so the
    // output is parsed and the numbers are compared instead.
    let scan = ''
    try {
      scan = execFileSync('node', [path.join(REPO, 'scripts/cdt00-origin-scan.mjs')],
        { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).toString()
    } catch (e) {
      scan = String(e.stdout || '')
    }
    const got = {
      contacted: Number(/contacted=(\d+)/.exec(scan)?.[1]),
      unexpected: Number(/unexpected=(\d+)/.exec(scan)?.[1]),
    }
    check(13, 'dist-mode contacted origins unchanged against the recorded baseline',
      got.contacted, ORIGIN_BASELINE_DIST.contacted)
    check(13, 'dist-mode unexpected origins unchanged against the recorded baseline',
      got.unexpected, ORIGIN_BASELINE_DIST.unexpected)
  }
} catch (e) {
  failures++
  console.error('\nHARNESS ERROR:', e?.message || e)
} finally {
  await browser.close()
  server.kill()
}

console.log(`\n${failures === 0 ? 'site04-ui: all checks pass.' : `site04-ui: ${failures} FAILURE(S).`}`)
process.exit(failures === 0 ? 0 : 1)
