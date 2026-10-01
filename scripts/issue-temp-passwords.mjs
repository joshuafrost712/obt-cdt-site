#!/usr/bin/env node
/**
 * SITE-18: issue a temporary password, with the first-login flag, to named members.
 *
 *     node scripts/issue-temp-passwords.mjs --emails /path/list.txt --out /path/creds.csv          dry run
 *     node scripts/issue-temp-passwords.mjs --emails /path/list.txt --out /path/creds.csv --apply  do it
 *
 * Why this exists beside create_portal_accounts.py. That script skips an address
 * that already has an account, but most of the cohort has one (created 2026-09-03,
 * password never read), so the job is an UPDATE of password and flag, not a create.
 * An address with no account is created here too, provided it is on
 * `member_allowlist` (the signup trigger refuses anyone else).
 *
 * Rules, each enforced below rather than left to care:
 *   - the address list and the credential file live OUTSIDE any git working tree;
 *     the script refuses a path that resolves inside one;
 *   - passwords are never printed, only written to the 0600 credential file;
 *   - stdout masks addresses;
 *   - the default is a dry run that writes nothing.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, appendFileSync, writeFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { randomInt } from 'node:crypto'

const args = process.argv.slice(2)
const flag = (n) => args.includes(n)
const val = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined)
const emailsPath = val('--emails')
const outPath = val('--out')
const apply = flag('--apply')
if (!emailsPath || !outPath) {
  console.error('usage: --emails FILE --out FILE [--apply]')
  process.exit(2)
}

function refuseIfInGit(p) {
  let dir = path.dirname(path.resolve(p))
  while (!existsSync(dir)) dir = path.dirname(dir)
  try {
    execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { stdio: 'pipe' })
  } catch {
    return
  }
  console.error(`refusing: ${p} is inside a git working tree`)
  process.exit(2)
}
refuseIfInGit(emailsPath)
refuseIfInGit(outPath)

const env = {}
for (const line of readFileSync(path.join(homedir(), '.claude/secrets/obt-cdt-supabase.env'), 'utf8').split('\n')) {
  const m = line.match(/^(?:export\s+)?([A-Z0-9_]+)=(.*)$/)
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}
const REF = env.OBT_CDT_SUPABASE_PROJECT_REF
const MGMT = `https://api.supabase.com/v1/projects/${REF}`
const MH = { Authorization: `Bearer ${env.OBT_CDT_SUPABASE_ACCESS_TOKEN}`, 'User-Agent': 'curl/8', 'Content-Type': 'application/json' }
let keyRes
let keys
for (let attempt = 1; attempt <= 4; attempt++) {
  // The management API answers an occasional transient 500 (seen 2026-10-01).
  keyRes = await fetch(`${MGMT}/api-keys?reveal=true`, { headers: MH })
  keys = await keyRes.json()
  if (Array.isArray(keys)) break
  await new Promise((r) => setTimeout(r, 1500 * attempt))
}
if (!Array.isArray(keys)) {
  console.error(`could not read the project keys: HTTP ${keyRes.status} ${JSON.stringify(keys).slice(0, 160)}`)
  process.exit(1)
}
const secret = keys.find((k) => k.type === 'secret')?.api_key
const AUTH = `https://${REF}.supabase.co/auth/v1/admin`
const AH = { apikey: secret, Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' }
const sql = async (query) => (await fetch(`${MGMT}/database/query`, { method: 'POST', headers: MH, body: JSON.stringify({ query }) })).json()

// Readable and dictation-safe, like create_portal_accounts.py. Three words, two digits.
const WORDS = 'amber basil birch cedar clover coral dune ember fern fig flint garnet hazel iris jade juniper kelp lark maple mesa moss olive pine quartz reed river sage slate spruce thyme tide willow wren yarrow'.split(' ')
const pick = () => WORDS[randomInt(WORDS.length)]
const passphrase = () => `${pick()}-${pick()}-${pick()}-${randomInt(10, 100)}`
const mask = (e) => e.replace(/^(.{2}).*@/, '$1***@')

const emails = readFileSync(emailsPath, 'utf8').split('\n').map((l) => l.trim().toLowerCase()).filter((l) => /@/.test(l))
const users = new Map()
for (let page = 1; ; page++) {
  const r = await (await fetch(`${AUTH}/users?page=${page}&per_page=200`, { headers: AH })).json()
  for (const u of r.users ?? []) users.set((u.email ?? '').toLowerCase(), u)
  if (!r.users || r.users.length < 200) break
}
const allow = new Set((await sql('select lower(email) e from member_allowlist')).map((r) => r.e))

if (apply) writeFileSync(outPath, 'email,temporary_password\n', { mode: 0o600, flag: 'wx' })
let updated = 0
let created = 0
let skipped = 0
for (const email of emails) {
  const existing = users.get(email)
  if (!existing && !allow.has(email)) {
    console.log(`  skip ${mask(email)}: no account and not on the allowlist`)
    skipped++
    continue
  }
  const password = passphrase()
  if (!apply) {
    console.log(`  would ${existing ? 'update' : 'create'} ${mask(email)}${existing ? (existing.email_confirmed_at ? ' (confirmed)' : ' (UNCONFIRMED: will be confirmed)') : ''}`)
    continue
  }
  const meta = { ...(existing?.user_metadata ?? {}), must_change_password: true }
  const res = existing
    ? await fetch(`${AUTH}/users/${existing.id}`, { method: 'PUT', headers: AH, body: JSON.stringify({ password, email_confirm: true, user_metadata: meta }) })
    : await fetch(`${AUTH}/users`, { method: 'POST', headers: AH, body: JSON.stringify({ email, password, email_confirm: true, user_metadata: meta }) })
  if (!res.ok) {
    console.log(`  FAILED ${mask(email)}: ${res.status}`)
    continue
  }
  existing ? updated++ : created++
  appendFileSync(outPath, `${email},${password}\n`)
  console.log(`  ${existing ? 'updated' : 'created'} ${mask(email)}`)
}
console.log(`\n${apply ? 'applied' : 'dry run'}: updated ${updated}, created ${created}, skipped ${skipped}, listed ${emails.length}`)
