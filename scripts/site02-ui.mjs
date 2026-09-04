/**
 * SITE-02: the participant walks the evaluation, in a real browser.
 *
 *   node scripts/site02-fixtures.mjs --setup
 *   npm run build           # with the four VITE_ variables, per finding 11
 *   node scripts/site02-ui.mjs
 *   node scripts/site02-fixtures.mjs --teardown
 *
 * Criteria 0 to 5 and 7 to 13. Criterion 6's database half is
 * `site02-fixtures.mjs --assert`; its coverage half — every sentence in the panel
 * naming an assertion that exists and ran — is here, because it needs both the
 * rendered page and the assertion report.
 *
 * ## Every string this file asserts is read at run time
 *
 * From the database, from `Question-Set.md` through `--print-columns`, or from
 * `evalDisclosure.ts` parsed with the TypeScript compiler. SITE-03 finding 18 and
 * program finding 24: a harness that hardcodes its expected strings both leaks
 * them into a public repository and jams the seed that would have caught the
 * leak. The one exception is structural markup — `data-eval-*` attributes and DOM
 * ids — which is this spec's own contract with itself.
 *
 * ## The screenshots are gitignored before any is taken
 *
 * Program finding 11: six tracked PNGs of portal pages are already on
 * `origin/main`, and no text gate in this campaign can read an image.
 */
import { execFileSync, spawn } from 'node:child_process'
import { readFileSync, mkdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright'
import ts from 'typescript'

const REPO = path.resolve(import.meta.dirname, '..')
const IDS_FILE = path.join(REPO, 'scripts/.site02-fixture-ids.json')
const SHOTS = path.join(REPO, 'feedback/site02-shots')
const PORT = 4195
const BASE = `http://localhost:${PORT}/obt-cdt-site`

/**
 * Program finding 10. The origin scan over `dist/` returns contacted=1
 * unexpected=1 today, on supabase-js's default GoTrue URL sitting inside the
 * classifier's proximity window. That is a recorded BASELINE, not zero, and a
 * criterion asserting zero in this mode is red before the session starts.
 */
const ORIGIN_BASELINE_DIST = { contacted: 1, unexpected: 1 }

/**
 * A pre-existing React #418 hydration warning fires on EVERY portal route,
 * because Pages serves portal URLs from `404.html`. CDT-04's build record counted
 * five of them as violations. It is excluded BY CLASS and justified by a control
 * run against `/portal` with no SITE-02 code on the page (criterion 10).
 */
const PREEXISTING_ERROR = /Minified React error #418|hydrat/i

if (!existsSync(IDS_FILE)) {
  console.error('no fixtures; run: node scripts/site02-fixtures.mjs --setup')
  process.exit(2)
}
const fx = JSON.parse(readFileSync(IDS_FILE, 'utf8'))
const PARTICIPANT = `${fx.prefix}participant@example.org`
const SECOND = `${fx.prefix}second@example.org`
const LATECOMER = `${fx.prefix}latecomer@example.org`
const UNATTACHED = `${fx.prefix}unattached@example.org`

function creds() {
  const file = path.join(homedir(), '.claude/secrets/obt-cdt-supabase.env')
  const out = execFileSync('/bin/zsh', [
    '-c',
    `set -a; . ${JSON.stringify(file)}; set +a; ` +
      'printf "%s\\n%s" "$OBT_CDT_SUPABASE_PROJECT_REF" "$OBT_CDT_SUPABASE_ACCESS_TOKEN"',
  ]).toString().split('\n').map((s) => s.trim())
  const [ref, token] = out
  if (!ref || !token) {
    console.error(`missing values in ${file}`)
    process.exit(2)
  }
  return { ref, token }
}
const { ref, token } = creds()

async function sql(query, attempt = 0) {
  // Retries a TRANSPORT failure, never a refusal. This lane makes roughly a
  // hundred management-API calls across ten minutes, and one `ECONNRESET`
  // killed a whole run mid-criterion — which is also how criterion 5's
  // membership mutation came to be left unrestored twice. A non-2xx response is
  // still thrown immediately: a 4xx is an answer and must never be retried into
  // looking like a different one.
  let res
  try {
    res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    })
  } catch (e) {
    if (attempt >= 2) throw e
    console.log(`  note  transport error on the management API (${e.cause?.code ?? e.message}); retry ${attempt + 1} of 2`)
    await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)))
    return sql(query, attempt + 1)
  }
  const text = await res.text()
  if (!res.ok) throw new Error(`SQL ${res.status}: ${text}`)
  try { return JSON.parse(text) } catch { return [] }
}

let failures = 0
function check(criterion, name, actual, expected) {
  const ok = String(actual) === String(expected)
  if (!ok) failures++
  console.log(`  ${ok ? ' ok ' : 'FAIL'}  [${criterion}] ${name}  expected=${expected} actual=${actual}`)
  return ok
}

// ------------------------------------------------- what the panel claims, parsed

/**
 * `DISCLOSURE` and `EVAL_ASSERTIONS`, read out of the TypeScript with the
 * compiler rather than a regex, because criterion 6's mutation adds a row and a
 * regex that mis-parses the addition would report the mutation passing.
 */
function readDisclosure() {
  const file = path.join(REPO, 'src/pages/backend/evalDisclosure.ts')
  const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
  const rows = []
  const names = []
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      if (node.name.text === 'EVAL_ASSERTIONS') {
        const grab = (n) => {
          if (ts.isStringLiteral(n)) names.push(n.text)
          ts.forEachChild(n, grab)
        }
        grab(node.initializer)
      }
      if (node.name.text === 'DISCLOSURE') {
        const arr = ts.isAsExpression(node.initializer) ? node.initializer.expression : node.initializer
        if (ts.isArrayLiteralExpression(arr)) {
          for (const el of arr.elements) {
            if (!ts.isObjectLiteralExpression(el)) continue
            const row = { node: null, when: null, assertions: [] }
            for (const p of el.properties) {
              if (!ts.isPropertyAssignment(p)) continue
              const k = p.name.getText(sf)
              if (k === 'node' && ts.isStringLiteral(p.initializer)) row.node = p.initializer.text
              if (k === 'when' && ts.isStringLiteral(p.initializer)) row.when = p.initializer.text
              if (k === 'assertions' && ts.isArrayLiteralExpression(p.initializer)) {
                for (const a of p.initializer.elements) if (ts.isStringLiteral(a)) row.assertions.push(a.text)
              }
            }
            rows.push(row)
          }
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return { rows, names }
}

/** The node's rendered text, from the content layer, never typed here. */
function contentLabel(id) {
  const content = JSON.parse(readFileSync(path.join(REPO, 'src/content/site-content.json'), 'utf8'))
  const item = content.site.items.find((i) => i.id === id)
  return item ? item.label : null
}

// ------------------------------------------------------------------ scaffold

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

async function newPage(viewport = { width: 1440, height: 2400 }, opts = {}) {
  const context = await browser.newContext({ viewport, ...opts })
  const page = await context.newPage()
  await page.addInitScript(() => {
    window.__cspViolations = []
    document.addEventListener('securitypolicyviolation', (e) => {
      window.__cspViolations.push(e.effectiveDirective || e.violatedDirective)
    })
  })
  page.on('pageerror', (e) => pageErrors.push({ url: page.url(), text: String(e) }))
  return page
}

async function signIn(page, email) {
  await page.goto(`${BASE}/portal/evaluations`, { waitUntil: 'networkidle' })
  await page.waitForSelector('#portal-email', { timeout: 30000 })
  await page.fill('#portal-email', email)
  await page.fill('#portal-password', fx.password)
  await page.click('button[type="submit"]')
  await page.waitForSelector('[data-eval-list], [data-eval-empty], [data-eval-error]', { timeout: 30000 })
  await page.waitForTimeout(400)
}

/** Top offset of the first match, in CSS pixels from the top of the viewport. */
async function topOf(page, selector) {
  return page.evaluate((s) => {
    const el = document.querySelector(s)
    return el ? Math.round(el.getBoundingClientRect().top) : null
  }, selector)
}

async function openRound(page, roundKey) {
  await page.click(`[data-eval-round="${roundKey}"] [data-eval-open]`)
  await page.waitForSelector('#site02-eval, [data-eval-closed], [data-eval-missing]', { timeout: 30000 })
  await page.waitForTimeout(300)
}

/**
 * The fixture invariants, verified and REPAIRED before anything is asserted.
 *
 * Criterion 5 deletes a fixture's round membership on purpose, to force the RPC's
 * own refusal rather than a fabricated one. A run that dies between the delete
 * and the restore leaves the next run opening a form for a fixture that is in no
 * round, which surfaces as a thirty-second timeout inside `openRound` and a stack
 * trace — a broken fixture set wearing the costume of a broken page. It happened
 * three times in this build.
 *
 * A `finally` in criterion 5 is necessary and is not sufficient: a hard kill, a
 * crash in Playwright's own teardown, or an interrupt all skip it. So the lane
 * does not assume the previous run exited cleanly. It states what the fixture set
 * must look like, repairs any drift as `postgres`, and PRINTS what it repaired,
 * because a self-healing harness that heals silently is a harness that stops
 * reporting that its fixtures keep breaking.
 */
async function repairFixtures() {
  console.log('\n=== fixtures: the invariants this lane depends on')
  const want = [
    [fx.w1, 'participant'], [fx.w1, 'second'], [fx.w1, 'unattached'],
    [fx.w2, 'participant'], [fx.w2, 'second'], [fx.w2, 'unattached'], [fx.w2, 'latecomer'],
  ]
  const before = await sql(
    `select round_key, profile_id from public.evaluation_participant
      where round_key in ('${fx.w1}', '${fx.w2}')`)
  const have = new Set(before.map((r) => `${r.round_key}|${r.profile_id}`))
  const missing = want.filter(([r, role]) => !have.has(`${r}|${fx.ids[role]}`))
  if (missing.length) {
    await sql(
      `insert into public.evaluation_participant (round_key, profile_id) values ` +
        missing.map(([r, role]) => `('${r}', '${fx.ids[role]}')`).join(', ') +
        ` on conflict do nothing`)
  }
  // The latecomer is on w2 and MUST NOT be on w1: that absence is the whole of
  // criterion 4's not-in-round case, and an over-eager repair would erase it.
  const wrong = before.filter((r) => r.round_key === fx.w1 && r.profile_id === fx.ids.latecomer)
  if (wrong.length) {
    await sql(`delete from public.evaluation_participant
                where round_key = '${fx.w1}' and profile_id = '${fx.ids.latecomer}'`)
  }
  const after = await sql(
    `select count(*)::int as n from public.evaluation_participant
      where round_key in ('${fx.w1}', '${fx.w2}')`)
  console.log(`  repaired ${missing.length} missing membership(s) and ${wrong.length} wrong one(s)`)
  if (missing.length) for (const [r, role] of missing) console.log(`    restored ${role} in ${r}`)
  check('fx', 'the fixture set holds exactly the memberships this lane needs', after[0].n, want.length)
  check('fx', 'and the latecomer is NOT in week one, which criterion 4 depends on',
    (await sql(`select count(*)::int as n from public.evaluation_participant
                 where round_key = '${fx.w1}' and profile_id = '${fx.ids.latecomer}'`))[0].n, 0)
}

try {
  await repairFixtures()

  // ============================================================ criterion 0
  console.log('\n=== criterion 0: the six preconditions, re-measured in this run')
  {
    const shell = readFileSync(path.join(REPO, 'dist/404.html'), 'utf8')
    const assets = [...shell.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map((m) => m[1])
    check(0, 'assets counted, so the check is not vacuous', assets.length > 0, true)
    check(0, 'every asset in 404.html is under the base prefix',
      assets.every((a) => a.startsWith('/obt-cdt-site/')), true)
    check(0, 'the served home page is 200', (await fetch(`${BASE}/`)).status, 200)

    const tables = await sql(
      `select count(*)::int as n from information_schema.tables
        where table_schema = 'public' and (table_name like 'evaluation%' or table_name = 'workshop_evaluation_round')`)
    check(0, 'SITE-01 is applied: eleven evaluation tables in the catalog', tables[0].n, 11)
    const link = await sql(
      `select count(*)::int as n from information_schema.tables
        where table_schema = 'public' and table_name = 'evaluation_participant'`)
    check(0, 'decision 2 is discharged: evaluation_participant exists', link[0].n, 1)

    const seeded = await sql(
      `select count(*)::int as n from public.workshop_evaluation_round where round_key like 'psalms-bali-2026:%'`)
    console.log(`        durable instrument rounds: ${seeded[0].n} — 0 means the contracts are unsigned and this run used the ephemeral path`)

    // Routing asserted POSITIVELY on a portal-only string, never through a flag.
    const p = await newPage()
    await p.goto(`${BASE}/portal/evaluations`, { waitUntil: 'networkidle' })
    check(0, 'the portal route renders its own sign-in field, not the 404 page',
      await p.locator('#portal-email').count(), 1)
    await p.context().close()
  }

  // ============================================================ criterion 3
  // Before the walkthrough, because the scale's words are what the walkthrough
  // clicks: if they disagree with the contract, every later assertion is
  // asserting the wrong strings.
  console.log('\n=== criterion 3: the scale reads as words from the contract, and the sentence is above the fold')
  const contractScale = (() => {
    const out = execFileSync('python3', [
      path.join(REPO, 'scripts/build_evaluation_form.py'),
      '--round', 'w1', '--print-columns', '--allow-unsigned-session-map',
    ], { cwd: REPO, encoding: 'utf8' })
    return [...out.matchAll(/^#\s+['"](.+?)['"]\t-> rating (\d+|null)\t/gm)].map((m) => m[1])
  })()

  const phone = await newPage({ width: 390, height: 844 })
  {
    check(3, 'the contract emitted a scale at all', contractScale.length, 6)
    await signIn(phone, PARTICIPANT)
    await openRound(phone, fx.w2)
    // Step 0 is the disclosure and the audience question; step 1 is the first day.
    await phone.click('#site02-next')
    await phone.waitForSelector('[data-eval-day]', { timeout: 15000 })

    const rendered = await phone.evaluate(() => {
      const set = document.querySelector('fieldset[data-field^="rate-"]')
      return set ? [...set.querySelectorAll('label[data-choice]')].map((l) => l.innerText.trim()) : []
    })
    check(3, 'the rendered options match the contract, in order',
      JSON.stringify(rendered), JSON.stringify(contractScale))

    // Measured from the TOP of the page, not from wherever the previous clicks
    // left the scroll. SITE-05's criterion 6 asked for `top <= 104` and went green
    // on -2,253px, an element two thousand pixels above the viewport; the same
    // shape arrived here at -1,566px on the first run. So the offset is asserted
    // as a RANGE — on screen AND above the fold — and the page is scrolled to the
    // top first, which is also what a participant opening the step actually sees.
    await phone.evaluate(() => window.scrollTo(0, 0))
    await phone.waitForTimeout(200)
    const noteTop = await topOf(phone, '[data-dfb-node="portal.eval.scale.note"]')
    check(3, 'the comparison sentence is rendered', noteTop !== null, true)
    check(3, `the comparison sentence sits at ${noteTop}px, which must be on screen`,
      noteTop !== null && noteTop >= 0, true)
    check(3, `and above the fold at 390x844 (${noteTop} < 640)`, noteTop !== null && noteTop < 640, true)
    const firstCard = await topOf(phone, '[data-card]')
    check(3, 'and it is ABOVE the first card', noteTop !== null && firstCard !== null && noteTop < firstCard, true)
    await phone.screenshot({ path: path.join(SHOTS, 'day-step-390.png'), fullPage: false })
  }

  // ============================================================ criterion 7
  console.log('\n=== criterion 7: the comment prompt is exhaustive over the kinds actually seeded')
  {
    const kinds = (await sql(
      `select distinct kind from public.evaluation_item where round_key in ('${fx.w1}', '${fx.w2}') and active order by 1`,
    )).map((r) => r.kind)
    check(7, 'kinds enumerated from the database, not from a list here', kinds.length > 0, true)
    const src = readFileSync(path.join(REPO, 'src/pages/backend/EvaluationPage.tsx'), 'utf8')
    const declared = [...src.matchAll(/^\s{2}(\w+): \{ node: 'portal\.eval\.prompt\.(\w+)'/gm)].map((m) => m[1])
    const missing = kinds.filter((k) => !declared.includes(k))
    check(7, `every seeded kind has a prompt (${kinds.join(', ')})`, missing.join(',') || 'none', 'none')
    // And the refusal is real: promptFor throws rather than falling back.
    check(7, 'an unmatched kind is a refusal, not a fallback', /No comment prompt for item kind/.test(src), true)
  }

  // ============================================================ criterion 1
  console.log('\n=== criterion 1: a participant completes a round end to end, and the rows read back')
  const answers = { ratings: new Map(), comments: new Map(), text: new Map(), scale: new Map() }
  {
    const items = await sql(
      `select item_key, day, ordinal from public.evaluation_item where round_key = '${fx.w2}' and active order by day, ordinal`)
    const questions = await sql(
      `select question_key, answer_shape, required, absence_allowed from public.evaluation_question
        where round_key = '${fx.w2}' and active order by ordinal`)
    const days = [...new Set(items.map((i) => i.day))]
    check(1, 'the walkthrough has items to walk', items.length > 0, true)

    // Back to step 0 to answer the audience question, which the RPC requires and
    // the spec (frozen before SITE-01's R1) never mentioned.
    await phone.click('#site02-back')
    await phone.waitForSelector('fieldset[data-field="group"]', { timeout: 15000 })
    const groups = await phone.evaluate(() =>
      [...document.querySelectorAll('fieldset[data-field="group"] label[data-choice]')].map((l) => l.dataset.choice))
    const dbGroups = await sql(`select count(*)::int as n from public.evaluation_respondent_group`)
    check(1, 'the audience groups come from the database, counted there', groups.length, dbGroups[0].n)
    await phone.click(`fieldset[data-field="group"] label[data-choice="${groups[0]}"]`)

    let absentUsed = false
    for (let d = 0; d < days.length; d++) {
      await phone.click('#site02-next')
      await phone.waitForSelector('[data-eval-day]', { timeout: 15000 })
      const dayItems = items.filter((i) => i.day === days[d])
      for (const it of dayItems) {
        // One item is answered "I wasn't there", and it must never become a zero.
        const choice = !absentUsed ? 'absent' : String((it.ordinal % 5) + 1)
        absentUsed = true
        await phone.click(`fieldset[data-field="rate-${it.item_key}"] label[data-choice="${choice}"]`)
        answers.ratings.set(it.item_key, choice)
        if (it.ordinal === 1) {
          const text = `Walkthrough note for ${it.item_key}.`
          await phone.fill(`#site02-c-${it.item_key}`, text)
          answers.comments.set(it.item_key, text)
        }
      }
    }

    await phone.click('#site02-next')
    await phone.waitForSelector('[data-eval-question]', { timeout: 15000 })
    for (const q of questions) {
      if (q.answer_shape === 'scale') {
        const v = q.absence_allowed ? 'absent' : '4'
        await phone.click(`fieldset[data-field="q-${q.question_key}"] label[data-choice="${v}"]`)
        answers.scale.set(q.question_key, v)
      } else {
        const text = `Walkthrough answer for ${q.question_key}.`
        await phone.fill(`#site02-q-${q.question_key}`, text)
        answers.text.set(q.question_key, text)
      }
    }

    check(1, 'the File button is enabled once everything required is answered',
      await phone.isEnabled('#site02-file'), true)
    await phone.click('#site02-file')
    await phone.waitForSelector('[data-eval-complete], #site02-file-error', { timeout: 30000 })
    check(1, 'the completion moment replaced the form', await phone.locator('[data-eval-complete]').count(), 1)

    // Read back FROM THE DATABASE, item by item.
    const rows = await sql(
      `select r.item_key, r.attended, r.rating, r.comment from public.evaluation_item_rating r
         join public.evaluation_response p on p.id = r.response_id
        where p.round_key = '${fx.w2}' and p.profile_id = '${fx.ids.participant}'`)
    check(1, 'every rating landed', rows.length, answers.ratings.size)
    let mismatched = 0
    for (const row of rows) {
      const want = answers.ratings.get(row.item_key)
      const got = row.attended ? String(row.rating) : 'absent'
      if (got !== want) mismatched++
      if (row.attended === false && row.rating !== null) mismatched++
      const wantComment = answers.comments.get(row.item_key) ?? null
      if ((row.comment ?? null) !== wantComment) mismatched++
    }
    check(1, 'every stored rating, absence and comment matches what was typed', mismatched, 0)
    const absent = rows.filter((r) => !r.attended)
    check(1, 'the missed session stored a NULL rating and never a zero',
      absent.length === 1 && absent[0].rating === null, true)

    const ans = await sql(
      `select a.question_key, a.answer_shape, a.body, a.attended, a.rating from public.evaluation_answer a
         join public.evaluation_response p on p.id = a.response_id
        where p.round_key = '${fx.w2}' and p.profile_id = '${fx.ids.participant}'`)
    check(1, 'every answer landed', ans.length, answers.text.size + answers.scale.size)
    let amiss = 0
    for (const a of ans) {
      if (a.answer_shape === 'text' && a.body !== answers.text.get(a.question_key)) amiss++
      if (a.answer_shape === 'scale') {
        const want = answers.scale.get(a.question_key)
        const got = a.attended === false ? 'absent' : String(a.rating)
        if (got !== want) amiss++
      }
    }
    check(1, 'every stored answer matches what was typed', amiss, 0)

    const state = await sql(
      `select state, respondent_group, source from public.evaluation_response
        where round_key = '${fx.w2}' and profile_id = '${fx.ids.participant}'`)
    check(1, 'the response is submitted', state[0].state, 'submitted')
    check(1, 'and carries the audience group the form collected', state[0].respondent_group, groups[0])
    check(1, 'and is provenanced as a portal filing', state[0].source, 'portal')

    // The JWT retry is a real code path, asserted present and asserted to be the
    // shared one rather than a second copy that could drift.
    const evalApi = readFileSync(path.join(REPO, 'src/lib/backend/evalApi.ts'), 'utf8')
    check(1, 'evalApi imports the shared JWT retry', /from '\.\/retry'/.test(evalApi), true)
    check(1, 'and does not reimplement it', /issued at future/.test(evalApi), false)
  }

  // ============================================================ criterion 2
  console.log('\n=== criterion 2: a missed session never becomes a zero on the wire')
  {
    const req = []
    const p = await newPage({ width: 1440, height: 2400 })
    p.on('request', (r) => {
      if (r.url().includes('submit_evaluation')) req.push(r.postData())
    })
    await signIn(p, SECOND)
    await openRound(p, fx.w2)
    const items = await sql(
      `select item_key, day, ordinal from public.evaluation_item where round_key = '${fx.w2}' and active order by day, ordinal`)
    const questions = await sql(
      `select question_key, answer_shape, required, absence_allowed from public.evaluation_question
        where round_key = '${fx.w2}' and active order by ordinal`)
    const days = [...new Set(items.map((i) => i.day))]
    const groups = await p.evaluate(() =>
      [...document.querySelectorAll('fieldset[data-field="group"] label[data-choice]')].map((l) => l.dataset.choice))
    await p.click(`fieldset[data-field="group"] label[data-choice="${groups[1]}"]`)
    let absentUsed = false
    for (let d = 0; d < days.length; d++) {
      await p.click('#site02-next')
      await p.waitForSelector('[data-eval-day]', { timeout: 15000 })
      for (const it of items.filter((i) => i.day === days[d])) {
        await p.click(`fieldset[data-field="rate-${it.item_key}"] label[data-choice="${!absentUsed ? 'absent' : '3'}"]`)
        absentUsed = true
      }
    }
    await p.click('#site02-next')
    await p.waitForSelector('[data-eval-question]', { timeout: 15000 })
    for (const q of questions) {
      if (q.answer_shape === 'scale') {
        await p.click(`fieldset[data-field="q-${q.question_key}"] label[data-choice="${q.absence_allowed ? 'absent' : '4'}"]`)
      } else if (q.required) {
        await p.fill(`#site02-q-${q.question_key}`, `Second walkthrough for ${q.question_key}.`)
      }
    }
    await p.click('#site02-file')
    await p.waitForSelector('[data-eval-complete], #site02-file-error', { timeout: 30000 })

    check(2, 'the submit request was captured', req.length > 0, true)
    const body = JSON.parse(req[0])
    const absentRows = (body._ratings ?? []).filter((r) => r.attended === false)
    check(2, 'the wire carries attended:false for the missed session', absentRows.length, 1)
    check(2, 'and carries NO rating with it', absentRows.every((r) => r.rating === null), true)
    check(2, 'no rating on the wire is a zero', (body._ratings ?? []).every((r) => r.rating !== 0), true)

    const stored = await sql(
      `select r.rating from public.evaluation_item_rating r join public.evaluation_response p on p.id = r.response_id
        where p.round_key = '${fx.w2}' and p.profile_id = '${fx.ids.second}' and not r.attended`)
    check(2, 'the stored row has a null rating', stored.length === 1 && stored[0].rating === null, true)
    await p.context().close()
  }
  {
    // The database refusal, forced. `attended = true` with a zero is the corner
    // the CHECK exists for, and it is watched FIRING rather than assumed.
    const one = await sql(
      `select r.response_id, r.item_key from public.evaluation_item_rating r
         join public.evaluation_response p on p.id = r.response_id
        where p.round_key = '${fx.w2}' and p.profile_id = '${fx.ids.second}' and not r.attended limit 1`)
    let state = 'no refusal'
    try {
      await sql(`update public.evaluation_item_rating set attended = true, rating = 0
                  where response_id = '${one[0].response_id}' and item_key = '${one[0].item_key}'`)
    } catch (e) {
      state = /23514/.test(String(e)) ? '23514' : String(e).slice(0, 60)
    }
    check(2, 'sending a zero instead is refused by the database, with its SQLSTATE', state, '23514')
  }

  // ============================================================ criterion 8
  console.log('\n=== criterion 8: the File button is disabled until the RPC would accept')
  {
    // This criterion means "disabled until complete", so it has to start from an
    // empty form. It cannot assume one: criterion 5 files this fixture's
    // evaluation successfully, so a SECOND run of this harness would open a
    // seeded form and read the enabled button as a pass. A harness whose verdict
    // depends on whether it has been run before is not a harness, so the
    // precondition is established here rather than hoped for.
    await sql(`
      delete from public.evaluation_answer      where response_id in (
        select id from public.evaluation_response where round_key = '${fx.w2}' and profile_id = '${fx.ids.latecomer}');
      delete from public.evaluation_item_rating where response_id in (
        select id from public.evaluation_response where round_key = '${fx.w2}' and profile_id = '${fx.ids.latecomer}');
      delete from public.evaluation_response    where round_key = '${fx.w2}' and profile_id = '${fx.ids.latecomer}';`)
    const left = await sql(
      `select count(*)::int as n from public.evaluation_response where round_key = '${fx.w2}' and profile_id = '${fx.ids.latecomer}'`)
    check(8, 'the form starts empty, whatever an earlier run left behind', left[0].n, 0)

    const p = await newPage()
    await signIn(p, LATECOMER)
    // The draft store is device-local and this is a fresh browser context, so it
    // starts empty too; asserted rather than assumed.
    await p.evaluate((k) => localStorage.removeItem(k), `site02.eval.${fx.w2}`)
    await openRound(p, fx.w2)
    check(8, 'with nothing answered, the File step reports missing pieces',
      await p.locator('#site02-file').count(), 0)
    // Walk to the last step without answering, and the button must be disabled.
    const days = (await sql(
      `select distinct day from public.evaluation_item where round_key = '${fx.w2}' and active order by 1`)).length
    for (let i = 0; i <= days; i++) await p.click('#site02-next')
    await p.waitForSelector('#site02-file', { timeout: 15000 })
    check(8, 'the File button is disabled', await p.isDisabled('#site02-file'), true)
    check(8, 'and the required marker is on screen',
      await p.locator('[data-dfb-node="portal.field.required"]').count() > 0, true)
    await p.context().close()
  }
  {
    // The two rules agree: with the client gate loosened the database still
    // refuses. Forced through a direct RPC call rather than through the button,
    // because loosening the button is what is being simulated.
    const missing = await sql(
      `select question_key from public.evaluation_question where round_key = '${fx.w2}' and active and required limit 1`)
    let state = 'no refusal'
    try {
      await sql(`
        set local role authenticated;
        set local request.jwt.claims = '{"role":"authenticated","sub":"${fx.ids.latecomer}","aal":"aal1"}';
        select public.submit_evaluation('${fx.w2}', 'cit', '[]'::jsonb, '[]'::jsonb, true);`)
    } catch (e) {
      state = /23502/.test(String(e)) ? '23502' : String(e).slice(0, 80)
    }
    check(8, `a filing missing ${missing[0].question_key} is refused by the database`, state, '23502')
  }

  // ======================================================= criteria 4 and 4a
  console.log('\n=== criterion 4: the round-2 read-back, and both empty cases')
  {
    const p = await newPage()
    await signIn(p, PARTICIPANT)
    await openRound(p, fx.w2)
    const shared = await sql(
      `select q2.question_key from public.evaluation_question q2
         join public.evaluation_question q1 on q1.question_key = q2.question_key and q1.round_key = '${fx.w1}'
        where q2.round_key = '${fx.w2}' and q2.active and q1.active and q1.answer_shape = 'text'`)
    check(4, 'the two rounds share at least one written question', shared.length > 0, true)

    const days = (await sql(
      `select distinct day from public.evaluation_item where round_key = '${fx.w2}' and active order by 1`)).length
    for (let i = 0; i <= days; i++) await p.click('#site02-next')
    await p.waitForSelector('[data-eval-question]', { timeout: 15000 })

    const stored = await sql(
      `select a.question_key, a.body from public.evaluation_answer a
         join public.evaluation_response r on r.id = a.response_id
        where r.round_key = '${fx.w1}' and r.profile_id = '${fx.ids.participant}' and a.body is not null`)
    const readbacks = await p.evaluate(() =>
      Object.fromEntries([...document.querySelectorAll('[data-eval-readback]')]
        .map((el) => [el.dataset.evalReadback, el.querySelector('[data-eval-readback-body]')?.innerText.trim()])))
    check(4, 'a read-back panel is rendered for the shared question(s)',
      Object.keys(readbacks).length >= shared.length, true)
    const exact = stored.filter((s) => readbacks[s.question_key] === s.body).length
    check(4, 'and it shows the participant their OWN week-one words, exactly',
      exact >= Object.keys(readbacks).length, true)
    check(4, 'the panel is labelled as theirs', await p.locator('[data-earlier="answers"]').count(), 1)
    await p.context().close()
  }
  {
    const p = await newPage()
    await signIn(p, LATECOMER)
    await openRound(p, fx.w2)
    const days = (await sql(
      `select distinct day from public.evaluation_item where round_key = '${fx.w2}' and active order by 1`)).length
    for (let i = 0; i <= days; i++) await p.click('#site02-next')
    await p.waitForSelector('[data-eval-question]', { timeout: 15000 })
    check(4, 'someone who was not on week one gets the not-in-round sentence',
      await p.locator('[data-earlier="not-in-round"]').count(), 1)
    check(4, 'and NOT the unattached sentence', await p.locator('[data-earlier="nothing-readable"]').count(), 0)
    check(4, 'and no read-back panel', await p.locator('[data-eval-readback]').count(), 0)
    await p.context().close()
  }
  {
    const p = await newPage()
    await signIn(p, UNATTACHED)
    await openRound(p, fx.w2)
    const days = (await sql(
      `select distinct day from public.evaluation_item where round_key = '${fx.w2}' and active order by 1`)).length
    for (let i = 0; i <= days; i++) await p.click('#site02-next')
    await p.waitForSelector('[data-eval-question]', { timeout: 15000 })
    check(4, 'someone whose week-one response is unattached gets the unattached sentence',
      await p.locator('[data-earlier="nothing-readable"]').count(), 1)
    check(4, 'and is NEVER told they joined late', await p.locator('[data-earlier="not-in-round"]').count(), 0)
    // The read that proves the case is real: a response exists in that round with
    // a null profile_id, and RLS returns it to nobody.
    const un = await sql(
      `select count(*)::int as n from public.evaluation_response where round_key = '${fx.w1}' and profile_id is null`)
    check(4, 'unattached week-one responses do exist', un[0].n > 0, true)
    await p.context().close()
  }

  console.log('\n=== criterion 4a: a closed round is still readable, and the completion link lands there')
  {
    const p = await newPage()
    await signIn(p, PARTICIPANT)
    await openRound(p, fx.w1)
    check('4a', 'the closed round renders the read-only view', await p.locator('[data-eval-closed]').count(), 1)
    const rows = await sql(
      `select r.item_key, r.attended, r.rating, r.comment from public.evaluation_item_rating r
         join public.evaluation_response p on p.id = r.response_id
        where p.round_key = '${fx.w1}' and p.profile_id = '${fx.ids.participant}'`)
    const shown = await p.evaluate(() =>
      Object.fromEntries([...document.querySelectorAll('[data-eval-past-item]')].map((el) => [
        el.dataset.evalPastItem,
        {
          rating: el.querySelector('[data-eval-past-rating]')?.dataset.evalPastRating,
          comment: el.querySelector('[data-eval-past-comment]')?.innerText.trim() ?? null,
        },
      ])))
    check('4a', 'every filed rating is on screen', Object.keys(shown).length, rows.length)
    let wrong = 0
    for (const r of rows) {
      const s = shown[r.item_key]
      if (!s) { wrong++; continue }
      if (s.rating !== (r.attended ? String(r.rating) : 'absent')) wrong++
      if ((r.comment ?? null) !== (s.comment ?? null)) wrong++
    }
    check('4a', 'and every one of them matches the database row', wrong, 0)
    const absent = rows.filter((r) => !r.attended)
    check('4a', 'this participant\'s week-one response contains an absence to show', absent.length > 0, true)
    const absentShown = absent.every((r) => shown[r.item_key]?.rating === 'absent')
    check('4a', 'and every absence reads as an absence, never as a number', absentShown, true)
    await p.screenshot({ path: path.join(SHOTS, 'closed-round-1440.png'), fullPage: false })
    await p.context().close()
  }
  {
    // The completion panel's own link, FOLLOWED. The first draft claimed this row
    // and checked only the database half.
    const p = await newPage()
    await signIn(p, SECOND)
    await openRound(p, fx.w2)
    // Already filed in criterion 2, so re-filing is a revision; walk to the end
    // and file again to reach the panel.
    const days = (await sql(
      `select distinct day from public.evaluation_item where round_key = '${fx.w2}' and active order by 1`)).length
    for (let i = 0; i <= days; i++) await p.click('#site02-next')
    await p.waitForSelector('#site02-file', { timeout: 15000 })
    check('4a', 'a filed response re-opens as an editable form, not a dead end',
      await p.isEnabled('#site02-file'), true)
    await p.click('#site02-file')
    await p.waitForSelector('[data-eval-complete]', { timeout: 30000 })
    // "Lands on their answers" is asserted as CONTENT, not as presence. The
    // stage-6 review found that a presence check passed over the bug it was
    // written for: the panel's control remounted the form against the data
    // already in hand, so a first-time filer got a blank form and a
    // `count() > 0` check could not tell. So this waits for the re-read to
    // finish and then asserts a value that can only be there if the form was
    // seeded from the database.
    const filed = await sql(
      `select r.item_key, r.attended, r.rating from public.evaluation_item_rating r
         join public.evaluation_response p on p.id = r.response_id
        where p.round_key = '${fx.w2}' and p.profile_id = '${fx.ids.second}' and r.attended limit 1`)
    check('4a', 'there is a filed rating to look for', filed.length, 1)
    await p.click('[data-eval-done-own]')
    await p.waitForSelector('#site02-eval, [data-eval-closed]', { timeout: 30000 })
    await p.waitForTimeout(500)
    check('4a', 'the completion panel\'s own control lands back on the form', 
      await p.locator('#site02-eval').count(), 1)
    // The RATED COUNT, not one control's value. The form reopens at the intro
    // step and that item's fieldset is not in the DOM there, so the first version
    // of this check read null and failed for a reason that had nothing to do with
    // the seed. The count is rendered on every step, is computed from the seeded
    // draft, and is exactly the number a stale-empty seed would get wrong: 0.
    const rated = await sql(
      `select count(*)::int as n from public.evaluation_item_rating r
         join public.evaluation_response x on x.id = r.response_id
        where x.round_key = '${fx.w2}' and x.profile_id = '${fx.ids.second}'`)
    const shownCount = await p.getAttribute('[data-eval-rated]', 'data-eval-rated')
    check('4a', 'and the form is re-seeded from the database, not from stale state',
      shownCount, `${rated[0].n}/${rated[0].n}`)
    check('4a', 'the seeded count is not zero, so the check is not vacuous', rated[0].n > 0, true)
    await p.context().close()
  }

  // ============================================================ criterion 5
  console.log('\n=== criterion 5: the draft survives a closed tab and clears only on success')
  {
    const context = await browser.newContext({ viewport: { width: 1440, height: 2400 } })
    const p = await context.newPage()
    await p.addInitScript(() => {
      window.__cspViolations = []
      document.addEventListener('securitypolicyviolation', (e) => {
        window.__cspViolations.push(e.effectiveDirective || e.violatedDirective)
      })
    })
    // Waits for ANY of the three outcomes and then asserts which one, rather than
    // waiting only for the list. A bare `waitForSelector('[data-eval-list]')`
    // turns "this fixture is in no round" into a 30-second hang and a stack
    // trace, which is what happened when an earlier crashed run left criterion
    // 5's own membership mutation unrestored: the next run died here with a
    // timeout instead of saying the fixture set was broken.
    await p.goto(`${BASE}/portal/evaluations`, { waitUntil: 'networkidle' })
    await p.fill('#portal-email', LATECOMER)
    await p.fill('#portal-password', fx.password)
    await p.click('button[type="submit"]')
    await p.waitForSelector('[data-eval-list], [data-eval-empty], [data-eval-error]', { timeout: 30000 })
    check(5, 'the fixture is in a round, so the draft can be exercised at all',
      await p.locator('[data-eval-list]').count(), 1)
    await openRound(p, fx.w2)
    const groups = await p.evaluate(() =>
      [...document.querySelectorAll('fieldset[data-field="group"] label[data-choice]')].map((l) => l.dataset.choice))
    await p.click(`fieldset[data-field="group"] label[data-choice="${groups[2]}"]`)
    await p.click('#site02-next')
    await p.waitForSelector('[data-eval-day]', { timeout: 15000 })
    const firstItem = (await sql(
      `select item_key from public.evaluation_item where round_key = '${fx.w2}' and active order by day, ordinal limit 1`))[0].item_key
    await p.click(`fieldset[data-field="rate-${firstItem}"] label[data-choice="5"]`)
    const typed = 'A half-finished note that must survive a closed tab.'
    await p.fill(`#site02-c-${firstItem}`, typed)
    await p.click('#site02-next')
    await p.waitForSelector('[data-eval-day]', { timeout: 15000 })
    const stepBefore = await p.getAttribute('#site02-eval', 'data-eval-step')
    await p.waitForTimeout(400)

    const state = await context.storageState()
    await context.close()

    // A NEW context carrying the same storage: the closed tab, reopened.
    const back = await browser.newContext({ viewport: { width: 1440, height: 2400 }, storageState: state })
    const p2 = await back.newPage()
    await p2.goto(`${BASE}/portal/e/${encodeURIComponent(fx.w2)}`, { waitUntil: 'networkidle' })
    await p2.waitForSelector('#site02-restore', { timeout: 30000 })
    check(5, 'the restore prompt appears after the tab is closed', await p2.locator('#site02-restore').count(), 1)
    await p2.click('#site02-restore-yes')
    await p2.waitForTimeout(400)
    check(5, 'the step position came back', await p2.getAttribute('#site02-eval', 'data-eval-step'), stepBefore)
    await p2.click('#site02-back')
    await p2.waitForSelector('[data-eval-day]', { timeout: 15000 })
    check(5, 'and the typed comment came back', await p2.inputValue(`#site02-c-${firstItem}`), typed)
    check(5, 'and the rating came back', await p2.evaluate((k) =>
      document.querySelector(`fieldset[data-field="rate-${k}"] input:checked`)?.value, firstItem), '5')

    const key = `site02.eval.${fx.w2}`
    check(5, 'the draft key exists before filing',
      await p2.evaluate((k) => localStorage.getItem(k) !== null, key), true)

    // A refusal must KEEP the draft, and forcing one is now harder than it was,
    // for a good reason. Removing the caller's round membership used to do it;
    // the page now refuses a non-participant BEFORE rendering the form (the
    // stage-6 review's note 16), so there is no form left to file from and the
    // wait times out on a page that is behaving correctly.
    //
    // So the refusal is raised by changing the instrument UNDER a form that has
    // already loaded: an item goes inactive after the client has rendered it, and
    // `submit_evaluation()` refuses a rating for an item that is not active in
    // the round. The client cannot know, which is exactly the situation the
    // clear-only-on-success rule exists for.
    const days = (await sql(
      `select distinct day from public.evaluation_item where round_key = '${fx.w2}' and active order by 1`)).length
    const items = await sql(
      `select item_key, day, ordinal from public.evaluation_item where round_key = '${fx.w2}' and active order by day, ordinal`)
    const questions = await sql(
      `select question_key, answer_shape, required, absence_allowed from public.evaluation_question
        where round_key = '${fx.w2}' and active order by ordinal`)
    const victim = items[items.length - 1].item_key

    let reactivated = false
    const reactivate = async () => {
      if (reactivated) return
      await sql(`update public.evaluation_item set active = true
                  where round_key = '${fx.w2}' and item_key = '${victim}'`)
      reactivated = true
    }

    try {
      // Fill the form completely, from the step the restore left it on.
      let step = Number(await p2.getAttribute('#site02-eval', 'data-eval-step'))
      while (step > 0) { await p2.click('#site02-back'); await p2.waitForTimeout(120); step-- }
      const dayList = [...new Set(items.map((i) => i.day))]
      const groups2 = await p2.evaluate(() =>
        [...document.querySelectorAll('fieldset[data-field="group"] label[data-choice]')].map((l) => l.dataset.choice))
      await p2.click(`fieldset[data-field="group"] label[data-choice="${groups2[0]}"]`)
      for (let d = 0; d < dayList.length; d++) {
        await p2.click('#site02-next')
        await p2.waitForSelector('[data-eval-day]', { timeout: 15000 })
        for (const it of items.filter((i) => i.day === dayList[d])) {
          await p2.click(`fieldset[data-field="rate-${it.item_key}"] label[data-choice="3"]`)
        }
      }
      await p2.click('#site02-next')
      await p2.waitForSelector('[data-eval-question]', { timeout: 15000 })
      for (const q of questions) {
        if (q.answer_shape === 'scale') await p2.click(`fieldset[data-field="q-${q.question_key}"] label[data-choice="4"]`)
        else if (q.required) await p2.fill(`#site02-q-${q.question_key}`, `Refused filing for ${q.question_key}.`)
      }

      // Now, and only now, the server changes under it.
      await sql(`update public.evaluation_item set active = false
                  where round_key = '${fx.w2}' and item_key = '${victim}'`)
      await p2.click('#site02-file')
      await p2.waitForSelector('#site02-file-error', { timeout: 30000 })
      check(5, 'a refused filing is reported, not swallowed', await p2.locator('#site02-file-error').count(), 1)
      check(5, 'and the draft is STILL there', await p2.evaluate((k) => localStorage.getItem(k) !== null, key), true)
      const none = await sql(
        `select count(*)::int as n from public.evaluation_response
          where round_key = '${fx.w2}' and profile_id = '${fx.ids.latecomer}' and state = 'submitted'`)
      check(5, 'and nothing was filed', none[0].n, 0)

      // Let it succeed, and the key must go.
      await reactivate()
      await p2.click('#site02-file')
      await p2.waitForSelector('[data-eval-complete]', { timeout: 30000 })
      check(5, 'the draft key is gone after a successful filing',
        await p2.evaluate((k) => localStorage.getItem(k) === null, key), true)
    } finally {
      await reactivate()
      const back2 = await sql(
        `select count(*)::int as n from public.evaluation_item
          where round_key = '${fx.w2}' and item_key = '${victim}' and active`)
      check(5, 'the item this criterion deactivated is active again, whatever happened', back2[0].n, 1)
    }
    check(5, `${days} day step(s) walked`, days > 0, true)
    await back.close()
  }

  // ============================================================ criterion 6
  console.log('\n=== criterion 6: every sentence in the panel is on screen and names an assertion that ran')
  {
    const { rows, names } = readDisclosure()
    check(6, 'the disclosure table parsed', rows.length > 0, true)
    check(6, 'every row names at least one assertion', rows.every((r) => r.assertions.length > 0), true)
    const unknown = rows.flatMap((r) => r.assertions).filter((a) => !names.includes(a))
    check(6, 'every named assertion is in the closed vocabulary', unknown.join(',') || 'none', 'none')

    const report = execFileSync('node', [path.join(REPO, 'scripts/site02-fixtures.mjs'), '--assert'],
      { cwd: REPO, encoding: 'utf8' })
    const ran = new Set(
      [...report.matchAll(/^\s+ ok\s+([a-z0-9-]+)(?:\/|\s)/gm)].map((m) => m[1]),
    )
    const notRun = rows.flatMap((r) => r.assertions).filter((a) => !ran.has(a))
    check(6, 'every sentence\'s assertion actually ran and passed', notRun.join(',') || 'none', 'none')
    const mutations = (report.match(/^\s+ ok\s+MUTATION /gm) ?? []).length
    check(6, 'and each was mutation-tested', mutations, names.length)

    // Every sentence is on the rendered page, for a participant who sees all of
    // them: the walkthrough participant's earlier round was imported.
    const p = await newPage()
    await signIn(p, PARTICIPANT)
    await openRound(p, fx.w2)
    const onScreen = await p.evaluate(() =>
      [...document.querySelectorAll('[data-disclosure]')].map((el) => el.dataset.disclosure))
    check(6, 'every row of the panel is rendered for this participant', onScreen.length, rows.length)
    let textMismatch = 0
    for (const r of rows) {
      const want = contentLabel(r.node)
      const got = await p.evaluate((n) => document.querySelector(`[data-disclosure="${n}"]`)?.innerText.trim(), r.node)
      if (!want || !got || !got.includes(want.slice(0, 40))) textMismatch++
    }
    check(6, 'and each one renders its own content node', textMismatch, 0)
    await p.screenshot({ path: path.join(SHOTS, 'disclosure-1440.png'), fullPage: false })
    await p.context().close()
  }

  // ============================================================ criterion 9
  console.log('\n=== criterion 9: the completion moment, with its credit, and with motion off')
  {
    const manifest = JSON.parse(readFileSync(path.join(REPO, 'src/content/media-manifest.json'), 'utf8'))
    const p = await newPage({ width: 1440, height: 2400 }, { reducedMotion: 'reduce' })
    await signIn(p, PARTICIPANT)
    await openRound(p, fx.w2)
    const days = (await sql(
      `select distinct day from public.evaluation_item where round_key = '${fx.w2}' and active order by 1`)).length
    for (let i = 0; i <= days; i++) await p.click('#site02-next')
    await p.waitForSelector('#site02-file', { timeout: 15000 })
    await p.click('#site02-file')
    await p.waitForSelector('[data-eval-complete]', { timeout: 30000 })

    const src = await p.getAttribute('[data-eval-image]', 'src')
    const alt = await p.getAttribute('[data-eval-image]', 'alt')
    const credit = await p.locator('[data-eval-credit]').innerText()
    const file = src.split('/').pop()
    const entry = Object.values(manifest).find((m) => m.src && m.src.endsWith(file))
    check(9, 'the image is one of the self-hosted files in the manifest', !!entry, true)
    check(9, 'it is served from public/media/', existsSync(path.join(REPO, 'public/media', file)), true)
    check(9, 'its alt text is the manifest\'s', alt, entry.alt)
    check(9, 'its credit is rendered', credit.trim(), entry.credit.trim())
    check(9, 'the heading is there', await p.locator('[data-dfb-node="portal.eval.done.heading"]').count(), 1)
    check(9, 'and both links', await p.locator('[data-eval-done-own], [data-eval-done-portal]').count(), 2)
    check(9, 'the panel is complete with prefers-reduced-motion: reduce',
      await p.locator('[data-eval-complete] img').isVisible(), true)
    await p.screenshot({ path: path.join(SHOTS, 'completion-reduced-motion-1440.png'), fullPage: false })
    await p.context().close()

    // The scan EXITS 1 in dist mode today and that is program finding 10's
    // recorded baseline, not a regression: supabase-js's default GoTrue URL sits
    // inside the classifier's ±120-character proximity window. So its exit code
    // is not the signal; its SUMMARY line is, compared against the baseline.
    // Asserting zero here would be red before this session started.
    const scanOut = (() => {
      try {
        return execFileSync('node', [path.join(REPO, 'scripts/cdt00-origin-scan.mjs')],
          { cwd: REPO, encoding: 'utf8' })
      } catch (e) {
        return e.stdout?.toString() ?? ''
      }
    })()
    const summary = scanOut.match(/SUMMARY\s+contacted=(\d+)\s+unexpected=(\d+)/)
    check(9, 'the origin scan produced a summary line to compare', !!summary, true)
    if (summary) {
      check(9, 'the dist-mode contacted-origin count is unchanged against the recorded baseline',
        Number(summary[1]), ORIGIN_BASELINE_DIST.contacted)
      check(9, 'and so is the unexpected count', Number(summary[2]), ORIGIN_BASELINE_DIST.unexpected)
    }
  }

  // ====================================================== criteria 10 and 12
  console.log('\n=== criterion 10: zero CSP violations on the new routes, with the error class named')
  {
    const p = await newPage()
    await signIn(p, PARTICIPANT)
    let v = await p.evaluate(() => window.__cspViolations || [])
    check(10, '/portal/evaluations: zero CSP violations', v.length, 0)
    await openRound(p, fx.w2)
    v = await p.evaluate(() => window.__cspViolations || [])
    check(10, '/portal/e/:roundKey: zero CSP violations', v.length, 0)
    await p.context().close()

    // The control: /portal carries no SITE-02 code and fires the same class.
    const ctrl = await newPage()
    await ctrl.goto(`${BASE}/portal`, { waitUntil: 'networkidle' })
    await ctrl.waitForTimeout(800)
    const before = pageErrors.length
    const controlErrors = pageErrors.filter((e) => e.url.endsWith('/portal'))
    // The population is asserted NON-EMPTY first. `[].every(...)` is `true`, so
    // without this the exclusion below is justified by a control that saw
    // nothing, and a real error on a SITE-02 route would be filtered out on the
    // strength of it. That is the campaign's signature class, in the one check
    // whose entire job is to be the evidence for an exclusion.
    check(10, 'the control route produced page errors to classify', controlErrors.length > 0, true)
    check(10, 'and every one of them is the pre-existing class',
      controlErrors.length > 0 && controlErrors.every((e) => PREEXISTING_ERROR.test(e.text)), true)
    const ours = pageErrors.filter((e) => /\/portal\/(e|evaluations)/.test(e.url) && !PREEXISTING_ERROR.test(e.text))
    check(10, 'no page error on a SITE-02 route outside that class', ours.length, 0)
    console.log(`        ${pageErrors.length} page error(s) seen, ${pageErrors.filter((e) => PREEXISTING_ERROR.test(e.text)).length} of the excluded class; ${before} before the control`)
    const allow = readFileSync(path.join(REPO, 'scripts/csp-allowed-inline.json'), 'utf8')
    const diff = execFileSync('git', ['diff', '--', 'scripts/csp-allowed-inline.json'], { cwd: REPO, encoding: 'utf8' })
    check(10, 'the inline-script allowlist is unchanged', diff.trim(), '')
    check(10, 'and it is a real file, so the check is not vacuous', allow.length > 0, true)
    await ctrl.context().close()
  }

  console.log('\n=== criterion 12: nobody can reach or alter another participant\'s evaluation')
  {
    // The refusal SHAPE, named from the migration rather than guessed. The
    // participant tables carry SELECT and nothing else, so an update is refused at
    // the GRANT with 42501 and never reaches a policy.
    const priv = await sql(
      `select has_table_privilege('authenticated', 'public.evaluation_response', 'UPDATE') as u,
              has_table_privilege('authenticated', 'public.evaluation_response', 'SELECT') as s`)
    check(12, 'authenticated holds SELECT on evaluation_response', priv[0].s, true)
    check(12, 'and holds no UPDATE, so the refusal is at the grant', priv[0].u, false)

    const p = await newPage()
    await signIn(p, SECOND)
    // A direct read of another participant's response from the page's own client.
    const read = await p.evaluate(async (other) => {
      const mod = await import('/obt-cdt-site/assets/shared-placeholder.js').catch(() => null)
      return mod ? 'imported' : other
    }, fx.ids.participant)
    check(12, 'the browser lane reached the page (the read itself is asserted in SQL)', typeof read, 'string')
    await p.context().close()

    const other = await sql(`
      set local role authenticated;
      set local request.jwt.claims = '{"role":"authenticated","sub":"${fx.ids.second}","aal":"aal1"}';
      select count(*)::int as n from public.evaluation_response where profile_id = '${fx.ids.participant}';`)
    check(12, 'a direct read of another participant\'s response returns zero rows', other[0].n, 0)
    const control = await sql(`
      set local role authenticated;
      set local request.jwt.claims = '{"role":"authenticated","sub":"${fx.ids.second}","aal":"aal1"}';
      select count(*)::int as n from public.evaluation_response where profile_id = '${fx.ids.second}';`)
    check(12, 'positive control: the same caller reads their own', control[0].n > 0, true)

    let state = 'no refusal'
    try {
      await sql(`
        set local role authenticated;
        set local request.jwt.claims = '{"role":"authenticated","sub":"${fx.ids.second}","aal":"aal1"}';
        update public.evaluation_response set state = 'draft' where round_key = '${fx.w1}';`)
    } catch (e) {
      state = /42501/.test(String(e)) ? '42501' : String(e).slice(0, 80)
    }
    check(12, 'an update of a closed round\'s response is refused with 42501', state, '42501')
  }

  // ============================================================ criterion 13
  console.log('\n=== criterion 13: two viewports, and the screenshots a person opens')
  {
    for (const [w, h, name] of [[390, 844, '390'], [1440, 2400, '1440']]) {
      const p = await newPage({ width: w, height: h })
      await signIn(p, PARTICIPANT)
      const overflowList = await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)
      check(13, `${name}px: the round list does not scroll sideways`, overflowList, false)
      await p.screenshot({ path: path.join(SHOTS, `list-${name}.png`), fullPage: false })

      await openRound(p, fx.w2)
      // Scrolled to a known position, and asserted as a RANGE. Program finding 34
      // is binding and this is the third time in three specs: a one-sided `top <
      // 200` is satisfied by an element eight hundred pixels above the viewport,
      // and `openRound` clicks a link inside a list card, which is exactly the
      // kind of navigation that leaves a scroll behind.
      await p.evaluate(() => window.scrollTo(0, 0))
      await p.waitForTimeout(200)
      const roundTop = await topOf(p, '[data-eval-round-name]')
      const closeTop = await topOf(p, '[data-eval-progress]')
      if (name === '390') {
        check(13, `the round name is on screen and inside the first 200px (${roundTop})`,
          roundTop !== null && roundTop >= 0 && roundTop < 200, true)
        check(13, `and the progress figure with it (${closeTop})`,
          closeTop !== null && closeTop >= 0 && closeTop < 260, true)
      }
      const days = (await sql(
        `select distinct day from public.evaluation_item where round_key = '${fx.w2}' and active order by 1`)).length
      // `lastStep` is days + 1: intro, one per day, then the QUESTION step, which
      // is where the read-back panel and the long textareas live. The first
      // version looped `i <= days` and stopped one short of it, so the two
      // surfaces this criterion names by name were never rendered at 390px at
      // all. Caught by the stage-6 review, not by the criterion.
      const lastStep = days + 1
      let missingProgress = 0
      let overflowed = 0
      let sawQuestions = 0
      for (let i = 0; i <= lastStep; i++) {
        if (await p.locator('[data-eval-progress]').count() !== 1) missingProgress++
        if (await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)) overflowed++
        if (await p.locator('[data-eval-question]').count() > 0) sawQuestions++
        await p.screenshot({ path: path.join(SHOTS, `step-${i}-${name}.png`), fullPage: false })
        if (i < lastStep) await p.click('#site02-next')
        await p.waitForTimeout(150)
      }
      check(13, `${name}px: the progress figure is visible at every step`, missingProgress, 0)
      check(13, `${name}px: no step scrolls sideways, across all ${lastStep + 1} step(s)`, overflowed, 0)
      check(13, `${name}px: the question step WAS reached and rendered`, sawQuestions > 0, true)
      check(13, `${name}px: the read-back panel was on screen there`,
        await p.locator('[data-earlier]').count() > 0, true)
      // And the completion moment, at this width. It was only ever rendered at
      // 1440 by criterion 9.
      await p.click('#site02-file')
      await p.waitForSelector('[data-eval-complete]', { timeout: 30000 })
      check(13, `${name}px: the completion moment does not scroll sideways`,
        await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false)
      await p.screenshot({ path: path.join(SHOTS, `completion-${name}.png`), fullPage: false })
      await p.context().close()
    }
    console.log(`        screenshots in ${path.relative(REPO, SHOTS)} — criterion 13 is not discharged until a person opens them beside the real Google Form`)
  }
} finally {
  await browser.close()
  server.kill()
}

console.log(`\n${failures === 0 ? 'site02-ui: every check passes.' : `site02-ui: ${failures} FAILURE(S).`}`)
process.exit(failures === 0 ? 0 : 1)
