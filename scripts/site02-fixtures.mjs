/**
 * SITE-02: the evaluation page's fixture lane.
 *
 *   node scripts/site02-fixtures.mjs --setup      # accounts + an EPHEMERAL instrument
 *   node scripts/site02-fixtures.mjs --assert     # the ten disclosure assertions
 *   node scripts/site02-fixtures.mjs --scan       # criterion 14's tree scan
 *   node scripts/site02-fixtures.mjs --teardown   # remove every durable row
 *
 * ## Its own lane, and its own round keys
 *
 * The coherence review of 2026-08-27 found SITE-03 provisioning from
 * `cdt04-fixtures.mjs`, whose `PREFIX` and `PASSWORD` are module constants, so a
 * `site03-gate-` account could never have come out of it. This file owns its own
 * prefix, `site02-ui-`, its own password, and imports nothing from another
 * spec's fixture script.
 *
 * It also owns its own ROUND KEYS, which is new and is the sharper half. The
 * seed emits `psalms-bali-2026:w1` and `:w2`, the real rounds. If this lane wrote
 * those and Joshua ran `seed_evaluation_instrument.py --apply` in between, the
 * teardown would delete his durable instrument. So the emitted SQL's round keys
 * are rewritten to `site02-ui-w1` / `site02-ui-w2` before it is posted, the
 * rewrite count is asserted non-zero, and the posted text is asserted to carry no
 * real round key at all. `workshop_key` is deliberately NOT rewritten: it is a
 * foreign key to `events.id` and `psalms-bali-2026` is the row that has to exist.
 *
 * ## The instrument rows are ephemeral in the sense that matters
 *
 * `Session-Map.md` and `Question-Set.md` are both `signed_off: false`, so nothing
 * durable may be written from them (SITE-01 D0, SITE-02 finding 10). CDT-04's
 * build record settled the shape: ask the seed for its rows with `--emit-sql`,
 * post them as postgres inside `--setup`, delete them at teardown. Reusing the
 * seed's own parser and gate rather than writing a second one is the
 * 41-chances-to-mis-key failure `seed_bundles.py` exists to prevent.
 *
 * ## What teardown has to remove, and the one that is easy to forget
 *
 * The six accounts and their profiles. The instrument rows under the fixture
 * round keys. AND the six `member_allowlist` rows, because
 * `handle_new_portal_user()` refuses a registration whose address is not
 * allowlisted, so the accounts cannot be made without allowlisting them first. A
 * teardown that removes the accounts and leaves the allowlist has left six
 * fixture addresses able to register on the live portal.
 */
import { readFileSync, existsSync, writeFileSync, unlinkSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'

const REPO = path.resolve(import.meta.dirname, '..')
const PREFIX = 'site02-ui-'
const PASSWORD = 'site02-evaluation-fixture-passphrase'
const IDS_FILE = path.join(REPO, 'scripts/.site02-fixture-ids.json')

/** The fixture rounds. `site02-ui-` is a prefix no other lane's key begins with. */
const W1 = 'site02-ui-w1'
const W2 = 'site02-ui-w2'
const REAL_ROUND_PREFIX = 'psalms-bali-2026:'
const WORKSHOP = 'psalms-bali-2026'

const FORBIDDEN_REFS = {
  vdbirmjvjzfdgajwgowj: 'Honest Eval (repo `cairn`)',
  ckorlrchryswnnrmuctr: 'the Local Genres Research app',
}

/**
 * Six accounts, and each one exists to make a different sentence checkable.
 *
 *   participant  the walkthrough. In BOTH rounds, with readable week-1 answers
 *                that arrived from the Google Form, so the imported disclosure
 *                sentence renders and the round-2 read-back has something to show.
 *   second       a different participant in both rounds: the zero-rows read.
 *   latecomer    in w2 and NOT on w1's list: the "you were not in that round" case.
 *   unattached   on w1's list, whose w1 response carries a null profile_id: the
 *                case a client CANNOT tell from "never answered", which is why
 *                the sentence names both.
 *   reader       in evaluation_reader and NOT oversight. The load-bearing one.
 *   headmentor   oversight, for the attributed read at aal2.
 */
const ROLES = {
  participant: 'SITE-02 participant A',
  second: 'SITE-02 participant B',
  latecomer: 'SITE-02 participant who joined for week two',
  unattached: 'SITE-02 participant whose week-1 answers are unattached',
  reader: 'SITE-02 evaluation reader, not oversight',
  headmentor: 'SITE-02 head mentor',
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

const { ref, token, secret, url: authUrl } = creds()

async function sql(query, attempt = 0) {
  // Retries a TRANSPORT failure, never a refusal. This lane makes roughly a
  // hundred management-API calls across ten minutes, and one `ECONNRESET`
  // killed a whole run mid-criterion — which is also how criterion 5's
  // membership mutation came to be left unrestored twice. A non-2xx response is
  // still thrown immediately: a 4xx is an answer and must never be retried into
  // looking like a different one.
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

// ------------------------------------------------------------- the instrument

/**
 * The seed's own SQL, with its round keys moved into this lane's namespace.
 *
 * Two assertions rather than a hopeful replace: the substitution must have
 * happened at all, and no real round key may survive it. A rewrite that silently
 * matched nothing would post the real keys and make teardown destructive.
 */
function instrumentSql() {
  const out = path.join(tmpdir(), 'site02-seed.sql')
  try {
    execFileSync(
      'python3',
      [path.join(REPO, 'scripts/seed_evaluation_instrument.py'), '--allow-unsigned-session-map', '--emit-sql', out],
      { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] },
    )
  } catch (e) {
    console.error(`the seed refused, so nothing was set up:\n${e.stderr?.toString() ?? e}`)
    process.exit(1)
  }
  let text = readFileSync(out, 'utf8')

  const before = (text.match(/psalms-bali-2026:w[12]/g) ?? []).length
  if (before === 0) {
    console.error('REFUSED: the emitted seed carries no psalms-bali-2026:w* round key, so the rewrite matched nothing.')
    process.exit(1)
  }
  text = text.replaceAll('psalms-bali-2026:w1', W1).replaceAll('psalms-bali-2026:w2', W2)
  if (text.includes(REAL_ROUND_PREFIX)) {
    console.error('REFUSED: a real round key survived the rewrite; posting it would make teardown destructive.')
    process.exit(1)
  }
  // The seed's group block ends with a global `delete ... where group_key not in
  // (...)`, which is right for the real seed and wrong here: this lane must not
  // reach outside its own prefix, and the groups are shared rows keyed on
  // group_key with no round at all.
  const dropped = text.split('\n').filter((l) => l.startsWith('delete from public.evaluation_respondent_group'))
  text = text
    .split('\n')
    .filter((l) => !l.startsWith('delete from public.evaluation_respondent_group'))
    .join('\n')

  console.log(`  instrument: ${before} round-key occurrence(s) rewritten to ${W1} / ${W2}`)
  console.log(`  instrument: ${dropped.length} global respondent-group delete(s) dropped, out of this lane's scope`)
  return text
}

// --------------------------------------------------------------------- setup

const PAST_OPEN = "now() - interval '60 days'"
const PAST_CLOSE = "now() - interval '30 days'"
const NOW_OPEN = "now() - interval '1 day'"
const FUTURE_CLOSE = "now() + interval '30 days'"

async function setup() {
  console.log('=== setup')
  const values = Object.keys(ROLES)
    .map((r) => `(${q(addr(r))}, ${q('SITE-02 fixture; delete with --teardown')})`)
    .join(', ')
  await sql(`insert into public.member_allowlist (email, note) values ${values} on conflict (email) do nothing`)

  const existing = await authApi('GET', '/admin/users?per_page=200')
  const byEmail = new Map((existing.users ?? []).map((u) => [u.email, u.id]))
  const ids = {}
  for (const role of Object.keys(ROLES)) {
    const a = addr(role)
    if (byEmail.has(a)) {
      ids[role] = byEmail.get(a)
      continue
    }
    // A CONFIRMED account through the admin API. A SQL-inserted user has no
    // usable password hash and could never sign in, which would split the SQL
    // lane from the browser one.
    const u = await authApi('POST', '/admin/users', { email: a, password: PASSWORD, email_confirm: true })
    ids[role] = u.id
  }
  for (const [role, name] of Object.entries(ROLES)) {
    await sql(`update public.profiles set full_name = ${q(name)}, org = 'Fixture' where id = ${q(ids[role])}`)
  }

  await sql(instrumentSql())

  // Round states. w1 is CLOSED, which is what makes criterion 4a and the
  // facilitator reads runnable at all; w2 is OPEN and is the walkthrough.
  await sql(`
    update public.workshop_evaluation_round
       set opens_at = ${PAST_OPEN}, closes_at = ${PAST_CLOSE}, state = 'closed'
     where round_key = ${q(W1)};
    update public.workshop_evaluation_round
       set opens_at = ${NOW_OPEN}, closes_at = ${FUTURE_CLOSE}, state = 'open'
     where round_key = ${q(W2)};
  `)

  // Membership. `latecomer` is deliberately absent from w1.
  const members = [
    [W1, 'participant'], [W1, 'second'], [W1, 'unattached'],
    [W2, 'participant'], [W2, 'second'], [W2, 'unattached'], [W2, 'latecomer'],
  ]
  await sql(
    `insert into public.evaluation_participant (round_key, profile_id) values ` +
      members.map(([r, role]) => `(${q(r)}, ${q(ids[role])})`).join(', ') +
      ` on conflict do nothing`,
  )
  await sql(
    `insert into public.evaluation_reader (profile_id, note) values (${q(ids.reader)}, 'SITE-02 fixture') ` +
      `on conflict (profile_id) do nothing`,
  )
  await sql(
    `insert into public.head_mentor (profile_id) values (${q(ids.headmentor)}) on conflict do nothing`,
  )

  await seedWeekOne(ids)

  writeFileSync(
    IDS_FILE,
    JSON.stringify({ prefix: PREFIX, password: PASSWORD, w1: W1, w2: W2, ids }, null, 2) + '\n',
  )
  const [n] = await sql(`select count(*)::int as n from public.profiles where email like ${q(PREFIX + '%')}`)
  console.log(`  ${Object.keys(ROLES).length} confirmed accounts, ${n.n} profiles`)
  console.log(`  ids written to ${path.relative(REPO, IDS_FILE)}`)
}

/**
 * Week one, closed, with enough responses for the aggregate to be worth reading.
 *
 * Eight responses, not two: `min_n` is 4 and a suppression assertion over a
 * population that never clears it proves nothing in either direction. One item is
 * deliberately rated by ONE person, which is the cell the panel promises to
 * withhold.
 *
 * Every string written here is generic fixture prose. No item title, question key
 * or participant sentence is typed into this file — SITE-03's finding 18 and
 * program finding 24: a harness that holds member prose both leaks it and jams
 * the seed that would have caught the leak.
 */
async function seedWeekOne(ids) {
  const rows = await sql(
    `select item_key from public.evaluation_item where round_key = ${q(W1)} and active order by day, ordinal`,
  )
  const items = rows.map((r) => r.item_key)
  if (items.length < 3) throw new Error(`expected the w1 instrument to be seeded, found ${items.length} active items`)
  // Two shaped items, and each is a sentence in the panel. `scarce` is rated by
  // ONE person, which is the cell suppression has to withhold. `first` collects a
  // single "I wasn't there", which is what makes `n_absent` non-zero on an item
  // that still publishes — a suppressed cell withholds its counts, so an absence
  // assertion measured only there would be measuring nothing.
  const scarce = items[items.length - 1]
  const first = items[0]
  // A third shaped item: response 0 is the walkthrough participant's, and
  // criterion 4a reads THEIR closed round back. Without an absence of their own
  // there is nothing on that screen for "shown as an absence, not as a number" to
  // measure, and the criterion asserted over an empty set on the first run.
  const shownAbsent = items[1]
  const questions = await sql(
    `select question_key, answer_shape, required from public.evaluation_question where round_key = ${q(W1)} and active order by ordinal`,
  )

  // Three named fixtures plus five extra unattached responses, which is what
  // takes the population past min_n without inventing five more accounts.
  const named = [
    { role: 'participant', group: 'cit', source: 'manual' },
    { role: 'second', group: 'consultant', source: 'portal' },
  ]
  // `evaluation_response_source_provenance` is a CHECK, not a convention:
  // `source = 'manual'` REQUIRES an import_id and `source = 'portal'` requires
  // none. So an imported fixture response needs a real `evaluation_import` row,
  // which is the schema refusing to let provenance be claimed without a record of
  // where it came from. Exactly right, and it means this lane creates one.
  const [imp] = await sql(`
    insert into public.evaluation_import
      (round_key, source_file, source_digest, manifest_file, manifest_digest,
       rows_read, rows_imported, rows_unattached, operator)
    values (${q(W1)}, 'site02-ui-fixture.csv', 'site02-ui-fixture-digest',
            'site02-ui-fixture-manifest.json', 'site02-ui-fixture-manifest-digest',
            8, 8, 6, 'site02-ui fixture')
    returning id`)
  const importId = q(imp.id)

  const statements = []
  const mkResponse = (profileId, group, source, idx) => {
    statements.push(`
      with r as (
        insert into public.evaluation_response (round_key, profile_id, respondent_group, state, source, import_id)
        values (${q(W1)}, ${profileId}, ${q(group)}, 'submitted', ${q(source)},
                ${source === 'manual' ? importId : 'null'})
        returning id
      ),
      ins_rating as (
        insert into public.evaluation_item_rating (response_id, round_key, item_key, attended, rating, comment)
        select r.id, ${q(W1)}, i.item_key,
               not (i.item_key = ${q(scarce)} and ${idx} > 0)
                 and not (i.item_key = ${q(first)} and ${idx} = 7)
                 and not (i.item_key = ${q(shownAbsent)} and ${idx} = 0),
               case when (i.item_key = ${q(scarce)} and ${idx} > 0)
                      or (i.item_key = ${q(first)} and ${idx} = 7)
                      or (i.item_key = ${q(shownAbsent)} and ${idx} = 0)
                    then null else ((${idx} % 5) + 1) end,
               case when i.ordinal = 1
                    then ${q(`Fixture comment ${idx} on `)} || i.item_key || ${q('.')} end
          from public.evaluation_item i, r
         where i.round_key = ${q(W1)} and i.active
        returning 1
      )
      insert into public.evaluation_answer
        (response_id, round_key, question_key, answer_shape, absence_allowed, body, attended, rating)
      select r.id, ${q(W1)}, qq.question_key, qq.answer_shape, qq.absence_allowed,
             -- DISTINCT PER QUESTION, not per response. With one string reused
             -- across every question, criterion 4's "their own words, exactly"
             -- still passes when the read-back is mis-keyed and shows question
             -- A's answer beside question B, which is the one screen where
             -- guessing wrong is worst.
             case when qq.answer_shape = 'text'
                  then ${q(`Fixture answer ${idx} for `)} || qq.question_key || ${q('.')} end,
             case when qq.answer_shape = 'scale' then true end,
             case when qq.answer_shape = 'scale' then ((${idx} % 5) + 1) end
        from public.evaluation_question qq, r
       where qq.round_key = ${q(W1)} and qq.active;
    `)
  }

  named.forEach((n, i) => mkResponse(q(ids[n.role]), n.group, n.source, i))
  // The unattached fixture's OWN response carries a null profile_id, which is the
  // whole point: RLS returns zero rows for it exactly as it does for a response
  // that was never filed.
  mkResponse('null', 'cit', 'manual', 2)
  for (let i = 3; i < 8; i++) mkResponse('null', 'ethnoarts', 'manual', i)

  await sql(statements.join('\n'))
  const [{ n }] = await sql(`select count(*)::int as n from public.evaluation_response where round_key = ${q(W1)}`)
  const [{ k }] = await sql(
    `select count(*)::int as k from public.evaluation_item_rating where round_key = ${q(W1)} and item_key = ${q(scarce)} and attended`,
  )
  const [{ a }] = await sql(
    `select count(*)::int as a from public.evaluation_item_rating where round_key = ${q(W1)} and item_key = ${q(first)} and not attended`,
  )
  console.log(`  week one: ${n} response(s); ${q(scarce)} has ${k} rating(s) against min_n 4; ${q(first)} has ${a} absence(s)`)
  console.log(`  questions: ${questions.length}; items: ${items.length}`)
}

// ------------------------------------------------------------------- assert

async function assertions() {
  console.log('=== the disclosure assertions')
  const ids = JSON.parse(readFileSync(IDS_FILE, 'utf8')).ids
  const harness = readFileSync(path.join(REPO, 'scripts/site02-assertions.sql'), 'utf8')
    .replaceAll('@W1@', W1)
    .replaceAll('@W2@', W2)
    .replaceAll('@PARTICIPANT@', ids.participant)
    .replaceAll('@SECOND@', ids.second)
    .replaceAll('@LATECOMER@', ids.latecomer)
    .replaceAll('@UNATTACHED@', ids.unattached)
    .replaceAll('@READER@', ids.reader)
    .replaceAll('@HEADMENTOR@', ids.headmentor)

  // One transaction per chunk. The scaffold is prepended to each and the report
  // select runs before the rollback, so a mutation's verdict comes back while the
  // mutation itself never commits. See the file header: asserting from inside a
  // savepoint discarded every mutation row and printed success.
  const parts = harness.split(/^-- @@CHUNK@@ (.+)$/m)
  const scaffold = parts[0]
  const chunks = []
  let headers = 0
  for (let i = 1; i < parts.length; i += 2) {
    const sql = parts[i + 1]
    // A marker followed immediately by another marker is a section HEADING whose
    // assertions live in the chunks below it. Dropping it is safe because it
    // carries no SQL at all; merging it forward is not, and merging it forward is
    // exactly the bug this split was written to fix.
    const bare = sql.replace(/^\s*--.*$/gm, '').trim()
    if (bare === '') {
      headers++
      continue
    }
    chunks.push({ name: parts[i].trim(), sql })
  }
  console.log(`  ${chunks.length} chunk(s) with SQL, ${headers} section heading(s) with none`)
  if (chunks.length < 11) {
    console.error(`REFUSED: ${chunks.length} chunk(s) parsed; the harness has an assertion block and ten mutations.`)
    process.exit(1)
  }

  const results = []
  for (const c of chunks) {
    const rows = await sql(
      `begin;\n${scaffold}\n${c.sql}\nselect verdict, label, outcome from site02_results order by seq;\nrollback;`,
    )
    const got = (Array.isArray(rows) ? rows : []).filter((r) => r && r.verdict)
    if (got.length === 0) {
      console.error(`REFUSED: chunk "${c.name}" returned no rows. A chunk that asserts nothing reports success.`)
      process.exit(1)
    }
    results.push(...got)
  }

  let failed = 0
  for (const r of results) {
    if (r.verdict === 'FAIL') failed++
    console.log(`  ${r.verdict === 'PASS' ? ' ok ' : r.verdict === 'note' ? 'note' : 'FAIL'}  ${r.label}${r.outcome ? `  ${r.outcome}` : ''}`)
  }
  const pass = results.filter((r) => r.verdict === 'PASS').length
  console.log(`\n  ${chunks.length} chunk(s): ${pass} pass, ${failed} fail, ${results.filter((r) => r.verdict === 'note').length} note`)

  const mutations = results.filter((r) => r.label.startsWith('MUTATION '))
  console.log(`  ${mutations.length} mutation verdict(s) reported, ${mutations.filter((m) => m.verdict === 'PASS').length} of them going the wrong way as intended`)
  if (mutations.length < 10) {
    console.error('REFUSED: fewer than ten mutation verdicts came back, so some mutation left no trace of having run.')
    process.exit(1)
  }
  return { results, failed }
}

// ----------------------------------------------------------------- teardown

async function teardown() {
  console.log('=== teardown')
  const emails = Object.keys(ROLES).map((r) => q(addr(r))).join(', ')
  // Responses first: evaluation_response has no cascade to the round, and a
  // fixture response left behind would keep the instrument undeletable.
  await sql(`
    delete from public.evaluation_answer      where round_key in (${q(W1)}, ${q(W2)});
    delete from public.evaluation_item_rating where round_key in (${q(W1)}, ${q(W2)});
    delete from public.evaluation_response    where round_key in (${q(W1)}, ${q(W2)});
    delete from public.evaluation_import      where round_key in (${q(W1)}, ${q(W2)});
    delete from public.evaluation_participant where round_key in (${q(W1)}, ${q(W2)});
    delete from public.evaluation_item        where round_key in (${q(W1)}, ${q(W2)});
    delete from public.evaluation_question    where round_key in (${q(W1)}, ${q(W2)});
    delete from public.evaluation_salt        where round_key in (${q(W1)}, ${q(W2)});
    delete from public.workshop_evaluation_round where round_key in (${q(W1)}, ${q(W2)});
  `)
  // Oversight and reader membership, scoped to this lane's own profiles. The
  // FK cascades on a profile delete, but deleting them by name first means the
  // count below is a check rather than a hope.
  const scope = `(select id from public.profiles where email like ${q(PREFIX + '%')})`
  await sql(`
    delete from public.evaluation_reader where profile_id in ${scope};
    delete from public.head_mentor       where profile_id in ${scope};
  `)

  const users = await authApi('GET', '/admin/users?per_page=200')
  for (const u of users.users ?? []) {
    if (u.email?.startsWith(PREFIX)) await authApi('DELETE', `/admin/users/${u.id}`)
  }
  await sql(`delete from public.member_allowlist where email like ${q(PREFIX + '%')}`)

  // Counted BY TABLE and printed, because "teardown ran" is not the claim.
  const counts = await sql(`
    select 'workshop_evaluation_round' as t, count(*)::int as n from public.workshop_evaluation_round where round_key like ${q(PREFIX + '%')}
    union all select 'evaluation_item',        count(*)::int from public.evaluation_item        where round_key like ${q(PREFIX + '%')}
    union all select 'evaluation_question',    count(*)::int from public.evaluation_question    where round_key like ${q(PREFIX + '%')}
    union all select 'evaluation_salt',        count(*)::int from public.evaluation_salt        where round_key like ${q(PREFIX + '%')}
    union all select 'evaluation_participant', count(*)::int from public.evaluation_participant where round_key like ${q(PREFIX + '%')}
    union all select 'evaluation_response',    count(*)::int from public.evaluation_response    where round_key like ${q(PREFIX + '%')}
    union all select 'evaluation_item_rating', count(*)::int from public.evaluation_item_rating where round_key like ${q(PREFIX + '%')}
    union all select 'evaluation_answer',      count(*)::int from public.evaluation_answer      where round_key like ${q(PREFIX + '%')}
    union all select 'evaluation_import',      count(*)::int from public.evaluation_import      where round_key like ${q(PREFIX + '%')}
    union all select 'member_allowlist',       count(*)::int from public.member_allowlist       where email like ${q(PREFIX + '%')}
    union all select 'profiles',               count(*)::int from public.profiles               where email like ${q(PREFIX + '%')}
    union all select 'evaluation_reader',      count(*)::int from public.evaluation_reader      where profile_id in ${scope}
    union all select 'head_mentor',            count(*)::int from public.head_mentor            where profile_id in ${scope}
  `)
  let dirty = 0
  for (const c of counts) {
    if (c.n !== 0) dirty++
    console.log(`  ${c.n === 0 ? ' ok ' : 'FAIL'}  ${c.t.padEnd(26)} ${c.n}`)
  }
  if (dirty) {
    console.error(`\n${dirty} table(s) still hold ${PREFIX} rows.`)
    process.exit(1)
  }
  console.log('\n  every prefix-scoped table is at zero.')
}

// --------------------------------------------------------------------------- scan

/**
 * Criterion 14, second half: no participant data anywhere in the working tree.
 *
 * The needles are read from the LIVE `profiles` table and never written to disk,
 * so this file holds no address and no name. Three properties make it a check
 * rather than a hope, and each was learned from a check that failed one of them:
 *
 *   * It scans TRACKED AND UNTRACKED files. SITE-03's finding 18: a leak in an
 *     uncommitted file is invisible to `git grep` until after it has shipped.
 *   * It carries a POSITIVE CONTROL. It plants one needle in a scratch file and
 *     proves it finds it, because "no hits" and "the scan read nothing" look
 *     identical, and SITE-06's verify script reported success over an empty set.
 *   * Its EXEMPT SET is named per entry, printed, and justified — never a
 *     loosened pattern. Program finding 12: an absence check whose population is
 *     not printed cannot be told apart from one that had nothing to look at.
 */
const SCAN_EXEMPT = [
  {
    value: 'josh_frost@sil.org',
    why: "the site's own published contact address, in the footer of every public page (SiteLayout.tsx) and in site-content.json. It is in `profiles` because Joshua is the portal admin, which is what puts it in the needle set; it is not participant data and removing it would delete the way people reach the track.",
  },
  {
    value: 'Joshua Frost',
    why: 'the same person. The public contact link reads "Email Joshua Frost" (site-content.json:2022). A facilitator name is the one named exception in this site\'s content rules, and this is the name the exemption has to carry: the profile row says "Joshua Frost" and an exemption written as "Josh Frost" matched nothing and left the real string being searched for.',
  },
]

async function scanTree() {
  console.log('=== criterion 14: no participant data in the working tree')
  const rows = await sql(`select email, coalesce(full_name, '') as name from public.profiles`)
  const exempt = new Set(SCAN_EXEMPT.map((e) => e.value))
  const all = [...new Set(rows.flatMap((r) => [r.email, r.name]))].filter((v) => v && v.trim().length > 3)
  // THIS LANE'S OWN FIXTURES ARE NOT PARTICIPANTS, and excluding them is what
  // makes the check runnable where it is documented. `ROLES` above puts "SITE-02
  // participant A" into `profiles.full_name`, so with fixtures up the scan found
  // its own source file and exited 1 — which means the first run of it happened
  // after teardown rather than in the sequence the build record printed. Caught
  // by the stage-6 review from the arithmetic: 22 emails + 21 names − 2 exempt =
  // 41, a total only reachable with zero fixture profiles.
  const fixtures = new Set(
    rows.filter((r) => r.email.startsWith(PREFIX)).flatMap((r) => [r.email, r.name]).filter(Boolean),
  )
  const needles = all.filter((v) => !exempt.has(v) && !fixtures.has(v))
  console.log(
    `  ${all.length} live name(s) and address(es); ${needles.length} searched, ` +
      `${all.length - needles.length - fixtures.size} exempt, ${fixtures.size} from this lane's own fixtures`,
  )
  if (needles.length < 10) {
    console.error(
      `REFUSED: only ${needles.length} needle(s) left to search for. An absence check over a ` +
        'population this small cannot be told apart from one that had nothing to look at.',
    )
    process.exit(1)
  }
  for (const e of SCAN_EXEMPT) {
    console.log(`  exempt  ${e.value}`)
    console.log(`          ${e.why}`)
  }

  const list = (args) => execFileSync('git', args, { cwd: REPO, encoding: 'utf8' }).split('\n').filter(Boolean)
  const tracked = list(['ls-files'])
  const untracked = list(['ls-files', '--others', '--exclude-standard'])
  const files = [...tracked, ...untracked]
  console.log(`  scanning ${tracked.length} tracked + ${untracked.length} untracked file(s)`)

  const hitsIn = (paths, terms) => {
    const out = []
    for (const f of paths) {
      let text
      try { text = readFileSync(path.join(REPO, f), 'utf8') } catch { continue }
      for (const n of terms) if (text.includes(n)) out.push(`${f}  ←  ${n.slice(0, 4)}…`)
    }
    return out
  }
  const hits = hitsIn(files, needles)

  const probe = path.join(REPO, 'scripts/.site02-scan-probe.txt')
  writeFileSync(probe, `positive control: ${needles[0]}\n`)
  const control = hitsIn(['scripts/.site02-scan-probe.txt'], needles)
  unlinkSync(probe)

  const controlOk = control.length === 1
  console.log(`  ${controlOk ? ' ok ' : 'FAIL'}  positive control: the scan finds a planted needle`)
  console.log(`  ${hits.length === 0 ? ' ok ' : 'FAIL'}  no participant name or address is in the tree`)
  for (const h of hits) console.log(`          ${h}`)
  if (!controlOk || hits.length) process.exit(1)
}

// --------------------------------------------------------------------- main

const mode = process.argv[2]
if (mode === '--setup') await setup()
else if (mode === '--assert') {
  const { failed } = await assertions()
  if (failed) process.exit(1)
} else if (mode === '--teardown') await teardown()
else if (mode === '--scan') await scanTree()
else {
  console.error('usage: node scripts/site02-fixtures.mjs --setup | --assert | --scan | --teardown')
  process.exit(2)
}
