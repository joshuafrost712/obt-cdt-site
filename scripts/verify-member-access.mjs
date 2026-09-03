/**
 * Sign in as a REAL participant account and photograph what they will see.
 *
 *   npm run build
 *   node scripts/verify-member-access.mjs --csv ~/Documents/obt-cdt-portal-accounts-<date>.csv
 *
 * This is the check that has never been run. `/members` and `/members/materials`
 * were built and seeded on 27 and 28 August, but `auth.users` was 0 rows until
 * today, so no human has ever loaded either page with a working account. A page
 * that renders for a fixture is not evidence that it renders for a participant:
 * the fixture was created by a script that also wrote its own profile row, and a
 * real account goes through `handle_new_portal_user()` instead.
 *
 * ## It holds no member prose and no credential at rest
 *
 * Program findings 18 and 24. Every string asserted here is read from the
 * database at run time, and the password is read from a CSV **outside every git
 * working tree** whose path is passed in. Neither is ever written into this
 * repository. The script refuses a CSV that resolves inside a repo, for the same
 * reason `create_portal_accounts.py` refuses to write one there.
 *
 * ## Why it signs in with a password and not a link
 *
 * Program finding 14: `uri_allow_list` carries four entries and no local port is
 * among them. A password sign-in issues no redirect, so the allowlist never
 * enters the flow. A magic-link or reset walkthrough would need an entry added,
 * and that setting belongs to CDT-00.
 */
import { execFileSync, spawn } from 'node:child_process'
import { readFileSync, mkdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright'

const REPO = path.resolve(import.meta.dirname, '..')
const SHOTS = path.join(REPO, 'feedback/verify-shots')
const PORT = 4203
const BASE = `http://localhost:${PORT}/obt-cdt-site`

const csvArg = process.argv.indexOf('--csv')
if (csvArg === -1 || !process.argv[csvArg + 1]) {
  console.error('usage: node scripts/verify-member-access.mjs --csv <path outside any repo>')
  process.exit(2)
}
const CSV = path.resolve(process.argv[csvArg + 1].replace(/^~/, homedir()))

// Refuse a credential file inside a git tree, in the reading direction this
// time. If it is in a repo it may already have shipped, and reading it here
// would make this script the second place it lives.
try {
  const top = execFileSync('git', ['-C', path.dirname(CSV), 'rev-parse', '--show-toplevel'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  console.error(`refusing to read credentials from inside a git working tree:\n  ${CSV}\n  is inside ${top}`)
  process.exit(2)
} catch { /* not in a repo, which is what we want */ }

if (!existsSync(CSV)) { console.error(`no such file: ${CSV}`); process.exit(2) }

// Take the first row whose status is `created`, so this exercises a participant
// account and not the administrator, whose reads are deliberately wider.
// Minimal RFC-4180 field split: quoted fields may hold a comma, and a doubled
// quote inside one is a literal quote. A bare `split(',')` is right for every
// row this file has today and wrong the first time a name carries a comma.
function cells(line) {
  const out = []
  let field = '', quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { field += '"'; i++ }
      else if (ch === '"') quoted = false
      else field += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') { out.push(field); field = '' }
    else field += ch
  }
  out.push(field)
  return out
}

// Python's csv writer emits CRLF, so a bare split on \n leaves a trailing \r on
// the last field of every row and `status === 'created'` never matches.
const rows = readFileSync(CSV, 'utf8').split(/\r?\n/).filter((l) => l.trim()).slice(1)
  .map((line) => {
    const c = cells(line)
    return { name: c[0], email: c[1], password: c[2], status: c[3] }
  })
const participant = rows.find((r) => r.status === 'created')
const admin = rows.find((r) => r.status === 'created-admin')
if (!participant) { console.error('no row with status `created` in the CSV'); process.exit(2) }

function creds() {
  const file = path.join(homedir(), '.claude/secrets/obt-cdt-supabase.env')
  const out = execFileSync('/bin/zsh', ['-c',
    `set -a; . ${JSON.stringify(file)}; set +a; ` +
    'printf "%s\\n%s\\n%s\\n%s\\n" "$OBT_CDT_SUPABASE_PROJECT_REF" "$OBT_CDT_SUPABASE_ACCESS_TOKEN" ' +
    '"$OBT_CDT_SUPABASE_URL" "$OBT_CDT_SUPABASE_PUBLISHABLE_KEY"'],
    { encoding: 'utf8' }).trim().split('\n')
  return { ref: out[0], token: out[1], url: out[2], key: out[3] }
}

/**
 * Build the way the deploy builds, which is the only build that has a sign-in
 * card at all.
 *
 * A bare `npm run build` leaves `VITE_SUPABASE_*` unset, `backendEnabled` false
 * and `AuthGate` rendering nothing, so `#portal-email` is absent and a harness
 * that waits for it times out looking like a broken gate. SITE-03's lane sets
 * these four for the same reason; this is that invocation, not a new one.
 */
function build() {
  const { url, key } = creds()
  console.log('building with the backend enabled, as the deploy does')
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

function sql(query) {
  const { ref, token } = creds()
  const out = execFileSync('curl', ['-sS', '-X', 'POST',
    `https://api.supabase.com/v1/projects/${ref}/database/query`,
    '-H', `Authorization: Bearer ${token}`,
    '-H', 'Content-Type: application/json',
    '-A', 'obt-cdt-verify',
    '-d', JSON.stringify({ query })], { encoding: 'utf8' })
  return JSON.parse(out)
}

// Expected strings, read from the database rather than typed here.
//
// The key is `title` and not `heading`. The first version of this file asked for
// `heading`, got null for every block, and every "shows every seeded heading"
// check then passed at expected=0 actual=0 — a gate iterating an empty set and
// printing success, which is the class this campaign has now caught eight times.
// The zero-population refusal below is what stops it recurring.
const pages = sql('select route, kicker from member_page order by route')
const blocks = sql(`
  select route, block_key,
         block->>'title' as title,
         coalesce(jsonb_array_length(block->'items'), 0) as item_count,
         (select string_agg(i->>'label', E'\\n') from jsonb_array_elements(coalesce(block->'items','[]'::jsonb)) i) as labels
    from member_block order by route, ordinal`)
const expectedRoutes = pages.map((p) => p.route)

const titles = Object.fromEntries(expectedRoutes.map((r) =>
  [r, blocks.filter((b) => b.route === r).map((b) => b.title).filter(Boolean)]))
const itemLabels = Object.fromEntries(expectedRoutes.map((r) =>
  [r, blocks.filter((b) => b.route === r)
      .flatMap((b) => (b.labels || '').split('\n'))
      .map((s) => s.trim()).filter(Boolean)]))

// The public content file, read once, so the exemption below is decided against
// what the site actually publishes rather than against a list typed here.
const PUBLIC_CONTENT = readFileSync(path.join(REPO, 'src/content/site-content.json'), 'utf8')

if (expectedRoutes.length === 0) {
  console.error('member_page is empty; there is nothing to verify. Seed it first.')
  process.exit(2)
}
for (const route of expectedRoutes) {
  if (titles[route].length === 0 && itemLabels[route].length === 0) {
    console.error(`${route} has no titles and no item labels in member_block.`)
    console.error('Refusing to report a pass over an empty expected set.')
    process.exit(2)
  }
}
console.log('expected population, read from the database:')
for (const route of expectedRoutes) {
  console.log(`  ${route}: ${titles[route].length} block title(s), ${itemLabels[route].length} item label(s)`)
}

let failures = 0
function check(name, actual, expected) {
  const ok = String(actual) === String(expected)
  if (!ok) failures++
  console.log(`  ${ok ? ' ok ' : 'FAIL'}  ${name}  expected=${expected} actual=${actual}`)
  return ok
}

mkdirSync(SHOTS, { recursive: true })

build()

const server = await new Promise((resolve) => {
  const child = spawn('node', [path.join(REPO, 'scripts/serve-dist.mjs'), '--port', String(PORT)],
    { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] })
  const done = () => resolve(child)
  child.stdout.on('data', (d) => { if (String(d).includes(String(PORT))) done() })
  setTimeout(done, 2500)
})

const browser = await chromium.launch()

async function open(viewport = { width: 1440, height: 2400 }) {
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

async function signIn(page, who) {
  await page.fill('#portal-email', who.email)
  await page.fill('#portal-password', who.password)
  await page.click('button[type="submit"]')
  await page.waitForSelector('[data-member-page], [data-dfb-node="portal.member.empty"], [role="alert"]',
    { timeout: 30000 })
  await page.waitForTimeout(600)
}

try {
  console.log(`\nsigning in as a real participant account (${participant.name || 'unnamed'})\n`)

  // 1. Signed out, the member routes refuse.
  const out = await open()
  for (const route of expectedRoutes) {
    await out.goto(`${BASE}${route}`, { waitUntil: 'networkidle' })
    const gate = await out.locator('#portal-email').count()
    check(`signed out ${route} shows the sign-in form`, gate > 0, true)
    const html = await out.content()

    // A member page's FRAMING copy is public on purpose (SITE-04 decision 6,
    // program finding 24): the shell renders `Teaching materials and
    // applications` from `site-content.json` while the member block is titled
    // `Teaching materials`, so a naive substring test reports a leak that is the
    // design working. Anything already in the public content file is exempt, and
    // the exempt set is PRINTED — an absence check whose population is invisible
    // cannot be told apart from one that had nothing to look at.
    const candidates = [...titles[route], ...itemLabels[route]]
    const exempt = candidates.filter((s) => PUBLIC_CONTENT.includes(s))
    const guarded = candidates.filter((s) => !PUBLIC_CONTENT.includes(s))
    const leaked = guarded.filter((s) => html.includes(s))

    check(`signed out ${route} leaks none of its ${guarded.length} gated strings`, leaked.length, 0)
    console.log(`        ${exempt.length} exempt (already public in site-content.json)` +
      (exempt.length ? `: ${exempt.join(' | ')}` : ''))
    if (leaked.length) console.log(`        LEAKED: ${leaked.slice(0, 5).join(' | ')}`)
  }
  await out.close()

  // 2. Signed in as a participant, both routes render their real blocks.
  for (const route of expectedRoutes) {
    const page = await open()
    await page.goto(`${BASE}${route}`, { waitUntil: 'networkidle' })
    await signIn(page, participant)
    await page.waitForTimeout(800)

    const alert = await page.locator('[role="alert"]').count()
    if (alert) {
      const text = await page.locator('[role="alert"]').first().innerText()
      console.log(`  !!  ${route} returned an alert: ${text.slice(0, 200)}`)
    }

    const rendered = await page.locator('[data-member-page]').count()
    check(`signed in ${route} renders a member page`, rendered > 0, true)

    const shown = await page.content()

    const missingTitles = titles[route].filter((t) => !shown.includes(t))
    check(`signed in ${route} shows all ${titles[route].length} block title(s)`, missingTitles.length, 0)
    if (missingTitles.length) console.log(`        missing: ${missingTitles.slice(0, 5).join(' | ')}`)

    // The materials page is 25 register rows. Asserting every label is the whole
    // point of signing in: a page that renders its headings and drops its rows
    // looks correct in a screenshot.
    const missingItems = itemLabels[route].filter((l) => !shown.includes(l))
    check(`signed in ${route} shows all ${itemLabels[route].length} item label(s)`, missingItems.length, 0)
    if (missingItems.length) console.log(`        missing: ${missingItems.slice(0, 5).join(' | ')}`)

    // Geometry, not innerText: memory note `innertext-passes-over-buried-ui`.
    const box = await page.locator('[data-member-page]').first().boundingBox()
    check(`signed in ${route} member page has real height`, (box?.height ?? 0) > 200, true)

    const violations = await page.evaluate(() => window.__cspViolations.length)
    check(`signed in ${route} raises no CSP violation`, violations, 0)

    const slug = route.replace(/\//g, '_') || '_root'
    await page.screenshot({ path: path.join(SHOTS, `participant${slug}.png`), fullPage: true })
    await page.close()
  }

  // 3. The administrator can sign in too, if one is in the CSV.
  if (admin) {
    const page = await open()
    await page.goto(`${BASE}/members`, { waitUntil: 'networkidle' })
    await signIn(page, admin)
    await page.waitForTimeout(600)
    check('administrator signs in', await page.locator('[data-member-page]').count() > 0, true)
    await page.screenshot({ path: path.join(SHOTS, 'admin_members.png'), fullPage: true })
    await page.close()
  }

  console.log(`\nshots in feedback/verify-shots/ (gitignored)`)
  console.log(failures === 0 ? '\nALL CHECKS PASSED\n' : `\n${failures} CHECK(S) FAILED\n`)
} finally {
  await browser.close()
  server.kill()
}

process.exit(failures === 0 ? 0 : 1)
