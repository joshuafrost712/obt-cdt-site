/**
 * SITE-01: provision the evaluation harness's accounts, and run its SQL.
 *
 *   node scripts/site01-fixtures.mjs --setup
 *   node scripts/site01-fixtures.mjs --run
 *   node scripts/site01-fixtures.mjs --teardown
 *
 * ## Its own lane, and that is not a style choice
 *
 * The 2026-08-27 coherence review found SITE-03 provisioning its fixtures from
 * `cdt04-fixtures.mjs`, whose `PREFIX` and `PASSWORD` are module constants, so a
 * `site03-gate-` account could never have come out of it. This file therefore
 * owns its own prefix, `site01-rls-`, and its own password, and imports nothing
 * from another spec's fixture script.
 *
 * Program finding 13's rule also applies: a LIKE prefix is a prefix, so
 * `site01-rls-` must not be a prefix of any other lane's. It is not.
 *
 * ## The instrument rows are EPHEMERAL, and that is D0's answer
 *
 * `Session-Map.md` and `Question-Set.md` are both `signed_off: false`, so nothing
 * durable is written from them. `--run` asks the seed for its rows with
 * `--emit-sql`, posts them inside `begin; … rollback;` along with the fixtures and
 * the assertions, and the whole thing disappears. Reusing the seed's own parser
 * and gate rather than writing a second one is the 41-chances-to-mis-key failure
 * `seed_bundles.py` exists to prevent.
 *
 * ## What IS durable, and what teardown therefore has to remove
 *
 * Two things, and the second is easy to forget. The six accounts in `auth.users`
 * and their `profiles` rows. AND the six `member_allowlist` rows, because
 * `handle_new_portal_user()` refuses a registration whose address is not
 * allowlisted, so the accounts cannot be created without allowlisting them first.
 * A teardown that removes the accounts and leaves the allowlist has left six
 * fixture addresses able to register on the live portal.
 */
import { readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'

const REPO = path.resolve(import.meta.dirname, '..')
const PREFIX = 'site01-rls-'
const PASSWORD = 'site01-evaluation-fixture-passphrase'

const FORBIDDEN_REFS = {
  vdbirmjvjzfdgajwgowj: 'Honest Eval (repo `cairn`)',
  ckorlrchryswnnrmuctr: 'the Local Genres Research app',
}

// Six accounts. `reader` is the load-bearing one: a facilitator who is in
// evaluation_reader and is NOT oversight, which is the only fixture that can
// prove criterion 10's sentence, that the two functions are the whole facilitator
// surface and the base tables are closed to them.
const ROLES = {
  participant: 'SITE-01 participant A',
  second: 'SITE-01 participant B',
  reader: 'SITE-01 evaluation reader, not oversight',
  headmentor: 'SITE-01 head mentor',
  admin: 'SITE-01 portal admin',
  outsider: 'SITE-01 member who is not in the round',
}

const addr = (role) => `${PREFIX}${role}@example.org`
const q = (s) => (s === null || s === undefined ? 'null' : `'${String(s).replace(/'/g, "''")}'`)

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
  if (FORBIDDEN_REFS[ref]) {
    console.error(`REFUSED: ${ref} is ${FORBIDDEN_REFS[ref]}, a different product.`)
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

async function authApi(method, pathname, body) {
  const res = await fetch(`${url}/auth/v1${pathname}`, {
    method,
    headers: { apikey: secret, Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`auth ${method} ${pathname} → ${res.status}: ${text}`)
  return text ? JSON.parse(text) : {}
}

// --------------------------------------------------------------------------- setup

async function setup() {
  const values = Object.keys(ROLES)
    .map((r) => `(${q(addr(r))}, ${q('SITE-01 fixture; delete with --teardown')})`)
    .join(', ')
  // Step 1. Without this, handle_new_portal_user() raises insufficient_privilege
  // on the auth.users insert and no account can be made.
  await sql(
    `insert into public.member_allowlist (email, note) values ${values} on conflict (email) do nothing`,
  )

  const existing = await authApi('GET', '/admin/users?per_page=200')
  const byEmail = new Map((existing.users ?? []).map((u) => [u.email, u.id]))
  const ids = {}
  for (const role of Object.keys(ROLES)) {
    const a = addr(role)
    if (byEmail.has(a)) {
      ids[role] = byEmail.get(a)
      continue
    }
    // Step 2. A CONFIRMED account through the admin API. A SQL-inserted user has
    // no usable password hash and can never sign in, which would split the SQL
    // lane from any future browser lane.
    const u = await authApi('POST', '/admin/users', {
      email: a,
      password: PASSWORD,
      email_confirm: true,
    })
    ids[role] = u.id
  }
  for (const [role, name] of Object.entries(ROLES)) {
    await sql(
      `update public.profiles set full_name = ${q(name)}, org = 'Fixture' where id = ${q(ids[role])}`,
    )
  }
  const [n] = await sql(
    `select count(*)::int as n from public.profiles where email like ${q(PREFIX + '%')}`,
  )
  console.log(`setup: ${Object.keys(ROLES).length} confirmed accounts, ${n.n} profiles`)
  console.log(Object.entries(ids).map(([r, id]) => `  ${r.padEnd(12)} ${id}`).join('\n'))
  return ids
}

// --------------------------------------------------------------------------- run

async function run() {
  const [profiles] = await sql(
    `select count(*)::int as n from public.profiles where email like ${q(PREFIX + '%')}`,
  )
  if (profiles.n !== Object.keys(ROLES).length) {
    console.error(
      `REFUSED: expected ${Object.keys(ROLES).length} ${PREFIX} profiles, found ${profiles.n}. ` +
        'Run --setup first. A harness that runs on a missing fixture set iterates an ' +
        'empty population and prints success, which is the highest-yield defect class ' +
        'in this campaign.',
    )
    process.exit(1)
  }

  // The instrument, from the seed's own gate and parser. If the contracts fail
  // their gate, the run stops here rather than asserting against nothing.
  const seedSql = path.join(tmpdir(), 'site01-seed.sql')
  try {
    execFileSync(
      'python3',
      [
        path.join(REPO, 'scripts/seed_evaluation_instrument.py'),
        '--allow-unsigned-session-map',
        '--emit-sql',
        seedSql,
      ],
      { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] },
    )
  } catch (e) {
    console.error(`the seed refused, so nothing was asserted:\n${e.stderr?.toString() ?? e}`)
    process.exit(1)
  }

  const composed = [
    'begin;',
    readFileSync(seedSql, 'utf8'),
    readFileSync(path.join(REPO, 'scripts/site01-rls-tests.sql'), 'utf8'),
    'rollback;',
  ].join('\n')

  const rows = await sql(composed)
  report(rows)
}

function report(rows) {
  const results = Array.isArray(rows) ? rows.filter((r) => r && r.verdict) : []
  if (!results.length) {
    console.error('no result rows came back. The transaction produced no report, which is a failure.')
    console.error(JSON.stringify(rows).slice(0, 2000))
    process.exit(1)
  }
  let pass = 0
  let fail = 0
  let note = 0
  let section = null
  for (const r of results) {
    if (r.section !== section) {
      section = r.section
      console.log(`\n${section}`)
    }
    if (r.verdict === 'PASS') pass++
    else if (r.verdict === 'FAIL') fail++
    else note++
    const mark = r.verdict === 'PASS' ? '  ok  ' : r.verdict === 'FAIL' ? ' FAIL ' : ' note '
    console.log(`${mark}${r.label}${r.outcome ? `  [${r.outcome}]` : ''}`)
  }
  console.log(`\n${pass} pass, ${fail} fail, ${note} note`)
  if (fail) process.exit(1)
}

// --------------------------------------------------------------------------- teardown

async function teardown() {
  // Every table this spec owns, scoped to the lane. The instrument rows were
  // never committed, so this is about accounts and anything a --run that died
  // before its rollback might have left.
  const scope = `(select id from public.profiles where email like ${q(PREFIX + '%')})`
  const counts = await sql(`
    select 'evaluation_answer' as t, count(*)::int as n from public.evaluation_answer a
      join public.evaluation_response r on r.id = a.response_id where r.profile_id in ${scope}
    union all select 'evaluation_item_rating', count(*)::int from public.evaluation_item_rating x
      join public.evaluation_response r on r.id = x.response_id where r.profile_id in ${scope}
    union all select 'evaluation_response', count(*)::int from public.evaluation_response where profile_id in ${scope}
    union all select 'evaluation_participant', count(*)::int from public.evaluation_participant where profile_id in ${scope}
    union all select 'evaluation_reader', count(*)::int from public.evaluation_reader where profile_id in ${scope}
    union all select 'head_mentor', count(*)::int from public.head_mentor where profile_id in ${scope}
    union all select 'portal_admin', count(*)::int from public.portal_admin where profile_id in ${scope}
  `)
  console.log('surviving rows before teardown:')
  for (const c of counts) console.log(`  ${c.t.padEnd(24)} ${c.n}`)

  await sql(`
    delete from public.evaluation_answer a using public.evaluation_response r
      where r.id = a.response_id and r.profile_id in ${scope};
    delete from public.evaluation_item_rating x using public.evaluation_response r
      where r.id = x.response_id and r.profile_id in ${scope};
    delete from public.evaluation_response where profile_id in ${scope};
    delete from public.evaluation_participant where profile_id in ${scope};
    delete from public.evaluation_reader where profile_id in ${scope};
    delete from public.head_mentor where profile_id in ${scope};
    delete from public.portal_admin where profile_id in ${scope};
  `)

  const list = await authApi('GET', '/admin/users?per_page=200')
  let removed = 0
  for (const u of list.users ?? []) {
    if (u.email?.startsWith(PREFIX)) {
      await authApi('DELETE', `/admin/users/${u.id}`)
      removed++
    }
  }
  // The half a teardown forgets. Leaving these behind leaves six fixture
  // addresses able to register on the live portal.
  const [al] = await sql(
    `with d as (delete from public.member_allowlist where email like ${q(PREFIX + '%')} returning 1)
     select count(*)::int as n from d`,
  )
  console.log(`teardown: ${removed} account(s), ${al.n} allowlist row(s) removed`)

  const after = await sql(`
    select 'profiles' as t, count(*)::int as n from public.profiles where email like ${q(PREFIX + '%')}
    union all select 'member_allowlist', count(*)::int from public.member_allowlist where email like ${q(PREFIX + '%')}
  `)
  for (const a of after) console.log(`  ${a.t.padEnd(24)} ${a.n} remaining`)
  if (after.some((a) => a.n !== 0)) process.exit(1)
}

// ---------------------------------------------------------------------------

const mode = process.argv[2]
if (mode === '--setup') await setup()
else if (mode === '--run') await run()
else if (mode === '--teardown') await teardown()
else {
  console.error('usage: node scripts/site01-fixtures.mjs --setup | --run | --teardown')
  process.exit(2)
}
