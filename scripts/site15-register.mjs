/**
 * SITE-15 contract: a person creating a portal account types the password twice,
 * and a mismatch is caught in the browser before any account is created.
 *
 *   npm i -D --no-save playwright && npx playwright install chromium
 *   node scripts/site15-register.mjs --assert
 *
 * The lane builds `dist/` itself with the deploy's environment, so it does not
 * trust whatever happens to be on disk.
 *
 * ## The defect this proves is fixed
 *
 * Measured 2026-09-17 from a participant's feedback: `SignInCard`'s register mode
 * had ONE password box. A typo became the account's real password, and the next
 * sign-in failed with nobody able to say why. Program finding 65 is the same
 * shape one layer down.
 *
 * ## What this lane refuses to claim
 *
 * The confirm field is a usability control against a typo. It is NOT a security
 * control, and neither ASVS 5.0.0 nor NIST SP 800-63B asks for one: a regex over
 * all 345 ASVS requirements returns 0 hits for a repeated password field and 0
 * for a strength meter. The mandatory weight in both sources is on a blocklist
 * check, which is a separate and recorded decision (criterion 13).
 *
 * ## Criteria asserted here
 *
 *   1  a mismatch is caught before any `/auth/v1/signup` request, two-sided
 *   2  the confirm field is in register mode only
 *   3  the hint's floor comes from the constant, in three places
 *   4  no character-class rule, read back over SQL and not from the form
 *   6  paste is not blocked (real keyboard input, never a synthetic event)
 *   7  the shell in this state, compared to a live sibling and not to an integer
 *   8  no strength score, asserted by set-equality over the form's text
 *  12  no third-party origin across the whole register flow
 *  13  the V6.2.4 record exists in docs/SECURITY.md
 *
 * Criteria 5, 9 and 11 belong to other lanes: `site09-auth-checks.mjs`,
 * `site12-ui.mjs` and `site15-confirm-live.mjs` respectively.
 *
 * ## Mutations (all recorded in the contract)
 *
 *   1. Remove the mismatch guard in `SignInCard`'s submit → a signup request
 *      reaches the network with mismatched passwords.
 *   2. Replace the hint's `PASSWORD_MIN_LENGTH` with the literal 12 → criterion 3.
 *   3. Insert a span reading "Strong" into the register form → criterion 8.
 *   4. Delete the V6.2.4 paragraph from docs/SECURITY.md → criterion 13.
 *
 * ## Why a real account is created
 *
 * Criterion 4 has to read `auth.users` over SQL, because the register form
 * answers identically on success and on an off-list refusal by design
 * (docs/SECURITY.md) — so a browser-side assertion would pass on a refusal. That
 * means one real unconfirmed row and one real Brevo email per run, against a live
 * rate limit of 30/hour. Do not run this in a loop. Teardown counts the rows back
 * to zero and proves it before returning.
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright'

const ASSERT = process.argv.includes('--assert')
if (!ASSERT) {
  console.error('usage: node scripts/site15-register.mjs --assert')
  process.exit(2)
}

// 4191 is on `uri_allow_list`, which has no wildcard, so the lane cannot invent
// a port. Held exclusively while running, as the other lanes on it do.
const PORT = 4191
const BASE = `http://localhost:${PORT}/obt-cdt-site`
const PREFIX = 'site15-reg-'
const SHOTS = 'feedback/site15-shots'

// Twelve characters, all lowercase, no digit or symbol: criterion 4's whole
// point. If any composition rule were in force, this account would not be
// created and the SQL read below would return 0.
const LOWER_PASSWORD = 'abcdefghijkl'

let pass = 0
let fail = 0
const ok = (name, cond, detail = '') => {
  if (cond) {
    pass++
    console.log(`  ok    ${name}${detail ? `  ${detail}` : ''}`)
  } else {
    fail++
    console.log(`  FAIL  ${name}${detail ? `  ${detail}` : ''}`)
  }
}

function creds() {
  const file = path.join(homedir(), '.claude/secrets/obt-cdt-supabase.env')
  if (!existsSync(file)) {
    console.error(`missing ${file}`)
    process.exit(2)
  }
  const out = execFileSync('/bin/zsh', [
    '-c',
    `set -a; . ${JSON.stringify(file)}; set +a; ` +
      'printf "%s\\n%s\\n%s\\n%s" "$OBT_CDT_SUPABASE_PROJECT_REF" "$OBT_CDT_SUPABASE_ACCESS_TOKEN" ' +
      '"$OBT_CDT_SUPABASE_SECRET_KEY" "$OBT_CDT_SUPABASE_URL"',
  ])
    .toString()
    .split('\n')
    .map((s) => s.trim())
  const [ref, token, secret, url] = out
  if (!ref || !token || !secret || !url) {
    console.error(`incomplete credentials in ${file}`)
    process.exit(2)
  }
  return { ref, token, secret, url }
}

const { ref, token, secret, url } = creds()

// ------------------------------------------------------------ roster guard
// Finding 68's two-part guard: the lane's own address prefix AND absence from
// the dated roster export, REFUSING when that export is absent. The same file
// `site08-name-scan.mjs` reads, so a lane cannot pass by checking a staler copy
// than the scan does.
function rosterGuard(addr) {
  const roster = execFileSync('/bin/zsh', [
    '-c',
    `ls ${JSON.stringify(homedir())}/Documents/obt-cdt-allowlist-names-*.csv 2>/dev/null | tail -1`,
  ])
    .toString()
    .trim()
  if (!roster) {
    console.error('REFUSED: no roster export found; cannot prove this address is not a participant.')
    console.error('Expected ~/Documents/obt-cdt-allowlist-names-<date>.csv')
    process.exit(2)
  }
  const text = readFileSync(roster, 'utf8').toLowerCase()
  if (text.includes(addr.toLowerCase())) {
    console.error(`REFUSED: ${addr} appears in the roster export.`)
    process.exit(1)
  }
  if (!addr.startsWith(PREFIX) || !addr.endsWith('@example.org')) {
    console.error(`REFUSED: ${addr} is not a lane fixture address.`)
    process.exit(1)
  }
  return path.basename(roster)
}

const sql = async (query) => {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  })
  if (!res.ok) throw new Error(`sql ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return res.json()
}

const admin = async (route, init = {}) =>
  fetch(`${url}/auth/v1/${route}`, {
    ...init,
    headers: {
      apikey: secret,
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  })

// --------------------------------------------------------------- fixtures
// Two addresses. MISMATCH_ADDR is used for the criterion-1 attempt that must
// never reach the network, so if the guard were broken it would create a row and
// the assertion below would see it. LOWER_ADDR is criterion 4's real account.
const stamp = Date.now()
const MISMATCH_ADDR = `${PREFIX}mismatch-${stamp}@example.org`
const LOWER_ADDR = `${PREFIX}lower-${stamp}@example.org`
const rosterName = rosterGuard(MISMATCH_ADDR)
rosterGuard(LOWER_ADDR)
console.log(`fixtures  = ${PREFIX}{mismatch,lower}-<ts>@example.org`)
console.log(`roster    = ${rosterName} (checked, both addresses absent)`)

let server = null
let browser = null

/**
 * Remove every row this run created, and PROVE it before returning.
 *
 * SITE-09's leaked-fixture finding: a teardown that swallows its deletes and
 * returns immediately leaves live rows on the PRODUCTION project, and the count
 * assertions then run against whatever state happens to exist. So each delete is
 * retried, and the counts are polled until they are actually zero. The cascade
 * from `auth.users` to `profiles` is not instantaneous, which is the other half
 * of why a single immediate count is not proof.
 */
async function teardown() {
  try {
    if (browser) await browser.close()
  } catch {}
  try {
    if (server) server.kill()
  } catch {}

  const addrs = [MISMATCH_ADDR, LOWER_ADDR]
  for (let attempt = 0; attempt < 5; attempt++) {
    for (const addr of addrs) {
      try {
        const rows = await sql(`select id from auth.users where email = '${addr}'`)
        for (const r of rows) await admin(`admin/users/${r.id}`, { method: 'DELETE' })
      } catch {}
      try {
        await sql(`delete from public.member_allowlist where email = '${addr}'`)
      } catch {}
    }
    try {
      const left = (
        await sql(
          `select (select count(*) from auth.users where email in ('${MISMATCH_ADDR}','${LOWER_ADDR}')) u,` +
            ` (select count(*) from public.profiles where email in ('${MISMATCH_ADDR}','${LOWER_ADDR}')) p,` +
            ` (select count(*) from public.member_allowlist where email in ('${MISMATCH_ADDR}','${LOWER_ADDR}')) a`,
        )
      )[0]
      if (Number(left.u) === 0 && Number(left.p) === 0 && Number(left.a) === 0) return true
    } catch {}
    await new Promise((r) => setTimeout(r, 1000))
  }
  console.log('  WARN  teardown could not confirm its own deletes after 5 attempts')
  return false
}

try {
  // --------------------------------------------------- D0 inside the lane
  const d0 = (
    await sql(
      'select (select count(*) from auth.users) u, (select count(*) from public.profiles) p,' +
        ' (select count(*) from public.member_allowlist) a',
    )
  )[0]
  console.log(`D0        = users=${d0.u} profiles=${d0.p} allowlist=${d0.a}`)

  // `handle_new_portal_user()` refuses any address absent from the allowlist, so
  // both fixtures are seeded there first. Without this, criterion 4's account is
  // refused and the lane would read that refusal as a composition rule.
  for (const addr of [MISMATCH_ADDR, LOWER_ADDR]) {
    await sql(`insert into public.member_allowlist (email, full_name)
               values ('${addr}', 'Site15 Register Fixture') on conflict (email) do nothing`)
  }

  // ------------------------------------------- criterion 3a and 3b, on source
  // The digit can hide in three artifacts and the assertion covers all three,
  // because `siteLabel` returns `node.label ?? fallback`: the label in
  // site-content.json WINS over the component at runtime, so a content edit
  // could otherwise write the floor into the page with nothing red.
  const policySrc = readFileSync('src/lib/backend/passwordPolicy.ts', 'utf8')
  const floor = Number(/PASSWORD_MIN_LENGTH\s*=\s*(\d+)/.exec(policySrc)[1])
  ok('the floor was read from the constant', Number.isInteger(floor) && floor > 0, `floor=${floor}`)

  const sharedSrc = readFileSync('src/pages/backend/shared.tsx', 'utf8')
  // The hint's own JSX, isolated by its node id, so a digit elsewhere in the
  // file (a className, an unrelated literal) cannot fail this.
  const hintCall = /siteLabel\(\s*'portal\.signin\.hint',([\s\S]{0,400}?)\)\s*\.replace\(([\s\S]{0,120}?)\)/.exec(sharedSrc)
  ok('criterion 3a: the hint is composed with a replace over the constant', Boolean(hintCall))
  const hintRegion = (hintCall?.[1] ?? '') + (hintCall?.[2] ?? '')
  ok(
    'criterion 3a: the hint references PASSWORD_MIN_LENGTH',
    /PASSWORD_MIN_LENGTH/.test(hintCall?.[2] ?? ''),
    'the replacement value must come from the constant, not a literal',
  )
  ok(
    'criterion 3a: the hint carries no digit literal equal to the live floor',
    !new RegExp(`\\b${floor}\\b`).test(hintRegion),
    `region=${JSON.stringify(hintRegion.slice(0, 120))}`,
  )

  const content = JSON.parse(readFileSync('src/content/site-content.json', 'utf8'))
  const labelOf = (id) => {
    let found
    const walk = (n) => {
      if (Array.isArray(n)) n.forEach(walk)
      else if (n && typeof n === 'object') {
        if (n.id === id) found = n.label
        Object.values(n).forEach(walk)
      }
    }
    walk(content)
    return found
  }
  const hintLabel = labelOf('portal.signin.hint')
  ok('criterion 3b: the hint node exists', typeof hintLabel === 'string', `label=${JSON.stringify(hintLabel)}`)
  ok(
    'criterion 3b: the hint node carries the placeholder',
    typeof hintLabel === 'string' && hintLabel.includes('{min}'),
    `label=${JSON.stringify(hintLabel)}`,
  )
  ok(
    'criterion 3b: the hint node carries no digit literal equal to the live floor',
    typeof hintLabel === 'string' && !new RegExp(`\\b${floor}\\b`).test(hintLabel),
    `label=${JSON.stringify(hintLabel)}`,
  )

  // ------------------------------------------------ criterion 13, on the doc
  // The decision Joshua answered on 2026-09-17 bought a documentation
  // deliverable, and a deliverable nothing tests is the defect this campaign has
  // hit three times. So the code does not ship without the record.
  const securityDoc = readFileSync('docs/SECURITY.md', 'utf8')
  const v624 = /\*\*ASVS V6\.2\.4[\s\S]{0,2000}/.exec(securityDoc)?.[0] ?? ''
  ok('criterion 13: docs/SECURITY.md carries a paragraph naming V6.2.4', v624.includes('V6.2.4'))

  // The compensating-controls correction, SCOPED to its own paragraph. A test
  // for /aal2/ over the whole document is vacuous: the document already carries
  // 9 pre-existing `aal2` hits in the MFA-migration section, so deleting this
  // correction would leave such an assertion green.
  // Through the CLOSING fence, not the opening one: the measured result is a
  // comment inside the SQL block, so a scope ending at the first ``` excludes
  // exactly the line this criterion is about.
  const mfaCorrection =
    /\*\*The fourth item this list used to claim[\s\S]{0,1600}?```sql[\s\S]{0,800}?```/.exec(securityDoc)?.[0] ?? ''
  ok(
    'criterion 13: the compensating-controls correction exists as its own paragraph',
    mfaCorrection.length > 0 && /aal2/.test(mfaCorrection),
    'scoped to the correction, not a document-wide grep that 9 pre-existing hits would satisfy',
  )

  // And it is MEASURED at read time, not frozen. The first version asserted the
  // literal `verified_factors=0 admin_has_aal2=false`, which is a build-time
  // integer nailed into a lane: when SITE-16 enrols MFA the correct document
  // reads 1/true and this lane would go red on a correct product, or the
  // document would be kept stale to keep the lane green. That is program
  // finding 78 inverted, inside the spec that recorded finding 78.
  const mfaNow = (
    await sql(
      "select (select count(*) from auth.mfa_factors where status='verified') as verified_factors," +
        " (pg_get_functiondef('public.is_portal_admin()'::regprocedure) like '%aal2%') as admin_has_aal2",
    )
  )[0]
  const expectedLine = `verified_factors=${mfaNow.verified_factors}  admin_has_aal2=${mfaNow.admin_has_aal2}`
  ok(
    'criterion 13: the recorded MFA state matches the LIVE measurement taken now',
    mfaCorrection.includes(expectedLine),
    `live now: ${expectedLine}`,
  )

  // ------------------------------------------- build as production does
  // Two build-env mistakes each produce a page that looks exactly like "the
  // feature does not render" while the product is correct: VITE_BASE unset makes
  // every asset 404, and the Supabase keys unset make `backendEnabled` false so
  // `/portal` is never registered and the SPA renders its 404 page. Program
  // finding 73. Both are asserted on the artifact below, not assumed from the
  // env passed in.
  //
  // The publishable key is public by design and ships in the live bundle, so it
  // is read from there rather than stored. The entry chunk is RESOLVED, never
  // typed: `site09-recovery.mjs` hardcodes a hash that has since changed twice.
  const LIVE = 'https://joshuafrost712.github.io/obt-cdt-site'
  const liveIndex = await (await fetch(`${LIVE}/`)).text()
  const liveEntry = /index-[A-Za-z0-9_-]+\.js/.exec(liveIndex)?.[0]
  if (!liveEntry) {
    console.error('REFUSED: could not resolve the live entry chunk from the served index.')
    process.exit(2)
  }
  const liveBundle = await (await fetch(`${LIVE}/assets/${liveEntry}`)).text()
  const pubKey = /sb_publishable_[A-Za-z0-9_-]+/.exec(liveBundle)?.[0]
  const projectUrl = /https:\/\/[a-z]+\.supabase\.co/.exec(liveBundle)?.[0]
  if (!pubKey || !projectUrl) {
    console.error('REFUSED: could not read the publishable key or project URL from the live bundle.')
    process.exit(2)
  }

  console.log(`building dist/ with the deploy's own environment (entry ${liveEntry})…`)
  execFileSync('npm', ['run', 'build'], {
    stdio: 'ignore',
    env: {
      ...process.env,
      VITE_BASE: '/obt-cdt-site/',
      VITE_SUPABASE_URL: projectUrl,
      VITE_SUPABASE_PUBLISHABLE_KEY: pubKey,
    },
  })

  const four04 = readFileSync('dist/404.html', 'utf8')
  ok('dist/ is built with the production base path', four04.includes('src="/obt-cdt-site/assets/'))
  const builtEntry = /src="\/obt-cdt-site\/(assets\/index-[A-Za-z0-9_-]+\.js)"/.exec(four04)?.[1]
  const entryText = builtEntry ? readFileSync(path.join('dist', builtEntry), 'utf8') : ''
  ok('dist/ is built with the backend enabled', entryText.includes('sb_publishable_'))

  server = spawn('node', ['scripts/serve-dist.mjs', '--port', String(PORT)], { stdio: 'ignore' })
  // Probed at BASE, never at /portal: the portal is an SPA route with no file
  // behind it, so this server answers it through 404.html with a 404 status,
  // exactly as GitHub Pages does. A readiness check on `r.ok` at /portal never
  // goes true even when the server is up and correct.
  const up = async () => {
    for (let i = 0; i < 60; i++) {
      try {
        const r = await fetch(`${BASE}/`)
        if (r.ok) return true
      } catch {}
      await new Promise((r) => setTimeout(r, 250))
    }
    return false
  }
  if (!(await up())) throw new Error(`dist server did not come up on ${PORT}`)

  // ------------------------------------------------------------- the browser
  mkdirSync(SHOTS, { recursive: true })
  browser = await chromium.launch()
  // Clipboard permissions, so criterion 6 can drive a REAL paste rather than an
  // insertText that no `onPaste` handler would ever see.
  const ctx = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] })
  const page = await ctx.newPage()

  // Criteria 1 and 12 share this listener, installed before the first
  // navigation so nothing in the flow escapes it.
  const requests = []
  page.on('request', (r) => requests.push(r.url()))
  const signupCount = () => requests.filter((u) => /\/auth\/v1\/signup/.test(u)).length

  // Criterion 12's second observable, and the reason it exists: the shipped meta
  // CSP's `connect-src` blocks a stray origin BEFORE the request is issued, so
  // Playwright's `request` event never fires for it. The signing review injected
  // a `fetch` at api.pwnedpasswords.com into the register branch and watched the
  // host assertion stay green at `foreign=none`, which means the recorded
  // mutation could not go red and the criterion could not fail.
  //
  // A `securitypolicyviolation` listener sees exactly what the request listener
  // cannot. Installed with addInitScript so it is registered before any page
  // script runs, and it makes the lane strictly stronger than the CSP rather
  // than dependent on it.
  const cspViolations = []
  await page.exposeFunction('__site15CspViolation', (d) => cspViolations.push(d))
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => {
      window.__site15CspViolation?.({ directive: e.violatedDirective, blocked: e.blockedURI })
    })
  })

  const toRegister = async (p) => {
    await p.goto(`${BASE}/portal`, { waitUntil: 'networkidle' })
    await p
      .getByRole('button', { name: /I need to create an account/i })
      .first()
      .click()
      .catch(() => {})
    await p.waitForTimeout(800)
  }

  await toRegister(page)
  ok('the lane is on its own origin, not production', new URL(page.url()).origin === `http://localhost:${PORT}`, page.url().split('#')[0])
  // Asserted on the register heading, which only that mode renders: sign-in
  // mode's input set would otherwise grade the wrong form.
  ok('the register form is in REGISTER mode', (await page.getByRole('heading', { name: /Create your account/i }).count()) > 0)

  // ---------------------------------------------------------- criterion 2
  ok('criterion 2: the confirm field is present in register mode', (await page.locator('#portal-confirm').count()) === 1)
  await page.screenshot({ path: `${SHOTS}/01-register-form.png` })

  // ---------------------------------------------------------- criterion 3c
  // Behavioural: the rendered hint names the floor. The scratch build at a
  // different floor is run by the build session as a separate sequenced step
  // (site09-auth-checks.mjs asserts the constant equals the LIVE floor, so a
  // scratch build left in dist/ turns that lane red); here the assertion is that
  // the number on screen is the number in the constant, which is what a person
  // reads.
  const hintText = ((await page.locator('[data-portal-hint]').first().textContent()) ?? '').trim()
  ok('criterion 3c: the hint renders', hintText.length > 0, `hint=${JSON.stringify(hintText)}`)
  ok('criterion 3c: the rendered hint names the floor', hintText.includes(String(floor)), `hint=${JSON.stringify(hintText)}`)
  ok('criterion 3c: the placeholder was substituted', !hintText.includes('{min}'), `hint=${JSON.stringify(hintText)}`)

  // ----------------------------------------------------------- criterion 8
  // Set-equality over the form's rendered text, so an added element of any kind
  // fails this, not only one that looks like a score. The expected strings are
  // read from the content nodes rather than typed, so a copy edit does not turn
  // this red for the wrong reason.
  // EVERY text node in the form, not a chosen tag list. The first version of
  // this collected `label, p, button`, and the signing review injected a bare
  // `<span>Strong</span>` and watched the lane stay green: a real strength meter
  // is a div or a span, so the must_not was enforced only against insertions
  // shaped like a paragraph. Walking text nodes is what makes "asserted totally"
  // true rather than a claim about the mutation that happened to be tried.
  const formText = await page.evaluate(() => {
    const form = document.querySelector('form')
    if (!form) return null
    const walker = document.createTreeWalker(form, NodeFilter.SHOW_TEXT)
    const out = []
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = (n.textContent ?? '').trim()
      if (t) out.push(t)
    }
    return out
  })
  ok('criterion 8: the register form rendered at all', Array.isArray(formText) && formText.length > 0,
     'an empty form would make the set-equality below vacuous')
  const expectedText = [
    labelOf('portal.signin.email') ?? 'Email address',
    labelOf('portal.signin.password') ?? 'Password',
    labelOf('portal.signin.confirm') ?? 'Password again',
    (labelOf('portal.signin.hint') ?? '').replace('{min}', String(floor)),
    labelOf('portal.signin.cta.register') ?? 'Create account',
  ]
  const setEq = (a, b) => a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i])
  ok(
    'criterion 8: the register form\'s text is set-equal to the expected labels',
    Array.isArray(formText) && setEq(formText, expectedText),
    `got ${JSON.stringify(formText)} expected ${JSON.stringify(expectedText)}`,
  )
  const meters = await page.evaluate(() => {
    const form = document.querySelector('form')
    if (!form) return -1
    return form.querySelectorAll('meter, progress, [role=meter], [role=progressbar]').length
  })
  ok('criterion 8: no meter, progress or progressbar element is in the form', meters === 0, `found=${meters}`)

  // ----------------------------------------------------------- criterion 7
  // The shell in this state, with no frozen integer. Member links must be 0
  // because the form holds no session; and the PUBLIC nav must be identical
  // between sign-in and register mode, compared to a live sibling measured in
  // this same run rather than to a number recorded when the spec was written.
  const navNames = async (p) =>
    (await p.evaluate(() => [...document.querySelectorAll('nav a')].map((a) => (a.textContent ?? '').trim()))).sort()
  const registerNav = await navNames(page)
  const memberLinks = await page.getByRole('link', { name: /^(Members|Materials|Psalms handbook)$/ }).count()
  ok('criterion 7: no member nav link is offered on the register form', memberLinks === 0, `member links=${memberLinks}`)

  const sibling = await ctx.newPage()
  await sibling.goto(`${BASE}/portal`, { waitUntil: 'networkidle' })
  await sibling.waitForTimeout(600)
  const signinNav = await navNames(sibling)
  ok('criterion 7: the nav population is non-empty', registerNav.length > 0, 'an empty nav would make the comparison vacuous')
  ok(
    'criterion 7: the public nav is identical between sign-in and register modes',
    JSON.stringify(registerNav) === JSON.stringify(signinNav),
    `register=${JSON.stringify(registerNav)} signin=${JSON.stringify(signinNav)}`,
  )
  await sibling.close()

  // ----------------------------------------------------------- criterion 6
  // Paste, through REAL keyboard input. A synthetic `dispatchEvent` inserts
  // nothing into a React controlled input and would fail on a correct build, so
  // it would prove nothing about paste being permitted.
  // First the source, because it is the assertion that can actually FAIL on the
  // defect this criterion names. `keyboard.insertText` does NOT emit a `paste`
  // event, so an `onPaste={(e) => e.preventDefault()}` on a password input is
  // invisible to it: the signing review added exactly that handler and watched
  // this criterion stay green. The spec permitted insertText, so the first
  // version followed its letter and proved nothing.
  // Split on the tag opener and cut each block at its own `/>`, rather than a
  // fixed lookahead window: `#portal-password` carries a multi-line
  // `autoComplete` ternary and a 400-character window silently dropped it, so
  // the population read 3 where the file holds 4. A population this assertion
  // undercounts is a population it cannot police, which is why the count below
  // is checked against the file's own total rather than trusted.
  const passwordInputBlocks = sharedSrc
    .split('<input')
    .slice(1)
    .map((chunk) => chunk.slice(0, chunk.indexOf('/>') + 2))
    .filter((b) => /type="password"/.test(b))
  const passwordInputTotal = (sharedSrc.match(/type="password"/g) ?? []).length
  ok(
    'criterion 6: the password input population is non-empty',
    passwordInputBlocks.length > 0,
    `found ${passwordInputBlocks.length} password inputs in shared.tsx`,
  )
  ok(
    'criterion 6: the parsed population covers every password input in the file',
    passwordInputBlocks.length === passwordInputTotal,
    `parsed=${passwordInputBlocks.length} total type="password"=${passwordInputTotal}`,
  )
  ok(
    'criterion 6: no password input carries an onPaste handler',
    passwordInputBlocks.every((b) => !/onPaste/.test(b)),
    `inputs with onPaste=${passwordInputBlocks.filter((b) => /onPaste/.test(b)).length}`,
  )

  // Then the behaviour, through a REAL clipboard paste rather than a synthetic
  // event: a synthetic `dispatchEvent` inserts nothing into a React controlled
  // input and would fail on a correct build, proving the opposite of what it
  // looks like it proves.
  await page.locator('#portal-password').fill('')
  await page.locator('#portal-password').click()
  const clipboardOk = await page
    .evaluate(async () => {
      try {
        await navigator.clipboard.writeText('pasted-twelve-chars')
        return true
      } catch {
        return false
      }
    })
    .catch(() => false)
  if (clipboardOk) {
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+V' : 'Control+V')
    await page.waitForTimeout(400)
    const pasted = await page.locator('#portal-password').inputValue()
    ok('criterion 6: a real clipboard paste reaches the password field', pasted === 'pasted-twelve-chars',
       `value=${JSON.stringify(pasted)}`)
  } else {
    // Said out loud rather than skipped silently. The source assertion above is
    // the one that carries the criterion in this case.
    console.log('  note  clipboard write was refused by the browser; the source assertion above carries criterion 6')
  }
  await page.locator('#portal-password').fill('')

  // ----------------------------------------------------------- criterion 1
  // The mismatch arm. Two-sided: the matching arm below must produce exactly one
  // signup request, or this assertion would pass on a form that never submits
  // anything at all.
  const signupBefore = signupCount()
  await page.locator('#portal-email').fill(MISMATCH_ADDR)
  await page.locator('#portal-password').fill(LOWER_PASSWORD)
  await page.locator('#portal-confirm').fill(`${LOWER_PASSWORD}x`)
  await page.getByRole('button', { name: /^Create account$/ }).click()
  await page.waitForTimeout(1500)

  const mismatchLabel = labelOf('portal.signin.mismatch') ?? ''
  const bodyText = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
  ok(
    'criterion 1: the mismatch message is on screen',
    mismatchLabel.length > 0 && bodyText.includes(mismatchLabel.replace(/\s+/g, ' ')),
    `looking for ${JSON.stringify(mismatchLabel.slice(0, 60))}`,
  )
  ok(
    'criterion 1: NO signup request reached the network on a mismatch',
    signupCount() === signupBefore,
    `signup requests before=${signupBefore} after=${signupCount()}`,
  )
  const mismatchRows = Number(
    (await sql(`select count(*) as n from auth.users where email = '${MISMATCH_ADDR}'`))[0].n,
  )
  ok('criterion 1: no account was created for the mismatched attempt', mismatchRows === 0, `rows=${mismatchRows}`)
  await page.screenshot({ path: `${SHOTS}/02-mismatch-refused.png` })

  // Criterion 1, the other side: matching passwords DO submit, exactly once.
  //
  // This asserts that the guard lets a correct attempt THROUGH to the network,
  // which is the half that makes the mismatch assertion meaningful: without it,
  // a form that never submits anything at all would pass criterion 1's first
  // arm. It deliberately asserts nothing about what the server then does with
  // the request, because at an undeliverable fixture domain the confirmation
  // mail bounces and GoTrue rolls the insert back (see criterion 4 below). The
  // browser's behaviour is what this criterion owns.
  await page.locator('#portal-email').fill(LOWER_ADDR)
  await page.locator('#portal-password').fill(LOWER_PASSWORD)
  await page.locator('#portal-confirm').fill(LOWER_PASSWORD)
  await page.getByRole('button', { name: /^Create account$/ }).click()
  await page.waitForTimeout(4000)
  ok(
    'criterion 1: matching passwords produce exactly one signup request',
    signupCount() === signupBefore + 1,
    `signup requests=${signupCount() - signupBefore}`,
  )
  await page.screenshot({ path: `${SHOTS}/03-registered.png` })

  // ----------------------------------------------------------- criterion 4
  // No character-class rule is imposed, asserted on GoTrue's OWN VERDICT on the
  // password rather than on the form or on a row count.
  //
  // ## Why not a row count, which is what the spec first asked for
  //
  // Measured 2026-09-21 while building this lane. A fixture at an undeliverable
  // domain CANNOT create a row, whatever its password: `mailer_autoconfirm` is
  // false, so GoTrue sends a confirmation mail through Brevo and, when that
  // bounces, returns `500 unexpected_failure / Error sending confirmation email`
  // and rolls the insert back. Two controls separate that from a password
  // refusal, and both were run before this assertion was rewritten:
  //
  //   - an allowlisted fixture with a STRONG mixed password (`Abcd3fgh!jkLMN9`)
  //     fails identically with the same 500, so the 500 says nothing about
  //     composition;
  //   - an address absent from the allowlist fails DIFFERENTLY, with "Database
  //     error saving new user", which is the trigger's own refusal.
  //
  // So a row-count assertion here reads a mail-delivery failure as a composition
  // rule. That is a false diagnosis wired into the lane, and it would have been
  // the second such defect this campaign shipped.
  //
  // ## What is asserted instead, and why it is stronger
  //
  // The policy is evaluated BEFORE the mail step, and it says so explicitly:
  // a six-character password returns `422 weak_password` with
  // `reasons: ["length"]`, while the twelve-character all-lowercase password
  // gets past the policy and only then hits the mail failure. So the observable
  // that actually carries the fact is the ABSENCE of a `weak_password` refusal
  // for an all-lowercase password that meets the length floor.
  //
  // Two-sided in one run: the same endpoint must still REFUSE a password below
  // the floor, or "no weak_password refusal" would be true of a server that had
  // stopped checking passwords altogether.
  //
  // ## What this proves and does not prove
  //
  // It rules out Supabase's `password_required_characters` presets and any
  // upper/digit/symbol requirement, because such a rule refuses at exactly this
  // step with `reasons` naming the missing class. It would still pass under an
  // exotic rule such as "must contain a letter" or "no repeated characters".
  // Stated rather than left implied.
  const signupProbe = async (password) => {
    const res = await fetch(`${url}/auth/v1/signup`, {
      method: 'POST',
      headers: { apikey: pubKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: LOWER_ADDR, password }),
    })
    return { status: res.status, body: await res.json().catch(() => ({})) }
  }

  const lowerProbe = await signupProbe(LOWER_PASSWORD)
  ok(
    'criterion 4: an all-lowercase password at the floor is NOT refused as weak',
    lowerProbe.body?.error_code !== 'weak_password' && lowerProbe.status !== 422,
    `status=${lowerProbe.status} error_code=${lowerProbe.body?.error_code ?? 'none'} ` +
      `reasons=${JSON.stringify(lowerProbe.body?.weak_password?.reasons ?? null)} ` +
      `(password was ${LOWER_PASSWORD.length} chars, [a-z] only)`,
  )

  const shortProbe = await signupProbe('abcdef')
  ok(
    'criterion 4, the other side: a password below the floor IS refused as weak',
    shortProbe.status === 422 && shortProbe.body?.error_code === 'weak_password',
    `status=${shortProbe.status} error_code=${shortProbe.body?.error_code ?? 'none'} ` +
      `reasons=${JSON.stringify(shortProbe.body?.weak_password?.reasons ?? null)}`,
  )
  ok(
    'criterion 4, the other side: and the refusal is about LENGTH, not composition',
    Array.isArray(shortProbe.body?.weak_password?.reasons) &&
      shortProbe.body.weak_password.reasons.includes('length'),
    `reasons=${JSON.stringify(shortProbe.body?.weak_password?.reasons ?? null)}`,
  )

  // ---------------------------------------------------------- criterion 12
  // Every request across the WHOLE flow, not only the submit. Self or the
  // Supabase project host; anything else is a third-party origin in the page.
  const allowedHosts = new Set([`localhost:${PORT}`, new URL(projectUrl).host])
  const foreign = [...new Set(requests.map((u) => {
    try {
      return new URL(u).host
    } catch {
      return null
    }
  }).filter((h) => h && !allowedHosts.has(h)))]
  ok('criterion 12: the request population is non-empty', requests.length > 0,
     'a zero-request run would make the host check vacuous')
  ok(
    'criterion 12: no third-party origin was contacted by the register flow',
    foreign.length === 0,
    `requests=${requests.length} hosts=${[...allowedHosts].join(',')} foreign=${foreign.join(',') || 'none'}`,
  )
  // The half the request listener structurally cannot see. A `connect-src`
  // violation means code in the page TRIED to reach an origin the CSP refuses,
  // which is the defect this criterion is about even though no request was ever
  // issued. Without this the recorded mutation cannot go red.
  const connectViolations = cspViolations.filter((v) => /connect-src/.test(v.directive ?? ''))
  ok(
    'criterion 12: the page attempted no connection the CSP had to block',
    connectViolations.length === 0,
    `violations=${JSON.stringify(connectViolations)}`,
  )

  // ------------------------------------------- criterion 2, the negative arms
  // The confirm field must be absent from the other two modes. Fresh context, so
  // no state from the register flow above leaks into the reading.
  const other = await browser.newContext()
  const p2 = await other.newPage()
  await p2.goto(`${BASE}/portal`, { waitUntil: 'networkidle' })
  await p2.waitForTimeout(600)
  ok('criterion 2: sign-in mode renders its own form', (await p2.locator('#portal-password').count()) === 1,
     'a zero here would make the absence assertion below vacuous')
  ok('criterion 2: the confirm field is absent in sign-in mode', (await p2.locator('#portal-confirm').count()) === 0)

  await p2.getByRole('button', { name: /I forgot my password/i }).first().click().catch(() => {})
  await p2.waitForTimeout(800)
  ok('criterion 2: reset mode rendered', (await p2.getByRole('heading', { name: /Reset your password/i }).count()) > 0,
     'a zero here would make the absence assertion below vacuous')
  ok('criterion 2: the confirm field is absent in reset mode', (await p2.locator('#portal-confirm').count()) === 0)
  await other.close()

  // ------------------------------------------------------------- teardown
  const clean = await teardown()
  ok('teardown removed every fixture row and confirmed it', clean === true)
  const d1 = (
    await sql(
      'select (select count(*) from auth.users) u, (select count(*) from public.profiles) p,' +
        ' (select count(*) from public.member_allowlist) a',
    )
  )[0]
  ok(
    'the database is back to its pre-run counts',
    Number(d1.u) === Number(d0.u) && Number(d1.p) === Number(d0.p) && Number(d1.a) === Number(d0.a),
    `D0 users=${d0.u} profiles=${d0.p} allowlist=${d0.a} | D1 users=${d1.u} profiles=${d1.p} allowlist=${d1.a}`,
  )
} catch (e) {
  fail++
  console.log(`  FAIL  lane threw: ${e.message}`)
  await teardown()
} finally {
  try {
    if (browser) await browser.close()
  } catch {}
  try {
    if (server) server.kill()
  } catch {}
}

console.log(`\n${pass} pass / ${fail} fail`)
process.exit(fail === 0 ? 0 : 1)
