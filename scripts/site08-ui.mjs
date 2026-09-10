#!/usr/bin/env node
/**
 * SITE-08 criteria 6 and 17: the attribution page in a real browser.
 *
 *     node scripts/site08-fixtures.mjs --setup
 *     node scripts/site08-ui.mjs        # it builds dist/ itself
 *
 * It builds `dist/` itself, with VITE_BASE and the backend variables, because a
 * plain `npm run build` produces a bundle whose assets 404 under the served
 * base and whose CSP omits the project origin. The old header said to run
 * `npm run build` first, which is the wrong instruction and is what the stage-6
 * review of this build caught.
 *
 * ## What this lane asserts that the SQL lane cannot
 *
 * Criterion 17: the three sections render in D7's order, each empty one
 * renders its own sentence rather than a blank region, the picker shows the
 * ATTESTED name, and a signed-in non-administrator gets the refusal sentence.
 * Criterion 6's browser half: the page makes no PostgREST request against
 * `member_allowlist` or `evaluation_response_identity`, paired with a positive
 * control so a page that simply failed to render cannot pass the negative half
 * on its own.
 *
 * ## Rules this lane inherits, each from a defect
 *
 * **Every geometry assertion is two-sided and scrolls to a known position
 * first** (findings 34 and 49). SITE-05 asked for `top <= 104` and went green
 * on −2,253px; the same shape arrived in SITE-02 at −1,566px. So an offset is
 * asserted as a RANGE, on screen AND above the fold, after `scrollY` has
 * stopped changing.
 *
 * **No expected string is hardcoded from participant prose** (findings 18 and
 * 24, and this session's own leak). Every name asserted here is read out of
 * the fixture's own database row or the content layer at run time. That
 * matters more in this spec than anywhere in the campaign, because the string
 * in question is a person's name.
 *
 * **The lane runs twice and the second verdict is recorded** (finding 35). A
 * harness whose verdict depends on whether it has been run before is not a
 * harness, and the only way to find that is to run it twice.
 *
 * **A criterion establishes its own precondition and prints that it did.**
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 4205
const BASE = `http://localhost:${PORT}/obt-cdt-site`
const SHOTS = path.join(REPO, 'feedback/site08-shots')
const STATE = path.join(tmpdir(), 'site08-fixtures.json')

if (!existsSync(STATE)) {
  console.error(`no fixture state at ${STATE}; run site08-fixtures.mjs --setup first`)
  process.exit(2)
}
let fx = JSON.parse(readFileSync(STATE, 'utf8'))

// The expected strings come from the content layer, never typed here, so a
// copy change cannot make this lane assert yesterday's wording.
function contentLabel(id) {
  const content = JSON.parse(readFileSync(path.join(REPO, 'src/content/site-content.json'), 'utf8'))
  const item = content.site.items.find((i) => i.id === id)
  return item ? item.label : null
}

// The attested name is read from the DATABASE at run time, per D9.
function creds() {
  const out = execFileSync('/bin/zsh', ['-c',
    `set -a; . ${JSON.stringify(path.join(homedir(), '.claude/secrets/obt-cdt-supabase.env'))}; set +a; ` +
    'printf "%s\\n%s\\n%s\\n%s" "$OBT_CDT_SUPABASE_PROJECT_REF" "$OBT_CDT_SUPABASE_ACCESS_TOKEN" ' +
    '"$OBT_CDT_SUPABASE_URL" "$OBT_CDT_SUPABASE_PUBLISHABLE_KEY"',
  ]).toString().split('\n').map((s) => s.trim())
  return { ref: out[0], token: out[1], supaUrl: out[2], supaKey: out[3] }
}
const { ref, token, supaUrl, supaKey } = creds()

/**
 * The lane builds the artifact it tests, with the env CI uses.
 *
 * It did not, and the stage-6 review of this build found the consequence. The
 * header of this file used to say `npm run build`, and a plain `npm run build`
 * emits assets at `/assets/…` with no Supabase origin in the CSP. Served under
 * `/obt-cdt-site/` every asset 404s, the app never mounts, the page is blank —
 * and criterion 6's negative assertion ("no PostgREST read of
 * member_allowlist") passes trivially against a blank page.
 *
 * Every sibling lane already does this (site03, site05, site07,
 * verify-member-access), and cdt06-ui.mjs:249-266 carries the same guard with a
 * comment describing this exact hazard. This lane was the one that did not, so
 * it inherits both the build and the assertion.
 */
function build() {
  console.log('=== building dist/ with the CI environment')
  execFileSync('npm', ['run', 'build'], {
    cwd: REPO,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      VITE_BASE: '/obt-cdt-site/',
      VITE_SITE_ORIGIN: 'https://joshuafrost712.github.io',
      VITE_SUPABASE_URL: supaUrl,
      VITE_SUPABASE_PUBLISHABLE_KEY: supaKey,
    },
  })
}
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

/**
 * A hydration mismatch on every portal route, pre-existing and not this
 * spec's. GitHub Pages serves portal URLs from `404.html`, whose prerendered
 * shell is the 404 page rather than the route being requested, so React
 * re-renders on mount. SITE-02 established the class and CDT-04's build record
 * counted five of them.
 *
 * It is excluded BY CLASS and the exclusion is EVIDENCED, not asserted: the
 * control below runs `/portal`, which carries no SITE-08 code at all, and the
 * population is checked non-empty before anything is filtered on its strength.
 * `[].every(...)` is `true`, so a control that saw nothing would justify
 * excluding a real error — which is this campaign's signature class landing in
 * the one check whose whole job is to be the evidence for an exclusion.
 */
const PREEXISTING_ERROR = /Minified React error #418|hydrat/i

const results = []
const check = (crit, label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  results.push({ ok, crit, label, got, want })
  console.log(`  ${ok ? ' ok ' : 'FAIL'}  c${crit} ${label}` +
    (ok ? '' : `\n          got ${JSON.stringify(got)} want ${JSON.stringify(want)}`))
}
const checkThat = (crit, label, ok, detail = '') => {
  results.push({ ok: !!ok, crit, label })
  console.log(`  ${ok ? ' ok ' : 'FAIL'}  c${crit} ${label}${detail ? `  — ${detail}` : ''}`)
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

build()

// cdt06-ui.mjs:249-266's guard, inherited. The build under test is asserted
// rather than assumed: a dist built without VITE_BASE serves a blank page, and
// every absence assertion in this lane would pass over it.
{
  const shell = readFileSync(path.join(REPO, 'dist/404.html'), 'utf8')
  const srcs = [...shell.matchAll(/(?:src|href)="(\/[^"]*\/assets\/[^"]*)"/g)].map((m) => m[1])
  checkThat(0, 'dist was built with VITE_BASE: every asset in 404.html is under the base prefix',
    srcs.length > 0 && srcs.every((x) => x.startsWith('/obt-cdt-site/assets/')),
    `${srcs.length} asset reference(s)`)
  checkThat(0, 'dist was built with the backend variables: the project origin is in the CSP',
    shell.includes(supaUrl), supaUrl.replace(/^https:\/\//, ''))
}

const server = await startServer()
// Note 4 of the build review: the server was killed only on the success path,
// so a lane that threw left port 4205 held and blocked the next run. Cleaning
// up on exit covers the throw, the refusal and the interrupt alike.
const cleanup = () => { try { server.kill() } catch { /* already gone */ } }
process.on('exit', cleanup)
process.on('SIGINT', () => { cleanup(); process.exit(130) })
process.on('uncaughtException', (e) => { cleanup(); console.error(e); process.exit(1) })

const browser = await chromium.launch()
const pageErrors = []

async function newPage() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 2400 } })
  const page = await context.newPage()
  page.on('pageerror', (e) => pageErrors.push(String(e)))
  return page
}

/**
 * Signs in and waits for the page to REACH A DECIDED STATE, rather than
 * sleeping and hoping.
 *
 * The first version ended in `waitForTimeout(1200)`. While `isAdmin` is still
 * `undefined` the page renders only "Checking your access…", so every
 * `querySelectorAll('[data-attrib-section]')` returned `[]` and the loops over
 * that population did not execute — silently, because iterating an empty array
 * asserts nothing. The stage-6 review of this build measured 30 assertions on
 * one run and 21 on a slowed one, against the 39 this lane is supposed to make.
 * That is program finding 33's class arriving through a race rather than a
 * savepoint: a harness that reports success over tests that never ran.
 *
 * So it waits for one of the three real outcomes to appear, and REFUSES on
 * timeout rather than proceeding into assertions that cannot fail.
 */
async function signIn(page, email) {
  await page.goto(`${BASE}/portal/admin/attributions`, { waitUntil: 'networkidle' })
  await page.waitForSelector('#portal-email', { timeout: 30000 })
  await page.fill('#portal-email', email)
  await page.fill('#portal-password', fx.password)
  await page.click('button[type="submit"]')
  // Either the queue rendered, or the refusal sentence did, or an error note.
  // `state: 'attached'` rather than visible, because the refusal is the whole
  // page for a non-administrator and the sections never appear for them.
  await page.waitForSelector(
    '[data-attrib-section], [data-dfb-node="portal.attrib.refused"], [data-dfb-node="portal.attrib.checking"]',
    { state: 'attached', timeout: 30000 })
  // And then wait for "checking" to be GONE, which is what distinguishes a
  // decided page from one still resolving is_portal_admin().
  await page.waitForFunction(
    () => !document.querySelector('[data-dfb-node="portal.attrib.checking"]'),
    null, { timeout: 30000 })
  await page.waitForTimeout(250)
}

/** Two-sided geometry, measured after scrollY has stopped changing. */
async function topOf(page, selector) {
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.waitForFunction(() => {
    return new Promise((r) => {
      const y0 = window.scrollY
      requestAnimationFrame(() => r(window.scrollY === y0))
    })
  })
  return page.evaluate((s) => {
    const el = document.querySelector(s)
    return el ? Math.round(el.getBoundingClientRect().top) : null
  }, selector)
}

const addr = (role) => `${fx.prefix}${role}@example.org`

async function run(pass) {
  console.log(`\n=== pass ${pass}`)

  // --- Criterion 17: the administrator sees three sections in D7's order
  const admin = await newPage()
  const requests = []
  admin.on('request', (r) => requests.push(r.url()))
  await signIn(admin, addr('admin'))

  const sections = await admin.evaluate(() =>
    [...document.querySelectorAll('[data-attrib-section]')].map((el) => el.dataset.attribSection))
  check(17, 'the three sections render in D7 order', sections, ['matched', 'ambiguous', 'unmatched'])

  // Two-sided geometry: on screen AND above the fold.
  const firstTop = await topOf(admin, '[data-attrib-section="matched"]')
  checkThat(17, `the matched section sits at ${firstTop}px, on screen and above the fold`,
    firstTop !== null && firstTop > 0 && firstTop < 2400, `${firstTop}px`)

  // The picker carries the ATTESTED name, read from the database at run time.
  const [row] = await sql(`
    select m.full_name as attested, p.full_name as declared
    from public.profiles p join public.member_allowlist m on lower(m.email) = lower(p.email)
    where p.id = '${fx.ids.real}'`)
  const pickerText = await admin.evaluate(() => {
    const sel = document.querySelector('[data-attrib-section="matched"] select')
    return sel ? [...sel.options].map((o) => o.textContent).join(' | ') : ''
  })
  checkThat(17, 'the picker renders the attested name', pickerText.includes(row.attested),
    `attested "${row.attested}" present`)
  checkThat(17, 'the picker never renders the self-declared name',
    !pickerText.includes(row.declared),
    `self-declared "${row.declared}" absent`)

  // Criterion 6's browser half, with its positive control in the same run.
  const badReads = requests.filter((u) =>
    /\/rest\/v1\/(member_allowlist|evaluation_response_identity)/.test(u))
  const renderedRows = await admin.evaluate(() =>
    document.querySelectorAll('[data-attrib-row]').length)
  checkThat(6, 'the page makes no PostgREST read of the allowlist or the identity table',
    badReads.length === 0, `${badReads.length} such request(s)`)
  checkThat(6, 'positive control: the page actually rendered rows',
    renderedRows > 0, `${renderedRows} row(s)`)

  await admin.screenshot({ path: path.join(SHOTS, `pass${pass}-admin-queue.png`), fullPage: true })

  // --- Criterion 17: each EMPTY section renders its own sentence.
  // The criterion establishes its own precondition and prints that it did:
  // every fixture response is decided, so all three sections go empty.
  const decided = await sql(`
    select count(*)::int as n from public.evaluation_response
    where round_key = '${fx.w1}' and profile_id is null`)
  console.log(`  note  precondition: ${decided[0].n} undecided response(s) before the empty-state pass`)

  await sql(`
    update public.evaluation_response set profile_id = '${fx.ids.other}'
    where id = '${fx.responseIds.unmatched}';
    delete from public.evaluation_response_identity where round_key = '${fx.w1}';
    update public.evaluation_response set profile_id = '${fx.ids.twin_a}'
    where id = '${fx.responseIds.matched}';
    update public.evaluation_response set profile_id = '${fx.ids.offlist}'
    where id = '${fx.responseIds.ambiguous}';
    update public.evaluation_response set profile_id = '${fx.ids.admin}'
    where id = '${fx.responseIds.blank}';`)

  const empty = await newPage()
  await signIn(empty, addr('admin'))
  // Each node is addressed EXACTLY, by its own id, rather than by a `$=".empty"`
  // suffix. The suffix is ambiguous: `portal.attrib.history.empty` ends in
  // `.empty` too, so a suffix selector inside a section could match the wrong
  // node, and reading a wrong-but-present node is how an assertion passes for
  // the wrong reason. Finding 49's rule about stating the content-node address
  // applies to the selector as much as to the assertion.
  const emptyStates = await empty.evaluate(() =>
    [...document.querySelectorAll('[data-attrib-section]')].map((el) => {
      const bucket = el.dataset.attribSection
      const node = el.querySelector(`[data-dfb-node="portal.attrib.${bucket}.empty"]`)
      return {
        bucket,
        rows: el.querySelectorAll('[data-attrib-row]').length,
        text: (node?.textContent ?? '').trim(),
        field: node?.getAttribute('data-dfb-field') ?? null,
      }
    }))
  // The population is asserted NON-EMPTY and of the expected size before
  // anything iterates it. `for (const x of [])` runs zero times and reports
  // nothing, so without this the nine assertions below can silently not exist —
  // which is what the review measured. Program finding 47: a zero is a result.
  checkThat(17, 'the empty-state pass found all three sections to assert over',
    emptyStates.length === 3, `${emptyStates.length} section(s)`)

  for (const s of emptyStates) {
    checkThat(17, `the empty ${s.bucket} section renders its own sentence`,
      s.rows === 0 && s.text.length > 20,
      s.text ? `"${s.text.slice(0, 60)}…"` : 'NO SENTENCE')
    const expected = contentLabel(`portal.attrib.${s.bucket}.empty`)
    checkThat(17, `the ${s.bucket} empty sentence is the content node's own text`,
      expected !== null && s.text === expected)
    // Finding 49: every content-node address states its data-dfb-field, which
    // is what makes the string rewritable in `npm run dev`.
    checkThat(17, `the ${s.bucket} empty node carries data-dfb-field`,
      s.field === 'label', String(s.field))
  }
  await empty.screenshot({ path: path.join(SHOTS, `pass${pass}-empty-states.png`), fullPage: true })

  // Restore, and assert the restore, per D9's durable-state rule.
  await sql(`
    update public.evaluation_response set profile_id = null where round_key = '${fx.w1}';`)
  const restored = await sql(`
    select count(*)::int as n from public.evaluation_response
    where round_key = '${fx.w1}' and profile_id is null`)
  checkThat(17, 'the fixture responses are restored to unattached',
    restored[0].n === 4, `${restored[0].n} of 4 unattached`)
  // The identity rows were deleted above, so the lane rebuilds them: D9's
  // rebuild contract, which is what makes a second pass meaningful rather
  // than consuming state the first pass decided.
  execFileSync('node', [path.join(REPO, 'scripts/site08-fixtures.mjs'), '--setup'],
    { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] })
  // --setup is idempotent by DELETING and recreating this round's responses, so
  // it hands back NEW ids. Re-read them, or the next pass updates rows that no
  // longer exist and matches nothing — silently, because an UPDATE affecting
  // zero rows is not an error. That is what made pass 1 green and pass 2 red,
  // and it is exactly the class finding 35's twice-run rule exists to catch.
  fx = JSON.parse(readFileSync(STATE, 'utf8'))
  const rebuilt = await sql(`
    select count(*)::int as n from public.evaluation_response_identity
    where round_key = '${fx.w1}'`)
  checkThat(17, 'the identity rows are rebuilt for the next pass',
    rebuilt[0].n === 3, `${rebuilt[0].n} identity row(s)`)

  // --- Criterion 17: a signed-in NON-administrator gets the refusal sentence.
  const member = await newPage()
  await signIn(member, addr('real'))
  const refusal = await member.evaluate(() => ({
    text: (document.querySelector('[data-dfb-node="portal.attrib.refused"]')?.textContent ?? '').trim(),
    sections: document.querySelectorAll('[data-attrib-section]').length,
  }))
  checkThat(17, 'a non-administrator sees the refusal sentence and no queue',
    refusal.text === contentLabel('portal.attrib.refused') && refusal.sections === 0,
    `sections=${refusal.sections}`)
  await member.screenshot({ path: path.join(SHOTS, `pass${pass}-refusal.png`), fullPage: true })

  for (const p of [admin, empty, member]) await p.context().close()
}

await run(1)
await run(2)

// --- The control for the page-error exclusion, run last so it classifies
// everything the two passes produced.
{
  const ctrl = await newPage()
  const before = pageErrors.length
  await ctrl.goto(`${BASE}/portal`, { waitUntil: 'networkidle' })
  await ctrl.waitForTimeout(1200)
  const controlErrors = pageErrors.slice(before)
  checkThat(17, 'the control route produced page errors to classify',
    controlErrors.length > 0, `${controlErrors.length} on /portal, which carries no SITE-08 code`)
  checkThat(17, 'and every one of them is the pre-existing hydration class',
    controlErrors.length > 0 && controlErrors.every((e) => PREEXISTING_ERROR.test(e)),
    'so the exclusion below is evidenced rather than assumed')
  await ctrl.context().close()
}

const ours = pageErrors.filter((e) => !PREEXISTING_ERROR.test(e))
checkThat(17, 'no page error outside the pre-existing class', ours.length === 0,
  ours.length ? ours.slice(0, 3).join(' | ') : `${pageErrors.length} seen, all of the excluded class`)

await browser.close()
server.kill()

/**
 * The assertion count is itself an assertion, exactly as D9 makes the SQL
 * lane's mutation count one. The review found this lane reporting "30
 * assertions, 30 pass, exit 0" — nine short — with no diagnostic, because the
 * missing nine were inside a loop over an empty population.
 *
 * Equality, not a floor, so an assertion that stops running fails the run
 * rather than shrinking the total quietly. Adding one means updating this
 * number deliberately.
 */
const EXPECTED_ASSERTIONS = 43

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length} assertion(s): ${results.length - failed.length} pass, ${failed.length} fail`)
if (results.length !== EXPECTED_ASSERTIONS) {
  console.error(`REFUSED: ${results.length} assertion(s), expected exactly ${EXPECTED_ASSERTIONS}.`)
  console.error('  An assertion that did not run is a gate that stopped testing, and it')
  console.error('  would otherwise leave this run green. If you added or removed one,')
  console.error('  update EXPECTED_ASSERTIONS.')
  process.exit(1)
}
console.log(`${pageErrors.length} page error(s), ` +
  `${pageErrors.filter((e) => PREEXISTING_ERROR.test(e)).length} of the excluded hydration class`)
if (failed.length) process.exit(1)
