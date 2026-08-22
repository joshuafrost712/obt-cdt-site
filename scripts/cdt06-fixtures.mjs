/**
 * CDT-06a: provision and tear down the boundary harness's fixtures, and post its
 * SQL files to the live OBT-CDT project.
 *
 *   node scripts/cdt06-fixtures.mjs --setup
 *   node scripts/cdt06-fixtures.mjs --print-ids
 *   node scripts/cdt06-fixtures.mjs --sql scripts/cdt06-rls-tests.sql
 *   node scripts/cdt06-fixtures.mjs --teardown
 *
 * ## Why this file exists, when the spec names four artifacts and not five
 *
 * CDT-06a's D2 says its fixtures are `cdt04-fixtures.mjs`'s five-step chain with
 * wider fixtures. That chain cannot be expressed in SQL, for the reason the spec's
 * own finding 4 records: an account inserted into `auth.users` with a fake
 * password hash can never sign in, so the UI half and the SQL half would need two
 * disjoint fixture sets. Accounts therefore come from the Auth admin API, which
 * needs a JavaScript caller. A fifth file is the mechanism, not a scope change.
 *
 * It also carries the SQL poster, so `cdt06-rls-tests.sql`, `-restore.sql` and
 * `-teardown.sql` are plain SQL that any psql session could run, rather than each
 * embedding its own credential handling.
 *
 * ## Two prefixes, neither a prefix of the other
 *
 * Program finding 13, from `cairn/scripts/tl05-rls-teardown.sql:5-9`: a LIKE
 * prefix is a prefix, so one spec's two harnesses delete each other's accounts.
 * This spec has two harnesses, so it has two complete, independent fixture lanes:
 *
 *   cdt06-rls-*  the SQL matrix callers, eight accounts
 *   cdt06-ui-*   the browser callers, six accounts
 *
 * Neither lane's teardown can reach the other's rows, which is the whole point.
 * `cdt04-ui-` is a third prefix and is not touched here either.
 *
 * ## The instrument rows are EPHEMERAL, inherited from CDT-04 as a decision
 *
 * Program finding 20: the live project holds the full schema and, before this
 * runs, no registry rows, no bundles, no allowlist and no users. Both source maps
 * are still `signed_off: false` pending Viji's 2026-08-26 review, and Joshua's
 * standing instruction is dry-run only for the bundle seed. So `--setup` asks each
 * seed for its rows with `--emit-sql` and posts them as postgres, and `--teardown`
 * deletes them again. Nothing durable is written from an unsigned map. Reusing
 * each seed's own parser and gate, rather than writing a second one, is the
 * 41-chances-to-mis-key failure `seed_bundles.py` exists to prevent.
 *
 * ## The three nonces
 *
 * Every absence assertion in this spec has a positive control in the same run,
 * because "the page does not contain X" passes on a blank page, a 404 and a
 * fixture that never landed. Each protected value carries a unique token:
 *
 *   nonce 1  in the primary consultant's evidence_sentence on CIT A's I-1
 *            write-up. The second rater on the same CIT must not see it.
 *   nonce 2  in an unreleased submission's body. CIT A, its subject, must not
 *            see it until released_at is set.
 *   nonce 3  in CIT B's full_name. The primary consultant, who has no assignment
 *            with CIT B, must not see it; the third consultant must.
 *
 * If a run dies half way, `--teardown` is idempotent and safe to run again.
 */
import { readFileSync, writeFileSync, existsSync, mkdtempSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'

const REPO = path.resolve(import.meta.dirname, '..')
const IDS_FILE = path.join(REPO, 'scripts/.cdt06-fixture-ids.json')

// The projects a fixture or a migration from this repo must never reach.
const FORBIDDEN_REFS = {
  vdbirmjvjzfdgajwgowj: 'Honest Eval (repo `cairn`), a different product',
  ckorlrchryswnnrmuctr: 'the Local Genres Research app, a different project again',
}

const RLS = 'cdt06-rls-'
const UI = 'cdt06-ui-'
// Fixture-only, thrown away at teardown, and above the project's 12-character
// minimum (CDT-00 D5 raised it from 6 on 2026-08-21).
const PASSWORD = 'cdt06-boundary-fixture-passphrase'

// The nonces. Deliberately not random: a fixed token is greppable out of the repo
// and out of a screenshot, which criterion 13 checks.
export const NONCE = {
  evidence: 'cdt06-nonce-1-evidence-only-the-primary-may-read',
  unreleased: 'cdt06-nonce-2-unreleased-body-not-for-the-subject',
  citb: 'cdt06-nonce-3-citb-name-not-for-the-primary',
}

// Seven callers in the SQL lane, and each is here because it catches something.
// `anon` is the eighth and is not an account: it is a column of the matrix.
const RLS_ROLES = {
  primary: { kind: 'consultant', name: 'Fixture Primary Consultant' },
  second: { kind: 'consultant', name: 'Fixture Second Rater' },
  third: { kind: 'consultant', name: 'Fixture Third Consultant' },
  headmentor: { kind: 'oversight', name: 'Fixture Head Mentor' },
  admin: { kind: 'oversight', name: 'Fixture Portal Admin' },
  member: { kind: 'member', name: 'Fixture Plain Member' },
  cita: { kind: 'cit', name: 'Fixture CIT A' },
  citb: { kind: 'cit', name: `Fixture CIT B ${NONCE.citb}` },
}

const UI_ROLES = {
  primary: { kind: 'consultant', name: 'Fixture UI Primary Consultant' },
  second: { kind: 'consultant', name: 'Fixture UI Second Rater' },
  third: { kind: 'consultant', name: 'Fixture UI Third Consultant' },
  admin: { kind: 'oversight', name: 'Fixture UI Portal Admin' },
  cita: { kind: 'cit', name: 'Fixture UI CIT A' },
  citb: { kind: 'cit', name: `Fixture UI CIT B ${NONCE.citb}` },
}

const LANES = {
  rls: { prefix: RLS, roles: RLS_ROLES },
  ui: { prefix: UI, roles: UI_ROLES },
}

const addr = (prefix, role) => `${prefix}${role}@example.org`

// ------------------------------------------------------------- credentials

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

export const { ref, token, secret, url } = creds()

/** Run SQL as `postgres` through the management API. */
export async function sql(query) {
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
export async function auth(method, pathname, body) {
  const res = await fetch(`${url}/auth/v1${pathname}`, {
    method,
    headers: {
      apikey: secret,
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`auth ${method} ${pathname} → ${res.status}: ${text}`)
  return text ? JSON.parse(text) : {}
}

const q = (s) => `'${String(s).replace(/'/g, "''")}'`

// ------------------------------------------------------- the instrument rows

// The tables the two seeds own, in delete order. Each seed emits plain INSERTs, so
// seeding twice without clearing first fails on competency_scale's primary key.
// Setup clears before it seeds, which is what makes --setup re-runnable.
const INSTRUMENT_TABLES = [
  'bundle_qualification',
  'bundle_unit',
  'assessment_bundle',
  'bundle_grant',
  'unit_descriptor',
  'unit_prerequisite',
  'category_domain',
  'competency_unit',
  'competency_category',
  'competency_domain',
  'competency_scale',
  'registry_version',
]

async function seedInstrument() {
  const [before] = await sql('select count(*) as n from public.competency_unit')
  if (Number(before.n) > 0) {
    console.log(`  registry already holds ${before.n} units; clearing first so the seeds can re-run`)
  }
  // An assignment references a bundle, so the instrument cannot be cleared while
  // this lane's assignments hold it. Only OUR prefixes are cleared: another
  // session's fixtures in the same tables are not ours to delete.
  await clearAssessmentRows()
  for (const t of INSTRUMENT_TABLES) await sql(`delete from public.${t}`)

  const scratch = mkdtempSync(path.join(tmpdir(), 'cdt06-'))
  const files = []
  for (const [script, flag] of [
    ['seed_competency_registry.py', '--allow-unsigned-domain-map'],
    ['seed_bundles.py', '--allow-unsigned-bundle-map'],
  ]) {
    const out = path.join(scratch, `${script}.sql`)
    console.log(`  ${script} --emit-sql`)
    try {
      // --emit-sql runs the seed's own count gate first and reads no credential,
      // so a map that fails its gate stops the run rather than half seeding.
      execFileSync('python3', [path.join(REPO, 'scripts', script), '--emit-sql', out, flag], {
        cwd: REPO,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (e) {
      console.error(`${script} refused:\n${e.stderr?.toString() ?? e}`)
      process.exit(1)
    }
    files.push(out)
  }
  await sql(files.map((f) => readFileSync(f, 'utf8')).join('\n'))
  const [c] = await sql(
    'select (select count(*) from competency_unit) as units,' +
      ' (select count(*) from assessment_bundle) as bundles,' +
      ' (select count(*) from bundle_unit) as bundle_units',
  )
  console.log(
    `  seeded ephemerally: ${c.units} units, ${c.bundles} bundles, ${c.bundle_units} bundle_units`,
  )
}

/** Every assessment row belonging to EITHER of this spec's two lanes. */
function laneScope() {
  return `(select id from public.profiles where email like ${q(RLS + '%')} or email like ${q(UI + '%')})`
}

async function clearAssessmentRows() {
  const scope = laneScope()
  await sql(
    `delete from public.submission_rating where submission_id in (select id from public.submission
        where consultant_profile_id in ${scope}
           or assignment_id in (select id from public.assignment where consultant_profile_id in ${scope} or subject_profile_id in ${scope}));
     delete from public.submission_file where submission_id in (select id from public.submission
        where consultant_profile_id in ${scope}
           or assignment_id in (select id from public.assignment where consultant_profile_id in ${scope} or subject_profile_id in ${scope}));
     delete from public.submission where consultant_profile_id in ${scope}
        or assignment_id in (select id from public.assignment where consultant_profile_id in ${scope} or subject_profile_id in ${scope});
     delete from public.assignment_event where assignment_id in (select id from public.assignment where consultant_profile_id in ${scope} or subject_profile_id in ${scope});
     delete from public.assignment where second_of is not null and (consultant_profile_id in ${scope} or subject_profile_id in ${scope});
     delete from public.assignment where consultant_profile_id in ${scope} or subject_profile_id in ${scope};
     delete from public.consultant_qualification where profile_id in ${scope};`,
  )
}

// ------------------------------------------------------------------ setup

/** Create the accounts for one lane and return {role: uuid}. */
async function accounts(lane) {
  const { prefix, roles } = LANES[lane]
  const ids = {}
  const values = Object.keys(roles)
    .map((r) => `(${q(addr(prefix, r))}, ${q(`CDT-06a ${lane} fixture; delete with --teardown`)})`)
    .join(', ')
  // Step 1: handle_new_portal_user() raises insufficient_privilege on the
  // auth.users insert unless the address is allowlisted first.
  await sql(
    `insert into public.member_allowlist (email, note) values ${values} on conflict (email) do nothing`,
  )

  const existing = await auth('GET', '/admin/users?per_page=200')
  const byEmail = new Map((existing.users ?? []).map((u) => [u.email, u.id]))
  for (const role of Object.keys(roles)) {
    const a = addr(prefix, role)
    if (byEmail.has(a)) {
      ids[role] = byEmail.get(a)
      continue
    }
    // Step 2: a CONFIRMED account through the admin API. A SQL-inserted user has
    // no usable password hash and can never sign in.
    const u = await auth('POST', '/admin/users', { email: a, password: PASSWORD, email_confirm: true })
    ids[role] = u.id
  }
  for (const [role, meta] of Object.entries(roles)) {
    await sql(
      `update public.profiles set full_name = ${q(meta.name)}, org = ${q('Fixture')} where id = ${q(ids[role])}`,
    )
  }
  console.log(`  ${lane}: ${Object.keys(roles).length} confirmed accounts`)
  return ids
}

/** Steps 3 to 5 of the chain, for one lane. */
async function relationships(lane, ids) {
  const { roles } = LANES[lane]
  const consultants = Object.entries(roles)
    .filter(([, m]) => m.kind === 'consultant')
    .map(([r]) => r)

  // Step 3: consultant and qualification rows, or assignment_qualification_guard
  // refuses. qualification_covers() is an EXISTS over the join, but the four
  // bundles ask for three DIFFERENT scope kinds (CDT-04's recorded mistake): I-1
  // wants domains, I-2/I-3 want bt-* categories, I-4 wants the bundle-scoped
  // credential. So each consultant gets one row per scope kind.
  for (const role of consultants) {
    await sql(
      `insert into public.consultant (profile_id, is_cbc_mentor, languages, status, note)
         values (${q(ids[role])}, false, array['en'], 'active', 'CDT-06a ${lane} fixture')
         on conflict (profile_id) do nothing;
       insert into public.consultant_qualification (profile_id, scope_kind, scope_key, basis)
         select ${q(ids[role])}, 'domain', domain_key, 'CDT-06a ${lane} fixture'
           from public.competency_domain on conflict do nothing;
       insert into public.consultant_qualification (profile_id, scope_kind, scope_key, basis)
         select ${q(ids[role])}, 'category', category_key, 'CDT-06a ${lane} fixture'
           from public.competency_category on conflict do nothing;
       insert into public.consultant_qualification (profile_id, scope_kind, scope_key, basis)
         select ${q(ids[role])}, 'bundle', grant_key, 'CDT-06a ${lane} fixture'
           from public.bundle_grant on conflict do nothing;`,
    )
  }

  // Step 4: cit_enrollment against an existing cohort event.
  const [ev] = await sql('select id from public.events order by start_date nulls last limit 1')
  for (const role of Object.entries(roles).filter(([, m]) => m.kind === 'cit').map(([r]) => r)) {
    await sql(
      `insert into public.cit_enrollment (profile_id, participant_kind, track_membership, cohort_event_id, assessment_language, note)
         values (${q(ids[role])}, 'cit', 'sil-obt-cdt', ${ev ? q(ev.id) : 'null'}, 'en', 'CDT-06a ${lane} fixture')
         on conflict (profile_id) do nothing`,
    )
  }

  // Step 5: assignments, walked one legal transition at a time, because
  // assignment_change_guard refuses a jump.
  const mk = async (subject, consultant, bundle, states, extra = '') => {
    const [row] = await sql(
      `insert into public.assignment
         (subject_profile_id, consultant_profile_id, bundle_key, qualification_basis,
          scheduled_at, meeting_language, subject_l1${extra ? ', rating_role, second_of' : ''})
       values (${q(ids[subject])}, ${q(ids[consultant])}, ${q(bundle)}, ${q('CDT-06a fixture')},
               now() + interval '3 days', 'Indonesian', true${extra})
       returning id`,
    )
    for (const s of states) await sql(`update public.assignment set state = ${q(s)} where id = ${q(row.id)}`)
    return row.id
  }

  const a = {}
  // CIT A: the shared subject. The primary holds I-1; the second rater holds the
  // SAME bundle on the SAME CIT, which is what the blindness checks run on.
  a.primary = await mk('cita', 'primary', 'I-1', ['scheduled', 'held'])
  a.second = await mk('cita', 'second', 'I-1', ['scheduled', 'held'], `, 'second', ${q(a.primary)}`)
  // A second assignment for the primary, whose write-up stays unreleased.
  a.unreleased = await mk('cita', 'primary', 'I-2', ['scheduled', 'held'])
  // CIT B: one assignment, held by the third consultant only. This is what the
  // by-URL check runs on: with a single CIT it was either false for a correct
  // build or free for a caller with no data anywhere.
  a.third = await mk('citb', 'third', 'I-1', ['scheduled', 'held'])

  // Oversight rows. head_mentor and portal_admin exist only in the RLS lane's
  // shape for the SQL matrix, and in the UI lane for criterion 9's admin pair.
  if (roles.headmentor) {
    await sql(
      `insert into public.head_mentor (profile_id) values (${q(ids.headmentor)}) on conflict do nothing`,
    )
  }
  if (roles.admin) {
    await sql(
      `insert into public.portal_admin (profile_id, is_owner) values (${q(ids.admin)}, false) on conflict do nothing`,
    )
  }

  // The write-ups that carry the nonces.
  const submit = async (assignmentId, bundle, consultant, body, evidence, released) => {
    const [sub] = await sql(
      `insert into public.submission
         (assignment_id, bundle_key, consultant_profile_id, body_md, strength_note,
          growth_note_1, growth_note_2, context_note, connection_quality,
          consent_recorded, transcript_source, submitted_at, released_at)
       values (${q(assignmentId)}, ${q(bundle)}, ${q(ids[consultant])}, ${q(body)},
               'Fixture strength.', 'Fixture growth one.', 'Fixture growth two.',
               'Fixture context.', 'good', true, 'none', now(), ${released ? 'now()' : 'null'})
       returning id`,
    )
    // Every unit in the bundle, because the RPC's coverage gate is the rule and a
    // fixture that could not have been created through the real path is a lie.
    await sql(
      `insert into public.submission_rating
         (submission_id, bundle_key, unit_key, observed_level, recommended_level,
          confidence, evidence_sentence, plain_language_check, escalate)
       select ${q(sub.id)}, bundle_key, unit_key, 2, 2, 'medium',
              ${q(evidence)} || ' for ' || unit_key, 'yes', false
         from public.bundle_unit where bundle_key = ${q(bundle)}`,
    )
    // An assignment holding a filed write-up is `submitted`, not `held`. Walking
    // it there is not decoration: CDT-04's page renders a filed write-up back
    // only in that state, so a fixture left at `held` would make every positive
    // nonce control fail for a reason that has nothing to do with a boundary.
    await sql(`update public.assignment set state = 'submitted' where id = ${q(assignmentId)}`)
    return sub.id
  }

  // Nonce 1 rides in the primary's evidence sentences on CIT A's I-1 write-up,
  // which IS released, so the only thing standing between the second rater and it
  // is helper 3.
  a.primarySubmission = await submit(
    a.primary, 'I-1', 'primary', 'Fixture write-up body for CIT A.', NONCE.evidence, true,
  )
  // Nonce 2 rides in a body that is submitted but NOT released, which is the only
  // thing standing between CIT A and it.
  a.unreleasedSubmission = await submit(
    a.unreleased, 'I-2', 'primary',
    `Fixture unreleased write-up. ${NONCE.unreleased}`, 'Fixture evidence', false,
  )
  // One attachment row, so submission_file has a `permitted` cell to be measured
  // against rather than a vacuous zero for every caller.
  await sql(
    `insert into public.submission_file (submission_id, kind, source_url, filename)
       values (${q(a.primarySubmission)}, 'transcript', 'https://example.org/cdt06-fixture',
               'cdt06-fixture-transcript.txt')`,
  )
  console.log(`  ${lane}: ${Object.keys(a).length} assessment rows (assignments, write-ups, one file)`)
  return a
}

async function setup() {
  console.log('--- 0. the instrument, from the two unsigned maps, ephemerally')
  await seedInstrument()

  const out = { password: PASSWORD, nonces: NONCE, lanes: {} }
  for (const lane of ['rls', 'ui']) {
    console.log(`--- ${lane} lane, prefix ${LANES[lane].prefix}`)
    const ids = await accounts(lane)
    const rows = await relationships(lane, ids)
    out.lanes[lane] = { prefix: LANES[lane].prefix, profiles: ids, rows }
  }

  writeFileSync(IDS_FILE, JSON.stringify(out, null, 2))
  console.log(`\nwrote ${path.relative(REPO, IDS_FILE)} (gitignored; holds no real participant)`)
}

// --------------------------------------------------------------- teardown

async function teardown() {
  console.log('--- SQL-side deletion, by join, in FK order')
  const report = await runSqlFile(path.join(REPO, 'scripts/cdt06-rls-teardown.sql'), true)

  console.log('--- auth users, which cascade their profiles')
  const list = await auth('GET', '/admin/users?per_page=200')
  let n = 0
  for (const u of list.users ?? []) {
    if (u.email?.startsWith(RLS) || u.email?.startsWith(UI)) {
      await auth('DELETE', `/admin/users/${u.id}`)
      n++
    }
  }
  console.log(`  deleted ${n} auth users across both lanes`)

  // profiles cascades from auth.users, but a profile orphaned by a half-run
  // setup would survive it. Scoped to exactly this spec's two prefixes.
  await sql(
    `delete from public.profiles where email like ${q(RLS + '%')} or email like ${q(UI + '%')}`,
  )

  // member_allowlist: the delete NAMES the fourteen addresses this script put
  // there. It never matches a pattern over the table, because the rest of the
  // table is the real cohort roster and this harness does not read it.
  const addrs = Object.entries(LANES)
    .flatMap(([lane, { prefix, roles }]) => Object.keys(roles).map((r) => q(addr(prefix, r))))
    .join(', ')
  await sql(`delete from public.member_allowlist where email in (${addrs})`)
  console.log(`  cleared member_allowlist for exactly ${addrs.split(',').length} named fixture addresses`)

  console.log('--- the ephemeral instrument rows (both maps are still unsigned)')
  for (const t of INSTRUMENT_TABLES) await sql(`delete from public.${t}`)

  console.log('\n--- surviving rows, counted per table through the same joins')
  const [left] = await sql(
    `select
       (select count(*) from public.profiles where email like ${q(RLS + '%')} or email like ${q(UI + '%')}) as profiles,
       (select count(*) from public.member_allowlist where email in (${addrs})) as member_allowlist,
       (select count(*) from public.consultant) as consultant,
       (select count(*) from public.consultant_qualification) as consultant_qualification,
       (select count(*) from public.cit_enrollment) as cit_enrollment,
       (select count(*) from public.head_mentor) as head_mentor,
       (select count(*) from public.portal_admin) as portal_admin,
       (select count(*) from public.assignment) as assignment,
       (select count(*) from public.assignment_event) as assignment_event,
       (select count(*) from public.submission) as submission,
       (select count(*) from public.submission_rating) as submission_rating,
       (select count(*) from public.submission_file) as submission_file,
       (select count(*) from public.competency_unit) as competency_unit,
       (select count(*) from public.assessment_bundle) as assessment_bundle,
       (select count(*) from pg_class where relnamespace='public'::regnamespace and relname like 'cdt06%') as harness_tables,
       (select count(*) from pg_proc where pronamespace='public'::regnamespace and proname like 'cdt06%') as harness_functions`,
  )
  let dirty = 0
  for (const [k, v] of Object.entries(left)) {
    console.log(`  ${String(v).padStart(4)}  ${k}`)
    if (Number(v) !== 0) dirty++
  }
  const users = await auth('GET', '/admin/users?per_page=200')
  const leftUsers = (users.users ?? []).filter(
    (u) => u.email?.startsWith(RLS) || u.email?.startsWith(UI),
  ).length
  console.log(`  ${String(leftUsers).padStart(4)}  auth users across both fixture prefixes`)
  if (leftUsers) dirty++
  console.log(dirty === 0 ? '\nclean: every count is zero.' : `\nNOT CLEAN: ${dirty} non-zero counts above.`)
  return dirty === 0 ? 0 : 1
}

// -------------------------------------------------------------- SQL poster

/**
 * Post a .sql file and render whatever report rows it returns.
 *
 * The management API returns the LAST statement's rows, so each harness file ends
 * with its own `select ... from cdt06_results order by ...`.
 */
export async function runSqlFile(file, quiet = false) {
  const body = readFileSync(file, 'utf8')
  if (!quiet) console.log(`--- posting ${path.relative(REPO, file)} (${body.split('\n').length} lines)`)
  const rows = await sql(body)
  if (!Array.isArray(rows) || rows.length === 0) {
    if (!quiet) console.log('  (no report rows)')
    return { pass: 0, fail: 0, rows: [] }
  }
  let pass = 0
  let fail = 0
  let section = null
  for (const r of rows) {
    if (r.section !== undefined && r.section !== section) {
      console.log(`\n=== ${r.section}`)
      section = r.section
    }
    if (r.verdict === 'PASS') pass++
    else if (r.verdict === 'FAIL') fail++
    const mark = r.verdict === 'PASS' ? '  ok  ' : r.verdict === 'FAIL' ? ' FAIL ' : '  --  '
    const label = String(r.label ?? '').padEnd(64)
    const detail = r.outcome ? `  ${r.outcome}` : ''
    console.log(`${mark}${label}${r.expect ? `expect=${String(r.expect).padEnd(10)}` : ''}${detail}`)
  }
  console.log(`\n${pass} passed, ${fail} failed, ${rows.length} rows`)
  return { pass, fail, rows }
}

// ------------------------------------------------------------------ main
//
// Guarded on being the entry point, because `cdt06-ui.mjs` imports `sql`, `auth`
// and NONCE from here. Without the guard, importing it would re-run the CLI
// against the importer's argv, which is how a UI run would silently invoke a
// teardown.

const isEntry = process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename
const mode = isEntry ? process.argv[2] : '--as-module'
if (mode === '--setup') {
  await setup()
} else if (mode === '--teardown') {
  process.exit(await teardown())
} else if (mode === '--print-ids') {
  if (!existsSync(IDS_FILE)) {
    console.error('no fixture ids on disk; run --setup first')
    process.exit(1)
  }
  console.log(readFileSync(IDS_FILE, 'utf8'))
} else if (mode === '--sql') {
  const f = process.argv[3]
  if (!f) {
    console.error('usage: --sql <path to .sql>')
    process.exit(2)
  }
  const { fail } = await runSqlFile(path.resolve(f))
  process.exit(fail > 0 ? 1 : 0)
} else if (mode !== '--as-module') {
  console.error(
    'usage: node scripts/cdt06-fixtures.mjs --setup | --print-ids | --sql <file> | --teardown',
  )
  process.exit(2)
}
