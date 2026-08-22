/**
 * Provision and tear down CDT-04's UI fixtures on the live OBT-CDT project.
 *
 *   node scripts/cdt04-fixtures.mjs --setup
 *   node scripts/cdt04-fixtures.mjs --print-ids
 *   node scripts/cdt04-fixtures.mjs --teardown
 *
 * ## Why this file exists at all
 *
 * CDT-04's first draft named a fixture prefix and never said how a signed-in
 * consultant holding a real assignment comes to exist. The chain is five steps
 * and every one of them is a refusal if skipped:
 *
 *   1. a `member_allowlist` row, or `handle_new_portal_user()` raises
 *      insufficient_privilege on the auth.users insert;
 *   2. a CONFIRMED auth user through the Auth admin API, because a SQL-inserted
 *      account has no usable password and cannot sign in;
 *   3. `consultant` and `consultant_qualification` rows, or
 *      `assignment_qualification_guard` refuses the assignment;
 *   4. `cit_enrollment` and an `events` row for the CIT side;
 *   5. the assignment itself, walked through the state graph one legal
 *      transition at a time, because `assignment_change_guard` refuses a jump.
 *
 * ## The prefix is `cdt04-ui-`, never `cdt04-`
 *
 * Program finding 13. A LIKE prefix is a prefix: cairn's `tl05-rls-teardown.sql`
 * header records two harnesses in one spec deleting each other's accounts because
 * both matched `tl05-`. Every fixture here is `cdt04-ui-<role>@example.org`, and
 * CDT-06a owns `cdt06-rls-` and `cdt06-ui-` rather than reusing these.
 *
 * ## The instrument rows are EPHEMERAL, and that is a decision
 *
 * Measured 2026-08-21 in this session: the live project holds the full schema and
 * zero rows — no registry, no bundles, no allowlist, no users. Both source maps
 * (`Domain-Map.md`, `Bundle-Map.md`) are still `signed_off: false` pending Viji's
 * 2026-08-26 review, and Joshua's standing instruction is dry-run only for the
 * bundle seed.
 *
 * But criterion 1 fills I-1's 121 inputs in a real browser across many HTTP
 * requests, so the rows cannot live inside CDT-02's rolled-back transaction. So
 * `--setup` seeds the registry and the bundles by asking each seed for its rows
 * with `--emit-sql` and posting them as postgres, and `--teardown` deletes them
 * again. Nothing durable is written from an unsigned map, which is the
 * instruction honoured rather than worked around. Reusing each seed's own parser
 * and gate — rather than writing a second one here — is the same reason
 * `cdt02-assertions.mjs` does it: a second parser is the 41-chances-to-mis-key
 * failure `seed_bundles.py` exists to prevent.
 *
 * If a run dies half way, `--teardown` is idempotent and safe to run again.
 */
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'

const REPO = path.resolve(import.meta.dirname, '..')
const IDS_FILE = path.join(REPO, 'scripts/.cdt04-fixture-ids.json')

// The one project a migration or fixture from this repo must never reach.
const FORBIDDEN_REFS = {
  vdbirmjvjzfdgajwgowj: 'Honest Eval (repo `cairn`), a different product',
  ckorlrchryswnnrmuctr: 'the Local Genres Research app, a different project again',
}

const PREFIX = 'cdt04-ui-'
const ADDR = (role) => `${PREFIX}${role}@example.org`
// Fixture-only, thrown away at teardown, and above the project's 12-character
// minimum (CDT-00 D5 raised it from 6 on 2026-08-21).
const PASSWORD = 'cdt04-ui-fixture-passphrase'

const ROLES = {
  consultant: { kind: 'consultant', name: 'Fixture Consultant' },
  second: { kind: 'consultant', name: 'Fixture Second Rater' },
  other: { kind: 'consultant', name: 'Fixture Other Consultant' },
  cit: { kind: 'cit', name: 'Fixture CIT' },
  cit2: { kind: 'cit', name: 'Fixture Second CIT' },
}

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

const { ref, token, secret, url } = creds()

/** Run SQL as `postgres` through the management API. */
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

// The tables the two seeds own, in delete order. Named once and used by both
// setup and teardown: each seed emits plain INSERTs (they were written for a
// fresh transaction, not for an upsert), so seeding twice without clearing first
// fails on competency_scale's primary key. Setup therefore clears before it
// seeds, which is also what makes --setup safe to re-run after a crash.
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

async function clearInstrument(log) {
  for (const t of INSTRUMENT_TABLES) {
    await sql(`delete from public.${t}`)
    if (log) console.log(`  cleared ${t}`)
  }
}

async function seedInstrument() {
  // An assignment references a bundle, so the instrument cannot be cleared while
  // fixture assignments hold it. Clearing them first keeps --setup re-runnable.
  await sql(
    `delete from public.submission_rating where submission_id in (select id from public.submission);
     delete from public.submission_file where submission_id in (select id from public.submission);
     delete from public.submission;
     delete from public.assignment_event;
     delete from public.assignment where second_of is not null;
     delete from public.assignment;`,
  )
  // And the qualifications, or `refuse_orphaning_category_delete` stops the
  // clear: a category that still backs a grant may not be deleted. That guard is
  // CDT-02 working as designed, so this yields to it rather than disabling it.
  // Step 3 of setup writes the qualifications again.
  await sql(
    `delete from public.consultant_qualification
       where profile_id in (select id from public.profiles where email like ${q(PREFIX + '%')})`,
  )
  await clearInstrument(false)
  const scratch = mkdtempSync(path.join(tmpdir(), 'cdt04-'))
  const files = []
  for (const [script, flag] of [
    ['seed_competency_registry.py', '--allow-unsigned-domain-map'],
    ['seed_bundles.py', '--allow-unsigned-bundle-map'],
  ]) {
    const out = path.join(scratch, `${script}.sql`)
    console.log(`  ${script} --emit-sql`)
    try {
      // --emit-sql runs the seed's own count gate first and reads no credential,
      // so a map that fails its gate stops the run here rather than half seeding.
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
  const [counts] = await sql(
    'select (select count(*) from competency_unit) as units,' +
      ' (select count(*) from assessment_bundle) as bundles,' +
      ' (select count(*) from bundle_unit) as bundle_units',
  )
  console.log(
    `  seeded ephemerally: ${counts.units} units, ${counts.bundles} bundles, ${counts.bundle_units} bundle_units`,
  )
}

// ------------------------------------------------------------------ setup

async function setup() {
  console.log('--- 0. the instrument, from the two unsigned maps, ephemerally')
  await seedInstrument()

  console.log('--- 1. member_allowlist rows (needed before any auth user)')
  const values = Object.keys(ROLES)
    .map((r) => `(${q(ADDR(r))}, ${q('CDT-04 UI fixture; delete with --teardown')})`)
    .join(', ')
  await sql(
    `insert into public.member_allowlist (email, note) values ${values} on conflict (email) do nothing`,
  )

  console.log('--- 2. confirmed auth users')
  const ids = {}
  const existing = await auth('GET', `/admin/users?per_page=200`)
  const byEmail = new Map((existing.users ?? []).map((u) => [u.email, u.id]))
  for (const role of Object.keys(ROLES)) {
    const addr = ADDR(role)
    if (byEmail.has(addr)) {
      ids[role] = byEmail.get(addr)
      console.log(`  ${addr} already exists`)
      continue
    }
    const u = await auth('POST', '/admin/users', {
      email: addr,
      password: PASSWORD,
      email_confirm: true,
    })
    ids[role] = u.id
    console.log(`  ${addr} created`)
  }

  // handle_new_portal_user() created each profile. Give them names so the queue
  // has something to render; still fixture identities, never a real participant.
  for (const [role, meta] of Object.entries(ROLES)) {
    await sql(
      `update public.profiles set full_name = ${q(meta.name)}, org = ${q('Fixture')} where id = ${q(ids[role])}`,
    )
  }

  console.log('--- 3. consultant rows and one qualification each')
  for (const role of ['consultant', 'second', 'other']) {
    await sql(
      `insert into public.consultant (profile_id, is_cbc_mentor, languages, status, note)
         values (${q(ids[role])}, false, array['en'], 'active', 'CDT-04 UI fixture')
         on conflict (profile_id) do nothing;
       insert into public.consultant_qualification (profile_id, scope_kind, scope_key, basis)
         values (${q(ids[role])}, 'domain', 'M1', 'CDT-04 UI fixture')
         on conflict do nothing;`,
    )
  }
  // qualification_covers() is an EXISTS over the join, so one row can cover a
  // bundle. But the four bundles ask for three DIFFERENT scope kinds, which the
  // first version of this script got wrong and the guard caught: I-1 asks for
  // domains M1-M6, I-2 and I-3 for bt-* categories, and I-4 for the
  // bundle-scoped credential `obt-cdt-facilitator` — finding 3 of CDT-02, where
  // Joshua chose the credential reading of `scope_kind = 'bundle'`. A consultant
  // holding only ('domain','M1') is refused I-4 with 42501, which is the guard
  // working. So each fixture consultant is granted one row per scope kind.
  for (const role of ['consultant', 'second', 'other']) {
    await sql(
      `insert into public.consultant_qualification (profile_id, scope_kind, scope_key, basis)
         select ${q(ids[role])}, 'category', category_key, 'CDT-04 UI fixture'
           from public.competency_category
          where category_key in ('bt-exegesis','bt-discourse','bt-biblical-languages',
                                 'bt-translation-practice','bt-guiding-translation-teams')
         on conflict do nothing;
       insert into public.consultant_qualification (profile_id, scope_kind, scope_key, basis)
         select ${q(ids[role])}, 'bundle', grant_key, 'CDT-04 UI fixture'
           from public.bundle_grant
         on conflict do nothing;`,
    )
  }

  console.log('--- 4. cit_enrollment against an existing event')
  const [ev] = await sql(`select id from public.events order by start_date nulls last limit 1`)
  for (const role of ['cit', 'cit2']) {
    await sql(
      `insert into public.cit_enrollment (profile_id, participant_kind, track_membership, cohort_event_id, assessment_language, note)
         values (${q(ids[role])}, 'cit', 'sil-obt-cdt', ${ev ? q(ev.id) : 'null'}, 'en', 'CDT-04 UI fixture')
         on conflict (profile_id) do nothing`,
    )
  }

  console.log('--- 5. assignments, one legal transition at a time')
  const plan = [
    { tag: 'held_i1', bundle: 'I-1', consultant: 'consultant', subject: 'cit', to: 'held' },
    { tag: 'proposed', bundle: 'I-3', consultant: 'consultant', subject: 'cit', to: 'proposed', undated: true },
    { tag: 'scheduled', bundle: 'I-4', consultant: 'consultant', subject: 'cit', to: 'scheduled' },
    { tag: 'submitted', bundle: 'I-2', consultant: 'consultant', subject: 'cit', to: 'submitted' },
    { tag: 'returned', bundle: 'I-3', consultant: 'consultant', subject: 'cit', to: 'returned' },
    { tag: 'closed', bundle: 'I-4', consultant: 'consultant', subject: 'cit', to: 'closed' },
    { tag: 'cancelled', bundle: 'I-2', consultant: 'consultant', subject: 'cit', to: 'cancelled', undated: true },
    { tag: 'other', bundle: 'I-1', consultant: 'other', subject: 'cit2', to: 'held' },
  ]

  const GRAPH = {
    proposed: [],
    scheduled: ['scheduled'],
    held: ['scheduled', 'held'],
    submitted: ['scheduled', 'held', 'submitted'],
    returned: ['scheduled', 'held', 'submitted', 'returned'],
    closed: ['scheduled', 'held', 'submitted', 'closed'],
    cancelled: ['cancelled'],
  }

  const assignments = {}
  for (const p of plan) {
    const [row] = await sql(
      `insert into public.assignment
         (subject_profile_id, consultant_profile_id, bundle_key, qualification_basis, scheduled_at, meeting_language, subject_l1)
       values (${q(ids[p.subject])}, ${q(ids[p.consultant])}, ${q(p.bundle)},
               ${q('CDT-04 UI fixture')},
               ${p.undated ? 'null' : "now() + interval '3 days'"},
               'Indonesian', true)
       returning id`,
    )
    const id = row.id
    for (const state of GRAPH[p.to]) {
      await sql(`update public.assignment set state = ${q(state)} where id = ${q(id)}`)
    }
    assignments[p.tag] = { id, bundle: p.bundle, state: p.to }
    console.log(`  ${p.tag.padEnd(10)} ${p.bundle}  ${p.to}  ${id}`)
  }

  // The second rater on the SAME I-1 assignment's subject. rating_role and
  // second_of are set at insert because assignment_change_guard forbids changing
  // either afterwards, so this fixture is created this way or not at all.
  const [secondRow] = await sql(
    `insert into public.assignment
       (subject_profile_id, consultant_profile_id, bundle_key, qualification_basis,
        scheduled_at, meeting_language, subject_l1, rating_role, second_of)
     values (${q(ids.cit)}, ${q(ids.second)}, 'I-1', ${q('CDT-04 UI fixture')},
             now() + interval '4 days', 'Indonesian', true, 'second', ${q(assignments.held_i1.id)})
     returning id`,
  )
  await sql(`update public.assignment set state = 'scheduled' where id = ${q(secondRow.id)}`)
  await sql(`update public.assignment set state = 'held' where id = ${q(secondRow.id)}`)
  assignments.second = { id: secondRow.id, bundle: 'I-1', state: 'held' }
  console.log(`  second     I-1  held  ${secondRow.id}`)

  console.log('--- 6. submissions for the states that imply one')
  for (const tag of ['submitted', 'returned', 'closed']) {
    const a = assignments[tag]
    const [sub] = await sql(
      `insert into public.submission
         (assignment_id, bundle_key, consultant_profile_id, body_md, strength_note,
          growth_note_1, growth_note_2, context_note, connection_quality,
          consent_recorded, transcript_source, submitted_at)
       values (${q(a.id)}, ${q(a.bundle)}, ${q(ids.consultant)},
               'Fixture write-up body.', 'Fixture strength.', 'Fixture growth one.',
               'Fixture growth two.', 'Fixture context.', 'good', true, 'none', now())
       returning id`,
    )
    // Every unit in the bundle, because the RPC's coverage gate is the rule and a
    // fixture that could not have been created through the real path is a lie.
    await sql(
      `insert into public.submission_rating
         (submission_id, bundle_key, unit_key, observed_level, recommended_level,
          confidence, evidence_sentence, plain_language_check, escalate)
       select ${q(sub.id)}, bundle_key, unit_key, 2, 2, 'medium',
              'Fixture evidence sentence for ' || unit_key, 'yes', false
         from public.bundle_unit where bundle_key = ${q(a.bundle)}`,
    )
    if (tag === 'returned') {
      await sql(
        `update public.submission
            set approval_state = 'returned',
                return_reason = 'Fixture return reason: the evidence sentence for U11 names no observable behaviour.'
          where id = ${q(sub.id)}`,
      )
    }
    assignments[tag].submission = sub.id
    console.log(`  ${tag} → submission ${sub.id}`)
  }

  writeFileSync(
    IDS_FILE,
    JSON.stringify({ prefix: PREFIX, password: PASSWORD, profiles: ids, assignments }, null, 2),
  )
  console.log(`\nwrote ${path.relative(REPO, IDS_FILE)} (gitignored; holds no real participant)`)
}

// --------------------------------------------------------------- teardown

async function teardown() {
  console.log('--- deleting fixture rows, by join through the fixture profiles')
  const scope = `(select id from public.profiles where email like ${q(PREFIX + '%')})`

  // FK order, never a truncation. Each step prints so a partial teardown is
  // visible rather than silent.
  const steps = [
    ['submission_rating', `delete from public.submission_rating where submission_id in (select id from public.submission where consultant_profile_id in ${scope} or assignment_id in (select id from public.assignment where consultant_profile_id in ${scope} or subject_profile_id in ${scope}))`],
    ['submission_file', `delete from public.submission_file where submission_id in (select id from public.submission where consultant_profile_id in ${scope} or assignment_id in (select id from public.assignment where consultant_profile_id in ${scope} or subject_profile_id in ${scope}))`],
    ['submission', `delete from public.submission where consultant_profile_id in ${scope} or assignment_id in (select id from public.assignment where consultant_profile_id in ${scope} or subject_profile_id in ${scope})`],
    ['assignment_event', `delete from public.assignment_event where assignment_id in (select id from public.assignment where consultant_profile_id in ${scope} or subject_profile_id in ${scope})`],
    // second_of is a self reference, so the secondaries go first.
    ['assignment (second)', `delete from public.assignment where second_of is not null and (consultant_profile_id in ${scope} or subject_profile_id in ${scope})`],
    ['assignment', `delete from public.assignment where consultant_profile_id in ${scope} or subject_profile_id in ${scope}`],
    ['consultant_qualification', `delete from public.consultant_qualification where profile_id in ${scope}`],
    ['consultant', `delete from public.consultant where profile_id in ${scope}`],
    ['cit_enrollment', `delete from public.cit_enrollment where profile_id in ${scope}`],
  ]
  for (const [name, stmt] of steps) {
    await sql(stmt)
    console.log(`  cleared ${name}`)
  }

  // The auth users, which cascade their profiles.
  const list = await auth('GET', '/admin/users?per_page=200')
  for (const u of list.users ?? []) {
    if (u.email?.startsWith(PREFIX)) {
      await auth('DELETE', `/admin/users/${u.id}`)
      console.log(`  deleted auth user ${u.email}`)
    }
  }
  await sql(`delete from public.profiles where email like ${q(PREFIX + '%')}`)

  // Scoped to exactly the fixture addresses. The rest of member_allowlist is the
  // real cohort roster, and this harness never reads it — the delete names the
  // five addresses it put there rather than matching a pattern over the table.
  const addrs = Object.keys(ROLES).map((r) => q(ADDR(r))).join(', ')
  await sql(`delete from public.member_allowlist where email in (${addrs})`)
  console.log(`  cleared member_allowlist for exactly ${Object.keys(ROLES).length} fixture addresses`)

  console.log('--- deleting the ephemeral instrument rows (both maps are unsigned)')
  await clearInstrument(true)

  console.log('\n--- surviving fixture rows, counted per table')
  const [left] = await sql(
    `select
       (select count(*) from public.profiles where email like ${q(PREFIX + '%')}) as profiles,
       (select count(*) from public.member_allowlist where email in (${addrs})) as allowlist,
       (select count(*) from public.consultant) as consultant,
       (select count(*) from public.consultant_qualification) as qualification,
       (select count(*) from public.cit_enrollment) as enrollment,
       (select count(*) from public.assignment) as assignment,
       (select count(*) from public.assignment_event) as assignment_event,
       (select count(*) from public.submission) as submission,
       (select count(*) from public.submission_rating) as submission_rating,
       (select count(*) from public.submission_file) as submission_file,
       (select count(*) from public.competency_unit) as competency_unit,
       (select count(*) from public.assessment_bundle) as assessment_bundle`,
  )
  let dirty = 0
  for (const [k, v] of Object.entries(left)) {
    console.log(`  ${String(v).padStart(4)}  ${k}`)
    if (Number(v) !== 0) dirty++
  }
  const users = await auth('GET', '/admin/users?per_page=200')
  const leftUsers = (users.users ?? []).filter((u) => u.email?.startsWith(PREFIX)).length
  console.log(`  ${String(leftUsers).padStart(4)}  auth users with the fixture prefix`)
  if (leftUsers) dirty++
  console.log(dirty === 0 ? '\nclean: every count is zero.' : `\nNOT CLEAN: ${dirty} non-zero counts above.`)
  return dirty === 0 ? 0 : 1
}

// ------------------------------------------------------------------ main

const mode = process.argv[2]
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
} else {
  console.error('usage: node scripts/cdt04-fixtures.mjs --setup | --print-ids | --teardown')
  process.exit(2)
}
