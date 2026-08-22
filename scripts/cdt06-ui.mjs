/**
 * CDT-06a D5: the boundary assertions only a browser can make, over the merged tree.
 *
 *   node scripts/cdt06-fixtures.mjs --setup
 *   npm i -D --no-save playwright && npx playwright install chromium
 *   npm run build
 *   node --dns-result-order=ipv4first scripts/cdt06-ui.mjs
 *
 * ## Three checks, and each says which CDT-04 assertion it sits on top of
 *
 * D3 forbids re-running CDT-04's criteria as a receipt, and CDT-04's own review
 * tightened criterion 8 until most of the first draft's browser half was already
 * covered. What is left, and it is sharper for being narrower:
 *
 *   1. The absence is asserted against FULL PAGE HTML with a nonce, not against a
 *      row count. A client-side filter renders the absence sentence and ships the
 *      data anyway; a row count cannot tell those apart and `page.content()` can.
 *      Every absence has a positive control in the same run, because "the page
 *      does not contain X" passes on a blank page, a 404 and a fixture that never
 *      landed.
 *   2. The helper-3 mutation runs THROUGH THE RENDERED PAGE on `main`. CDT-02 ran
 *      it in SQL on its own branch and CDT-04 against the API on its own; driving
 *      it through the page is the one version that can say whether the filtering
 *      is the database's or the component's.
 *   3. The administrator's assurance pair, which CDT-04 does not touch at all.
 *
 * ## This is the one mutation in this spec that must COMMIT
 *
 * `cdt06-rls-tests.sql` wraps its mutations in a rolled-back transaction, which is
 * strictly safer. That is not available here: the browser reads over its own
 * connection and cannot see an uncommitted change. So this file keeps D7's full
 * discipline — capture with `pg_policies`, mutate one object for one check,
 * restore from `cdt06-rls-restore.sql` in a `finally` that runs on success,
 * failure and throw alike, then re-read and diff.
 *
 * ## Ports
 *
 * 4193 serves the built `dist`, 4293 is its attacker origin under the `+100`
 * convention `cdt00-browser-check.mjs` uses at line 123, and 9336 is the CDP port
 * `scripts/lib/browser.mjs` needs for the screenshots. No dev-server port: this
 * runs against a served build, not `npm run dev`. 4293 is booked and unused here,
 * because framing is CDT-00's to test and this spec does not re-assert it.
 */
import { readFileSync, existsSync, mkdirSync } from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'
import { homedir } from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright'

const REPO = path.resolve(import.meta.dirname, '..')
const IDS_FILE = path.join(REPO, 'scripts/.cdt06-fixture-ids.json')
const SHOTS = path.join(REPO, 'feedback/cdt06-shots')
const PORT = 4193
const BASE = `http://localhost:${PORT}/obt-cdt-site`

if (!existsSync(IDS_FILE)) {
  console.error('no fixtures; run: node scripts/cdt06-fixtures.mjs --setup')
  process.exit(2)
}
const fx = JSON.parse(readFileSync(IDS_FILE, 'utf8'))
const UI = fx.lanes.ui
const N = fx.nonces

function creds() {
  const file = path.join(homedir(), '.claude/secrets/obt-cdt-supabase.env')
  const out = execFileSync('/bin/zsh', [
    '-c',
    `set -a; . ${JSON.stringify(file)}; set +a; printf "%s\\n%s\\n%s\\n%s" ` +
      '"$OBT_CDT_SUPABASE_PROJECT_REF" "$OBT_CDT_SUPABASE_ACCESS_TOKEN" ' +
      '"$OBT_CDT_SUPABASE_URL" "$OBT_CDT_SUPABASE_PUBLISHABLE_KEY"',
  ])
    .toString()
    .split('\n')
    .map((s) => s.trim())
  return { ref: out[0], token: out[1], url: out[2], anonKey: out[3] }
}
const { ref, token, url: SUPA_URL, anonKey } = creds()
if (ref === 'vdbirmjvjzfdgajwgowj') {
  console.error('REFUSED: that ref is Honest Eval.')
  process.exit(1)
}

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

// ------------------------------------------------------------------ report

let pass = 0
let fail = 0
const gaps = []
function check(criterion, label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  ok ? pass++ : fail++
  console.log(
    `${ok ? '  ok  ' : ' FAIL '}[${criterion}] ${label}` +
      (ok ? '' : `\n         expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`),
  )
  return ok
}
function gap(criterion, label, consequence) {
  gaps.push({ criterion, label, consequence })
  console.log(`  GAP  [${criterion}] ${label}\n         ${consequence}`)
}

// ------------------------------------------------------------------ server

mkdirSync(SHOTS, { recursive: true })
const server = spawn('node', [path.join(REPO, 'scripts/serve-dist.mjs'), '--port', String(PORT)], {
  cwd: REPO,
  stdio: ['ignore', 'pipe', 'pipe'],
})
await new Promise((resolve) => {
  server.stdout.on('data', (d) => {
    if (String(d).includes(String(PORT))) resolve()
  })
  setTimeout(resolve, 2500)
})

const browser = await chromium.launch()
const violations = []
const preexisting = []

function classify(page) {
  page.on('console', (m) => {
    const t = m.text()
    // frame-ancestors via <meta> is Chrome noting what CDT-00 already documented:
    // Pages cannot send headers, so that directive is inert and frameBuster.ts
    // stands in for it. Not a violation of the policy.
    if (/Content Security Policy|Refused to/i.test(t) && !/frame-ancestors/i.test(t)) violations.push(t)
  })
  page.on('pageerror', (e) => {
    // React #418 fires on EVERY portal URL, including ones no spec in this
    // campaign wrote, because they are all served from 404.html under the Pages
    // SPA fallback. CDT-04 measured and reported it; attributing it to this spec
    // would be as wrong as ignoring it.
    if (/Minified React error #418/.test(e.message)) preexisting.push(e.message.slice(0, 60))
    else violations.push(`pageerror: ${e.message}`)
  })
  return page
}

async function newCtx(width = 1440, height = 1000) {
  const ctx = await browser.newContext({ viewport: { width, height } })
  return { ctx, page: classify(await ctx.newPage()) }
}

/** Sign in and wait for a DEFINITE outcome, so a slow load is never read as an absence. */
async function signIn(page, role) {
  await page.goto(`${BASE}/portal/assignments`, { waitUntil: 'networkidle' })
  await page.fill('#portal-email', `${UI.prefix}${role}@example.org`)
  await page.fill('#portal-password', fx.password)
  await page.click('button[type="submit"]')
  await page.waitForSelector(
    '[data-cdt-section], [data-cdt-total-hours], [data-cdt-empty], [data-cdt-error]',
    { timeout: 30000 },
  )
  await page.waitForTimeout(500)
}

/**
 * What this signed-in session can actually get OFF THE WIRE.
 *
 * The HTML check catches a client-side filter that renders the absence sentence
 * and ships the data anyway. This catches the other half: whether the filtering is
 * the database's at all. Both together are the whole claim, and neither alone is.
 */
async function wireRead(page, pathAndQuery) {
  return page.evaluate(
    async ({ base, key, q }) => {
      const raw = localStorage.getItem(
        Object.keys(localStorage).find((k) => k.includes('auth-token')) ?? '',
      )
      const tok = raw ? JSON.parse(raw).access_token : null
      const r = await fetch(`${base}/rest/v1/${q}`, {
        headers: { apikey: key, Authorization: `Bearer ${tok}` },
      })
      const body = await r.text()
      return { status: r.status, body }
    },
    { base: SUPA_URL, key: anonKey, q: pathAndQuery },
  )
}

/** Every nonce, checked in both directions and on both channels, in one run. */
async function nonceCheck(criterion, { name, nonce, entitled, blind, urlFor, query }) {
  // The caller who SHOULD see it. Without this the absence below passes on a
  // blank page, a 404, or a fixture whose row never landed.
  {
    const { ctx, page } = await newCtx()
    await signIn(page, entitled)
    await page.goto(urlFor(entitled), { waitUntil: 'networkidle' })
    await page.waitForTimeout(800)
    const html = await page.content()
    const wire = await wireRead(page, query)
    check(criterion, `POSITIVE CONTROL: ${name} is on ${entitled}'s page HTML`, html.includes(nonce), true)
    check(criterion, `POSITIVE CONTROL: ${name} reaches ${entitled} on the wire`, wire.body.includes(nonce), true)
    await ctx.close()
  }
  // The caller who MUST NOT.
  {
    const { ctx, page } = await newCtx()
    await signIn(page, blind)
    await page.goto(urlFor(blind), { waitUntil: 'networkidle' })
    await page.waitForTimeout(800)
    const html = await page.content()
    const wire = await wireRead(page, query)
    check(criterion, `${name} is ABSENT from ${blind}'s full page HTML`, html.includes(nonce), false)
    check(criterion, `${name} is ABSENT from ${blind}'s own wire read too`, wire.body.includes(nonce), false)
    await ctx.close()
  }
}

let policyCaptured = null

try {
  // ===================================================================
  // Preconditions: assert the fixture states this run needs, rather than
  // assuming them. A stale fixture set makes a boundary check fail for a reason
  // that has nothing to do with a boundary.
  // ===================================================================
  console.log('\n=== preconditions')
  const [st] = await sql(
    `select
       (select state from public.assignment where id = '${UI.rows.primary}') as primary_state,
       (select state from public.assignment where id = '${UI.rows.second}')  as second_state,
       (select released_at is null from public.submission where id = '${UI.rows.unreleasedSubmission}') as unreleased,
       (select count(*) from public.submission_rating where submission_id = '${UI.rows.primarySubmission}'
          and evidence_sentence like '%${N.evidence}%') as nonce1_rows,
       (select full_name from public.profiles where email = '${UI.prefix}citb@example.org') as citb_name`,
  )
  check(0, 'the primary assignment holds a filed write-up', st.primary_state, 'submitted')
  check(0, "the second rater's assignment is still open", st.second_state, 'held')
  check(0, 'the second write-up is unreleased', st.unreleased, true)
  check(0, 'nonce 1 is on the primary write-up ratings', Number(st.nonce1_rows) > 0, true)
  check(0, "nonce 3 is on CIT B's name", String(st.citb_name).includes(N.citb), true)

  // The build under test is the one CI produces, asserted rather than assumed.
  //
  // This check exists because the first run of this harness was driven against a
  // build made without VITE_BASE. `npm run build` reported "backend: enabled" and
  // "csp-hashes: patched 14 files", which reads as a successful CI-reproduced
  // build, while every asset in dist/404.html pointed at `/assets/…` instead of
  // `/obt-cdt-site/assets/…` and therefore 404'd under the served base. The page
  // was blank. An absence-only harness would have reported a clean sweep across
  // all three nonces, which is precisely the vacuity class this spec exists to
  // catch — it was the POSITIVE controls that caught it.
  {
    const shell = readFileSync(path.join(REPO, 'dist/404.html'), 'utf8')
    const srcs = [...shell.matchAll(/(?:src|href)="(\/[^"]*\/assets\/[^"]*)"/g)].map((m) => m[1])
    check(0, 'dist was built with VITE_BASE: every asset in 404.html is under the base prefix',
      srcs.length > 0 && srcs.every((s) => s.startsWith('/obt-cdt-site/assets/')), true)
    check(0, 'dist was built with the backend variables: the project origin is in the CSP',
      shell.includes(`${SUPA_URL}`), true)
  }

  // Routing asserted POSITIVELY on a portal-only string. `--expect-portal` cannot
  // fire (CDT-04's finding 3: NotFoundPage renders neither pattern it tests, and
  // getRouteMeta('/portal') falls back to the site title), so no check here trusts it.
  {
    const { ctx, page } = await newCtx()
    await page.goto(`${BASE}/portal/assignments`, { waitUntil: 'networkidle' })
    const html = await page.content()
    check(0, '/portal/assignments renders the portal sign-in, asserted positively',
      /id="portal-email"/.test(html), true)
    await page.goto(`${BASE}/portal/definitely-not-a-route`, { waitUntil: 'networkidle' })
    const bogus = await page.content()
    check(0, 'and a bogus portal route does NOT render it', /id="portal-email"/.test(bogus), false)
    await ctx.close()
  }

  // ===================================================================
  // Criterion 8, first half: the three nonces, both directions, both channels.
  // ===================================================================
  console.log('\n=== criterion 8: the nonce checks, with a positive control in the same run')

  // Nonce 1 rides in the primary's evidence sentences on a RELEASED write-up
  // about CIT A. The second rater holds their own assignment on the same CIT, so
  // the only thing between them and it is helper 3. This is the disclosure that
  // silently destroys the round's second-rating design.
  await nonceCheck(8, {
    name: 'nonce 1 (the primary rater\'s evidence sentence)',
    nonce: N.evidence,
    entitled: 'primary',
    blind: 'second',
    urlFor: (r) => `${BASE}/portal/a/${r === 'primary' ? UI.rows.primary : UI.rows.second}`,
    query: `submission_rating?select=evidence_sentence`,
  })

  // Nonce 2 rides in a submitted but UNRELEASED body. CIT A is its subject, and
  // may_see_submission admits a subject only once released_at is set.
  await nonceCheck(8, {
    name: 'nonce 2 (an unreleased write-up body)',
    nonce: N.unreleased,
    entitled: 'primary',
    blind: 'cita',
    urlFor: () => `${BASE}/portal/a/${UI.rows.unreleased}`,
    query: `submission?select=body_md`,
  })

  // Nonce 3 rides in CIT B's name. The primary has no assignment with CIT B at
  // all, so may_see_profile must not reach them. This is the by-URL check, and it
  // is why the fixtures carry two CITs: with one, it was either false for a
  // correct build or free for a caller with no data anywhere.
  await nonceCheck(8, {
    name: 'nonce 3 (CIT B\'s name)',
    nonce: N.citb,
    entitled: 'third',
    blind: 'primary',
    urlFor: () => `${BASE}/portal/a/${UI.rows.third}`,
    query: `profiles?select=full_name`,
  })

  // ===================================================================
  // Criterion 8, second half: helper 3's mutation, driven through the page.
  // ===================================================================
  console.log('\n=== criterion 8: helper 3 widened, watched through the rendered page, restored')

  // Helper 3 is `may_see_submission()`, and the mutation has to be made in the
  // FUNCTION rather than in the policy.
  //
  // The first version of this check replaced the `submission` SELECT policy's
  // `may_see_submission(id)` with `may_see_assignment(assignment_id)`, on the
  // spec's "widen helper 3 to helper 1" wording, and the second rater's page
  // stayed clean. Two reasons, both worth keeping: the primary's write-up hangs
  // off a DIFFERENT assignment, so may_see_assignment refuses the second rater
  // anyway; and `submission_rating`, which is where an evidence sentence actually
  // lives, has its own policy calling the same helper, so widening one table's
  // policy could never have surfaced nonce 1.
  //
  // The widening that would really destroy second rating is the one CDT-02's
  // review found and removed: a helper that reaches by SUBJECT, so any consultant
  // with an assignment for a CIT reads every other consultant's write-up about
  // that CIT. That is what is re-introduced here, for one check, and removed.
  const [cap] = await sql(
    `select pg_get_functiondef('public.may_see_submission(uuid)'::regprocedure) as def,
            (select qual from pg_policies
              where schemaname='public' and tablename='submission' and cmd='SELECT') as pol`,
  )
  policyCaptured = cap?.pol ?? null
  console.log(`  CAPTURED submission SELECT policy: ${policyCaptured}`)
  check(8, 'the captured policy is the one the restore file carries', policyCaptured, 'may_see_submission(id)')
  check(8, 'and helper 3 currently reaches by AUTHOR, not by subject',
    /consultant_profile_id = auth.uid\(\)/.test(cap.def) && !/may_see_subject/.test(cap.def), true)

  // Before: the second rater's page does not carry nonce 1. (Re-read here so the
  // mutation's "after" has a same-session "before" to move against.)
  let before
  {
    const { ctx, page } = await newCtx()
    await signIn(page, 'second')
    await page.goto(`${BASE}/portal/a/${UI.rows.second}`, { waitUntil: 'networkidle' })
    await page.waitForTimeout(800)
    before = (await page.content()).includes(N.evidence)
    await ctx.close()
  }
  check(8, 'before the mutation, the second rater\'s page is clean', before, false)

  // One object, one check wide.
  await sql(`
    create or replace function public.may_see_submission(_submission_id uuid)
     returns boolean language sql stable security definer set search_path to 'public'
    as $f$
      select exists (
        select 1 from submission s join assignment a on a.id = s.assignment_id
         where s.id = _submission_id
           and (s.consultant_profile_id = auth.uid()
             or (a.subject_profile_id = auth.uid() and s.released_at is not null)
             or may_see_subject(a.subject_profile_id))
      ) or is_head_mentor() or is_portal_admin();
    $f$;`)

  let afterHtml
  let afterWire
  {
    const { ctx, page } = await newCtx()
    await signIn(page, 'second')
    await page.goto(`${BASE}/portal/a/${UI.rows.second}`, { waitUntil: 'networkidle' })
    await page.waitForTimeout(1500)
    afterHtml = (await page.content()).includes(N.evidence)
    afterWire = (await wireRead(page, 'submission_rating?select=evidence_sentence')).body.includes(N.evidence)
    await ctx.close()
  }
  // The wire is where this mutation must go red, and it does. That is what proves
  // the clean page above is the DATABASE refusing rather than a component
  // choosing: remove the boundary and the same session gets the value.
  check(8, "MUTATION: the primary's nonce now reaches the second rater on the wire", afterWire, true)

  // The page is a NOTE, not a check, and the reason is a finding in its own right.
  //
  // With helper 3 widened the rendered page stays clean, because the second
  // rater's page never asks for the other consultant's write-up at all: it
  // requests its own assignment's submission and nothing else. So the absence on
  // that page is over-determined — the database refuses AND the component does not
  // ask. That is real defence in depth and worth recording, but it also means an
  // assertion of the form "the nonce appears on the rendered page after widening"
  // can never go red, and this spec's own thesis is that a control never seen to
  // fail is not known to be a control. Asserting it would have been a green check
  // proving nothing, which is the exact class the wave-1 and wave-2 reviews kept
  // finding. So it is stated rather than counted.
  console.log(
    `  note  [8] with helper 3 widened the second rater's PAGE is still clean (html nonce: ${afterHtml}).\n` +
      "         The page never requests another consultant's write-up, so its absence is\n" +
      '         over-determined: the database refuses and the component does not ask. The\n' +
      '         database half is the one asserted above, because it is the half that can fail.',
  )

  // ===================================================================
  // Criterion 9: the administrator's assurance pair.
  // ===================================================================
  console.log('\n=== criterion 9: the administrator at aal1 and at aal2')

  const [adm] = await sql(
    `select (pg_get_functiondef('public.is_portal_admin()'::regprocedure) like '%aal2%') as gated,
            (select count(*) from supabase_migrations.schema_migrations where version='20260821120000') as mfa_applied`,
  )
  check(9, 'measured: is_portal_admin() carries an aal2 clause', adm.gated, true)

  {
    const { ctx, page } = await newCtx()
    await signIn(page, 'admin')
    const html = await page.content()
    // CDT-05 owns the "signed in without MFA, therefore seeing nothing" message
    // and the admin surface it sits on. Neither is built: CDT-05 is a wave-3
    // thumbnail. An absence-only check here would pass on a surface that
    // permanently renders the message whatever the helper does, which is the same
    // defect shape as the nonce finding, so this is reported as a gap and not
    // dressed up as a pass.
    const hasMfaMessage = /multi-factor|without MFA|two-factor|second factor/i.test(html)
    if (!hasMfaMessage) {
      gap(9, 'CDT-05\'s admin surface and its no-MFA message do not exist yet',
        'So the aal1 half cannot be asserted through the browser. It IS asserted at the ' +
          'database in cdt06-rls-tests.sql section 3, where an admin at aal1 reads all 8 ' +
          'assignments, 4 write-ups, 44 ratings and every profile. The consequence of the ' +
          'missing message, once a surface exists, is that an administrator sees a silent ' +
          'filter and reads it as an outage.')
    }
    await ctx.close()
  }

  // ===================================================================
  // Criterion 10: two viewports, six screenshots, opened by a person.
  // ===================================================================
  console.log('\n=== criterion 10: two viewports, six screenshots')
  for (const w of [390, 1440]) {
    for (const [name, role, target] of [
      ['queue', 'primary', `${BASE}/portal/assignments`],
      ['assignment', 'primary', `${BASE}/portal/a/${UI.rows.primary}`],
      ['second-rater', 'second', `${BASE}/portal/a/${UI.rows.second}`],
    ]) {
      const { ctx, page } = await newCtx(w, 900)
      await signIn(page, role)
      await page.goto(target, { waitUntil: 'networkidle' })
      await page.waitForTimeout(900)
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth + 1,
      )
      check(10, `${name} at ${w}px has no horizontal body overflow`, overflow, false)
      const unresolved = await page.evaluate(
        () => document.querySelectorAll('[data-reveal]:not([data-reveal="shown"])').length,
      )
      check(10, `${name} at ${w}px has no unresolved reveal`, unresolved, 0)
      await page.screenshot({ path: path.join(SHOTS, `${name}-${w}.png`), fullPage: true })
      await ctx.close()
    }
  }
} finally {
  // D7: the restore runs on success, on failure and on throw alike. A session
  // that dies mid-mutation would otherwise leave the submission read policy
  // widened on a database holding participant write-ups.
  console.log('\n=== D7: unconditional restore')
  try {
    const restore = readFileSync(path.join(REPO, 'scripts/cdt06-rls-restore.sql'), 'utf8')
    await sql(restore)
    const [now] = await sql(
      `select qual from pg_policies where schemaname='public' and tablename='submission' and cmd='SELECT'`,
    )
    check(11, 'the submission read policy is restored and diffs clean against the capture',
      now?.qual, policyCaptured ?? 'may_see_submission(id)')
    const [fn] = await sql(
      `select (pg_get_functiondef('public.is_head_mentor()'::regprocedure) like '%aal2%') as gated,
              (pg_get_functiondef('public.may_see_submission(uuid)'::regprocedure)
                 like '%may_see_subject%') as still_widened`,
    )
    check(11, 'is_head_mentor() still carries its aal2 clause after the run', fn.gated, true)
    check(11, 'helper 3 reaches by author again: the may_see_subject widening is gone',
      fn.still_widened, false)
  } catch (e) {
    console.error(`  RESTORE FAILED: ${e.message}`)
    console.error('  run by hand: node scripts/cdt06-fixtures.mjs --sql scripts/cdt06-rls-restore.sql')
    fail++
  }
  await browser.close()
  server.kill()
}

console.log(`\n${pass} passed, ${fail} failed, ${gaps.length} reported gaps`)
if (violations.length) console.log(`CSP/page violations: ${violations.length}\n  ${violations.join('\n  ')}`)
if (preexisting.length) {
  console.log(`pre-existing React #418 hydration errors (CDT-04 measured these; not this spec's): ${preexisting.length}`)
}
if (gaps.length) {
  console.log('\nGAPS, reported rather than skipped:')
  for (const g of gaps) console.log(`  [criterion ${g.criterion}] ${g.label}\n    ${g.consequence}`)
}
console.log(`screenshots in ${path.relative(REPO, SHOTS)} — a person opens these, per criterion 10`)
process.exit(fail > 0 ? 1 : 0)
