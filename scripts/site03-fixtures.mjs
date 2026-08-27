/**
 * Provision and tear down SITE-03's one fixture: a member who can sign in.
 *
 *   node scripts/site03-fixtures.mjs --setup
 *   node scripts/site03-fixtures.mjs --print-ids
 *   node scripts/site03-fixtures.mjs --teardown
 *
 * ## Why this file exists rather than a call into cdt04-fixtures.mjs
 *
 * SITE-04 finding 13, and it cost that spec half its estimate rise:
 * `cdt04-fixtures.mjs` is a TEMPLATE, not a caller. Its `PREFIX` and `PASSWORD`
 * are module constants, so a `site03-gate-` account cannot come out of it. What
 * is inherited is the shape of the chain, not the code.
 *
 * ## The chain, and it is two steps rather than CDT-04's five
 *
 * This spec needs a signed-in member and nothing else — no consultant, no
 * qualification, no assignment, no instrument. So:
 *
 *   1. a `member_allowlist` row, or `handle_new_portal_user()` raises
 *      insufficient_privilege on the auth.users insert;
 *   2. a CONFIRMED auth user through the Auth admin API, because a SQL-inserted
 *      account has no usable password and cannot sign in.
 *
 * Steps 3 to 5 of CDT-04's chain are about assessment rows, and a member page is
 * readable by any signed-in member by decision 1, so there is nothing to qualify.
 * That is the decision made visible: if the audience were ever scoped per cohort,
 * this file would grow a third step, which is the honest measure of what that
 * change would cost.
 *
 * ## The prefix is `site03-gate-`, never `site03-`
 *
 * Sibling finding 13. A LIKE prefix is a prefix, and cairn's tl05 teardown header
 * records two harnesses in one spec deleting each other's accounts.
 *
 * ## What it does NOT touch
 *
 * `member_page` and `member_block`. Those hold the real seeded document, written
 * from the vault, and a teardown that cleared them would leave the build gate
 * with a member page and no body and the next build red for the wrong reason.
 * The only rows this file owns are one allowlist address and one auth user.
 */
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import path from 'node:path'

const REPO = path.resolve(import.meta.dirname, '..')
const IDS_FILE = path.join(REPO, 'scripts/.site03-fixture-ids.json')

const FORBIDDEN_REFS = {
  vdbirmjvjzfdgajwgowj: 'Honest Eval (repo `cairn`), a different product',
  ckorlrchryswnnrmuctr: 'the Local Genres Research app, a different project again',
}

const PREFIX = 'site03-gate-'
const ROLES = { member: 'Fixture Member' }
const ADDR = (role) => `${PREFIX}${role}@example.org`
// Fixture-only and above the project's 12-character minimum, which CDT-00 D5
// raised from 6 on 2026-08-21.
const PASSWORD = 'site03-gate-fixture-passphrase'

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
  const missing = [
    ['OBT_CDT_SUPABASE_PROJECT_REF', ref],
    ['OBT_CDT_SUPABASE_ACCESS_TOKEN', token],
    ['OBT_CDT_SUPABASE_SECRET_KEY', secret],
    ['OBT_CDT_SUPABASE_URL', url],
  ].filter(([, v]) => !v)
  if (missing.length) {
    console.error(`empty in ${file}: ${missing.map(([k]) => k).join(', ')}`)
    process.exit(2)
  }
  if (FORBIDDEN_REFS[ref]) {
    console.error(`REFUSED: ${ref} is ${FORBIDDEN_REFS[ref]}.`)
    process.exit(1)
  }
  return { ref, token, secret, url }
}

const { ref, token, secret, url } = creds()

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

/** The Auth admin API, with the service key. Never logged. */
async function auth(method, pathname, body) {
  const res = await fetch(`${url}/auth/v1${pathname}`, {
    method,
    headers: { apikey: secret, Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`auth ${method} ${pathname} → ${res.status}: ${text}`)
  return text ? JSON.parse(text) : {}
}

const q = (s) => `'${String(s).replace(/'/g, "''")}'`

async function setup() {
  console.log('--- 1. member_allowlist rows (needed before any auth user)')
  const values = Object.keys(ROLES)
    .map((r) => `(${q(ADDR(r))}, ${q('SITE-03 gate fixture; delete with --teardown')})`)
    .join(', ')
  await sql(`insert into public.member_allowlist (email, note) values ${values} on conflict (email) do nothing`)

  console.log('--- 2. confirmed auth users')
  const ids = {}
  const existing = await auth('GET', '/admin/users?per_page=200')
  const byEmail = new Map((existing.users ?? []).map((u) => [u.email, u.id]))
  for (const role of Object.keys(ROLES)) {
    const addr = ADDR(role)
    if (byEmail.has(addr)) {
      ids[role] = byEmail.get(addr)
      console.log(`  ${addr} already exists`)
      continue
    }
    const user = await auth('POST', '/admin/users', { email: addr, password: PASSWORD, email_confirm: true })
    ids[role] = user.id
    console.log(`  ${addr} created`)
  }
  for (const [role, name] of Object.entries(ROLES)) {
    await sql(`update public.profiles set full_name = ${q(name)}, org = ${q('Fixture')} where id = ${q(ids[role])}`)
  }

  writeFileSync(IDS_FILE, JSON.stringify({ prefix: PREFIX, password: PASSWORD, ids }, null, 2) + '\n')
  console.log(`\nwrote ${path.relative(REPO, IDS_FILE)}`)
}

async function teardown() {
  console.log('--- deleting fixture auth users (profiles cascade)')
  const list = await auth('GET', '/admin/users?per_page=200')
  for (const user of list.users ?? []) {
    if (user.email?.startsWith(PREFIX)) {
      await auth('DELETE', `/admin/users/${user.id}`)
      console.log(`  deleted auth user ${user.email}`)
    }
  }
  await sql(`delete from public.profiles where email like ${q(PREFIX + '%')}`)

  // Named addresses, never a pattern over the table: the rest of
  // member_allowlist is the real cohort roster and this harness never reads it.
  const addrs = Object.keys(ROLES).map((r) => q(ADDR(r))).join(', ')
  await sql(`delete from public.member_allowlist where email in (${addrs})`)
  console.log(`  cleared member_allowlist for exactly ${Object.keys(ROLES).length} fixture address(es)`)

  console.log('\n--- surviving fixture rows, counted per table')
  const [left] = await sql(
    `select
       (select count(*) from public.profiles where email like ${q(PREFIX + '%')}) as profiles,
       (select count(*) from public.member_allowlist where email in (${addrs})) as allowlist,
       (select count(*) from auth.users where email like ${q(PREFIX + '%')}) as auth_users`,
  )
  let dirty = 0
  for (const [table, count] of Object.entries(left)) {
    console.log(`  ${String(count).padStart(4)}  ${table}`)
    if (Number(count) !== 0) dirty++
  }

  // The seeded member document is deliberately NOT counted as dirt. It is the
  // real page, written from the vault, and the build gate needs it.
  const [kept] = await sql(
    'select (select count(*) from public.member_page) as member_page,' +
      ' (select count(*) from public.member_block) as member_block',
  )
  console.log(`\n  kept, and not fixture rows: member_page ${kept.member_page}, member_block ${kept.member_block}`)

  if (existsSync(IDS_FILE)) unlinkSync(IDS_FILE)
  if (dirty) {
    console.log(`\nteardown INCOMPLETE: ${dirty} table(s) still hold fixture rows`)
    process.exit(1)
  }
  console.log('\nteardown clean.')
}

const mode = process.argv[2]
if (mode === '--setup') await setup()
else if (mode === '--teardown') await teardown()
else if (mode === '--print-ids') {
  if (!existsSync(IDS_FILE)) {
    console.error('no fixtures; run --setup')
    process.exit(2)
  }
  console.log(readFileSync(IDS_FILE, 'utf8'))
} else {
  console.error('usage: node scripts/site03-fixtures.mjs --setup | --print-ids | --teardown')
  process.exit(2)
}
