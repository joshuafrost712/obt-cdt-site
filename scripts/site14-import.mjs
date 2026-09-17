/**
 * SITE-14: an administrator imports a report and the person it is about reads it.
 *
 *   node scripts/site14-import.mjs --setup       # fixtures, idempotent
 *   node scripts/site14-import.mjs --assert --sql # the SQL lane (criteria 1-6, 15, 16, 17)
 *   node scripts/site14-import.mjs --assert       # the browser lane (criteria 7, 8, 10, 14)
 *   node scripts/site14-import.mjs --teardown --verify
 *
 * ## What this proves
 *
 * `publication` could hold a report since August and had no way to receive one:
 * INSERT belongs to `postgres` and `service_role` only, with no insert policies,
 * so a client write fails at the grant with 42501 before any policy is consulted.
 * These lanes prove the two definer functions that open that path are gated,
 * ordered, and dedupe correctly.
 *
 * ## The gate ordering is asserted behaviourally, never by reading the text
 *
 * CDT-10's criterion 9 found that a function testing its precondition before its
 * admin gate passes a test that only asserts "an exception was raised" with the
 * gate deleted. So every gate assertion here calls with a deliberately INVALID
 * argument as a non-administrator and requires `insufficient_privilege` back
 * rather than the argument error. Program finding 60 is the other half of that
 * lesson: `pg_get_functiondef` returns comments, so a text grep is defeated by
 * prose, and the criteria that do read the definition assert two-sided.
 *
 * The invalid argument is an EMPTY `recipient_email`, chosen because it is
 * well-typed and fails the function's own in-body check. A type-mismatched or
 * missing argument is rejected by PostgREST or Postgres before the body runs at
 * all and would read as a false red.
 *
 * ## Mutations (contract c1)
 *
 *   1. Remove the is_portal_admin() gate in import_publication_manual()
 *      → criterion 2 fails: a row is written by a non-administrator, and the
 *        invalid-argument call returns the argument error instead.
 *   2. Remove lower(btrim()) from the publication_key expression
 *      → criterion 4 fails: ' A@B.org ' inserts a second row for doc-1.
 *   3. Restore the naive || form in the publication_key expression
 *      → criterion 4 fails on the FIRST import with 23502, because
 *        publication_key is text not null unique.
 *   4. Remove the amPortalAdmin() refusal branch on the import page
 *      → criterion 7 fails: form fields present for a non-admin fixture.
 *   5. Remove the confirm step so the first submit writes directly
 *      → criterion 14 fails: publication incremented on the unconfirmed submit.
 *   6. Remove the is_portal_admin() gate in resolve_import_recipient()
 *      → criterion 17 fails: a non-administrator receives a roster row.
 *   7. Move the allowlist check above the admin gate
 *      → criterion 16's ordering arm fails: the non-administrator call returns
 *        the allowlist errcode instead of insufficient_privilege.
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

const ARGV = process.argv.slice(2)
const SETUP = ARGV.includes('--setup')
const ASSERT = ARGV.includes('--assert')
const SQL_LANE = ARGV.includes('--sql')
const TEARDOWN = ARGV.includes('--teardown')
const VERIFY = ARGV.includes('--verify')
if (!SETUP && !ASSERT && !TEARDOWN) {
  console.error('usage: node scripts/site14-import.mjs [--setup | --assert [--sql] | --teardown --verify]')
  process.exit(2)
}

const PREFIX = 'site14-imp-'
const PASSWORD = 'Site14-Fixture-Pass-2026x'
const PORT = 4205
const BASE = `http://localhost:${PORT}/obt-cdt-site`
const SHOTS = 'feedback/site14-shots'
const IDS_FILE = 'scripts/.site14-fixture-ids.json'

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

/**
 * The roster guard, program finding 68's two-part form. A fixture can only exist
 * if its address is on `member_allowlist` (handle_new_portal_user refuses any
 * other), so "never an allowlisted address" would block every fixture the lane
 * could use. The workable guard is the lane's own prefix AND absence from the
 * dated roster export, and it REFUSES when that export is absent rather than
 * passing an unprovable address.
 */
function rosterGuard(addr) {
  const roster = execFileSync('/bin/zsh', [
    '-c',
    `ls ${JSON.stringify(homedir())}/Documents/obt-cdt-allowlist-names-*.csv 2>/dev/null | tail -1`,
  ])
    .toString()
    .trim()
  if (!roster) {
    console.error('REFUSED: no roster export found; cannot prove this address is not a participant.')
    process.exit(1)
  }
  if (!addr.startsWith(PREFIX) || !addr.endsWith('@example.org')) {
    console.error(`REFUSED: ${addr} is not a lane fixture address.`)
    process.exit(1)
  }
  const body = readFileSync(roster, 'utf8').toLowerCase()
  if (body.includes(addr.toLowerCase())) {
    console.error(`REFUSED: ${addr} appears in the roster export.`)
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
  if (!res.ok) throw new Error(`sql ${res.status}: ${(await res.text()).slice(0, 300)}`)
  return res.json()
}

const q = (s) => `'${String(s).replace(/'/g, "''")}'`

const authApi = async (method, route, body) => {
  const res = await fetch(`${url}/auth/v1${route}`, {
    method,
    headers: {
      apikey: secret,
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  if (!res.ok && method !== 'DELETE') throw new Error(`auth ${method} ${route} ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return res.status === 204 ? {} : res.json().catch(() => ({}))
}

// The three fixtures. `admin` imports; `member_a` and `member_b` prove a member
// sees only their own; `noaccount` proves the unmatched-then-claimed path.
const ROLES = {
  admin: { name: 'Site14 Fixture Administrator' },
  member_a: { name: 'Site14 Fixture Member A' },
  member_b: { name: 'Site14 Fixture Member B' },
}
const addr = (role) => `${PREFIX}${role.replace(/_/g, '-')}@example.org`
const NOACCOUNT = `${PREFIX}noaccount@example.org`
const OFFLIST = `${PREFIX}offlist@example.org`

// The publishable key ships in the live bundle by design, so the lane reads it
// from there and stores no key of its own.
async function publishable() {
  const idx = await (await fetch('https://joshuafrost712.github.io/obt-cdt-site/')).text()
  const entry = /assets\/(index-[A-Za-z0-9_-]+\.js)/.exec(idx)?.[1]
  const bundle = await (await fetch(`https://joshuafrost712.github.io/obt-cdt-site/assets/${entry}`)).text()
  const key = /sb_publishable_[A-Za-z0-9_-]+/.exec(bundle)?.[0]
  const projectUrl = /https:\/\/[a-z]+\.supabase\.co/.exec(bundle)?.[0]
  if (!key || !projectUrl) {
    console.error('REFUSED: could not read the publishable key or project URL from the live bundle.')
    process.exit(2)
  }
  return { key, projectUrl }
}

/** Sign in as a fixture and return a PostgREST caller bound to that session. */
async function asUser(email, pubKey) {
  const res = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: pubKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  })
  const body = await res.json()
  if (!body.access_token) throw new Error(`sign-in failed for ${email}: ${JSON.stringify(body).slice(0, 200)}`)
  const jwt = body.access_token
  return {
    async rpc(fn, args) {
      const r = await fetch(`${url}/rest/v1/rpc/${fn}`, {
        method: 'POST',
        headers: { apikey: pubKey, Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(args ?? {}),
      })
      return { status: r.status, body: await r.json().catch(() => null) }
    },
    async select(pathAndQuery) {
      const r = await fetch(`${url}/rest/v1/${pathAndQuery}`, {
        headers: { apikey: pubKey, Authorization: `Bearer ${jwt}` },
      })
      return { status: r.status, body: await r.json().catch(() => null) }
    },
  }
}

// ---------------------------------------------------------------------- setup

const COUNT_QUERY = `select
  (select count(*)::int from publication) as publication,
  (select count(*)::int from publication_event) as publication_event,
  (select count(*)::int from profiles) as profiles,
  (select count(*)::int from auth.users) as auth_users,
  (select count(*)::int from member_allowlist) as member_allowlist,
  (select count(*)::int from portal_admin) as portal_admin`

/**
 * How much of THIS LANE is on the project, counted by prefix rather than by a
 * total. It answers "is anything of ours still here?", which is the question
 * criterion 11 actually asks and the one that cannot drift with the world: the
 * baseline comparison moves the day a real report is imported, this does not.
 */
const RESIDUE_QUERY = `select
  (select count(*)::int from publication where recipient_email like '${PREFIX}%') as publication,
  (select count(*)::int from auth.users where email like '${PREFIX}%') as auth_users,
  (select count(*)::int from profiles where email like '${PREFIX}%') as profiles,
  (select count(*)::int from member_allowlist where email like '${PREFIX}%') as member_allowlist,
  (select count(*)::int from portal_admin pa join profiles p on p.id = pa.profile_id
     where p.email like '${PREFIX}%') as portal_admin`

async function setup() {
  console.log('=== setup')
  const roster = rosterGuard(addr('admin'))
  for (const a of [addr('member_a'), addr('member_b'), NOACCOUNT, OFFLIST]) rosterGuard(a)
  console.log(`  guard:     lane prefix + absence from ${roster}`)

  // The baseline is MEASURED here, before a single fixture is inserted, and not
  // written into the lane as a constant. Signing review finding 2: a hardcoded
  // `publication: 0` is falsified the day contract 2 has Joshua import a real
  // report, after which --teardown --verify fails permanently on two tables and
  // the contract's own re-verification can never go green again. A leak gate
  // that cries wolf gets ignored or hand-edited, which is how SITE-09's three
  // leaked rows went unnoticed in the first place.
  //
  // But a measurement is only a baseline when NOTHING of this lane is already on
  // the project, and setup is documented idempotent, so the ordinary
  // crash-recovery move is to run it again over residue. Re-review finding 1,
  // reproduced here: a second --setup measured profiles=25 with its own fixtures
  // present, overwrote the good file, and --teardown --verify then reported
  // 0 pass / 6 fail against a project that was exactly at D0. So residue is
  // counted first, and a baseline is never re-measured over it.
  const residue = (await sql(RESIDUE_QUERY))[0]
  const dirty = Object.values(residue).some((n) => n > 0)
  let baseline
  if (dirty) {
    const kept = existsSync(IDS_FILE) ? JSON.parse(readFileSync(IDS_FILE, 'utf8')).baseline : null
    if (!kept) {
      console.error(
        `REFUSED: lane fixtures are already on the project (${Object.entries(residue).map(([k, v]) => `${k}=${v}`).join(' ')}) ` +
          `and ${IDS_FILE} carries no baseline to keep. Run --teardown first, then --setup on a clean project.`,
      )
      process.exit(2)
    }
    baseline = kept
    console.log(`  baseline:  KEPT from ${IDS_FILE}; not re-measured, because lane residue is present`)
    console.log(`             residue: ${Object.entries(residue).map(([k, v]) => `${k}=${v}`).join(' ')}`)
  } else {
    baseline = (await sql(COUNT_QUERY))[0]
    console.log(`  baseline:  ${Object.entries(baseline).map(([k, v]) => `${k}=${v}`).join(' ')}`)
  }

  // The allowlist rows, with their attested names. NOACCOUNT is on the list
  // because handle_new_portal_user() refuses anything else, so criterion 5's
  // second half could not otherwise run. OFFLIST is deliberately NOT added.
  const values = [
    ...Object.entries(ROLES).map(([r, v]) => `(${q(addr(r))}, ${q('SITE-14 fixture; delete with --teardown')}, ${q(v.name)})`),
    `(${q(NOACCOUNT)}, ${q('SITE-14 fixture; delete with --teardown')}, ${q('Site14 Fixture Late Registrant')})`,
  ].join(', ')
  await sql(`insert into public.member_allowlist (email, note, full_name) values ${values}
             on conflict (email) do update set full_name = excluded.full_name`)
  console.log(`  allowlist: ${Object.keys(ROLES).length + 1} rows (OFFLIST deliberately absent)`)

  // Accounts through the admin endpoint WITH user_metadata: the anon /signup
  // path cannot create a fixture here because custom SMTP is live and the send
  // failure is fatal (program finding 62). The trigger fires identically.
  const existing = await authApi('GET', '/admin/users?per_page=200')
  const have = new Map((existing.users ?? []).map((u) => [u.email, u.id]))
  const ids = {}
  for (const [role, v] of Object.entries(ROLES)) {
    const a = addr(role)
    if (have.has(a)) {
      ids[role] = have.get(a)
      continue
    }
    const u = await authApi('POST', '/admin/users', {
      email: a,
      password: PASSWORD,
      email_confirm: true,
      user_metadata: { full_name: v.name },
    })
    ids[role] = u.id
  }
  console.log(`  accounts:  ${Object.keys(ids).length} present`)

  await sql(`insert into public.portal_admin (profile_id)
             select id from public.profiles where email = ${q(addr('admin'))}
             on conflict do nothing`)
  console.log('  admin:     1 portal_admin row')

  writeFileSync(IDS_FILE, JSON.stringify({ ids, baseline, at: new Date().toISOString() }, null, 1))
  console.log(`  ids:       ${IDS_FILE}`)
}

// -------------------------------------------------------------------- SQL lane

async function sqlLane() {
  console.log('=== SITE-14 SQL lane')
  const { key: pubKey } = await publishable()
  const admin = await asUser(addr('admin'), pubKey)
  const memberA = await asUser(addr('member_a'), pubKey)
  const memberB = await asUser(addr('member_b'), pubKey)

  const countPub = async () => (await sql('select count(*)::int as n from publication'))[0].n

  // ---- criterion 2: the admin gate is refusal 1, proven by ordering.
  const before2 = await countPub()
  const nonAdminValid = await memberA.rpc('import_publication_manual', {
    _recipient_email: addr('member_b'),
    _document_id: 'site14-gate-1',
    _title: 'Fixture', _workshop_name: 'Fixture workshop', _date_label: '2026',
    _body_md: '# Fixture', _event_id: null,
  })
  ok(
    'criterion 2: a non-administrator is refused with insufficient_privilege',
    nonAdminValid.body?.code === '42501',
    `code=${nonAdminValid.body?.code}`,
  )
  // The ordering proof: an EMPTY recipient_email is well-typed and fails the
  // function's own in-body check. A non-administrator must still get the GATE
  // error, which is only true if the gate ran first.
  const nonAdminInvalid = await memberA.rpc('import_publication_manual', {
    _recipient_email: '',
    _document_id: 'site14-gate-2',
    _title: 'Fixture', _workshop_name: 'Fixture workshop', _date_label: '2026',
    _body_md: '# Fixture', _event_id: null,
  })
  ok(
    'criterion 2: the gate runs BEFORE the argument checks (empty address still 42501)',
    nonAdminInvalid.body?.code === '42501',
    `code=${nonAdminInvalid.body?.code}`,
  )
  // The detail prints the AFTER count, so a red names the row that was actually
  // written rather than the count before the call. Signing review finding 3: it
  // printed `before2`, which reads as a state the lane never asserted.
  const after2 = await countPub()
  ok('criterion 2: and no row was written', after2 === before2, `before=${before2} after=${after2}`)
  // Two-sided per finding 60: the gate is present AND the insert it guards is
  // present, so a mutation that merely empties the function body fails too.
  const def = (await sql(`select pg_get_functiondef('public.import_publication_manual(text,text,text,text,text,text,text,text,timestamptz)'::regprocedure) as d`))[0].d
  ok('criterion 2: the definition carries is_portal_admin()', def.includes('is_portal_admin()'))
  ok('criterion 2: and still carries the insert it guards', /insert into publication/i.test(def))

  // The admin-side half of criterion 2's argument check. Without it the four
  // in-body checks are exercised only under mutation 1 and never in the green
  // lane, so their errcodes are asserted nowhere. Signing review note 1.
  const adminEmpty = await admin.rpc('import_publication_manual', {
    _recipient_email: '',
    _document_id: 'site14-empty',
    _title: 'Fixture', _workshop_name: 'Fixture workshop', _date_label: '2026',
    _body_md: '# Fixture', _event_id: null,
  })
  ok(
    'criterion 2: an administrator with an empty address gets the ARGUMENT error, by its own errcode',
    adminEmpty.body?.code === '23514',
    `code=${adminEmpty.body?.code}`,
  )

  // ---- criterion 3: source, imported_by and recipient_role are not arguments.
  const args = (await sql(`select pg_get_function_identity_arguments('public.import_publication_manual(text,text,text,text,text,text,text,text,timestamptz)'::regprocedure) as a`))[0].a
  for (const forbidden of ['source', 'imported_by', 'recipient_role']) {
    ok(`criterion 3: ${forbidden} is not a parameter`, !new RegExp(`\\b_?${forbidden}\\b`).test(args))
  }

  // ---- criterion 16: an off-allowlist address is refused, both directions.
  const before16 = await countPub()
  const offlist = await admin.rpc('import_publication_manual', {
    _recipient_email: OFFLIST,
    _document_id: 'site14-offlist',
    _title: 'Fixture', _workshop_name: 'Fixture workshop', _date_label: '2026',
    _body_md: '# Fixture', _event_id: null,
  })
  ok(
    'criterion 16: an off-allowlist address is refused with its OWN errcode',
    offlist.body?.code === '23503',
    `code=${offlist.body?.code}`,
  )
  ok('criterion 16: and nothing was written', (await countPub()) === before16)
  // Ordering: a NON-administrator with the same off-allowlist address must still
  // get insufficient_privilege, which proves the gate stayed refusal 1.
  const offlistNonAdmin = await memberA.rpc('import_publication_manual', {
    _recipient_email: OFFLIST,
    _document_id: 'site14-offlist-2',
    _title: 'Fixture', _workshop_name: 'Fixture workshop', _date_label: '2026',
    _body_md: '# Fixture', _event_id: null,
  })
  ok(
    'criterion 16: the admin gate is still refusal 1 for an off-allowlist address',
    offlistNonAdmin.body?.code === '42501',
    `code=${offlistNonAdmin.body?.code}`,
  )
  // The second half: add it to the allowlist and the identical call succeeds, so
  // a mutation refusing every address fails here rather than passing above.
  await sql(`insert into public.member_allowlist (email, note, full_name)
             values (${q(OFFLIST)}, ${q('SITE-14 fixture; delete with --teardown')}, ${q('Site14 Fixture Offlist')})
             on conflict (email) do nothing`)
  const nowAllowed = await admin.rpc('import_publication_manual', {
    _recipient_email: OFFLIST,
    _document_id: 'site14-offlist',
    _title: 'Fixture report', _workshop_name: 'Fixture workshop', _date_label: '2026',
    _body_md: '# Fixture', _event_id: null,
  })
  ok(
    'criterion 16: the identical call succeeds once the address is allowlisted',
    nowAllowed.status === 200 && typeof nowAllowed.body === 'string',
    `status=${nowAllowed.status}`,
  )
  // This row is criterion 6's unmatched arm. OFFLIST has no account and never
  // registers in this lane, so it stays unmatched for the whole run; the row
  // criterion 5 imports does NOT, because criterion 5 registers that address
  // two steps later and asserts the flip to matched. Using the claimed row
  // there would let a policy carrying `and match_state = 'matched'` on the admin
  // disjunct pass the very arm that exists to exclude it. Signing review
  // finding 1, measured: after a full lane run, site14-doc-late is matched and
  // site14-offlist is the only unmatched row on the table.
  const offlistId = typeof nowAllowed.body === 'string' ? nowAllowed.body : null

  // ---- criterion 17: resolve_import_recipient() is gated, and gated FIRST.
  const resolveNonAdmin = await memberA.rpc('resolve_import_recipient', { _email: addr('member_b') })
  ok(
    'criterion 17: a non-administrator cannot resolve a recipient',
    resolveNonAdmin.body?.code === '42501',
    `code=${resolveNonAdmin.body?.code}`,
  )
  ok(
    'criterion 17: and no roster name was disclosed',
    !JSON.stringify(resolveNonAdmin.body ?? {}).includes('Site14 Fixture Member B'),
  )
  const resolveNonAdminEmpty = await memberA.rpc('resolve_import_recipient', { _email: '' })
  ok(
    'criterion 17: the gate runs BEFORE the lookup (empty address still 42501)',
    resolveNonAdminEmpty.body?.code === '42501',
    `code=${resolveNonAdminEmpty.body?.code}`,
  )
  // The two-sided half: the administrator still gets an answer, so a mutation
  // refusing every caller fails here rather than passing the refusal above.
  const resolveAdmin = await admin.rpc('resolve_import_recipient', { _email: ` ${addr('member_b').toUpperCase()} ` })
  const row = Array.isArray(resolveAdmin.body) ? resolveAdmin.body[0] : null
  ok('criterion 17: an administrator gets exactly one row', Array.isArray(resolveAdmin.body) && resolveAdmin.body.length === 1)
  ok('criterion 17: carrying the attested roster name', row?.attested_name === 'Site14 Fixture Member B', `name=${row?.attested_name}`)
  ok('criterion 17: and the normalized address', row?.normalized_email === addr('member_b'), `norm=${row?.normalized_email}`)
  ok('criterion 17: on_allowlist true, has_account true', row?.on_allowlist === true && row?.has_account === true)

  // ---- criterion 1: the end-to-end deliverable.
  const DOC = 'site14-doc-1'
  const BODY = '# Participant Evaluation: Fixture\n\n## Area one\n\nA fixture body, not a real report.'
  const imported = await admin.rpc('import_publication_manual', {
    _recipient_email: addr('member_a'),
    _document_id: DOC,
    _title: 'Fixture evaluation',
    _workshop_name: 'Fixture workshop',
    _date_label: 'September 2026',
    _body_md: BODY,
    _event_id: null,
  })
  const pubId = typeof imported.body === 'string' ? imported.body : null
  ok('criterion 1: the administrator imports a report', !!pubId, `id=${pubId}`)
  const readBack = await memberA.select(`publication?id=eq.${pubId}&select=body_md,source,match_state,recipient_role`)
  ok(
    'criterion 1: and the person it is about reads it, body intact',
    readBack.body?.[0]?.body_md === BODY,
    `len=${readBack.body?.[0]?.body_md?.length ?? 0}`,
  )

  // ---- criterion 3, stored half.
  //
  // Guarded on pubId rather than assuming it. A mutation that breaks the import
  // leaves this null, and an unguarded query then crashes the lane with a uuid
  // syntax error BEFORE the later criteria report their own verdicts — which is
  // program finding 64's shape in a harness: the gate stops working as a gate at
  // exactly the moment it is supposed to be reporting. Found running mutation 2.
  const adminProfile = (await sql(`select id from profiles where email = ${q(addr('admin'))}`))[0].id
  if (pubId) {
    const stored = (await sql(`select source, imported_by, recipient_role, match_state from publication where id = ${q(pubId)}`))[0]
    ok("criterion 3: source = 'manual', written by the function", stored.source === 'manual')
    ok('criterion 3: imported_by is the calling administrator', stored.imported_by === adminProfile)
    ok("criterion 3: recipient_role = 'subject', hardcoded", stored.recipient_role === 'subject')
    const ev = await sql(`select kind, actor from publication_event where publication_id = ${q(pubId)}`)
    ok("criterion 3: one publication_event of kind 'imported' names the actor", ev.length === 1 && ev[0].kind === 'imported' && ev[0].actor === adminProfile)
  } else {
    ok("criterion 3: the stored row's source, imported_by and recipient_role", false, 'no row was imported: criterion 1 failed above')
  }

  // ---- criterion 4: the dedupe, against the case that actually defeats it.
  const dup = await admin.rpc('import_publication_manual', {
    _recipient_email: `  ${addr('member_a').toUpperCase()}  `,
    _document_id: DOC,
    _title: 'Fixture evaluation', _workshop_name: 'Fixture workshop', _date_label: 'September 2026',
    _body_md: BODY, _event_id: null,
  })
  ok(
    'criterion 4: a repeat paste with different case and whitespace is refused',
    dup.body?.code === '23505',
    `code=${dup.body?.code}`,
  )
  const dupCount = (await sql(`select count(*)::int as n from publication where document_id = ${q(DOC)}`))[0].n
  ok('criterion 4: exactly one row exists for that document', dupCount === 1, `count=${dupCount}`)

  // ---- criterion 5: no account is filed, not lost, and claimed at sign-up.
  const lateDoc = 'site14-doc-late'
  const lateImport = await admin.rpc('import_publication_manual', {
    _recipient_email: NOACCOUNT,
    _document_id: lateDoc,
    _title: 'Fixture late evaluation', _workshop_name: 'Fixture workshop', _date_label: 'September 2026',
    _body_md: '# Fixture late report', _event_id: null,
  })
  const lateId = typeof lateImport.body === 'string' ? lateImport.body : null
  if (lateId) {
    const lateRow = (await sql(`select match_state, profile_id from publication where id = ${q(lateId)}`))[0]
    ok('criterion 5: an import for somebody with no account is filed as unmatched', lateRow.match_state === 'unmatched' && lateRow.profile_id === null)
    // Now register that address and watch the live trigger claim it.
    await authApi('POST', '/admin/users', {
      email: NOACCOUNT,
      password: PASSWORD,
      email_confirm: true,
      user_metadata: { full_name: 'Site14 Fixture Late Registrant' },
    })
    const claimed = (await sql(`select match_state, profile_id from publication where id = ${q(lateId)}`))[0]
    const lateProfile = (await sql(`select id from profiles where email = ${q(NOACCOUNT)}`))[0]?.id
    ok('criterion 5: registering claims it, matched to the new profile', claimed.match_state === 'matched' && claimed.profile_id === lateProfile)
    const matchEv = (await sql(`select count(*)::int as n from publication_event where publication_id = ${q(lateId)} and kind = 'matched'`))[0].n
    ok("criterion 5: and a publication_event of kind 'matched' exists", matchEv === 1, `count=${matchEv}`)
  } else {
    ok('criterion 5: the unmatched-then-claimed path', false, `the import was refused: ${JSON.stringify(lateImport.body).slice(0, 120)}`)
  }

  // ---- criterion 15: an imported report cannot inject script.
  const xssDoc = 'site14-doc-xss'
  const XSS = '# Fixture\n\n<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>'
  const xssImport = await admin.rpc('import_publication_manual', {
    _recipient_email: addr('member_b'),
    _document_id: xssDoc,
    _title: 'Fixture xss', _workshop_name: 'Fixture workshop', _date_label: 'September 2026',
    _body_md: XSS, _event_id: null,
  })
  const xssId = typeof xssImport.body === 'string' ? xssImport.body : null
  ok('criterion 15: the xss fixture imports', !!xssId)

  // ---- criterion 6: the member sees only their own, the administrator sees all.
  const aList = await memberA.select('publication?select=id')
  const bList = await memberB.select('publication?select=id')
  const aIds = new Set((aList.body ?? []).map((r) => r.id))
  const bIds = new Set((bList.body ?? []).map((r) => r.id))
  ok('criterion 6: member A sees their own report', aIds.has(pubId))
  ok("criterion 6: and NOT member B's", !aIds.has(xssId), `A sees ${aIds.size} row(s)`)
  ok('criterion 6: member B sees their own', bIds.has(xssId))
  ok("criterion 6: and NOT member A's", !bIds.has(pubId), `B sees ${bIds.size} row(s)`)
  const crossRead = await memberA.select(`publication?id=eq.${xssId}&select=id`)
  ok(
    "criterion 6: A requesting B's report id gets an empty result, not an error",
    crossRead.status === 200 && Array.isArray(crossRead.body) && crossRead.body.length === 0,
    `status=${crossRead.status}`,
  )
  // The third arm: the administrator sees the SUPERSET, including the unmatched
  // row, which a matched-set description would wrongly predict absent.
  const adminList = await admin.select('publication?select=id')
  const adminIds = new Set((adminList.body ?? []).map((r) => r.id))
  ok("criterion 6: the administrator's list contains A's report", adminIds.has(pubId))
  ok("criterion 6: and B's", adminIds.has(xssId))
  // The state is re-measured HERE rather than inherited from the import, so the
  // arm cannot quietly become a matched-row assertion if a later edit changes
  // when the fixtures register.
  const offlistState = offlistId
    ? (await sql(`select match_state, profile_id from publication where id = ${q(offlistId)}`))[0]
    : null
  ok(
    'criterion 6: the row this arm uses is genuinely unmatched at this moment',
    offlistState?.match_state === 'unmatched' && offlistState?.profile_id === null,
    `state=${offlistState?.match_state}`,
  )
  ok(
    'criterion 6: and the administrator sees that UNMATCHED row too, which is the superset the policy actually grants',
    !!offlistId && adminIds.has(offlistId),
    `admin sees ${adminIds.size} row(s)`,
  )

  console.log(`\nSQL lane: ${pass} pass / ${fail} fail`)
  return { pubId, xssId, lateId }
}

// ---------------------------------------------------------------- browser lane

async function browserLane() {
  console.log('=== SITE-14 browser lane')
  const { chromium } = await import('playwright')
  const { key: pubKey, projectUrl } = await publishable()

  // Program finding 73: build dist/ with the DEPLOY's environment and assert
  // both preconditions on the artifact before asserting anything about the
  // product. Without this a correct feature reads as a routing bug.
  console.log("building dist/ with the deploy's own environment…")
  execFileSync('npm', ['run', 'build'], {
    stdio: 'ignore',
    env: { ...process.env, VITE_BASE: '/obt-cdt-site/', VITE_SUPABASE_URL: projectUrl, VITE_SUPABASE_PUBLISHABLE_KEY: pubKey },
  })
  const four04 = readFileSync('dist/404.html', 'utf8')
  ok('criterion 10: dist/ is built with the production base path', four04.includes('src="/obt-cdt-site/assets/'))
  const builtEntry = /src="\/obt-cdt-site\/(assets\/index-[A-Za-z0-9_-]+\.js)"/.exec(four04)?.[1]
  const entryText = builtEntry ? readFileSync(path.join('dist', builtEntry), 'utf8') : ''
  ok('criterion 10: dist/ is built with the backend enabled', entryText.includes('sb_publishable_'))
  ok('criterion 10: and the import route is registered in the entry chunk', entryText.includes('portal/admin/import'))

  // Criterion 15's rendered half needs an imported report carrying the script
  // payload. The SQL lane imports one, but a lane that depends on another lane
  // having run first is a lane that passes or fails by ORDER rather than by the
  // product: measured here, the browser lane read 16/3 when run from a freshly
  // torn-down state. So it seeds its own precondition, idempotently.
  const XSS_DOC = 'site14-doc-xss'
  const existingXss = await sql(`select id from publication where document_id = ${q(XSS_DOC)}`)
  if (existingXss.length === 0) {
    const seedAdmin = await asUser(addr('admin'), pubKey)
    await seedAdmin.rpc('import_publication_manual', {
      _recipient_email: addr('member_b'),
      _document_id: XSS_DOC,
      _title: 'Fixture xss',
      _workshop_name: 'Fixture workshop',
      _date_label: 'September 2026',
      _body_md: '# Fixture\n\n<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>',
      _event_id: null,
    })
    console.log('  seeded the criterion 15 fixture row (this lane does not depend on the SQL lane having run)')
  }

  const server = spawn('node', ['scripts/serve-dist.mjs', '--port', String(PORT)], { stdio: 'ignore' })
  const up = async () => {
    for (let i = 0; i < 60; i++) {
      try {
        if ((await fetch(`${BASE}/`)).ok) return true
      } catch {}
      await new Promise((r) => setTimeout(r, 250))
    }
    return false
  }
  if (!(await up())) {
    server.kill()
    throw new Error(`dist server did not come up on ${PORT}`)
  }

  mkdirSync(SHOTS, { recursive: true })
  const browser = await chromium.launch()
  try {
    const signIn = async (page, email) => {
      await page.goto(`${BASE}/portal`, { waitUntil: 'networkidle' })
      await page.fill('input[type="email"]', email)
      await page.fill('input[type="password"]', PASSWORD)
      await page.click('button[type="submit"]')
      await page.waitForTimeout(2500)
    }

    // ---- criterion 7, refusal half: a non-admin sees the sentence, no fields.
    {
      const ctx = await browser.newContext()
      const page = await ctx.newPage()
      await signIn(page, addr('member_a'))
      await page.goto(`${BASE}/portal/admin/import`, { waitUntil: 'networkidle' })
      await page.waitForTimeout(1500)
      const text = await page.innerText('body')
      ok('criterion 7: a non-administrator gets the refusal sentence', text.includes('This page is for portal administrators'))
      const fields = await page.locator('input, textarea').count()
      ok('criterion 7: and NO form field exists, asserted structurally', fields === 0, `fields=${fields}`)
      await page.screenshot({ path: `${SHOTS}/refusal.png`, fullPage: true })

      // ---- criterion 7, report-copy half: a MEMBER sees no admin note.
      await page.goto(`${BASE}/portal`, { waitUntil: 'networkidle' })
      await page.waitForTimeout(1500)
      const memberNote = await page.locator('[data-site14-admin-note]').count()
      ok('criterion 7: a member sees NO administrator note on /portal', memberNote === 0, `notes=${memberNote}`)
      await ctx.close()
    }

    // ---- the administrator's screen.
    {
      const ctx = await browser.newContext()
      const page = await ctx.newPage()
      await signIn(page, addr('admin'))

      // criterion 7: the admin note IS present for an administrator.
      await page.goto(`${BASE}/portal`, { waitUntil: 'networkidle' })
      await page.waitForTimeout(2000)
      const adminNote = await page.locator('[data-site14-admin-note]').count()
      ok('criterion 7: an administrator DOES see the note on /portal', adminNote === 1, `notes=${adminNote}`)
      const noteText = adminNote ? await page.locator('[data-site14-admin-note]').innerText() : ''
      ok('criterion 7: and it says the list is every report, not only theirs', /every report/i.test(noteText))
      // The count on /portal, for criterion 8's comparison.
      const portalNav = await page.locator('header a, nav a').count()
      await page.screenshot({ path: `${SHOTS}/portal-admin.png`, fullPage: true })

      await page.goto(`${BASE}/portal/admin/import`, { waitUntil: 'networkidle' })
      await page.waitForTimeout(2000)
      const body = await page.innerText('body')
      ok('criterion 7: the form renders for an administrator', (await page.locator('[data-site14-import]').count()) === 1)
      ok(
        'criterion 7: and says a manual import is a human\'s word, not a signed claim',
        body.includes("not a signed claim"),
      )
      ok('criterion 7: and carries the not-yet-two-factor sentence', body.includes('Two-factor protection'))

      // ---- criterion 8: the shell behaves on the admin route (finding 75).
      const importNav = await page.locator('header a, nav a').count()
      ok('criterion 8: the member nav renders on the import route', importNav > 0, `links=${importNav}`)
      ok('criterion 8: and matches the count on /portal', importNav === portalNav, `import=${importNav} portal=${portalNav}`)

      // ---- criterion 14: the first submit resolves and writes NOTHING.
      const before = (await sql('select count(*)::int as n from publication'))[0].n
      const DOC = `site14-ui-${Date.now()}`
      await page.fill('#site14-email', addr('member_b'))
      await page.fill('#site14-document', DOC)
      await page.fill('#site14-title', 'Fixture UI evaluation')
      await page.fill('#site14-workshop', 'Fixture workshop')
      await page.fill('#site14-date', 'September 2026')
      await page.fill('#site14-body', '# Fixture UI report\n\nPasted by the lane.')
      await page.click('[data-site14-resolve]')
      await page.waitForTimeout(2500)
      const afterResolve = (await sql('select count(*)::int as n from publication'))[0].n
      ok('criterion 14: the first submit writes nothing', afterResolve === before, `before=${before} after=${afterResolve}`)
      ok('criterion 14: and the confirm step appears', (await page.locator('[data-site14-confirm]').count()) === 1)
      const resolvedName = await page.locator('[data-site14-resolved-name]').innerText()
      ok('criterion 14: showing the attested roster name', resolvedName.includes('Site14 Fixture Member B'), resolvedName)
      await page.screenshot({ path: `${SHOTS}/confirm.png`, fullPage: true })

      await page.click('[data-site14-commit]')
      await page.waitForTimeout(3000)
      const afterCommit = (await sql('select count(*)::int as n from publication'))[0].n
      ok('criterion 14: confirming increments by exactly 1', afterCommit === before + 1, `after=${afterCommit}`)
      ok('criterion 14: and the screen says the report is filed', (await page.innerText('body')).includes('The report is filed'))
      await page.screenshot({ path: `${SHOTS}/imported.png`, fullPage: true })
      await ctx.close()
    }

    // ---- criterion 15, rendered half: the xss body renders as TEXT.
    {
      const ctx = await browser.newContext()
      const page = await ctx.newPage()
      await signIn(page, addr('member_b'))
      const xss = (await sql(`select id from publication where document_id = 'site14-doc-xss'`))[0]
      if (xss) {
        await page.goto(`${BASE}/portal/r/${xss.id}`, { waitUntil: 'networkidle' })
        await page.waitForTimeout(2000)
        const injected = await page.locator('article script, article img').count()
        ok('criterion 15: no script or img element reaches the rendered report', injected === 0, `elements=${injected}`)
        const rendered = await page.innerText('body')
        ok('criterion 15: and the literal text is visible instead', rendered.includes('<script>alert(1)</script>'))
        // criterion 7: the report page's admin note is ABSENT for a member.
        ok('criterion 7: a member sees no administrator note on the report page', (await page.locator('[data-site14-report-admin-note]').count()) === 0)
        await page.screenshot({ path: `${SHOTS}/report-xss.png`, fullPage: true })
      } else {
        ok('criterion 15: the xss fixture row exists', false, 'run --assert --sql first')
      }
      await ctx.close()
    }

    // criterion 7: the report page's admin note IS present for an administrator.
    {
      const ctx = await browser.newContext()
      const page = await ctx.newPage()
      await signIn(page, addr('admin'))
      const xss = (await sql(`select id from publication where document_id = 'site14-doc-xss'`))[0]
      if (xss) {
        await page.goto(`${BASE}/portal/r/${xss.id}`, { waitUntil: 'networkidle' })
        await page.waitForTimeout(2000)
        const note = await page.locator('[data-site14-report-admin-note]').count()
        ok('criterion 7: an administrator DOES see the note on a report page', note === 1, `notes=${note}`)
        await page.screenshot({ path: `${SHOTS}/report-admin.png`, fullPage: true })
      }
      await ctx.close()
    }
  } finally {
    await browser.close()
    server.kill()
  }

  console.log(`\nBrowser lane: ${pass} pass / ${fail} fail`)
}

// ------------------------------------------------------------------- teardown

async function teardown() {
  console.log('=== teardown')
  const scope = `(select id from public.profiles where email like ${q(PREFIX + '%')})`

  // Publications first: by recipient address, which covers matched and unmatched
  // alike, then their events cascade.
  await sql(`delete from public.publication where recipient_email like ${q(PREFIX + '%')}`)
  await sql(`delete from public.portal_admin where profile_id in ${scope}`)

  const users = await authApi('GET', '/admin/users?per_page=200')
  let deleted = 0
  for (const u of users.users ?? []) {
    if (u.email?.startsWith(PREFIX)) {
      await authApi('DELETE', `/admin/users/${u.id}`)
      deleted++
    }
  }
  await sql(`delete from public.member_allowlist where email like ${q(PREFIX + '%')}`)
  console.log(`  accounts:  ${deleted} deleted`)

  if (!VERIFY) return

  // The baseline this asserts against is the one --setup MEASURED before it
  // inserted anything, never a constant: see the note in setup(). It REFUSES
  // when that file is absent rather than falling back to a typed number, on the
  // same reasoning the roster guard refuses without its export.
  if (!existsSync(IDS_FILE)) {
    console.error(`REFUSED: ${IDS_FILE} is absent, so there is no measured baseline to verify against. Run --setup first.`)
    process.exit(2)
  }
  const D0 = JSON.parse(readFileSync(IDS_FILE, 'utf8')).baseline
  if (!D0) {
    console.error(`REFUSED: ${IDS_FILE} carries no baseline. Re-run --setup.`)
    process.exit(2)
  }

  // SITE-09's leak is the reason this polls rather than assuming. The cascade
  // from auth.users to profiles LAGS, so a single read can report a clean
  // database while rows are still going.
  let counts = null
  for (let i = 0; i < 20; i++) {
    counts = (await sql(COUNT_QUERY))[0]
    if (Object.entries(D0).every(([k, v]) => counts[k] === v)) break
    await new Promise((r) => setTimeout(r, 1500))
  }
  // The primary gate, and the one that cannot drift: nothing carrying this
  // lane's prefix is left anywhere. Re-review finding 1 is why this leads rather
  // than the baseline comparison — "is anything of ours still here?" stays true
  // as a question however much the rest of the project changes.
  let residue = null
  for (let i = 0; i < 20; i++) {
    residue = (await sql(RESIDUE_QUERY))[0]
    if (Object.values(residue).every((n) => n === 0)) break
    await new Promise((r) => setTimeout(r, 1500))
  }
  console.log('  per table, lane residue by prefix:')
  for (const [table, n] of Object.entries(residue)) {
    ok(`teardown: no ${table} rows carrying the lane prefix`, n === 0, `residue=${n}`)
  }

  const residueClean = Object.values(residue).every((n) => n === 0)

  console.log('  per table, against the baseline --setup measured before inserting anything:')
  const baselineFailures = []
  for (const [table, expected] of Object.entries(D0)) {
    const good = counts[table] === expected
    if (!good) baselineFailures.push(table)
    ok(`teardown: ${table} back to baseline`, good, `expected=${expected} actual=${counts[table]}`)
  }

  // Residue clean but the baseline red means the stored baseline no longer
  // describes the world, not that this lane leaked: the likeliest cause is a row
  // somebody else added between setup and teardown, and the first real report
  // import will do exactly that. Say so, because the correct move is to
  // re-measure on a clean project rather than to hunt a leak.
  if (residueClean && baselineFailures.length > 0) {
    console.log(
      `\n  NOTE: no row carrying this lane's prefix is left (${Object.keys(residue).length} of ${Object.keys(residue).length} clean), ` +
        `so this lane leaked nothing. The baseline in ${IDS_FILE} has gone stale on: ${baselineFailures.join(', ')}. ` +
        `Delete that file and re-run --setup on a clean project to re-measure; do not hunt a leak.`,
    )
  }
  console.log(`\nTeardown: ${pass} pass / ${fail} fail`)
}

// ----------------------------------------------------------------------- main

try {
  if (SETUP) await setup()
  if (ASSERT && SQL_LANE) await sqlLane()
  else if (ASSERT) await browserLane()
  if (TEARDOWN) await teardown()
} catch (e) {
  console.error(`\nlane error: ${e instanceof Error ? e.stack : String(e)}`)
  process.exit(1)
}

process.exit(fail === 0 ? 0 : 1)
