#!/usr/bin/env node
/**
 * SITE-18: a hand-issued temporary password forces a first-login change, and an
 * in-session "Change my password" exists on the account screen.
 *
 *     node scripts/site18-ui.mjs --assert     the full lane (builds, serves, tests, tears down)
 *
 * Why a live lane. The gate reads `user_metadata.must_change_password` from a
 * real session, and the password change goes through GoTrue, so a fixture that
 * stubs either proves nothing about the thing members will meet.
 *
 * The one fixture is a throwaway account whose address is generated, never a
 * participant's. It is added to `member_allowlist` (the signup trigger refuses
 * anyone else), created through the admin API with the flag set, exercised in a
 * real browser, then removed in a `finally`. The lane reads the counts before and
 * after and fails if they differ, so a leaked fixture is a red run.
 *
 * Secrets: the management token comes from ~/.claude/secrets/obt-cdt-supabase.env
 * and the secret key is fetched at run time. Neither is written to disk or printed.
 */
import { execFileSync, spawn } from 'node:child_process'
import { readFileSync, mkdirSync, writeFileSync, unlinkSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { homedir } from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 4218
const BASE = `http://localhost:${PORT}/obt-cdt-site`
const SHOTS = path.join(REPO, 'scripts/.site18-shots')

function loadEnv() {
  const env = {}
  for (const line of readFileSync(path.join(homedir(), '.claude/secrets/obt-cdt-supabase.env'), 'utf8').split('\n')) {
    const m = line.match(/^(?:export\s+)?([A-Z0-9_]+)=(.*)$/)
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
  return env
}
const ENV = loadEnv()
const REF = ENV.OBT_CDT_SUPABASE_PROJECT_REF
const TOKEN = ENV.OBT_CDT_SUPABASE_ACCESS_TOKEN
const MGMT = 'https://api.supabase.com/v1/projects/' + REF
const MGMT_HEADERS = { Authorization: `Bearer ${TOKEN}`, 'User-Agent': 'curl/8', 'Content-Type': 'application/json' }

async function sql(query) {
  const r = await fetch(`${MGMT}/database/query`, { method: 'POST', headers: MGMT_HEADERS, body: JSON.stringify({ query }) })
  if (!r.ok) throw new Error(`sql ${r.status}: ${(await r.text()).slice(0, 200)}`)
  return r.json()
}

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? '   ok' : ' FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
}

async function counts() {
  const [row] = await sql('select (select count(*) from member_allowlist)::int a, (select count(*) from auth.users)::int u')
  return row
}

async function main() {
  mkdirSync(SHOTS, { recursive: true })
  let keys
  for (let attempt = 1; attempt <= 4; attempt++) {
    keys = await (await fetch(`${MGMT}/api-keys?reveal=true`, { headers: MGMT_HEADERS })).json()
    if (Array.isArray(keys)) break
    await new Promise((r) => setTimeout(r, 1500 * attempt))
  }
  const publishable = keys.find((k) => k.type === 'publishable')?.api_key
  const secret = keys.find((k) => k.type === 'secret')?.api_key
  if (!publishable || !secret) throw new Error('could not resolve keys')
  const URL_ = `https://${REF}.supabase.co`

  const before = await counts()
  console.log('before', before)

  execFileSync('npm', ['run', 'build'], {
    cwd: REPO,
    stdio: 'ignore',
    env: { ...process.env, VITE_BASE: '/obt-cdt-site/', VITE_SUPABASE_URL: URL_, VITE_SUPABASE_PUBLISHABLE_KEY: publishable },
  })
  const server = spawn('node', ['scripts/serve-dist.mjs', '--port', String(PORT)], { cwd: REPO, stdio: 'ignore' })
  await new Promise((r) => setTimeout(r, 1500))

  const rand = randomBytes(4).toString('hex')
  const email = `site18-qa-${rand}@example.org`
  const temp = `Temp-${randomBytes(6).toString('hex')}-x`
  const mine1 = `Mine-${randomBytes(6).toString('hex')}-one`
  const mine2 = `Mine-${randomBytes(6).toString('hex')}-two`
  let userId = null
  let userId2 = null
  const email2 = `site18-qb-${rand}@example.org`
  let browser = null

  try {
    await sql(`insert into member_allowlist (email, note, full_name) values ('${email}', 'site18-qa', 'Site18 QA')`)
    const created = await (
      await fetch(`${URL_}/auth/v1/admin/users`, {
        method: 'POST',
        headers: { apikey: secret, Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          password: temp,
          email_confirm: true,
          user_metadata: { full_name: 'Site18 QA', must_change_password: true },
        }),
      })
    ).json()
    userId = created.id
    check('fixture account created with the flag', Boolean(userId) && created.user_metadata?.must_change_password === true)

    browser = await chromium.launch()
    for (const [label, width] of [['desktop', 1280], ['phone', 390]]) {
      const ctx = await browser.newContext({ viewport: { width, height: 900 } })
      const page = await ctx.newPage()
      await page.goto(`${BASE}/portal`, { waitUntil: 'networkidle' })
      await page.fill('#portal-email', email)
      await page.fill('#portal-password', temp)
      await page.click('button[type=submit]')
      await page.waitForSelector('[data-portal-state="recovery"]', { timeout: 15000 })
      const body = await page.innerText('body')
      check(`${label}: forced card shown after sign-in`, /Choose your own password/.test(body))
      // The member shell prints the signed-in address in its bar; the gate must not.
      check(`${label}: no member shell behind the gate`, !body.includes(email))
      const over = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1)
      check(`${label}: no horizontal overflow on the forced card`, !over)
      await page.screenshot({ path: path.join(SHOTS, `forced-${label}.png`), fullPage: true })

      if (label === 'phone') {
        await page.fill('#portal-recovery-password', 'short')
        await page.fill('#portal-recovery-confirm', 'short')
        await page.evaluate(() => document.querySelectorAll('input').forEach((i) => i.removeAttribute('minlength')))
        await page.click('button[type=submit]')
        check('too-short password is refused client-side', /too short/i.test(await page.innerText('body')))
        await page.fill('#portal-recovery-password', mine1)
        await page.fill('#portal-recovery-confirm', mine1 + 'x')
        await page.click('button[type=submit]')
        check('mismatched passwords are refused', /not the same/i.test(await page.innerText('body')))
        await page.fill('#portal-recovery-password', mine1)
        await page.fill('#portal-recovery-confirm', mine1)
        await page.click('button[type=submit]')
        await page.waitForFunction(() => !document.querySelector('[data-portal-state="recovery"]') && !document.querySelector('[data-portal-state="recovery-done"]'), null, { timeout: 15000 })
        const after = await page.innerText('body')
        check('gate lifts after a good password', !/Choose your own password/.test(after) && after.includes(email))
        await page.reload({ waitUntil: 'networkidle' })
        check('reload stays signed in with no gate', !(await page.locator('[data-portal-state="recovery"]').count()))

        await page.goto(`${BASE}/portal/account`, { waitUntil: 'networkidle' })
        await page.waitForSelector('[data-site18-change-password]', { timeout: 15000 })
        check('account screen offers Change my password', (await page.locator('[data-site18-change-password]').count()) === 1)
        await page.click('[data-site18-change-password]')
        await page.waitForSelector('#portal-recovery-password')
        await page.screenshot({ path: path.join(SHOTS, 'voluntary-phone.png'), fullPage: true })
        await page.fill('#portal-recovery-password', mine2)
        await page.fill('#portal-recovery-confirm', mine2)
        await page.click('button[type=submit]')
        await page.waitForSelector('[data-portal-state="recovery-done"]', { timeout: 15000 })
        check('voluntary change confirms', (await page.locator('[data-portal-state="recovery-done"]').count()) === 1)
        await page.click('text=Back to your portal')
        await page.waitForTimeout(500)
        check('voluntary change did not raise the forced gate', !(await page.locator('[data-portal-state="recovery"]').count()))
      }
      await ctx.close()
    }

    // The UPDATE path of scripts/issue-temp-passwords.mjs, which is how the real cohort is
    // reached (their accounts exist already, some unconfirmed). Fixture 2 is created
    // UNCONFIRMED with a password nobody knows, the script is run on it for real, and the
    // password it issues must sign in and land on the forced card.
    await sql(`insert into member_allowlist (email, note, full_name) values ('${email2}', 'site18-qa', 'Site18 QB')`)
    const c2 = await (
      await fetch(`${URL_}/auth/v1/admin/users`, {
        method: 'POST',
        headers: { apikey: secret, Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email2, password: `Nobody-${randomBytes(8).toString('hex')}`, email_confirm: false }),
      })
    ).json()
    userId2 = c2.id
    const listFile = path.join(tmpdir(), `site18-list-${rand}.txt`)
    const credFile = path.join(tmpdir(), `site18-creds-${rand}.csv`)
    writeFileSync(listFile, email2 + '\n')
    try {
      const out = execFileSync('node', ['scripts/issue-temp-passwords.mjs', '--emails', listFile, '--out', credFile, '--apply'], { cwd: REPO, encoding: 'utf8' })
      check('issue script updates an existing unconfirmed account', /updated 1/.test(out))
      check('issue script never prints the password', !out.includes(readFileSync(credFile, 'utf8').split('\n')[1].split(',')[1]))
      const issued = readFileSync(credFile, 'utf8').split('\n')[1].split(',')[1]
      const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 900 } })
      const p2 = await ctx2.newPage()
      await p2.goto(`${BASE}/portal`, { waitUntil: 'networkidle' })
      await p2.fill('#portal-email', email2)
      await p2.fill('#portal-password', issued)
      await p2.click('button[type=submit]')
      await p2.waitForSelector('[data-portal-state="recovery"]', { timeout: 15000 })
      check('an issued password signs in and lands on the forced card', /Choose your own password/.test(await p2.innerText('body')))
      await ctx2.close()
    } finally {
      for (const f of [listFile, credFile]) if (existsSync(f)) unlinkSync(f)
    }

    // The third context signs in fresh: only the newest password may work.
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    const page = await ctx.newPage()
    for (const [pw, shouldWork, what] of [[temp, false, 'temporary password'], [mine1, false, 'first chosen password'], [mine2, true, 'newest password']]) {
      await page.goto(`${BASE}/portal`, { waitUntil: 'networkidle' })
      await page.fill('#portal-email', email)
      await page.fill('#portal-password', pw)
      await page.click('button[type=submit]')
      await page.waitForTimeout(3500)
      const t = await page.innerText('body')
      const worked = t.includes(email) && !/Choose your own password/.test(t)
      check(`fresh sign-in with ${what} ${shouldWork ? 'works' : 'is refused'}`, worked === shouldWork)
      if (worked) {
        await page.screenshot({ path: path.join(SHOTS, 'signed-in-1280.png') })
        await page.click('text=Sign out')
      }
    }
    await ctx.close()
  } finally {
    if (browser) await browser.close()
    server.kill()
    if (userId) {
      await fetch(`${URL_}/auth/v1/admin/users/${userId}`, { method: 'DELETE', headers: { apikey: secret, Authorization: `Bearer ${secret}` } })
    }
    if (userId2) {
      await fetch(`${URL_}/auth/v1/admin/users/${userId2}`, { method: 'DELETE', headers: { apikey: secret, Authorization: `Bearer ${secret}` } })
    }
    await sql(`delete from member_allowlist where email in ('${email}', '${email2}')`)
    const after = await counts()
    console.log('after', after)
    check('fixture fully removed (counts unchanged)', after.a === before.a && after.u === before.u)
  }

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => {
  console.error('lane error:', e.message)
  process.exit(2)
})
