#!/usr/bin/env node
/**
 * SITE-08 criteria 6 and 17: the attribution page in a real browser.
 *
 *     node scripts/site08-fixtures.mjs --setup
 *     npm run build
 *     node scripts/site08-ui.mjs
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
    'printf "%s\\n%s" "$OBT_CDT_SUPABASE_PROJECT_REF" "$OBT_CDT_SUPABASE_ACCESS_TOKEN"',
  ]).toString().split('\n').map((s) => s.trim())
  return { ref: out[0], token: out[1] }
}
const { ref, token } = creds()
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

const server = await startServer()
const browser = await chromium.launch()
const pageErrors = []

async function newPage() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 2400 } })
  const page = await context.newPage()
  page.on('pageerror', (e) => pageErrors.push(String(e)))
  return page
}

async function signIn(page, email) {
  await page.goto(`${BASE}/portal/admin/attributions`, { waitUntil: 'networkidle' })
  await page.waitForSelector('#portal-email', { timeout: 30000 })
  await page.fill('#portal-email', email)
  await page.fill('#portal-password', fx.password)
  await page.click('button[type="submit"]')
  await page.waitForTimeout(1200)
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

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length} assertion(s): ${results.length - failed.length} pass, ${failed.length} fail`)
console.log(`${pageErrors.length} page error(s), ` +
  `${pageErrors.filter((e) => PREEXISTING_ERROR.test(e)).length} of the excluded hydration class`)
if (failed.length) process.exit(1)
