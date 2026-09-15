/**
 * SITE-09 contract c1: a person who clicks the reset link sets a new password
 * and signs in with it on a different device.
 *
 *   npm i -D --no-save playwright && npx playwright install chromium
 *   npm run build
 *   node scripts/site09-recovery.mjs --assert
 *
 * ## The defect this proves is fixed
 *
 * Measured 2026-09-10: the reset email sent a link, the link signed the person
 * in, and NO screen anywhere in `src/` called `updateUser`. So the password
 * never changed and a second device could never sign in. `recovery_sent_at` was
 * 0 across all 22 accounts, which means no participant had yet walked it.
 *
 * ## `redirect_to` must be TOP-LEVEL on generate_link
 *
 * Found in this build, 2026-09-15, and it is a trap worth naming. Passing
 * `options.redirect_to` (the shape the client SDK uses) is accepted, ignored,
 * and silently falls back to `site_url` — which is PRODUCTION. A lane that did
 * not check would have driven a real browser against the live site while
 * believing it was local. The assertion below refuses any link whose
 * `redirect_to` is not this lane's own localhost origin.
 *
 * ## Why 4191
 *
 * `uri_allow_list` has four entries and no wildcard, so the lane cannot invent a
 * port. 4191 is on the list and is booked by four other lanes (CDT-04, CDT-06a,
 * SITE-04, SITE-05); this lane holds it exclusively while running.
 *
 * ## Mutations (contract c1)
 *
 *   1. Remove the `recovery` branch in `AuthGate` → the member shell renders and
 *      the form is absent.
 *   2. Make `markRecovery()` a no-op → the reload-and-navigate arm fails while
 *      first paint still passes. This is the one that proves persistence, and it
 *      is the defect review finding B1 caught in the design.
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright'

const ASSERT = process.argv.includes('--assert')
if (!ASSERT) {
  console.error('usage: node scripts/site09-recovery.mjs --assert')
  process.exit(2)
}

const PORT = 4191
const BASE = `http://localhost:${PORT}/obt-cdt-site`
const PREFIX = 'site09-rec-'
const NEW_PASSWORD = 'Fixture-New-Pass-2026-Xyz'
const OLD_PASSWORD = 'OldFixturePass2026x'
const SHOTS = 'feedback/site09-shots'

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
// Contract c1: no recovery link is ever minted against a cohort address. The
// guard is the lane prefix AND absence from the dated roster export, and it
// REFUSES when that export is absent (review finding B3).
function rosterGuard(addr) {
  // The same file `site08-name-scan.mjs` reads, deliberately: one roster, one
  // location, so a lane cannot pass by checking a staler copy than the scan.
  // It lives in ~/Documents and never in this repo.
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

// --------------------------------------------------------------- fixture
const ADDR = `${PREFIX}${Date.now()}@example.org`
const rosterName = rosterGuard(ADDR)
console.log(`fixture   = ${PREFIX}<ts>@example.org`)
console.log(`roster    = ${rosterName} (checked, address absent)`)

let userId = null
let server = null
let browser = null

/**
 * Remove every row this run created, and PROVE it before returning.
 *
 * The first version swallowed both deletes with `.catch(() => {})` and returned
 * immediately, so the count assertions ran against whatever state happened to
 * exist. The build review caught it the only way it could be caught: by running
 * the lane and watching one run leave `users=1, allowlist=1` behind — three live
 * rows (`auth.users`, `profiles`, `member_allowlist`) on the PRODUCTION project,
 * taking it to 23/43/23 against D0's 22/42/22. A flaky teardown against the real
 * cohort's database is the worst place to have one.
 *
 * Two causes, both handled here. The admin DELETE can transiently fail, and a
 * swallowed rejection looked identical to success. And the delete of the
 * `auth.users` row cascades to `profiles`, which is not instantaneous, so a
 * count taken immediately after the call can still see the row.
 *
 * So: retry each delete, then poll until the rows are actually gone, and only
 * then return. A teardown that cannot confirm its own work fails loudly rather
 * than leaving the caller to assert against a race.
 */
async function teardown() {
  try {
    if (browser) await browser.close()
  } catch {}
  try {
    if (server) server.kill()
  } catch {}

  for (let attempt = 0; attempt < 5; attempt++) {
    if (userId) {
      try {
        await admin(`admin/users/${userId}`, { method: 'DELETE' })
      } catch {}
    }
    try {
      await sql(`delete from public.member_allowlist where email = '${ADDR}'`)
    } catch {}

    // Confirm, rather than assume. `profiles` is included because the cascade
    // from `auth.users` is what lags.
    try {
      const left = (
        await sql(
          `select (select count(*) from auth.users where email = '${ADDR}') u,` +
            ` (select count(*) from public.profiles where id = '${userId ?? '00000000-0000-0000-0000-000000000000'}') p,` +
            ` (select count(*) from public.member_allowlist where email = '${ADDR}') a`,
        )
      )[0]
      if (Number(left.u) === 0 && Number(left.p) === 0 && Number(left.a) === 0) return
    } catch {}
    await new Promise((r) => setTimeout(r, 1000))
  }
  console.log('  WARN  teardown could not confirm its own deletes after 5 attempts')
}

process.on('exit', () => {})

try {
  // Allowlist first: handle_new_portal_user() refuses any address absent from it.
  await sql(`insert into public.member_allowlist (email, full_name) values ('${ADDR}', 'Site09 Recovery Fixture') on conflict (email) do nothing`)

  const created = await (
    await admin('admin/users', {
      method: 'POST',
      body: JSON.stringify({ email: ADDR, password: OLD_PASSWORD, email_confirm: true }),
    })
  ).json()
  userId = created.id
  if (!userId) throw new Error(`fixture account not created: ${JSON.stringify(created).slice(0, 200)}`)

  // ------------------------------------------------- build as production does
  //
  // The lane builds `dist/` itself rather than trusting whatever is on disk,
  // because TWO build-env mistakes each produce a page that looks exactly like
  // "the recovery form does not render" while the product is in fact correct.
  // Both were hit in this build, 2026-09-15, and cost seven false failures each:
  //
  //   1. `VITE_BASE` unset defaults to `/`, so the bundle emits
  //      `src="/assets/..."`. Served under this server's `/obt-cdt-site/` base
  //      every asset 404s and the body renders blank.
  //   2. `VITE_SUPABASE_*` unset makes `backendEnabled` false (config.ts:25), so
  //      `App.tsx` never registers the `/portal` route at all and the SPA
  //      renders its 404 page instead. This is the sharper of the two: the page
  //      is fully rendered and entirely wrong.
  //
  // The publishable key is public by design and ships in the live bundle; it is
  // read from there rather than stored, so this lane holds no key of its own.
  const liveBundle = await (
    await fetch('https://joshuafrost712.github.io/obt-cdt-site/assets/index-C6BLGjsx.js')
  ).text()
  const pubKey = /sb_publishable_[A-Za-z0-9_-]+/.exec(liveBundle)?.[0]
  const projectUrl = /https:\/\/[a-z]+\.supabase\.co/.exec(liveBundle)?.[0]
  if (!pubKey || !projectUrl) {
    console.error('REFUSED: could not read the publishable key or project URL from the live bundle.')
    process.exit(2)
  }

  console.log('building dist/ with the deploy\'s own environment…')
  execFileSync('npm', ['run', 'build'], {
    stdio: 'ignore',
    env: {
      ...process.env,
      VITE_BASE: '/obt-cdt-site/',
      VITE_SUPABASE_URL: projectUrl,
      VITE_SUPABASE_PUBLISHABLE_KEY: pubKey,
    },
  })

  // Both preconditions, asserted on the artifact rather than assumed from the
  // env we just passed.
  const four04 = readFileSync('dist/404.html', 'utf8')
  ok('dist/ is built with the production base path', four04.includes('src="/obt-cdt-site/assets/'))
  const builtEntry = /src="\/obt-cdt-site\/(assets\/index-[A-Za-z0-9_-]+\.js)"/.exec(four04)?.[1]
  const entryText = builtEntry ? readFileSync(path.join('dist', builtEntry), 'utf8') : ''
  ok('dist/ is built with the backend enabled', entryText.includes('sb_publishable_'))

  server = spawn('node', ['scripts/serve-dist.mjs', '--port', String(PORT)], { stdio: 'ignore' })
  // Readiness is probed at the BASE, not at /portal. The portal is an SPA route
  // with no file behind it, so this server answers it through 404.html with a
  // 404 status, exactly as GitHub Pages does. A readiness check on `r.ok` at
  // /portal therefore never goes true even though the server is up and correct.
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

  // ------------------------------------------------------ mint the link
  // redirect_to is TOP-LEVEL. Nested under options it is ignored and falls back
  // to site_url, which is production.
  const linkRes = await (
    await admin('admin/generate_link', {
      method: 'POST',
      body: JSON.stringify({ type: 'recovery', email: ADDR, redirect_to: `${BASE}/portal` }),
    })
  ).json()
  const actionLink = linkRes.action_link
  if (!actionLink) throw new Error(`no action_link: ${JSON.stringify(linkRes).slice(0, 200)}`)

  const redirectTo = new URL(actionLink).searchParams.get('redirect_to')
  ok(
    'the minted link redirects to THIS lane, not to production',
    redirectTo === `${BASE}/portal`,
    `redirect_to=${redirectTo}`,
  )
  if (redirectTo !== `${BASE}/portal`) throw new Error('refusing to drive a browser against production')

  // --------------------------------------------------------- the browser
  mkdirSync(SHOTS, { recursive: true })
  browser = await chromium.launch()
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  await page.goto(actionLink, { waitUntil: 'networkidle' })

  // Criterion 1: the recovery form renders, the member shell does not, and the
  // origin is this lane's own localhost.
  ok('the lane is on its own origin, not production', new URL(page.url()).origin === `http://localhost:${PORT}`, page.url().split('#')[0])
  await page.waitForSelector('[data-portal-state="recovery"]', { timeout: 10000 }).catch(() => {})
  ok('the new-password form renders', await page.locator('[data-portal-state="recovery"]').count() > 0)
  ok('two password fields are present', (await page.locator('input[type="password"]').count()) === 2)
  ok('the member sign-out bar is absent', (await page.locator('[data-portal-state="recovery"]').count()) > 0 && (await page.getByRole('button', { name: /^Sign out$/ }).count()) === 0)

  // The nav must not offer the member entries while the password is unset. The
  // person holds a live session, so without the recovery check in `SiteLayout`
  // the full member nav renders behind this form. Found by READING THE
  // SCREENSHOT, 2026-09-15, not by an assertion — which is why there is one now.
  const memberNav = await page.getByRole('link', { name: /^(Members|Materials|Psalms handbook)$/ }).count()
  ok('the nav hides the member entries during recovery', memberNav === 0, `member links=${memberNav}`)
  await page.screenshot({ path: `${SHOTS}/01-recovery-form.png` })

  // Criterion 1a: it survives a reload and a route change. This is the arm that
  // makes review finding B1 false.
  await page.reload({ waitUntil: 'networkidle' })
  ok('the form survives a reload', (await page.locator('[data-portal-state="recovery"]').count()) > 0)
  await page.goto(`${BASE}/portal/evaluations`, { waitUntil: 'networkidle' })
  ok('the form survives a route change', (await page.locator('[data-portal-state="recovery"]').count()) > 0)
  await page.screenshot({ path: `${SHOTS}/02-after-nav.png` })

  // Criterion 5: both inputs refuse a short value before any network call.
  const floor = Number(/PASSWORD_MIN_LENGTH\s*=\s*(\d+)/.exec(readFileSync('src/lib/backend/passwordPolicy.ts', 'utf8'))[1])
  const mins = await page.locator('input[type="password"]').evaluateAll((els) => els.map((e) => e.minLength))
  ok('both recovery inputs carry the floor', mins.length === 2 && mins.every((m) => m === floor), `mins=${mins.join(',')} floor=${floor}`)

  // Criterion 5, second half: a mismatch is refused before any network call.
  await page.goto(`${BASE}/portal`, { waitUntil: 'networkidle' })
  await page.locator('#portal-recovery-password').fill(NEW_PASSWORD)
  await page.locator('#portal-recovery-confirm').fill(`${NEW_PASSWORD}-different`)
  await page.getByRole('button', { name: /Save the new password/ }).click()
  await page.waitForTimeout(400)
  ok('a mismatch is refused and the form stays', (await page.locator('[data-portal-state="recovery"]').count()) > 0)

  // ----------------------------------------------------------- criterion 3a
  // The form TELLS the person their other devices will need the new password.
  // That sentence has to be true, not decorative. GoTrue's LogoutAllExceptMe
  // fires on a password change, so a session signed in before the reset must be
  // gone after it.
  //
  // The build review found this unasserted while the RecoveryCard doc comment
  // claimed it was — a false sentence in the source about a user-facing promise
  // nothing checked. So: sign in from a third context NOW, record the session
  // row, and assert below that it is gone.
  const otherCtx = await browser.newContext()
  const pOther = await otherCtx.newPage()
  await pOther.goto(`${BASE}/portal`, { waitUntil: 'networkidle' })
  await pOther.locator('#portal-email').fill(ADDR)
  await pOther.locator('#portal-password').fill(OLD_PASSWORD)
  await pOther.getByRole('button', { name: /^Sign in$/ }).click()
  await pOther.waitForTimeout(2500)
  const otherSignedIn = (await pOther.getByRole('button', { name: /^Sign out$/ }).count()) > 0
  ok('criterion 3a: another device is signed in before the reset', otherSignedIn)
  const sessionsBefore = Number(
    (await sql(`select count(*) as n from auth.sessions where user_id = '${userId}'`))[0].n,
  )
  ok('criterion 3a: that session exists in auth.sessions', sessionsBefore > 0, `sessions=${sessionsBefore}`)

  // Criterion 2: the password actually sets.
  const before = (await sql(`select encrypted_password from auth.users where id = '${userId}'`))[0].encrypted_password
  await page.locator('#portal-recovery-confirm').fill(NEW_PASSWORD)
  await page.getByRole('button', { name: /Save the new password/ }).click()
  await page.waitForSelector('[data-portal-state="recovery-done"]', { timeout: 15000 }).catch(() => {})
  ok('the page confirms the password is set', (await page.locator('[data-portal-state="recovery-done"]').count()) > 0)
  await page.screenshot({ path: `${SHOTS}/03-done.png` })

  const after = (await sql(`select encrypted_password from auth.users where id = '${userId}'`))[0].encrypted_password
  ok('encrypted_password changed', before !== after)

  // Criterion 3a, the other half: the pre-reset session is gone, so the
  // sentence on the form is a description of what happened.
  const sessionsAfter = Number(
    (await sql(`select count(*) as n from auth.sessions where user_id = '${userId}'`))[0].n,
  )
  ok(
    'criterion 3a: the other device\'s session is gone after the reset',
    sessionsAfter < sessionsBefore,
    `before=${sessionsBefore} after=${sessionsAfter}`,
  )
  await otherCtx.close()

  // And the suppression ends when recovery does: the member entries return
  // without a reload, because `clearRecovery()` is followed by a session
  // notification. Without that the nav stays empty until the person reloads.
  const navBack = await page.getByRole('link', { name: /^(Members|Materials|Psalms handbook)$/ }).count()
  ok('the nav restores the member entries after success', navBack > 0, `member links=${navBack}`)

  // Criterion 3: a second context with no storage is refused the OLD password
  // and accepts the NEW one, in that order.
  const fresh = await browser.newContext()
  const p2 = await fresh.newPage()
  // The refusal is compared against the content node `bad-credentials` resolves
  // to, READ AT RUN TIME from the content file rather than typed here — finding
  // 50, and the build review's F6. Inferring refusal from "no Sign out button"
  // is weaker in exactly the way finding 50 names: a page that failed to render,
  // or that threw, also has no Sign out button, so that assertion passes on a
  // broken page. This one needs the specific sentence to be on screen.
  const content = JSON.parse(readFileSync('src/content/site-content.json', 'utf8'))
  const findLabel = (node, id) => {
    if (Array.isArray(node)) {
      for (const n of node) {
        const hit = findLabel(n, id)
        if (hit) return hit
      }
      return null
    }
    if (node && typeof node === 'object') {
      if (node.id === id && typeof node.label === 'string') return node.label
      for (const v of Object.values(node)) {
        const hit = findLabel(v, id)
        if (hit) return hit
      }
    }
    return null
  }
  const badCreds = findLabel(content, 'portal.signin.error.bad-credentials')
  ok('the bad-credentials content node was read at run time', Boolean(badCreds), badCreds ? 'found' : 'MISSING')

  const signIn = async (pw) => {
    await p2.goto(`${BASE}/portal`, { waitUntil: 'networkidle' })
    await p2.locator('#portal-email').fill(ADDR)
    await p2.locator('#portal-password').fill(pw)
    await p2.getByRole('button', { name: /^Sign in$/ }).click()
    await p2.waitForTimeout(2500)
    const body = await p2.locator('body').innerText()
    return {
      signedIn: (await p2.getByRole('button', { name: /^Sign out$/ }).count()) > 0,
      refusedWithWords: badCreds ? body.includes(badCreds) : false,
    }
  }
  const oldTry = await signIn(OLD_PASSWORD)
  ok('a second device is REFUSED the old password', oldTry.signedIn === false)
  ok(
    'and the refusal is the bad-credentials sentence, not a blank page',
    oldTry.refusedWithWords,
    oldTry.refusedWithWords ? '' : 'the sentence was not on screen',
  )
  ok('a second device ACCEPTS the new password', (await signIn(NEW_PASSWORD)).signedIn === true)
  await p2.screenshot({ path: `${SHOTS}/04-second-device.png` })
  await fresh.close()

  // ------------------------------------------------------------ criterion 6
  // A person in recovery can leave WITHOUT setting a password, lands signed
  // out, and the persisted flag is cleared. Without this they are stuck on the
  // form: the flag outlives the session by design, so a browser that never
  // completes recovery would show the form forever.
  //
  // Needs its own link because the first one is consumed. Added after the
  // shadow review pointed out criterion 6 had no assertion at all — it had
  // verified the BEHAVIOUR by reading auth-js (signOut defaults to global
  // scope), which is better than assuming, but the contract wants it tested.
  const link2 = await (
    await admin('admin/generate_link', {
      method: 'POST',
      body: JSON.stringify({ type: 'recovery', email: ADDR, redirect_to: `${BASE}/portal` }),
    })
  ).json()
  if (!link2.action_link) throw new Error('could not mint a second recovery link')

  const leaveCtx = await browser.newContext()
  const p3 = await leaveCtx.newPage()
  await p3.goto(link2.action_link, { waitUntil: 'networkidle' })
  await p3.waitForSelector('[data-portal-state="recovery"]', { timeout: 10000 }).catch(() => {})
  ok('criterion 6: the form renders on a second link', (await p3.locator('[data-portal-state="recovery"]').count()) > 0)

  await p3.getByRole('button', { name: /Not now/ }).click()
  await p3.waitForTimeout(2000)
  ok(
    'criterion 6: leaving clears the persisted recovery flag',
    (await p3.evaluate(() => localStorage.getItem('obtcdt.portal.recovery'))) === null,
  )
  // Signed out, so the sign-in card is what a reload shows — not the recovery
  // form, and not the member shell.
  await p3.goto(`${BASE}/portal`, { waitUntil: 'networkidle' })
  ok('criterion 6: they land signed out', (await p3.locator('#portal-password').count()) > 0)
  ok('criterion 6: and not back on the recovery form', (await p3.locator('[data-portal-state="recovery"]').count()) === 0)
  await p3.screenshot({ path: `${SHOTS}/05-left-recovery.png` })
  await leaveCtx.close()

  // ------------------------------------------------- criteria 4 and 3, arm two
  // Both were flagged by the re-review as unmet AND undeclared, which is the
  // worse half: the contract read as covered.
  //
  // Criterion 4: the reset panel renders the SAME content node for an address
  // with an account and one without, both arms in the same run. If it did not,
  // the form would answer "is this person in the cohort?" to anyone who typed
  // an address — the same disclosure c2 exists to prevent, through a different
  // door.
  //
  // Criterion 3, second arm: a failed sign-in must not state whether the
  // address exists. F6 asserted the bad-credentials sentence for a WRONG
  // PASSWORD on a real account; this asserts the same sentence for an address
  // with no account at all. One node, two causes, which is the two-sided proof
  // the c3 must_not needs.
  const resetSent = findLabel(content, 'portal.signin.reset-sent')
  ok('the reset-sent content node was read at run time', Boolean(resetSent), resetSent ? 'found' : 'MISSING')

  const panelCtx = await browser.newContext()
  const p4 = await panelCtx.newPage()

  const askReset = async (addr) => {
    await p4.goto(`${BASE}/portal`, { waitUntil: 'networkidle' })
    await p4.getByRole('button', { name: /I forgot my password|Forgot/i }).click()
    await p4.locator('#portal-email').fill(addr)
    await p4.getByRole('button', { name: /Email me a reset link/ }).click()
    await p4.waitForTimeout(2500)
    return (await p4.locator('body').innerText()).includes(resetSent)
  }
  // The fixture HAS an account. A random address on nobody's list does not.
  const strangerAddr = `site09-nobody-${Date.now()}@example.org`
  const withAccount = await askReset(ADDR)
  const withoutAccount = await askReset(strangerAddr)
  ok('criterion 4: the reset panel answers the same for an address WITH an account', withAccount)
  ok('criterion 4: and the same for one WITHOUT', withoutAccount)
  ok('criterion 4: both arms resolve to the same node, in one run', withAccount && withoutAccount)

  // Criterion 3, arm two: an unknown address gets the bad-credentials sentence,
  // the same one a wrong password gets.
  await p4.goto(`${BASE}/portal`, { waitUntil: 'networkidle' })
  await p4.locator('#portal-email').fill(strangerAddr)
  await p4.locator('#portal-password').fill('SomeLongEnoughPassword2026')
  await p4.getByRole('button', { name: /^Sign in$/ }).click()
  await p4.waitForTimeout(2500)
  const unknownBody = await p4.locator('body').innerText()
  ok(
    'criterion 3: an UNKNOWN address gets the same bad-credentials sentence as a wrong password',
    badCreds ? unknownBody.includes(badCreds) : false,
  )
  ok('criterion 3: and is not signed in', (await p4.getByRole('button', { name: /^Sign out$/ }).count()) === 0)
  await p4.screenshot({ path: `${SHOTS}/06-enumeration.png` })
  await panelCtx.close()
} catch (e) {
  fail++
  console.log(`  FAIL  lane threw: ${e.message}`)
} finally {
  // Criterion 12: teardown asserts a count per table by name.
  await teardown()
  try {
    // Criterion 12: a count per table BY NAME. `profiles` is counted because
    // the build review found it leaking alongside the other two and the
    // original assertion could not see it: the row is created by
    // `handle_new_portal_user()` and removed by cascade, so it is the one most
    // likely to lag. `auth.sessions` is counted against its D0 value rather
    // than a prefix, because sessions carry no address.
    const t = (await sql(
      `select (select count(*) from auth.users where email like '${PREFIX}%') as users,` +
        ` (select count(*) from public.member_allowlist where email like '${PREFIX}%') as allowlist,` +
        ` (select count(*) from public.profiles p join auth.users u on u.id = p.id where u.email like '${PREFIX}%') as profiles,` +
        ` (select count(*) from auth.users) as total_users,` +
        ` (select count(*) from public.member_allowlist) as total_allowlist`,
    ))[0]
    ok('teardown: no fixture users remain', Number(t.users) === 0, `users=${t.users}`)
    ok('teardown: no fixture allowlist rows remain', Number(t.allowlist) === 0, `allowlist=${t.allowlist}`)
    ok('teardown: no fixture profiles remain', Number(t.profiles) === 0, `profiles=${t.profiles}`)
    // And the project is back to the numbers D0 recorded, which is the check
    // that would catch a fixture from a DIFFERENT prefix or an earlier crashed
    // run. D0 2026-09-15: 22 users, 42 allowlist.
    ok('teardown: the project is back to its D0 totals', Number(t.total_users) === 22 && Number(t.total_allowlist) === 42, `users=${t.total_users} allowlist=${t.total_allowlist}`)
  } catch (e) {
    fail++
    console.log(`  FAIL  teardown count: ${e.message}`)
  }
}

console.log(`\nsite09-recovery: pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)
