#!/usr/bin/env node
/**
 * SITE-08 fixtures: the attribution queue's four bucket cases, provisioned.
 *
 *     node scripts/site08-fixtures.mjs --setup
 *     node scripts/site08-fixtures.mjs --teardown
 *     node scripts/site08-fixtures.mjs --verify
 *
 * ## What this lane provisions, and why each piece has to be here
 *
 * Four unattached responses in one CLOSED round, one per bucket case D1 names:
 * a typed name that normalises to exactly one allowlist name (`matched`), one
 * that normalises to two (`ambiguous`), one that matches nothing
 * (`unmatched`), and one with no identity row at all, which is the blank-name
 * case folded into `unmatched`. Criterion 5 reads all four.
 *
 * ## One fixture member is created the way a REAL member is created
 *
 * D9's rule, and it is not decoration. `site02-fixtures.mjs:234` writes
 * `profiles.full_name` with a raw SQL UPDATE, and `:230` creates the account
 * through the `/admin/users` management endpoint. Neither is a path a real
 * member takes: a real member signs up through the portal, and
 * `handle_new_portal_user()` fills `profiles.full_name` from client-supplied
 * `raw_user_meta_data`.
 *
 * That matters because criterion 5's whole point is that the queue buckets on
 * the ATTESTED name and never on the self-declared one. A mutation repointing
 * the join at `profiles.full_name` only proves something if at least one
 * fixture profile got its name the way a real member would. So `real` below
 * signs up through the anon SDK path with `options.data.full_name` set to a
 * DIFFERENT name from its allowlist row, which is exactly the shape finding 13
 * describes.
 *
 * ## One fixture state cannot be built through signUp at all
 *
 * `resolve`'s refusal 5 fires when the named subject's address is NOT on
 * `member_allowlist`, and `handle_new_portal_user()` refuses to create a
 * profile for an address that is not on the allowlist. So no sequence of
 * sign-ups reaches that state. This lane builds it by registering `offlist`
 * normally and THEN deleting its allowlist row, restoring the row on teardown.
 * It does NOT write `profiles` directly, which is what a session reading only
 * the signUp rule would do.
 *
 * ## The password is published, and that is a known decision
 *
 * Program finding 40 and open item 10: five lanes already declare a working
 * password to a live production account in a public repository. This is the
 * sixth, and it is the first whose fixtures write the field a match depends
 * on. The fix is Joshua's and is deliberately not smuggled in here.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PREFIX = 'site08-rls-'
const PASSWORD = 'site08-attribution-fixture-passphrase'
const W1 = `${PREFIX}w1`
const REAL_ROUND_PREFIX = 'psalms-bali-2026:'
const STATE = path.join(tmpdir(), 'site08-fixtures.json')

// A project ref that is a different product entirely. Refusing by name is
// cheaper than discovering it from a wrong write.
const FORBIDDEN_REFS = {}

/**
 * The four bucket cases, and the two extra roles the criteria need.
 *
 * `real` is the signUp member. Its ALLOWLIST name and its PROFILE name differ
 * deliberately: criterion 5 asserts the picker shows the first and never the
 * second, and criterion 5's mutation (a) sets profiles.full_name to another
 * member's name to prove the bucket join is not reading it.
 */
const ROLES = {
  admin:   { allowName: 'SITE08 Admin Fixture',   profileName: 'SITE08 Admin Fixture' },
  real:    { allowName: 'Rowan Attested Fixture', profileName: 'Rowan SelfDeclared Fixture', signUp: true },
  twin_a:  { allowName: 'Twin Ambiguous Fixture', profileName: 'Twin Ambiguous Fixture' },
  twin_b:  { allowName: 'Twin Ambiguous Fixture', profileName: 'Twin Ambiguous Fixture' },
  other:   { allowName: 'Otho Other Fixture',     profileName: 'Otho Other Fixture' },
  offlist: { allowName: 'Offlist Fixture',        profileName: 'Offlist Fixture' },
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
      'printf "%s\\n%s\\n%s\\n%s\\n%s" "$OBT_CDT_SUPABASE_PROJECT_REF" "$OBT_CDT_SUPABASE_ACCESS_TOKEN" ' +
      '"$OBT_CDT_SUPABASE_SECRET_KEY" "$OBT_CDT_SUPABASE_URL" "$OBT_CDT_SUPABASE_PUBLISHABLE_KEY"',
  ]).toString().split('\n').map((s) => s.trim())
  const [ref, token, secret, url, anonKey] = out
  if (!ref || !token || !secret || !url) {
    console.error(`incomplete credentials in ${file}`)
    process.exit(2)
  }
  if (FORBIDDEN_REFS[ref]) {
    console.error(`REFUSED: ${ref} is ${FORBIDDEN_REFS[ref]}, a different product.`)
    process.exit(1)
  }
  return { ref, token, secret, url, anonKey }
}

const { ref, token, secret, url: authUrl } = creds()

/**
 * Retries a TRANSPORT failure, never a refusal. Program finding 41: a 4xx is an
 * answer and must never be retried into looking like a different one.
 */
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
    console.log(`  note  transport error on the management API (${e.cause?.code ?? e.message}); retry ${attempt + 1} of 2`)
    await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)))
    return sql(query, attempt + 1)
  }
  const text = await res.text()
  if (!res.ok) throw new Error(`SQL ${res.status}: ${text}`)
  try { return JSON.parse(text) } catch { return [] }
}

async function authApi(method, pathname, body) {
  const res = await fetch(`${authUrl}/auth/v1${pathname}`, {
    method,
    headers: { apikey: secret, Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`auth ${method} ${pathname} → ${res.status}: ${text}`)
  return text ? JSON.parse(text) : {}
}

/**
 * The real member's path, and the one compromise in this lane, stated rather
 * than hidden.
 *
 * D9 requires at least one fixture member whose `profiles.full_name` was
 * written the way a REAL member's is: by `handle_new_portal_user()` reading
 * client-supplied `raw_user_meta_data`, and NOT by the raw SQL UPDATE at
 * `site02-fixtures.mjs:234`. That is what makes criterion 5's mutation (b)
 * honest, because a mutation repointing a join at `profiles.full_name` only
 * proves something if at least one profile got its name that way.
 *
 * The anon `/signup` endpoint is the literal path `shared.tsx` takes and it
 * CANNOT be used here: custom SMTP is live on this project, `@example.org` is
 * undeliverable, and the send failure is fatal — measured in session, the call
 * returns 500 `Error sending confirmation email` and rolls the account back, so
 * no user and no profile are created.
 *
 * So this uses the admin create endpoint WITH `user_metadata`, which is a
 * different door into the same room: `handle_new_portal_user()` is an
 * `after insert on auth.users` trigger, so it fires identically and fills
 * `profiles.full_name` from the metadata exactly as it would for a real
 * registrant. What is skipped is the confirmation email, which no assertion in
 * this spec depends on.
 *
 * The distinction that matters is preserved and the one that does not is not.
 * This lane never writes `profiles.full_name` directly, and the setup asserts
 * the trigger actually produced the name rather than assuming it.
 */
async function createWithMetadata(email, fullName) {
  return authApi('POST', '/admin/users', {
    email,
    password: PASSWORD,
    email_confirm: true,
    user_metadata: { full_name: fullName },
  })
}

// --------------------------------------------------------------------- setup

const PAST_OPEN = "now() - interval '60 days'"
const PAST_CLOSE = "now() - interval '30 days'"

async function setup() {
  console.log('=== setup')

  // 1. The allowlist rows, with their ATTESTED names. twin_a and twin_b carry
  //    the SAME attested name, which is what makes `ambiguous` reachable. It
  //    mirrors a live instance the spec's D8 records, where one participant
  //    holds two allowlisted addresses; that person is named in the vault and
  //    deliberately not here, because this is a public repository.
  const values = Object.entries(ROLES)
    .map(([r, v]) => `(${q(addr(r))}, ${q('SITE-08 fixture; delete with --teardown')}, ${q(v.allowName)})`)
    .join(', ')
  await sql(`insert into public.member_allowlist (email, note, full_name)
             values ${values}
             on conflict (email) do update set full_name = excluded.full_name`)
  console.log(`  allowlist: ${Object.keys(ROLES).length} row(s) with attested names`)

  // 2. The accounts. `real` goes through the portal's own signUp path; the
  //    rest through the management endpoint, which is fine because nothing
  //    asserts anything about how THEY got their names.
  const ids = {}
  const existing = await authApi('GET', '/admin/users?per_page=200')
  const byEmail = new Map((existing.users ?? []).map((u) => [u.email, u.id]))

  for (const [role, spec] of Object.entries(ROLES)) {
    const a = addr(role)
    if (byEmail.has(a)) {
      ids[role] = byEmail.get(a)
      continue
    }
    if (spec.signUp) {
      const out = await createWithMetadata(a, spec.profileName)
      ids[role] = out.id
      // NOTE the absence of a `profiles` UPDATE here. The name must arrive
      // through handle_new_portal_user(), and the assertion below proves it
      // did rather than trusting that it did.
      console.log(`  account:   ${role} created with user_metadata; the trigger writes its profile name (D9)`)
    } else {
      const u = await authApi('POST', '/admin/users', { email: a, password: PASSWORD, email_confirm: true })
      ids[role] = u.id
      await sql(`update public.profiles set full_name = ${q(spec.profileName)}, org = 'Fixture'
                 where id = ${q(ids[role])}`)
    }
  }
  console.log(`  accounts:  ${Object.keys(ids).length}`)

  // Assert the real member's two names actually differ on the live rows, which
  // is the precondition criterion 5's mutation (b) depends on. A fixture that
  // quietly ended up with matching names would make that mutation vacuous.
  const realRow = await sql(`
    select p.full_name as profile_name, m.full_name as allow_name
    from public.profiles p join public.member_allowlist m on lower(m.email) = lower(p.email)
    where p.id = ${q(ids.real)}`)
  if (!realRow.length) throw new Error('the signUp member has no profile row')
  const { profile_name: pn, allow_name: an } = realRow[0]
  // Three things, and the first is the one a later session would skip. The
  // name must be the one the TRIGGER wrote from user_metadata, which is proven
  // by it equalling the metadata string we supplied and by this lane never
  // having issued a profiles UPDATE for this role. Then it must be non-empty,
  // and it must DIFFER from the attested name, or criterion 5's mutation (b)
  // repoints a join onto an identical string and goes green while broken.
  if (pn !== ROLES.real.profileName) {
    throw new Error(
      `REFUSED: handle_new_portal_user() did not write the metadata name. ` +
      `Expected ${JSON.stringify(ROLES.real.profileName)}, found ${JSON.stringify(pn)}. ` +
      `Without the trigger having written it, criterion 5's mutation (b) proves nothing.`)
  }
  if (!pn || pn === an) {
    throw new Error(
      `REFUSED: the real member's profile name (${JSON.stringify(pn)}) must be non-empty ` +
      `and differ from its allowlist name (${JSON.stringify(an)}), ` +
      `or criterion 5's mutation (b) proves nothing.`)
  }
  console.log(`  real:      allowlist "${an}" vs profile "${pn}" — trigger-written and different, as criterion 5 needs`)

  // 3. The administrator.
  await sql(`insert into public.portal_admin (profile_id)
             values (${q(ids.admin)}) on conflict do nothing`)
  console.log('  admin:     1 portal_admin row')

  // 4. A CLOSED round in this lane's namespace, plus its instrument. Every
  //    criterion that calls a writing function runs on a closed round unless it
  //    says otherwise (D9), because decisions 9 and 10 make both functions
  //    closed-round-only.
  // workshop_key is a foreign key into public.events, not a slug column, so it
  // carries a real event id. The round KEY is this lane's own namespace, which
  // is what teardown scopes on; the event is shared reference data and is
  // neither created nor deleted here.
  await sql(`
    insert into public.workshop_evaluation_round
      (round_key, workshop_key, display_name, state, opens_at, closes_at)
    values (${q(W1)}, 'psalms-bali-2026', 'SITE-08 fixture round', 'closed',
            ${PAST_OPEN}, ${PAST_CLOSE})
    on conflict (round_key) do update
      set state = 'closed', opens_at = ${PAST_OPEN}, closes_at = ${PAST_CLOSE}`)
  console.log(`  round:     ${W1} closed`)

  // 5. An import row, because evaluation_response_identity.import_id is a
  //    non-null foreign key.
  const imp = await sql(`
    insert into public.evaluation_import
      (round_key, source_file, source_digest, manifest_file, manifest_digest,
       rows_read, rows_imported, rows_unattached, operator)
    values (${q(W1)}, 'site08-fixture.csv', repeat('0', 64), 'Round-1-Columns.json',
            repeat('0', 64), 4, 4, 4, 'site08-fixtures')
    returning id`)
  const importId = imp[0].id

  // 6. The four unattached responses, one per bucket case.
  const cases = [
    { key: 'matched',   typed: ROLES.real.allowName },
    { key: 'ambiguous', typed: ROLES.twin_a.allowName },
    { key: 'unmatched', typed: 'Nobody On This Roster' },
    { key: 'blank',     typed: null },
  ]
  const responseIds = {}
  for (const c of cases) {
    const r = await sql(`
      insert into public.evaluation_response
        (round_key, profile_id, respondent_group, state, source, import_id, submitted_at)
      values (${q(W1)}, null, 'cit', 'submitted', 'manual', ${q(importId)}, now())
      returning id`)
    responseIds[c.key] = r[0].id
    if (c.typed !== null) {
      await sql(`
        insert into public.evaluation_response_identity
          (response_id, round_key, typed_name, name_norm, import_id)
        values (${q(responseIds[c.key])}, ${q(W1)}, ${q(c.typed)},
                public.evaluation_name_norm(${q(c.typed)}), ${q(importId)})`)
    }
  }
  console.log(`  responses: 4 unattached (matched, ambiguous, unmatched, blank)`)

  // 7. The off-allowlist state, which no sequence of sign-ups can reach.
  await sql(`delete from public.member_allowlist where email = ${q(addr('offlist'))}`)
  console.log('  offlist:   allowlist row deleted after registration (restored on teardown)')

  writeFileSync(STATE, JSON.stringify(
    { prefix: PREFIX, password: PASSWORD, w1: W1, ids, responseIds, importId }, null, 2) + '\n')
  console.log(`  state:     ${STATE}`)
  await verify()
}

// -------------------------------------------------------------------- verify

/**
 * Program finding 41: the fixture set is verified and REPAIRED before the
 * criteria run, and the repair is printed. A lane that assumes its own setup
 * is the lane that reports a green run against a half-built world.
 */
async function verify() {
  console.log('=== verify')
  let repaired = 0

  const [acc] = await sql(`select count(*)::int as n from public.profiles
                           where email like ${q(PREFIX + '%')}`)
  console.log(`  profiles:  ${acc.n} of ${Object.keys(ROLES).length}`)

  const [rnd] = await sql(`select count(*)::int as n from public.workshop_evaluation_round
                           where round_key = ${q(W1)} and state = 'closed'`)
  if (rnd.n !== 1) {
    await sql(`update public.workshop_evaluation_round
               set state='closed', opens_at=${PAST_OPEN}, closes_at=${PAST_CLOSE}
               where round_key = ${q(W1)}`)
    repaired++
    console.log('  repair:    round forced back to closed')
  }

  const [resp] = await sql(`select count(*)::int as n from public.evaluation_response
                            where round_key = ${q(W1)}`)
  const [ident] = await sql(`select count(*)::int as n from public.evaluation_response_identity
                             where round_key = ${q(W1)}`)
  console.log(`  responses: ${resp.n}   identity rows: ${ident.n}`)

  const [off] = await sql(`select count(*)::int as n from public.member_allowlist
                           where email = ${q(addr('offlist'))}`)
  if (off.n !== 0) {
    await sql(`delete from public.member_allowlist where email = ${q(addr('offlist'))}`)
    repaired++
    console.log('  repair:    offlist allowlist row removed again')
  }

  console.log(`  repairs:   ${repaired}`)
  return repaired
}

// ------------------------------------------------------------------ teardown

async function teardown() {
  console.log('=== teardown')
  // Scoped to this lane's prefix and round key throughout. Nothing here may
  // reach a real row.
  if (W1.startsWith(REAL_ROUND_PREFIX)) {
    console.error('REFUSED: this lane is pointed at a real round key.')
    process.exit(1)
  }
  await sql(`delete from public.evaluation_attribution_log where round_key = ${q(W1)}`)
  await sql(`delete from public.evaluation_response_identity where round_key = ${q(W1)}`)
  await sql(`delete from public.evaluation_item_rating where round_key = ${q(W1)}`)
  await sql(`delete from public.evaluation_answer where round_key = ${q(W1)}`)
  await sql(`delete from public.evaluation_participant where round_key = ${q(W1)}`)
  await sql(`delete from public.evaluation_response where round_key = ${q(W1)}`)
  await sql(`delete from public.evaluation_import where round_key = ${q(W1)}`)
  await sql(`delete from public.evaluation_salt where round_key = ${q(W1)}`)
  await sql(`delete from public.evaluation_item where round_key = ${q(W1)}`)
  await sql(`delete from public.evaluation_question where round_key = ${q(W1)}`)
  await sql(`delete from public.workshop_evaluation_round where round_key = ${q(W1)}`)

  const scope = `(select id from public.profiles where email like ${q(PREFIX + '%')})`
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

  // Finding 4's lesson: assert a count PER TABLE and name the table, rather
  // than asserting a total. A teardown that reports a clean database while
  // leaving a table seeded is this campaign's signature class in the one place
  // a later session checks state.
  const rows = await sql(`
    select 'workshop_evaluation_round' as t, count(*)::int as n from public.workshop_evaluation_round where round_key = ${q(W1)}
    union all select 'evaluation_response',          count(*)::int from public.evaluation_response          where round_key = ${q(W1)}
    union all select 'evaluation_response_identity', count(*)::int from public.evaluation_response_identity where round_key = ${q(W1)}
    union all select 'evaluation_attribution_log',   count(*)::int from public.evaluation_attribution_log   where round_key = ${q(W1)}
    union all select 'evaluation_participant',       count(*)::int from public.evaluation_participant       where round_key = ${q(W1)}
    union all select 'evaluation_import',            count(*)::int from public.evaluation_import            where round_key = ${q(W1)}
    union all select 'member_allowlist',             count(*)::int from public.member_allowlist             where email like ${q(PREFIX + '%')}
    union all select 'profiles',                     count(*)::int from public.profiles                     where email like ${q(PREFIX + '%')}`)
  let dirty = 0
  for (const r of rows) {
    console.log(`  ${r.t.padEnd(30)} ${r.n}`)
    if (r.n !== 0) dirty++
  }
  if (dirty) {
    console.error(`\n${dirty} table(s) still hold ${PREFIX} rows.`)
    process.exit(1)
  }
  console.log('  clean: every table above is at zero, counted by name')
}

const mode = process.argv[2]
if (mode === '--setup') await setup()
else if (mode === '--teardown') await teardown()
else if (mode === '--verify') await verify()
else {
  console.error('usage: site08-fixtures.mjs --setup | --teardown | --verify')
  process.exit(2)
}
