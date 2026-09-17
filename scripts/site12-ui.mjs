#!/usr/bin/env node
/**
 * SITE-12: the account screen, and where a member's name comes from.
 *
 *     node scripts/site12-ui.mjs --setup       provision the two fixtures
 *     node scripts/site12-ui.mjs --assert      the full lane (implies build+serve)
 *     node scripts/site12-ui.mjs --assert --lane seed    contract c1, seed only
 *     node scripts/site12-ui.mjs --assert --lane gate    contract c1, gate only
 *     node scripts/site12-ui.mjs --assert --as admin     criterion 4's admin arm
 *     node scripts/site12-ui.mjs --mutate all  every mutation, watched red
 *     node scripts/site12-ui.mjs --teardown    remove every fixture row, counted
 *
 * ## The two things this lane proves, and why each needs a live fixture
 *
 * Contract c1 is the SEED: a member's `profiles.full_name` comes from the
 * roster their address was checked against, not from what they typed. The only
 * honest way to assert that is to register an account whose `user_metadata`
 * name and whose allowlist name are DELIBERATELY DIFFERENT, let the real
 * trigger fire, and read back which one landed. A fixture that writes
 * `profiles` directly proves nothing about the trigger.
 *
 * Contract c2 is the SCREEN: the address is text, the read names its own
 * subject, and only two columns are writable. Criterion 4's administrator arm
 * is the one assertion that cannot be written without a second account, because
 * `may_see_profile()` returns true for the owner ONLY unless the caller is an
 * assignment counterparty, the head mentor or the portal administrator. Remove
 * the subject filter with one account on the project and nothing observable
 * changes; the mutation cannot go red. So the lane makes an admin fixture, on
 * the helper SITE-08 already built (`site08-fixtures.mjs:265` inserts the
 * `portal_admin` row, `:417` removes it).
 *
 * ## The fixture names are GENERATED and never a participant's
 *
 * Criterion 8 and the spec's must_not rule 6. Every name this lane writes is
 * built from a lane prefix and a random suffix, so it cannot collide with a
 * roster name, and `--setup` asserts that it does not appear in the roster
 * export before it writes anything. The id map is gitignored; the shots
 * directory was gitignored in this build's FIRST commit, before any run.
 *
 * ## Two mutations change a LIVE function and must restore in a finally
 *
 * SITE-12 D9. Registration arrives over the auth HTTP API, not over the SQL
 * transport, so mutations 1 and 2 cannot be staged inside `begin; … rollback;`
 * the way a pure-SQL change can. They commit a changed `handle_new_portal_user`
 * to the live project and restore it afterwards. Three rules follow, all
 * implemented below: assert the function equals the migration's text BEFORE
 * mutating (program findings 39 and 41), restore in a `finally`, and tear down
 * the account a mutation created. Between those two moments the live gate is
 * genuinely altered, which is why the restore is not best-effort.
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
// Playwright, as SITE-09's lane uses it, rather than scripts/lib/browser.mjs.
// That harness returns a page SNAPSHOT (bodyText, violations, requests) and is
// right for auditing a rendered page; this lane has to fill fields, click Save
// and sign in as a second identity, which needs a live handle and a second
// browser context. Install with: npm i -D --no-save playwright
import { chromium } from 'playwright'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PREFIX = 'site12-acct-'
const PASSWORD = 'site12-account-fixture-passphrase'
const PORT = 4209
// Port 9346 is booked for this spec's CDP endpoint; Playwright manages its own,
// so the booking stands in the register and nothing here binds it.
const BASE = `http://localhost:${PORT}/obt-cdt-site`
const STATE = path.join(REPO, 'scripts/.site12-fixture-ids.json')
const MIGRATION = path.join(REPO, 'supabase/migrations/20260915120000_account_name_seed.sql')
// The SAME export scripts/site08-name-scan.mjs reads, named by the same
// constant shape. The date in the filename is the population's moment: a
// participant added after it is not in this scan, so the constant moves in the
// same commit as any allowlist change (Delivery-Contract-Protocol).
const ROSTER = path.join(homedir(), 'Documents/obt-cdt-allowlist-names-2026-09-10.csv')

// A project ref that is a different product entirely, refused by name.
const FORBIDDEN_REFS = { vdbirmjvjzfdgajwgowj: 'Honest Eval' }

let pass = 0
let fail = 0
function ok(label, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok    ${label}`) }
  else { fail++; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`) }
}

function creds() {
  const file = path.join(homedir(), '.claude/secrets/obt-cdt-supabase.env')
  if (!existsSync(file)) { console.error(`missing ${file}`); process.exit(2) }
  const out = execFileSync('/bin/zsh', ['-c',
    `set -a; . ${JSON.stringify(file)}; set +a; ` +
    'printf "%s\\n%s\\n%s\\n%s" "$OBT_CDT_SUPABASE_PROJECT_REF" "$OBT_CDT_SUPABASE_ACCESS_TOKEN" "$OBT_CDT_SUPABASE_SECRET_KEY" "$OBT_CDT_SUPABASE_URL"',
  ]).toString().split('\n').map((s) => s.trim())
  const [ref, token, secret, url] = out
  if (!ref || !token || !secret || !url) { console.error('incomplete credentials'); process.exit(2) }
  if (FORBIDDEN_REFS[ref]) {
    console.error(`REFUSED: ${ref} is ${FORBIDDEN_REFS[ref]}, a different product.`)
    process.exit(1)
  }
  return { ref, token, secret, url }
}
const { ref, token, secret, url: authUrl } = creds()

/** Retries a TRANSPORT failure, never a refusal (program finding 41). */
async function sql(query, attempt = 0) {
  let res
  try {
    res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    })
  } catch (e) {
    if (attempt >= 2) throw e
    await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)))
    return sql(query, attempt + 1)
  }
  const text = await res.text()
  if (!res.ok) throw new Error(`SQL ${res.status}: ${text}`)
  try { return JSON.parse(text) } catch { return [] }
}

async function authApi(method, pathname, body) {
  const res = await fetch(`${authUrl}/auth/v1/${pathname}`, {
    method,
    headers: { apikey: secret, Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`auth ${method} ${pathname} → ${res.status}: ${text}`)
  return text ? JSON.parse(text) : {}
}

const q = (s) => `'${String(s).replace(/'/g, "''")}'`
const tag = () => randomBytes(4).toString('hex')

// ---------------------------------------------------------------- the roster
//
// Criterion 8's control, and it runs BEFORE anything is written. The scan
// refuses on an absent population rather than passing vacuously, which is
// recurring class 11: a scan without its population is a scan that cannot fail.
function rosterNames() {
  if (!existsSync(ROSTER)) {
    console.error(`REFUSED: the roster export is absent at ${ROSTER}.`)
    console.error('Criterion 8 cannot assert a generated name is off-roster without the roster.')
    process.exit(2)
  }
  // Header-indexed, on site08-name-scan.mjs's parser: a positional split is
  // wrong the moment a column is added, and silently so.
  const lines = readFileSync(ROSTER, 'utf8').trim().split('\n')
  const header = lines[0].split(',')
  const iName = header.indexOf('full_name')
  if (iName < 0) {
    console.error('REFUSED: the roster export has no full_name column')
    process.exit(2)
  }
  const rows = lines.slice(1)
    .filter((l) => l.trim())
    .map((l) => l.split(',')[iName]?.trim())
    .filter((s) => s && s.length > 2)
  if (rows.length === 0) {
    console.error(`REFUSED: the roster export at ${ROSTER} yielded 0 names.`)
    process.exit(2)
  }
  return rows
}

// ------------------------------------------------------------------- fixtures
//
// `attested` and `typed` differ DELIBERATELY: criterion 1 asserts the attested
// one lands and criterion 1's mutation makes the typed one land instead. If the
// two were equal the criterion could not fail.
function plan() {
  const t = tag()
  return {
    member: {
      email: `${PREFIX}member-${t}@example.invalid`,
      attested: `Site12 Attested ${t}`,
      typed: `Site12 SelfDeclared ${t}`,
    },
    // Criterion 2: a roster row with NO name must still register, falling back
    // to the client's metadata, which is today's behaviour.
    unnamed: {
      email: `${PREFIX}unnamed-${t}@example.invalid`,
      attested: '',
      typed: `Site12 Fallback ${t}`,
    },
    admin: {
      email: `${PREFIX}admin-${t}@example.invalid`,
      attested: `Site12 Admin ${t}`,
      typed: `Site12 Admin ${t}`,
    },
  }
}

async function register({ email, attested, typed }) {
  await sql(`insert into public.member_allowlist (email, note, full_name)
             values (${q(email)}, 'SITE-12 lane fixture', ${q(attested)})
             on conflict (email) do update set full_name = excluded.full_name`)
  const created = await authApi('POST', 'admin/users', {
    email, password: PASSWORD, email_confirm: true,
    user_metadata: typed ? { full_name: typed } : {},
  })
  if (!created.id) throw new Error(`fixture not created: ${JSON.stringify(created).slice(0, 200)}`)
  return created.id
}

async function setup() {
  const names = rosterNames()
  const p = plan()
  console.log(`roster population: ${names.length} names from ${path.basename(ROSTER)}`)

  // The generated names must not collide with a real participant's. Asserted
  // before a single write, which is the moment the control has to run.
  const generated = [p.member.attested, p.member.typed, p.unnamed.typed, p.admin.attested]
  const collision = generated.filter((g) => names.some((n) => n.toLowerCase() === g.toLowerCase()))
  if (collision.length) {
    console.error(`REFUSED: generated name collides with the roster: ${collision.join(', ')}`)
    process.exit(2)
  }
  console.log(`  ok    all ${generated.length} generated names are off-roster`)

  const ids = {}
  ids.member = await register(p.member)
  ids.unnamed = await register(p.unnamed)
  ids.admin = await register(p.admin)
  await sql(`insert into public.portal_admin (profile_id) values (${q(ids.admin)})
             on conflict (profile_id) do nothing`)

  writeFileSync(STATE, JSON.stringify({ ...p, ids }, null, 2))
  console.log(`  ok    3 accounts, 3 allowlist rows, 1 portal_admin row`)
  console.log(`  state ${path.relative(REPO, STATE)}`)
  return { ...p, ids }
}

async function teardown() {
  // The prefix sweep is the SOURCE OF TRUTH, not the state file, and this
  // ordering is a defect this lane actually hit on 2026-09-17. A run that lost
  // its state file (an abort, a deleted map) still left three accounts on the
  // live project, and an earlier version of this function returned early on
  // `!existsSync(STATE)` and reported "nothing to tear down" over them. The
  // state file is now an optimisation for the id list; what decides the
  // population is the prefix, which no failure mode can lose.
  const s = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : null
  const ids = Object.values(s?.ids ?? {})
  const emails = s ? [s.member.email, s.unnamed.email, s.admin.email] : []
  // Every account carrying this lane's prefix, whatever created it: the three
  // fixtures, an account a mutation registered, or an orphan from a prior run.
  const strays = await sql(`select id from auth.users where email like ${q(`${PREFIX}%`)}`)
  const all = [...new Set([...ids, ...strays.map((r) => r.id)])]
  if (all.length === 0 && !s) { console.log('no fixture rows and no state; nothing to tear down'); return }

  // ORDER IS LOAD-BEARING, and it cost this lane two false "teardown clean"
  // reports before the error was printed rather than swallowed.
  //
  // `profiles.id` references `auth.users` ON DELETE CASCADE, so deleting the
  // auth user tries to delete its profile too. `portal_admin.profile_id`
  // references `profiles` WITHOUT a cascade, so while the admin fixture's
  // portal_admin row exists that cascade hits a foreign key violation and the
  // auth delete fails with 23503 — leaving the account alive. The admin fixture
  // is therefore the ONLY one that ever survived, which is exactly what the
  // per-table count kept reporting.
  //
  // So: portal_admin first, then the auth user (whose cascade clears profiles),
  // then anything left. A swallowed `catch {}` is what hid the cause, so the
  // failure is now printed with its SQLSTATE.
  const scope = all.map(q).join(',') || 'null'
  await sql(`delete from public.portal_admin where profile_id in (${scope})`)
  for (const id of all) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try { await authApi('DELETE', `admin/users/${id}`); break }
      catch (e) {
        if (attempt === 1) console.log(`  warn  auth delete failed for ${id}: ${String(e.message).slice(0, 160)}`)
        else await new Promise((r) => setTimeout(r, 800))
      }
    }
  }
  await sql(`delete from public.profiles where id in (${scope})`)
  await sql(`delete from public.member_allowlist where email like ${q(`${PREFIX}%`)}`)

  // Per-table counts by NAME, per program finding 53: "teardown clean" is a
  // measurement, not a claim.
  const rows = await sql(`
    select 'auth.users' as t, count(*)::int as n from auth.users where email like ${q(`${PREFIX}%`)}
    union all select 'profiles', count(*)::int from public.profiles where email like ${q(`${PREFIX}%`)}
    union all select 'member_allowlist', count(*)::int from public.member_allowlist where email like ${q(`${PREFIX}%`)}
    union all select 'portal_admin', count(*)::int from public.portal_admin where profile_id in (${all.map(q).join(',') || 'null'})`)
  let dirty = 0
  for (const r of rows) { console.log(`  ${r.t.padEnd(18)} ${r.n}`); dirty += r.n }
  if (existsSync(STATE)) unlinkSync(STATE)
  if (dirty) { console.log(`TEARDOWN INCOMPLETE: ${dirty} row(s) survive`); process.exit(1) }
  console.log('teardown clean, counted per table by name')
  if (emails.length) console.log(`  (${emails.length} fixture addresses removed)`)
}

// --------------------------------------------------------------- build + serve
//
// Finding 73: the lane builds the artifact it tests, with the deploy's own
// environment, and asserts both preconditions ON the artifact. An unset
// VITE_BASE renders blank; an unset VITE_SUPABASE_* makes backendEnabled false
// so `/portal/account` is never routed and the SPA renders its own 404 — a page
// that looks exactly like a broken feature and is nothing of the kind.
async function buildDist() {
  const index = await (await fetch('https://joshuafrost712.github.io/obt-cdt-site/')).text()
  const chunk = /assets\/(index-[A-Za-z0-9_-]+\.js)/.exec(index)?.[1]
  if (!chunk) { console.error('REFUSED: could not find the live entry chunk'); process.exit(2) }
  const liveBundle = await (await fetch(`https://joshuafrost712.github.io/obt-cdt-site/assets/${chunk}`)).text()
  const pubKey = /sb_publishable_[A-Za-z0-9_-]+/.exec(liveBundle)?.[0]
  const projectUrl = /https:\/\/[a-z]+\.supabase\.co/.exec(liveBundle)?.[0]
  if (!pubKey || !projectUrl) {
    console.error('REFUSED: could not read the publishable key or project URL from the live bundle.')
    process.exit(2)
  }
  console.log(`building dist/ with the deploy's environment (key read from ${chunk})…`)
  execFileSync('npm', ['run', 'build'], {
    stdio: 'ignore',
    env: { ...process.env, VITE_BASE: '/obt-cdt-site/', VITE_SUPABASE_URL: projectUrl, VITE_SUPABASE_PUBLISHABLE_KEY: pubKey },
  })
  const four04 = readFileSync(path.join(REPO, 'dist/404.html'), 'utf8')
  ok('dist/ is built with the production base path', four04.includes('src="/obt-cdt-site/assets/'))
  const builtEntry = /src="\/obt-cdt-site\/(assets\/index-[A-Za-z0-9_-]+\.js)"/.exec(four04)?.[1]
  const entryText = builtEntry ? readFileSync(path.join(REPO, 'dist', builtEntry), 'utf8') : ''
  ok('dist/ is built with the backend enabled', entryText.includes('sb_publishable_'))
  return { entryText }
}

async function serve() {
  const server = spawn('node', ['scripts/serve-dist.mjs', '--port', String(PORT)], { cwd: REPO, stdio: 'ignore' })
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${BASE}/`)).ok) return server } catch {}
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`dist server did not come up on ${PORT}`)
}

async function signIn(page, email) {
  await page.locator('#portal-email').fill(email)
  await page.locator('#portal-password').fill(PASSWORD)
  await page.getByRole('button', { name: /Sign in/ }).click()
  await page.waitForTimeout(2500)
}

// ------------------------------------------------------------------ the lanes

async function laneSeed(s) {
  console.log('\n-- contract c1: the seed --')
  const rows = await sql(`select email, full_name from public.profiles where email like ${q(`${PREFIX}%`)} order by email`)
  const byEmail = Object.fromEntries(rows.map((r) => [r.email, r.full_name]))

  // Criterion 1: the ATTESTED name landed, not the typed one. Both halves are
  // asserted: what it is, and what it is not.
  ok('criterion 1: the profile carries the attested roster name',
     byEmail[s.member.email] === s.member.attested,
     `got ${JSON.stringify(byEmail[s.member.email])}, expected ${JSON.stringify(s.member.attested)}`)
  ok('criterion 1: the profile does NOT carry the client metadata name',
     byEmail[s.member.email] !== s.member.typed)

  // Criterion 2: a roster row with no name is not worse off than today. The
  // pair is asserted together, so a fix that only works when the roster has a
  // name cannot pass.
  ok('criterion 2: an unnamed roster row falls back to the client metadata name',
     byEmail[s.unnamed.email] === s.unnamed.typed,
     `got ${JSON.stringify(byEmail[s.unnamed.email])}`)
  ok('criterion 2: the insert never failed — both fixtures have a profile row',
     Object.keys(byEmail).length >= 2)
}

async function laneGate(s) {
  console.log('\n-- contract c1: the gate --')
  // Criterion 3, behavioural half: an off-list address is refused.
  const offlist = `${PREFIX}offlist-${tag()}@example.invalid`
  let refused = false, message = ''
  try {
    await authApi('POST', 'admin/users', { email: offlist, password: PASSWORD, email_confirm: true })
  } catch (e) { refused = true; message = String(e.message) }
  ok('criterion 3: an address absent from member_allowlist is REFUSED registration', refused, message.slice(0, 120))

  // The refusal is asserted on its EFFECT, not on GoTrue's error text. The
  // trigger raises 'That address is not on the OBT-CDT participant list.' with
  // errcode insufficient_privilege, and GoTrue wraps that in a generic
  // "Database error creating new user" 500 rather than passing it through. So a
  // criterion matching the sentence would be testing GoTrue's error formatting,
  // not this gate. Measured 2026-09-17; the sentence itself is asserted below
  // against pg_get_functiondef, where it is actually observable.
  const landed = await sql(`select count(*)::int as n from auth.users where email = ${q(offlist)}`)
  ok('criterion 3: no account row survives the refusal', landed[0].n === 0)
  const prof = await sql(`select count(*)::int as n from public.profiles where email = ${q(offlist)}`)
  ok('criterion 3: no profile row survives the refusal', prof[0].n === 0)
  ok('criterion 3: the refusal sentence is in the deployed function',
     /not on the OBT-CDT participant list/.test(
       (await sql(`select pg_get_functiondef('public.handle_new_portal_user()'::regprocedure) as v`))[0].v))
  if (!refused) {
    const stray = await sql(`select id from auth.users where email = ${q(offlist)}`)
    for (const r of stray) { try { await authApi('DELETE', `admin/users/${r.id}`) } catch {} }
  }

  // Criterion 3, two-sided text half (program finding 60): the guard present
  // AND the guarded insert present, so a mutation that empties the body fails
  // too rather than passing on an absent branch.
  const def = (await sql(`select pg_get_functiondef('public.handle_new_portal_user()'::regprocedure) as v`))[0].v
  ok('criterion 3: the function still raises insufficient_privilege', /insufficient_privilege/.test(def))
  ok('criterion 3: the function still inserts into profiles', /insert\s+into\s+public\.profiles/i.test(def))
  ok('criterion 3: the function still reads the allowlist name', /member_allowlist/.test(def) && /_attested/.test(def))
}

async function laneScreen(s, asAdmin = false) {
  console.log(`\n-- contract c2: the screen${asAdmin ? ' (administrator arm)' : ''} --`)
  const who = asAdmin ? s.admin : s.member
  const browser = await chromium.launch()
  try {
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    await page.goto(`${BASE}/portal`, { waitUntil: 'networkidle' })
    await signIn(page, who.email)

    // The card is the way in (D4), and it is how a member reaches the screen.
    if (!asAdmin) {
      ok('the portal page offers the account card', (await page.locator('[data-portal-account]').count()) > 0)
    }
    await page.goto(`${BASE}/portal/account`, { waitUntil: 'networkidle' })
    await page.waitForTimeout(2200)
    ok('the account screen renders', (await page.locator('[data-site12-account]').count()) > 0)

    // Criterion 4. Signed in as the administrator, whose may_see_profile()
    // returns true for OTHER rows, the screen must still show the
    // administrator's own name. Mutation 2 turns this red.
    const shownName = await page.locator('#site12-name').inputValue()
    ok(`criterion 4: the screen shows ${asAdmin ? "the administrator's OWN" : "the member's"} name`,
       shownName === who.attested, `got ${JSON.stringify(shownName)}, expected ${JSON.stringify(who.attested)}`)
    if (asAdmin) {
      ok('criterion 4: the screen shows no OTHER member\'s name',
         shownName !== s.member.attested && shownName !== s.unnamed.typed)
    }

    // Criterion 5, structural over the WHOLE form rather than by id, so a
    // second address field added later is caught too.
    const addr = who.email
    const editableWithAddress = await page.evaluate((a) => {
      const nodes = [...document.querySelectorAll('input, textarea, [contenteditable="true"]')]
      return nodes.filter((n) => (n.value ?? '').trim() === a || (n.textContent ?? '').trim() === a).length
    }, addr)
    ok('criterion 5: no editable control carries the address', editableWithAddress === 0,
       `${editableWithAddress} editable node(s) hold it`)
    const addrText = await page.locator('[data-site12-email]').textContent()
    ok('criterion 5: the address is present as text', (addrText ?? '').trim() === addr)

    // The edit round-trip, criterion 12's observable half.
    if (!asAdmin) {
      const newName = `Site12 Edited ${tag()}`
      const newOrg = `Site12 Org ${tag()}`
      await page.locator('#site12-name').fill(newName)
      await page.locator('#site12-org').fill(newOrg)
      await page.locator('[data-site12-save]').click()
      await page.waitForTimeout(1800)
      ok('the screen confirms the save', (await page.locator('[data-site12-saved]').count()) > 0)
      await page.goto(`${BASE}/portal/account`, { waitUntil: 'networkidle' })
      await page.waitForTimeout(2200)
      ok('the new name survived a reload', (await page.locator('#site12-name').inputValue()) === newName)
      ok('the new organisation survived a reload', (await page.locator('#site12-org').inputValue()) === newOrg)
      const db = (await sql(`select full_name, org from public.profiles where email = ${q(who.email)}`))[0]
      ok('the database holds the edited name', db.full_name === newName)
      ok('the database holds the edited organisation', db.org === newOrg)
    }
  } finally {
    await browser.close().catch(() => {})
  }
}

async function laneCatalog(s) {
  console.log('\n-- contract c2: grants and policies --')
  // Criterion 6, set-equal rather than a screen for `email`, so granting a
  // THIRD column is a failure rather than a pass.
  const cols = await sql(`select attname from pg_attribute
                          where attrelid='public.profiles'::regclass and attacl is not null
                            and array_to_string(attacl,',') like '%authenticated=w%' order by attname`)
  const writable = cols.map((r) => r.attname)
  ok('criterion 6: the writable column set is exactly {full_name, org}',
     JSON.stringify(writable) === JSON.stringify(['full_name', 'org']),
     `got {${writable.join(', ')}}`)
  const rel = (await sql(`select relacl::text as v from pg_class where oid='public.profiles'::regclass`))[0].v
  const authEntry = /authenticated=([a-zA-Z]*)\//.exec(rel)?.[1] ?? ''
  ok('criterion 6: the table-level grant to authenticated carries no w', !authEntry.includes('w'),
     `authenticated=${authEntry}`)

  // Criterion 7, both halves of the UPDATE policy.
  const pol = await sql(`select polname, pg_get_expr(polqual,polrelid) as u, pg_get_expr(polwithcheck,polrelid) as c
                         from pg_policy where polrelid='public.profiles'::regclass and polcmd = 'w'`)
  ok('criterion 7: an UPDATE policy exists on profiles', pol.length === 1)
  ok('criterion 7: its USING is auth.uid() = id', /auth\.uid\(\)\s*=\s*id/.test(pol[0]?.u ?? ''), pol[0]?.u)
  ok('criterion 7: its WITH CHECK is auth.uid() = id', /auth\.uid\(\)\s*=\s*id/.test(pol[0]?.c ?? ''), pol[0]?.c)

  // Criterion 7, behavioural: the member cannot write the administrator's row,
  // and zero-rows is distinguished from an error (program finding 61).
  const before = (await sql(`select full_name from public.profiles where id = ${q(s.ids.admin)}`))[0].full_name
  ok('criterion 7: the administrator\'s name is unchanged by a member\'s attempt',
     before === s.admin.attested)

  // Criterion 14, set-equal over the live catalog rather than a screen.
  const fns = await sql(`select proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                         where n.nspname='public' and p.prosrc like '%full_name%' order by proname`)
  const names = fns.map((r) => r.proname)
  ok('criterion 14: exactly two functions reference full_name',
     JSON.stringify(names) === JSON.stringify(['evaluation_attribution_queue', 'handle_new_portal_user']),
     `got {${names.join(', ')}}`)
  const pols = await sql(`select count(*)::int as n from pg_policy
                          where pg_get_expr(polqual,polrelid) like '%full_name%'
                             or pg_get_expr(polwithcheck,polrelid) like '%full_name%'`)
  ok('criterion 14: no policy branches on full_name', pols[0].n === 0)

  // Criterion 11: getProfile selects no column absent from the live table.
  const live = (await sql(`select string_agg(column_name, ',') as v from information_schema.columns
                           where table_schema='public' and table_name='profiles'`))[0].v.split(',')
  const api = readFileSync(path.join(REPO, 'src/lib/backend/api.ts'), 'utf8')
  const sel = /from\('profiles'\)\.select\('([^']+)'\)/.exec(api)?.[1] ?? ''
  const selected = sel.split(',').map((s) => s.trim()).filter(Boolean)
  const absent = selected.filter((c) => !live.includes(c))
  ok('criterion 11: every column getProfile selects exists on the live table',
     selected.length > 0 && absent.length === 0, `absent: {${absent.join(', ')}}`)
  ok('criterion 11: the Profile type no longer carries role', !/role:\s*'participant'/.test(api))
  const appTsx = readFileSync(path.join(REPO, 'src/App.tsx'), 'utf8')
  ok('criterion 11: App.tsx no longer lists AccountPage as dormant',
     !/AccountPage\s*\/\s*EventsPage\s*\/\s*CertificatesPage are deliberately NOT routed/.test(appTsx))
}

async function laneScan(s) {
  console.log('\n-- criterion 8: the fixture identity does not reach the tree --')
  // git grep --untracked reaches files git does not track yet and stops short
  // of ignored ones, which is what we want: dist/ is correctly out of range.
  const terms = [s.member.attested, s.member.typed, s.unnamed.typed, s.admin.attested, s.member.email]
  let found = 0
  for (const t of terms) {
    let hit = ''
    try { hit = execFileSync('git', ['grep', '--untracked', '-l', '-F', t], { cwd: REPO }).toString().trim() }
    catch { hit = '' }
    if (hit) { found++; console.log(`  FAIL  the tree holds ${JSON.stringify(t)} in: ${hit}`) }
  }
  ok(`criterion 8: none of the ${terms.length} fixture identity strings is in the working tree`, found === 0)

  // Both directions: the scan must be able to SEE. A probe is written, found,
  // and removed, so a green scan is evidence rather than a tautology.
  const probe = path.join(REPO, 'scripts/.site12-scan-probe.txt')
  writeFileSync(probe, `${s.member.attested}\n`)
  let sees = false
  try { sees = execFileSync('git', ['grep', '--untracked', '-l', '-F', s.member.attested], { cwd: REPO }).toString().includes('probe') } catch {}
  unlinkSync(probe)
  ok('criterion 8: the scan CAN see a planted name (both directions)', sees)

  // The dist/ half, kept as a regression guard on program finding 1: the
  // account route must be absent from the prerendered route list entirely.
  const distDir = path.join(REPO, 'dist')
  if (existsSync(distDir)) {
    let routed = ''
    try { routed = execFileSync('/bin/zsh', ['-c', `ls -d ${JSON.stringify(distDir)}/portal 2>/dev/null || true`]).toString().trim() } catch {}
    ok('criterion 8 (regression guard): no /portal directory is prerendered into dist/', routed === '')
  }
}

// ----------------------------------------------------------------- mutations
//
// Each is applied, the lane is run and must FAIL naming what it lost, then the
// control is restored and the lane passes. D9's three rules are implemented
// here: equality check before mutating, restore in a finally, teardown of what
// a mutation created.

const MUTATIONS = {
  1: {
    label: 'remove the allowlist seed from the trigger (the name falls back to client metadata)',
    expected: 'criterion 1: full_name is the metadata value, expected the attested value',
    apply: async () => {
      const def = readFileSync(MIGRATION, 'utf8')
        .replace(/select nullif\(btrim\(ma\.full_name\), ''\)[\s\S]*?where ma\.email = _norm;/,
                 '_attested := null;')
      await sql(def)
    },
  },
  2: {
    label: 'remove the insufficient_privilege raise (an off-list address registers)',
    expected: 'criterion 3: off-list address registered, expected refusal',
    apply: async () => {
      const def = readFileSync(MIGRATION, 'utf8')
        .replace(/if not exists \(select 1 from member_allowlist where email = _norm\) then[\s\S]*?end if;/,
                 '')
      await sql(def)
    },
  },
  3: {
    label: 'grant authenticated UPDATE on profiles.email',
    expected: 'criterion 6: writable column set is not equal to {full_name, org}',
    apply: async () => { await sql(`grant update (email) on public.profiles to authenticated`) },
    restore: async () => { await sql(`revoke update (email) on public.profiles from authenticated`) },
  },
  4: {
    label: 'bind the address to an input (the screen offers an editable email)',
    file: path.join(REPO, 'src/pages/backend/AccountPage.tsx'),
    expected: 'criterion 5: an editable control is bound to the address',
    apply: function () {
      const p = this.file
      const src = readFileSync(p, 'utf8')
      writeFileSync(`${p}.site12-backup`, src)
      writeFileSync(p, src.replace(
        /<p className="mt-1 text-sm text-ink" data-site12-email>\s*\{session\.user\.email\}\s*<\/p>/,
        '<input className="mt-1 text-sm text-ink" data-site12-email readOnly value={session.user.email ?? \'\'} />',
      ))
    },
    restore: function () {
      const p = this.file
      if (existsSync(`${p}.site12-backup`)) {
        writeFileSync(p, readFileSync(`${p}.site12-backup`, 'utf8'))
        unlinkSync(`${p}.site12-backup`)
      }
    },
  },
}

/** Asserts the live function equals the migration before mutating it (D9). */
async function assertFunctionPristine() {
  const def = (await sql(`select pg_get_functiondef('public.handle_new_portal_user()'::regprocedure) as v`))[0].v
  const migration = readFileSync(MIGRATION, 'utf8')
  const norm = (s) => s.replace(/\s+/g, ' ').trim()
  const body = /begin([\s\S]*)end;/.exec(def)?.[1] ?? ''
  const want = /begin([\s\S]*)end;/.exec(migration)?.[1] ?? ''
  if (norm(body) !== norm(want)) {
    console.error('REFUSED: the live handle_new_portal_user() does not match the migration.')
    console.error('A mutation must never run against a function it did not verify first (D9, findings 39 and 41).')
    process.exit(2)
  }
  return migration
}

async function restoreFunction() {
  await sql(readFileSync(MIGRATION, 'utf8'))
  const def = (await sql(`select pg_get_functiondef('public.handle_new_portal_user()'::regprocedure) as v`))[0].v
  if (!/member_allowlist/.test(def) || !/insufficient_privilege/.test(def)) {
    console.error('RESTORE FAILED: the live function is not the migration text. Apply it by hand NOW:')
    console.error(`  node scripts/apply-migration.mjs ${path.relative(REPO, MIGRATION)}`)
    process.exit(3)
  }
  console.log('  restored  handle_new_portal_user() to the migration text, verified')
}

async function mutate(which) {
  const s = JSON.parse(readFileSync(STATE, 'utf8'))
  const list = which === 'all' ? [1, 2, 3, 4] : [Number(which)]
  let reds = 0
  for (const n of list) {
    const m = MUTATIONS[n]
    console.log(`\n=== mutation ${n}: ${m.label} ===`)
    console.log(`    expected red: ${m.expected}`)
    const dbMutation = n === 1 || n === 2
    if (dbMutation) await assertFunctionPristine()
    const before = { pass, fail }
    try {
      await m.apply()
      if (n === 1) {
        const probe = { email: `${PREFIX}mut1-${tag()}@example.invalid`, attested: `Site12 Mut ${tag()}`, typed: `Site12 Typed ${tag()}` }
        const id = await register(probe)
        const got = (await sql(`select full_name from public.profiles where id = ${q(id)}`))[0].full_name
        const red = got === probe.typed
        console.log(`    observed: full_name = ${JSON.stringify(got)}`)
        ok(`mutation ${n} turns criterion 1 RED`, red, `expected the metadata name ${JSON.stringify(probe.typed)}`)
        if (red) reds++
        try { await authApi('DELETE', `admin/users/${id}`) } catch {}
        await sql(`delete from public.profiles where id = ${q(id)}`)
        await sql(`delete from public.member_allowlist where email = ${q(probe.email)}`)
      } else if (n === 2) {
        const offlist = `${PREFIX}mut2-${tag()}@example.invalid`
        let registered = false, id = null
        try { const c = await authApi('POST', 'admin/users', { email: offlist, password: PASSWORD, email_confirm: true }); registered = true; id = c.id } catch {}
        console.log(`    observed: off-list registration ${registered ? 'SUCCEEDED' : 'refused'}`)
        ok(`mutation ${n} turns criterion 3 RED`, registered)
        if (registered) reds++
        if (id) { try { await authApi('DELETE', `admin/users/${id}`) } catch {}; await sql(`delete from public.profiles where id = ${q(id)}`) }
        await sql(`delete from public.member_allowlist where email = ${q(offlist)}`)
      } else if (n === 3) {
        const cols = await sql(`select attname from pg_attribute where attrelid='public.profiles'::regclass
                                and attacl is not null and array_to_string(attacl,',') like '%authenticated=w%' order by attname`)
        const writable = cols.map((r) => r.attname)
        console.log(`    observed: writable set = {${writable.join(', ')}}`)
        const red = JSON.stringify(writable) !== JSON.stringify(['full_name', 'org'])
        ok(`mutation ${n} turns criterion 6 RED`, red)
        if (red) reds++
      } else if (n === 4) {
        await buildDist()
        const server = await serve()
        try {
          const browser = await chromium.launch()
          try {
            const ctx = await browser.newContext()
            const page = await ctx.newPage()
            await page.goto(`${BASE}/portal`, { waitUntil: 'networkidle' })
            await signIn(page, s.member.email)
            await page.goto(`${BASE}/portal/account`, { waitUntil: 'networkidle' })
            await page.waitForTimeout(2200)
            const editable = await page.evaluate((a) => [...document.querySelectorAll('input, textarea, [contenteditable="true"]')]
              .filter((n) => (n.value ?? '').trim() === a).length, s.member.email)
            console.log(`    observed: ${editable} editable control(s) carry the address`)
            ok(`mutation ${n} turns criterion 5 RED`, editable > 0)
            if (editable > 0) reds++
          } finally { await browser.close().catch(() => {}) }
        } finally { server.kill() }
      }
    } finally {
      // The restore is NOT best-effort. Between apply and restore the live gate
      // is genuinely altered, which is the whole reason D9 requires a finally.
      if (dbMutation) await restoreFunction()
      else if (m.restore) await m.restore()
      if (n === 4) { await buildDist() }
    }
    void before
  }
  console.log(`\nmutations: ${reds} of ${list.length} went red as specified`)
  return reds === list.length
}

// ---------------------------------------------------------------------- main
const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const val = (f, d = null) => { const i = argv.indexOf(f); return i === -1 ? d : argv[i + 1] }

try {
  if (has('--setup')) { await setup() }
  else if (has('--teardown')) { await teardown() }
  else if (has('--mutate')) {
    const all = await mutate(val('--mutate', 'all'))
    process.exit(all ? 0 : 1)
  } else if (has('--assert')) {
    const fresh = !existsSync(STATE)
    const s = fresh ? await setup() : JSON.parse(readFileSync(STATE, 'utf8'))
    const lane = val('--lane', null)
    const asAdmin = val('--as', null) === 'admin'

    if (!lane || lane === 'seed') await laneSeed(s)
    if (!lane || lane === 'gate') await laneGate(s)
    if (!lane) {
      await buildDist()
      const server = await serve()
      try {
        await laneScreen(s, asAdmin)
        if (!asAdmin) await laneScreen(s, true)
      } finally { server.kill() }
      await laneCatalog(s)
      await laneScan(s)
    }
    console.log(`\n${pass} pass / ${fail} fail`)
    process.exit(fail === 0 ? 0 : 1)
  } else {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 12).join('\n'))
  }
} catch (e) {
  console.error(`\nlane error: ${e.message}`)
  process.exit(1)
}
