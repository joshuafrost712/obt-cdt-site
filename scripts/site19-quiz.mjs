/**
 * SITE-19: a member takes a review quiz, and the answer key never reaches the
 * browser before an answer is submitted.
 *
 *   node scripts/site19-quiz.mjs --assert             # the whole lane, one command
 *   node scripts/site19-quiz.mjs --assert --no-build  # reuse dist/ (mutations of the DB only)
 *   node scripts/site19-quiz.mjs --teardown           # remove residue of a crashed run
 *
 * One run is: measure the baseline, set up fixtures, the SQL half (criteria 1
 * to 9), the browser half (4, 10, 11, 16), the seed and completion steps (13,
 * 17), and a counted teardown in a `finally` (19). Every count is asserted by
 * equality, never only printed (program finding 64), and every expected string
 * is read from the database or site-content.json at run time, never typed here
 * (finding 18).
 *
 * ## The fixture quiz carries no member content
 *
 * The SQL and browser halves run against `site19-qa-<hex>`, a quiz of generated
 * stems the lane writes as postgres and removes. The real Quiz 1 is touched only
 * by criterion 13's counts and criterion 16's link, never answered, so this
 * file never needs, and never holds, the real key.
 *
 * ## A refusal and an empty read are never one verdict
 *
 * Every 42501 assertion checks the code, not "no rows", and every zero-row read
 * across members carries a positive control on the reader's own row.
 *
 * ## Mutations (the contract's list)
 *
 *   1. quiz_paper returns is_correct          → criteria 2 and 4 red
 *   2. quiz_paper returns every explanation    → criteria 2 and 4 red
 *   3. grant select on quiz_choice             → criteria 1 and 5 red
 *   4. completion at score >= total - 1        → criterion 8 red
 *   5. quiz_attempt read policy `using (true)` → criterion 7 red
 *   6. the seed skips its repo grep            → seed --self-test red
 *   7. QuizPage marks every question right     → criterion 10 red
 *   8. the Review 1 row uses a raw href        → criterion 16 red
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { randomBytes, randomInt } from 'node:crypto'

const ARGV = process.argv.slice(2)
const ASSERT = ARGV.includes('--assert')
const TEARDOWN_ONLY = ARGV.includes('--teardown')
const NO_BUILD = ARGV.includes('--no-build')
if (!ASSERT && !TEARDOWN_ONLY) {
  console.error('usage: node scripts/site19-quiz.mjs --assert [--no-build] | --teardown')
  process.exit(2)
}

const PREFIX = 'site19-qa-'
const RUN = randomBytes(4).toString('hex')
const PASSWORD = `Site19-Fixture-${randomBytes(6).toString('hex')}`
const PORT = 4219
const CDP = 9339
const BASE = `http://localhost:${PORT}/obt-cdt-site`
const SHOTS = 'feedback/site19-shots'
const VAULT = process.env.OBT_CDT_VAULT || path.join(homedir(), 'Documents/Josh & Katie Vault/Claude Can Access PARA')
const QUIZ1_SOURCE = path.join(VAULT, 'Projects/OBT/OBT-CDT Central Hub/Member Pages/Psalms-Quiz-1.md')
const MEMBER_ROUTE = '/members/psalms-bali-2026'

let pass = 0
let fail = 0
const ok = (name, cond, detail = '') => {
  if (cond) pass++
  else fail++
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`)
}

// ---------------------------------------------------------------- plumbing

function creds() {
  const file = path.join(homedir(), '.claude/secrets/obt-cdt-supabase.env')
  if (!existsSync(file)) {
    console.error(`missing ${file}`)
    process.exit(2)
  }
  const [ref, token, secret, url] = execFileSync('/bin/zsh', [
    '-c',
    `set -a; . ${JSON.stringify(file)}; set +a; ` +
      'printf "%s\\n%s\\n%s\\n%s" "$OBT_CDT_SUPABASE_PROJECT_REF" "$OBT_CDT_SUPABASE_ACCESS_TOKEN" ' +
      '"$OBT_CDT_SUPABASE_SECRET_KEY" "$OBT_CDT_SUPABASE_URL"',
  ])
    .toString()
    .split('\n')
    .map((s) => s.trim())
  if (!ref || !token || !secret || !url) {
    console.error(`incomplete credentials in ${file}`)
    process.exit(2)
  }
  if (['vdbirmjvjzfdgajwgowj', 'ckorlrchryswnnrmuctr'].includes(ref)) {
    console.error(`REFUSED: ${ref} is a different product's project.`)
    process.exit(1)
  }
  return { ref, token, secret, url }
}
const { ref, token, secret, url } = creds()

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
    headers: { apikey: secret, Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  if (!res.ok && method !== 'DELETE') throw new Error(`auth ${method} ${route} ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return res.status === 204 ? {} : res.json().catch(() => ({}))
}

/** Program finding 68's guard: the lane prefix AND absence from the roster export. */
function rosterGuard(addr) {
  const roster = execFileSync('/bin/zsh', [
    '-c',
    `ls ${JSON.stringify(homedir())}/Documents/obt-cdt-allowlist-names-*.csv 2>/dev/null | tail -1`,
  ])
    .toString()
    .trim()
  if (!roster) {
    console.error('REFUSED: no roster export found; cannot prove a fixture address is not a participant.')
    process.exit(1)
  }
  if (!addr.startsWith(PREFIX) || !addr.endsWith('@example.org')) {
    console.error(`REFUSED: ${addr} is not a lane fixture address.`)
    process.exit(1)
  }
  if (readFileSync(roster, 'utf8').toLowerCase().includes(addr.toLowerCase())) {
    console.error(`REFUSED: ${addr} appears in the roster export.`)
    process.exit(1)
  }
  return path.basename(roster)
}

async function publishable() {
  const idx = await (await fetch('https://joshuafrost712.github.io/obt-cdt-site/')).text()
  const entry = /assets\/(index-[A-Za-z0-9_-]+\.js)/.exec(idx)?.[1]
  const bundle = await (await fetch(`https://joshuafrost712.github.io/obt-cdt-site/assets/${entry}`)).text()
  const key = /sb_publishable_[A-Za-z0-9_-]+/.exec(bundle)?.[0]
  const projectUrl = /https:\/\/[a-z]+\.supabase\.co/.exec(bundle)?.[0]
  if (!key || !projectUrl) throw new Error('could not read the publishable key or project URL from the live bundle')
  return { key, projectUrl }
}

function caller(pubKey, jwt) {
  const headers = { apikey: pubKey, 'Content-Type': 'application/json', ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}) }
  return {
    async rpc(fn, args) {
      const r = await fetch(`${url}/rest/v1/rpc/${fn}`, { method: 'POST', headers, body: JSON.stringify(args ?? {}) })
      return { status: r.status, body: await r.json().catch(() => null) }
    },
    async select(pathAndQuery) {
      const r = await fetch(`${url}/rest/v1/${pathAndQuery}`, { headers })
      return { status: r.status, body: await r.json().catch(() => null) }
    },
  }
}

async function asUser(email, pubKey) {
  const res = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: pubKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  })
  const body = await res.json()
  if (!body.access_token) throw new Error(`sign-in failed for a fixture: ${JSON.stringify(body).slice(0, 200)}`)
  return caller(pubKey, body.access_token)
}

/**
 * Run one read as an impersonated role, gathering the verdict as postgres
 * (program finding 63). Returns {ok, rows} or {ok:false, state, msg}; a refusal
 * and an empty result are never collapsed.
 */
async function impersonate(claims, role, query) {
  const out = await sql(`begin;
create function pg_temp.s19run(_claims text, _role text, _sql text) returns jsonb language plpgsql as $f$
declare r jsonb;
begin
  perform set_config('request.jwt.claims', _claims, true);
  perform set_config('role', _role, true);
  begin
    execute 'select coalesce(jsonb_agg(z), ''[]''::jsonb) from (' || _sql || ') z' into r;
    return jsonb_build_object('ok', true, 'rows', r);
  exception when others then
    return jsonb_build_object('ok', false, 'state', sqlstate, 'msg', sqlerrm);
  end;
end $f$;
select pg_temp.s19run(${q(JSON.stringify(claims))}, ${q(role)}, ${q(query)}) as out;
rollback;`)
  // The management API returns the LAST statement's result; rollback has none,
  // so the select is read from the array the API returns for the batch.
  const row = Array.isArray(out) ? out.find((r) => r && r.out) : null
  return row ? row.out : { ok: false, state: 'no-result', msg: JSON.stringify(out).slice(0, 200) }
}

// ----------------------------------------------------------------- fixtures

const MEMBERS = ['a', 'b', 'c', 'd']
const addr = (m) => `${PREFIX}${RUN}-${m}@example.org`
const QUIZ = `${PREFIX}${RUN}`
const QUIZ_OFF = `${PREFIX}${RUN}-off`
const WORDS = ['river', 'lantern', 'harvest', 'meadow', 'copper', 'willow', 'granite', 'orchard', 'falcon', 'ember']
const words = (n) => Array.from({ length: n }, () => WORDS[randomInt(WORDS.length)]).join(' ')

const COUNT_QUERY = `select
  (select count(*)::int from auth.users) as auth_users,
  (select count(*)::int from public.member_allowlist) as member_allowlist,
  (select count(*)::int from public.quiz) as quiz,
  (select count(*)::int from public.quiz_question) as quiz_question,
  (select count(*)::int from public.quiz_choice) as quiz_choice,
  (select count(*)::int from public.quiz_attempt) as quiz_attempt,
  (select count(*)::int from public.quiz_completion) as quiz_completion`
const RESIDUE_QUERY = `select
  (select count(*)::int from auth.users where email like '${PREFIX}%') as auth_users,
  (select count(*)::int from public.member_allowlist where email like '${PREFIX}%') as member_allowlist,
  (select count(*)::int from public.quiz where quiz_key like '${PREFIX}%') as quiz,
  (select count(*)::int from public.quiz_attempt where quiz_key like '${PREFIX}%') as quiz_attempt`

async function teardown() {
  await sql(`delete from public.quiz where quiz_key like ${q(PREFIX + '%')}`)
  const users = await authApi('GET', '/admin/users?per_page=1000')
  let deleted = 0
  for (const u of users.users ?? []) {
    if (u.email?.startsWith(PREFIX)) {
      await authApi('DELETE', `/admin/users/${u.id}`)
      deleted++
    }
  }
  await sql(`delete from public.member_allowlist where email like ${q(PREFIX + '%')}`)
  return deleted
}

async function setup() {
  const roster = rosterGuard(addr('a'))
  for (const m of MEMBERS) rosterGuard(addr(m))
  console.log(`  guard: lane prefix + absence from ${roster}`)

  await sql(`insert into public.member_allowlist (email, note, full_name) values ${MEMBERS.map(
    (m) => `(${q(addr(m))}, ${q('SITE-19 fixture; the lane removes it')}, ${q(`Site19 Fixture Member ${m.toUpperCase()}`)})`,
  ).join(', ')}`)
  const ids = {}
  for (const m of MEMBERS) {
    const u = await authApi('POST', '/admin/users', {
      email: addr(m),
      password: PASSWORD,
      email_confirm: true,
      user_metadata: { full_name: `Site19 Fixture Member ${m.toUpperCase()}` },
    })
    ids[m] = u.id
  }

  // The fixture quiz: ten generated questions. q10 has THREE choices so that
  // "a choice of a different question" (d) exists for criterion 6. Every
  // question has an explanation, so criterion 4 and 9 have text to look for.
  const qs = []
  for (let n = 1; n <= 10; n++) {
    const nChoices = n === 10 ? 3 : 4
    qs.push({
      key: `q${String(n).padStart(2, '0')}`,
      n,
      stem: `Fixture question ${n} ${RUN} about ${words(6)}?`,
      explanation: `Fixture explanation ${n} ${RUN}: ${words(8)}.`,
      choices: Array.from({ length: nChoices }, (_, i) => `Fixture option ${'abcd'[i]} ${words(3)}`),
      answer: 'abcd'[randomInt(nChoices)],
    })
  }
  const stmts = [
    `insert into public.quiz (quiz_key, title, review_route, review_anchor, review_block, source_digest, active)
     values (${q(QUIZ)}, ${q(`Site19 fixture quiz ${RUN}`)}, ${q(MEMBER_ROUTE)}, 'r1-review', 'site19-qa-block', 'fixture', true),
            (${q(QUIZ_OFF)}, ${q(`Site19 inactive fixture ${RUN}`)}, ${q(MEMBER_ROUTE)}, 'r1-review', null, 'fixture', false);`,
  ]
  for (const quiz of [QUIZ, QUIZ_OFF]) {
    for (const x of quiz === QUIZ ? qs : qs.slice(0, 2)) {
      stmts.push(`insert into public.quiz_question (quiz_key, question_key, position, stem, explanation)
                  values (${q(quiz)}, ${q(x.key)}, ${x.n}, ${q(x.stem)}, ${q(x.explanation)});`)
      x.choices.forEach((label, i) => {
        const ck = 'abcd'[i]
        stmts.push(`insert into public.quiz_choice (question_id, choice_key, position, label, is_correct)
          values ((select id from public.quiz_question where quiz_key = ${q(quiz)} and question_key = ${q(x.key)}),
                  ${q(ck)}, ${i + 1}, ${q(label)}, ${ck === x.answer});`)
      })
    }
  }
  await sql(stmts.join('\n'))
  // The key is read BACK as postgres, never taken from the generator above, so
  // the lane asserts against what the database actually holds.
  const keyRows = await sql(`select qq.question_key, qc.choice_key from public.quiz_question qq
    join public.quiz_choice qc on qc.question_id = qq.id where qq.quiz_key = ${q(QUIZ)} and qc.is_correct`)
  const key = Object.fromEntries(keyRows.map((r) => [r.question_key, r.choice_key]))
  const choiceCount = (await sql(`select count(*)::int as n from public.quiz_choice qc join public.quiz_question qq
    on qq.id = qc.question_id where qq.quiz_key = ${q(QUIZ)}`))[0].n
  const explanations = (await sql(`select question_key, explanation from public.quiz_question where quiz_key = ${q(QUIZ)}`))
  const choicesOf = Object.fromEntries(qs.map((x) => [x.key, x.choices.map((_, i) => 'abcd'[i])]))
  console.log(`  fixtures: ${MEMBERS.length} members, quiz ${QUIZ} (${keyRows.length} questions, ${choiceCount} choices), inactive ${QUIZ_OFF}`)
  return { ids, key, choiceCount, explanations, choicesOf }
}

const allRight = (fx) => Object.entries(fx.key).map(([question_key, choice_key]) => ({ question_key, choice_key }))
const wrongOn = (fx, wrongKeys) =>
  Object.entries(fx.key).map(([question_key, choice_key]) => ({
    question_key,
    choice_key: wrongKeys.includes(question_key) ? fx.choicesOf[question_key].find((c) => c !== choice_key) : choice_key,
  }))

// ----------------------------------------------------------------- SQL half

async function sqlHalf(fx, pubKey) {
  console.log('=== SQL half (criteria 1 to 9)')
  const A = await asUser(addr('a'), pubKey)
  const B = await asUser(addr('b'), pubKey)
  const C = await asUser(addr('c'), pubKey)
  const anon = caller(pubKey, null)

  // ---- criterion 1: the migration's own assertions, and the grants after it.
  const migration = readFileSync('supabase/migrations/20261015120000_review_quiz.sql', 'utf8')
  let reapply = 'ok'
  try {
    await sql(`begin;\n${migration}\nrollback;`)
  } catch (e) {
    reapply = String(e).slice(0, 200)
  }
  ok('criterion 1: the migration re-applies in a rolled-back transaction with no exception from its DO block', reapply === 'ok', reapply === 'ok' ? '' : reapply)
  const priv = (await sql(`select
    (select count(*)::int from pg_tables where schemaname='public' and tablename in ('quiz','quiz_question','quiz_choice','quiz_attempt','quiz_completion')) as tables,
    (select count(*)::int from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('quiz_paper','submit_quiz_attempt') and p.prosecdef and 'search_path=public' = any(p.proconfig)) as definers,
    (select count(*)::int from unnest(array['quiz','quiz_question','quiz_choice','quiz_attempt','quiz_completion']) t, unnest(array['SELECT','INSERT','UPDATE','DELETE']) p where has_table_privilege('anon', 'public.'||t, p)) as anon_privs,
    (select count(*)::int from unnest(array['quiz_question','quiz_choice']) t, unnest(array['SELECT','INSERT','UPDATE','DELETE']) p where has_table_privilege('authenticated', 'public.'||t, p)) as auth_key_privs,
    (select count(*)::int from unnest(array['quiz','quiz_question','quiz_choice','quiz_attempt','quiz_completion']) t, unnest(array['INSERT','UPDATE','DELETE']) p where has_table_privilege('authenticated', 'public.'||t, p)) as auth_write_privs,
    has_function_privilege('anon','public.quiz_paper(text)','EXECUTE') as anon_paper,
    has_function_privilege('anon','public.submit_quiz_attempt(text,jsonb)','EXECUTE') as anon_submit,
    has_function_privilege('authenticated','public.quiz_paper(text)','EXECUTE') as auth_paper,
    has_function_privilege('authenticated','public.submit_quiz_attempt(text,jsonb)','EXECUTE') as auth_submit`))[0]
  ok('criterion 1: 5 tables', priv.tables === 5, `tables=${priv.tables}`)
  ok('criterion 1: 2 functions, each security definer with search_path=public', priv.definers === 2, `definers=${priv.definers}`)
  ok('criterion 1: anon holds no privilege on any of the five', priv.anon_privs === 0, `privs=${priv.anon_privs}`)
  ok('criterion 1: authenticated holds no privilege on quiz_question or quiz_choice', priv.auth_key_privs === 0, `privs=${priv.auth_key_privs}`)
  ok('criterion 1: authenticated holds no write privilege on any of the five', priv.auth_write_privs === 0, `privs=${priv.auth_write_privs}`)
  ok('criterion 1: anon cannot execute either function', !priv.anon_paper && !priv.anon_submit)
  ok('criterion 1: authenticated can execute both (two-sided)', priv.auth_paper && priv.auth_submit)

  // ---- criterion 2: quiz_paper's columns are exactly the allowlist.
  const result = (await sql(`select pg_get_function_result('public.quiz_paper(text)'::regprocedure) as r`))[0].r
  const cols = new Set(
    (/TABLE\((.*)\)/s.exec(result)?.[1] ?? '').split(',').map((c) => c.trim().split(/\s+/)[0]).filter(Boolean),
  )
  const ALLOW = ['question_key', 'question_position', 'stem', 'choice_key', 'choice_position', 'label', 'explanation']
  ok(
    'criterion 2: quiz_paper result columns are set-equal to the allowlist',
    cols.size === ALLOW.length && ALLOW.every((c) => cols.has(c)),
    `extra=[${[...cols].filter((c) => !ALLOW.includes(c)).join(',')}] missing=[${ALLOW.filter((c) => !cols.has(c)).join(',')}]`,
  )
  const cPaper = await C.rpc('quiz_paper', { _quiz_key: QUIZ })
  const cRows = Array.isArray(cPaper.body) ? cPaper.body : []
  ok('criterion 2: a never-attempted member gets one row per choice', cRows.length === fx.choiceCount, `rows=${cRows.length} choices=${fx.choiceCount}`)
  ok('criterion 2: and every explanation is null', cRows.length > 0 && cRows.every((r) => r.explanation === null),
    `non-null=${cRows.filter((r) => r.explanation !== null).length}`)
  ok('criterion 2: and no row carries is_correct', cRows.length > 0 && cRows.every((r) => !('is_correct' in r)))

  // ---- criterion 3: anon and a null caller are refused, not answered empty.
  const anonPaper = await anon.rpc('quiz_paper', { _quiz_key: QUIZ })
  ok('criterion 3: anon calling quiz_paper is refused with 42501', anonPaper.body?.code === '42501', `status=${anonPaper.status} code=${anonPaper.body?.code}`)
  const nosub = await impersonate({ role: 'authenticated' }, 'authenticated', `select * from public.quiz_paper(${q(QUIZ)})`)
  ok(
    'criterion 3: authenticated with no sub gets the signed-in refusal, not zero rows',
    nosub.ok === false && nosub.state === '42501' && /signed in/.test(nosub.msg ?? ''),
    `state=${nosub.state} msg=${(nosub.msg ?? '').slice(0, 60)}`,
  )
  const withSub = await impersonate({ role: 'authenticated', sub: fx.ids.c }, 'authenticated', `select * from public.quiz_paper(${q(QUIZ)})`)
  ok('criterion 3: and the same impersonation WITH a sub is answered (control)', withSub.ok === true && withSub.rows.length === fx.choiceCount,
    `rows=${withSub.rows?.length}`)

  // ---- criterion 5: no direct read of the key tables, by code.
  for (const t of ['quiz_question', 'quiz_choice']) {
    const r = await A.select(`${t}?select=*&limit=1`)
    ok(`criterion 5: ${t} is refused with 42501, not answered empty`, r.body?.code === '42501', `status=${r.status} code=${r.body?.code}`)
  }
  const embed = await A.select(`quiz?select=*,quiz_question(*)&quiz_key=eq.${QUIZ}`)
  ok(
    'criterion 5: the embed probe quiz?select=*,quiz_question(*) is refused with 42501',
    embed.body?.code === '42501' && !Array.isArray(embed.body),
    `status=${embed.status} code=${embed.body?.code}`,
  )
  const quizRead = await A.select(`quiz?select=quiz_key&quiz_key=eq.${QUIZ}`)
  ok('criterion 5: while quiz itself is readable (control)', Array.isArray(quizRead.body) && quizRead.body.length === 1)

  // ---- criterion 6: scoring as the caller, and the refusals.
  const nullSubmit = await impersonate({ role: 'authenticated' }, 'authenticated',
    `select * from public.submit_quiz_attempt(${q(QUIZ)}, ${q(JSON.stringify(allRight(fx)))}::jsonb)`)
  ok('criterion 6: a null caller is refused', nullSubmit.ok === false && nullSubmit.state === '42501', `state=${nullSubmit.state}`)
  const missing = allRight(fx).filter((a) => a.question_key !== 'q03')
  const rMissing = await A.rpc('submit_quiz_attempt', { _quiz_key: QUIZ, _answers: missing })
  ok('criterion 6: an answer set missing one question is refused, naming it', rMissing.body?.code === '23502' && /q03/.test(rMissing.body?.message ?? ''),
    `code=${rMissing.body?.code} msg=${rMissing.body?.message}`)
  const dup = [...allRight(fx), { question_key: 'q04', choice_key: fx.key.q04 }]
  const rDup = await A.rpc('submit_quiz_attempt', { _quiz_key: QUIZ, _answers: dup })
  ok('criterion 6: a duplicate question is refused', rDup.body?.code === '23505' && /q04/.test(rDup.body?.message ?? ''),
    `code=${rDup.body?.code} msg=${rDup.body?.message}`)
  const foreign = allRight(fx).map((a) => (a.question_key === 'q10' ? { question_key: 'q10', choice_key: 'd' } : a))
  const rForeign = await A.rpc('submit_quiz_attempt', { _quiz_key: QUIZ, _answers: foreign })
  ok('criterion 6: a choice key from a different question is refused', rForeign.body?.code === '22023' && /q10/.test(rForeign.body?.message ?? ''),
    `code=${rForeign.body?.code} msg=${rForeign.body?.message}`)
  const rOff = await A.rpc('submit_quiz_attempt', { _quiz_key: QUIZ_OFF, _answers: [] })
  ok('criterion 6: an inactive quiz is refused', rOff.body?.code === 'P0002', `code=${rOff.body?.code}`)
  const refusedWrote = (await sql(`select count(*)::int as n from public.quiz_attempt where profile_id = ${q(fx.ids.a)}`))[0].n
  ok('criterion 6: and none of the refusals wrote an attempt', refusedWrote === 0, `attempts=${refusedWrote}`)

  const two = ['q02', 'q07']
  const picks6 = wrongOn(fx, two)
  const r6 = await A.rpc('submit_quiz_attempt', { _quiz_key: QUIZ, _answers: picks6 })
  const rows6 = Array.isArray(r6.body) ? r6.body : []
  const total = Object.keys(fx.key).length
  ok('criterion 6: a valid attempt with two wrong scores total minus 2', rows6[0]?.score === total - 2 && rows6[0]?.total === total,
    `score=${rows6[0]?.score} total=${rows6[0]?.total}`)
  ok('criterion 6: completed = false', rows6.length > 0 && rows6.every((r) => r.completed === false))
  const wrongRows = rows6.filter((r) => r.correct === false).map((r) => r.question_key).sort()
  ok('criterion 6: correct = false on exactly the two', JSON.stringify(wrongRows) === JSON.stringify(two), `wrong=${wrongRows.join(',')}`)
  const pickedOf = Object.fromEntries(picks6.map((p) => [p.question_key, p.choice_key]))
  const SUBMIT_COLS = ['attempt_no', 'score', 'total', 'completed', 'question_key', 'choice_key', 'correct', 'explanation']
  ok('criterion 6: every returned choice_key is the one picked, so no unpicked key is returned',
    rows6.length === total && rows6.every((r) => r.choice_key === pickedOf[r.question_key]))
  ok('criterion 6: and the rows carry exactly the eight allowlisted fields',
    rows6.length > 0 && rows6.every((r) => Object.keys(r).length === SUBMIT_COLS.length && SUBMIT_COLS.every((k) => k in r)))
  const owner = (await sql(`select profile_id from public.quiz_attempt where quiz_key = ${q(QUIZ)} order by submitted_at desc limit 1`))[0]?.profile_id
  ok("criterion 6: the stored attempt's profile_id is A's", owner === fx.ids.a)

  // ---- criterion 9: explanations follow the rule.
  ok('criterion 9: the submit returns null explanation on every not-yet question',
    rows6.filter((r) => !r.correct).every((r) => r.explanation === null))
  ok('criterion 9: and non-null where correct', rows6.filter((r) => r.correct).length > 0 && rows6.filter((r) => r.correct).every((r) => r.explanation !== null))
  const aPaper = await A.rpc('quiz_paper', { _quiz_key: QUIZ })
  const withExpl = new Set((aPaper.body ?? []).filter((r) => r.explanation !== null).map((r) => r.question_key))
  const correctSet = new Set(
    (await sql(`select r ->> 'question_key' as k from public.quiz_attempt a, jsonb_array_elements(a.result) r
               where a.profile_id = ${q(fx.ids.a)} and a.quiz_key = ${q(QUIZ)} and (r ->> 'correct')::boolean`)).map((r) => r.k),
  )
  ok('criterion 9: quiz_paper as A explains exactly the questions A has answered correctly',
    withExpl.size === correctSet.size && [...correctSet].every((k) => withExpl.has(k)) && withExpl.size === total - 2,
    `explained=${withExpl.size} correct=${correctSet.size}`)

  // ---- criterion 8: completion exactly at a full score, once.
  const r8a = await A.rpc('submit_quiz_attempt', { _quiz_key: QUIZ, _answers: wrongOn(fx, ['q05']) })
  ok('criterion 8: a one-wrong attempt is accepted', r8a.status === 200 && r8a.body?.[0]?.score === total - 1, `score=${r8a.body?.[0]?.score}`)
  const c8a = (await sql(`select count(*)::int as n from public.quiz_completion where profile_id = ${q(fx.ids.a)}`))[0].n
  ok('criterion 8: and writes no quiz_completion', c8a === 0, `rows=${c8a}`)
  const r8b = await A.rpc('submit_quiz_attempt', { _quiz_key: QUIZ, _answers: allRight(fx) })
  ok('criterion 8: an all-right attempt reports completed', r8b.body?.[0]?.completed === true && r8b.body?.[0]?.score === total)
  const aAttempts = (await sql(`select count(*)::int as n from public.quiz_attempt where profile_id = ${q(fx.ids.a)}`))[0].n
  const c8b = await sql(`select completed_at, attempts_to_complete from public.quiz_completion where profile_id = ${q(fx.ids.a)}`)
  ok('criterion 8: and writes exactly one completion', c8b.length === 1, `rows=${c8b.length}`)
  ok("criterion 8: with attempts_to_complete equal to A's attempt count", c8b[0]?.attempts_to_complete === aAttempts,
    `attempts_to_complete=${c8b[0]?.attempts_to_complete} attempts=${aAttempts}`)
  await new Promise((r) => setTimeout(r, 1100))
  await A.rpc('submit_quiz_attempt', { _quiz_key: QUIZ, _answers: allRight(fx) })
  const c8c = await sql(`select completed_at from public.quiz_completion where profile_id = ${q(fx.ids.a)}`)
  ok('criterion 8: a second all-right attempt leaves exactly one row', c8c.length === 1, `rows=${c8c.length}`)
  ok('criterion 8: with the original completed_at', c8c[0]?.completed_at === c8b[0]?.completed_at)

  // ---- criterion 7: privacy between members, with a positive control.
  await B.rpc('submit_quiz_attempt', { _quiz_key: QUIZ, _answers: allRight(fx) })
  const aCount = (await sql(`select count(*)::int as n from public.quiz_attempt where profile_id = ${q(fx.ids.a)}`))[0].n
  const bReadsA = await B.select(`quiz_attempt?select=id&profile_id=eq.${fx.ids.a}`)
  const bReadsOwn = await B.select(`quiz_attempt?select=id&profile_id=eq.${fx.ids.b}`)
  const bReadsAll = await B.select(`quiz_attempt?select=id,profile_id&quiz_key=eq.${QUIZ}`)
  ok("criterion 7: B reading A's attempts gets 0 rows with no error", bReadsA.status === 200 && Array.isArray(bReadsA.body) && bReadsA.body.length === 0,
    `status=${bReadsA.status} rows=${bReadsA.body?.length}`)
  ok('criterion 7: while B reads its own attempt (control)', Array.isArray(bReadsOwn.body) && bReadsOwn.body.length === 1, `rows=${bReadsOwn.body?.length}`)
  ok("criterion 7: and an unfiltered read by B returns only B's rows", Array.isArray(bReadsAll.body) && bReadsAll.body.length === 1 && bReadsAll.body.every((r) => r.profile_id === fx.ids.b),
    `rows=${bReadsAll.body?.length}`)
  const aReadsOwn = await A.select(`quiz_attempt?select=id&profile_id=eq.${fx.ids.a}`)
  ok('criterion 7: A reads its own attempts, the count written above', Array.isArray(aReadsOwn.body) && aReadsOwn.body.length === aCount,
    `rows=${aReadsOwn.body?.length} expected=${aCount}`)
  const bReadsAc = await B.select(`quiz_completion?select=quiz_key&profile_id=eq.${fx.ids.a}`)
  const bReadsOwnC = await B.select(`quiz_completion?select=quiz_key&profile_id=eq.${fx.ids.b}`)
  ok("criterion 7: B reading A's completion gets 0 rows with no error", bReadsAc.status === 200 && Array.isArray(bReadsAc.body) && bReadsAc.body.length === 0)
  ok('criterion 7: while B reads its own completion (control)', Array.isArray(bReadsOwnC.body) && bReadsOwnC.body.length === 1)
}

// ------------------------------------------------------------- browser half

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else out.push(p)
  }
  return out
}

function nodeText(id) {
  const content = JSON.parse(readFileSync('src/content/site-content.json', 'utf8'))
  const found = []
  const visit = (n) => {
    if (Array.isArray(n)) n.forEach(visit)
    else if (n && typeof n === 'object') {
      if (n.id === id) found.push(n.label ?? n.body ?? n.title)
      Object.values(n).forEach(visit)
    }
  }
  visit(content)
  return found[0] ?? null
}

async function browserHalf(fx, pub) {
  console.log('=== browser half (criteria 4, 10, 11, 16)')
  const { chromium } = await import('playwright')

  if (NO_BUILD) {
    // A stale dist/ reads as a product defect. Found running mutation 8 straight
    // after mutation 7: --no-build reused the dist/ that still carried mutation
    // 7's page, and criterion 10 went red for a reason that was not the product.
    const newestSrc = Math.max(...walk('src').map((f) => statSync(f).mtimeMs))
    const built = existsSync('dist/404.html') ? statSync('dist/404.html').mtimeMs : 0
    if (newestSrc > built) throw new Error('--no-build refused: src/ is newer than dist/, so dist/ may not be the code under test. Run without --no-build.')
  } else {
    console.log("  building dist/ with the deploy's own environment…")
    execFileSync('npm', ['run', 'build'], {
      stdio: 'ignore',
      env: { ...process.env, VITE_BASE: '/obt-cdt-site/', VITE_SUPABASE_URL: pub.projectUrl, VITE_SUPABASE_PUBLISHABLE_KEY: pub.key },
    })
  }
  const four04 = readFileSync('dist/404.html', 'utf8')
  ok('precondition: dist/ is built with the production base path', four04.includes('src="/obt-cdt-site/assets/'))
  const entry = /src="\/obt-cdt-site\/(assets\/index-[A-Za-z0-9_-]+\.js)"/.exec(four04)?.[1]
  const entryText = entry ? readFileSync(path.join('dist', entry), 'utf8') : ''
  ok('precondition: dist/ is built with the backend enabled and the quiz route registered',
    entryText.includes('sb_publishable_') && entryText.includes('/portal/q/'))

  // ---- criterion 4, static half: no is_correct in the shipped or source tree.
  const countIn = (files) => files.reduce((n, f) => n + (readFileSync(f, 'utf8').split('is_correct').length - 1), 0)
  const distHits = countIn(walk('dist').filter((f) => /\.(js|html|css|json)$/.test(f)))
  const srcHits = countIn(walk('src').filter((f) => /\.(ts|tsx|json|css)$/.test(f)))
  ok('criterion 4: is_correct occurs 0 times in dist/**', distHits === 0, `hits=${distHits}`)
  ok('criterion 4: is_correct occurs 0 times in src/**', srcHits === 0, `hits=${srcHits}`)

  const server = spawn('node', ['scripts/serve-dist.mjs', '--port', String(PORT)], { stdio: 'ignore' })
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${BASE}/`)).ok) break
    } catch {}
    await new Promise((r) => setTimeout(r, 250))
  }

  mkdirSync(SHOTS, { recursive: true })
  const browser = await chromium.launch({ args: [`--remote-debugging-port=${CDP}`] })
  const quizUrl = `${BASE}/portal/q/${QUIZ}`
  const signIn = async (page, email) => {
    await page.goto(`${BASE}/portal`, { waitUntil: 'networkidle' })
    await page.fill('input[type="email"]', email)
    await page.fill('input[type="password"]', PASSWORD)
    await page.click('button[type="submit"]')
    await page.waitForTimeout(2500)
  }
  const nodeIn = async (page, scope, id) => {
    const loc = page.locator(`${scope} [data-dfb-node="${id}"]`)
    const n = await loc.count()
    const text = n ? (await loc.first().innerText()).trim() : ''
    return { n, text }
  }
  const pickAll = async (page, choose) => {
    for (const k of Object.keys(fx.key)) await page.check(`#site19-${k}-${choose(k)}`)
  }
  const noOverflow = async (page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)

  try {
    // ---- criterion 11: signed out.
    {
      const ctx = await browser.newContext()
      const page = await ctx.newPage()
      await page.goto(quizUrl, { waitUntil: 'networkidle' })
      await page.waitForTimeout(1500)
      const s = await nodeIn(page, '[data-quiz-state="signed-out"]', 'portal.quiz.signed_out')
      ok('criterion 11: signed out renders portal.quiz.signed_out with its text', s.n === 1 && s.text === nodeText('portal.quiz.signed_out'), `n=${s.n}`)
      ok('criterion 11: and the sign-in form', (await page.locator('input[type="email"]').count()) === 1)
      await ctx.close()
    }

    // ---- criteria 4, 10 and 11, at both widths, each on a fresh member.
    for (const [width, height, member] of [[1280, 900, 'c'], [390, 844, 'd']]) {
      const ctx = await browser.newContext({ viewport: { width, height } })
      const page = await ctx.newPage()
      await signIn(page, addr(member))

      // Criterion 11's submit-failed state, on the 390 member BEFORE its run:
      // the RPC is aborted, so nothing may be recorded.
      if (member === 'd') {
        await page.goto(quizUrl, { waitUntil: 'networkidle' })
        await page.waitForSelector('[data-quiz-state="not-started"]', { timeout: 15000 })
        await pickAll(page, (k) => fx.key[k])
        await page.route('**/rest/v1/rpc/submit_quiz_attempt', (r) => r.abort())
        await page.click('[data-quiz-submit]')
        await page.waitForSelector('[data-quiz-state="submit-failed"]', { timeout: 15000 }).catch(() => {})
        const s = await nodeIn(page, '[data-quiz-state="submit-failed"]', 'portal.quiz.submit_failed')
        ok('criterion 11: an aborted submit renders portal.quiz.submit_failed', s.n === 1 && s.text === nodeText('portal.quiz.submit_failed'), `n=${s.n}`)
        const dAttempts = (await sql(`select count(*)::int as n from public.quiz_attempt where profile_id = ${q(fx.ids.d)}`))[0].n
        ok('criterion 11: and the aborted submit recorded nothing', dAttempts === 0, `attempts=${dAttempts}`)
        await page.screenshot({ path: `${SHOTS}/submit-failed-${width}.png`, fullPage: true })
        await page.unroute('**/rest/v1/rpc/submit_quiz_attempt')
      }

      // Criterion 4's capture: every /rest/v1/ body until Submit is pressed.
      const bodies = []
      let capturing = true
      page.on('response', async (res) => {
        if (!capturing || !res.url().includes('/rest/v1/')) return
        try {
          bodies.push(await res.text())
        } catch {}
      })
      await page.goto(quizUrl, { waitUntil: 'networkidle' })
      await page.waitForSelector('[data-quiz-state="not-started"]', { timeout: 15000 })
      const ns = await nodeIn(page, '[data-quiz-state="not-started"]', 'portal.quiz.not_started')
      ok(`criterion 11 @${width}: not started renders portal.quiz.not_started`, ns.n === 1 && ns.text === nodeText('portal.quiz.not_started'))
      const disc = await nodeIn(page, '[data-quiz-state="not-started"]', 'portal.quiz.disclosure')
      const discNode = nodeText('portal.quiz.disclosure') ?? ''
      ok(`criterion 11 @${width}: the disclosure renders with its node text`, disc.n === 1 && disc.text === discNode)
      ok(`criterion 11 @${width}: and names attempts, the completion date, the number of attempts and Joshua`,
        /attempt/i.test(discNode) && /date you complete/i.test(discNode) && /number of attempts/i.test(discNode) && /Joshua/.test(discNode))
      ok(`criterion 10 @${width}: the quiz title renders`, (await page.locator('[data-site19-title]').innerText()).includes(`Site19 fixture quiz ${RUN}`))

      const submit = page.locator('[data-quiz-submit]')
      ok(`criterion 10 @${width}: Submit is disabled before any pick`, await submit.isDisabled())
      const two = ['q02', 'q07']
      const keys = Object.keys(fx.key)
      for (const k of keys.slice(0, -1)) {
        const c = two.includes(k) ? fx.choicesOf[k].find((x) => x !== fx.key[k]) : fx.key[k]
        await page.check(`#site19-${k}-${c}`)
      }
      ok(`criterion 10 @${width}: and still disabled with one question unpicked`, await submit.isDisabled())
      const lastK = keys[keys.length - 1]
      await page.check(`#site19-${lastK}-${fx.key[lastK]}`)
      ok(`criterion 10 @${width}: and enabled once every question has a pick`, await submit.isEnabled())
      await page.screenshot({ path: `${SHOTS}/not-started-${width}.png`, fullPage: true })

      const leakKey = bodies.reduce((n, b) => n + (b.split('is_correct').length - 1), 0)
      const leakExpl = fx.explanations.reduce((n, e) => n + bodies.filter((b) => b.includes(e.explanation)).length, 0)
      ok(`criterion 4 @${width}: no /rest/v1/ body before Submit carries is_correct`, leakKey === 0 && bodies.length > 0, `bodies=${bodies.length} hits=${leakKey}`)
      ok(`criterion 4 @${width}: nor any fixture explanation's text`, leakExpl === 0, `hits=${leakExpl}`)
      capturing = false

      const [resp] = await Promise.all([
        page.waitForResponse((r) => r.url().includes('/rest/v1/rpc/submit_quiz_attempt')),
        submit.click(),
      ])
      const served = await resp.json()
      const score = served?.[0]?.score
      await page.waitForSelector('[data-quiz-state="partly"]', { timeout: 15000 })
      const rights = await page.locator('[data-quiz-mark="right"]').count()
      const notYets = page.locator('[data-quiz-mark="not-yet"]')
      ok(`criterion 10 @${width}: the right marks in the DOM equal the server's score`, typeof score === 'number' && rights === score, `dom=${rights} server=${score}`)
      ok(`criterion 10 @${width}: exactly the two wrong picks show not yet`, (await notYets.count()) === 2)
      const hrefs = await page.locator('[data-quiz-mark="not-yet"] a').evaluateAll((as) => as.map((a) => a.getAttribute('href')))
      ok(`criterion 10 @${width}: each not-yet links to ${MEMBER_ROUTE}#r1-review`, hrefs.length === 2 && hrefs.every((h) => h?.endsWith(`${MEMBER_ROUTE}#r1-review`)),
        hrefs.join(' '))
      const partly = await nodeIn(page, '[data-quiz-state="partly"]', 'portal.quiz.partly')
      ok(`criterion 11 @${width}: partly right renders portal.quiz.partly`, partly.n === 1 && partly.text === nodeText('portal.quiz.partly'))
      ok(`criterion 10 @${width}: no horizontal overflow`, await noOverflow(page))
      await page.screenshot({ path: `${SHOTS}/partly-${width}.png`, fullPage: true })

      await page.click('[data-quiz-retake]')
      await page.waitForSelector('[data-quiz-state="retaking"]', { timeout: 5000 })
      ok(`criterion 10 @${width}: Retake clears every radio, including the right ones`, (await page.locator('input[type="radio"]:checked').count()) === 0)
      ok(`criterion 10 @${width}: and removes every mark and explanation`,
        (await page.locator('[data-quiz-mark]').count()) === 0 && (await page.locator('[data-quiz-explanation]').count()) === 0)
      ok(`criterion 10 @${width}: and Submit is disabled again`, await submit.isDisabled())
      const lastLine = page.locator('[data-quiz-last-score]')
      ok(`criterion 10 @${width}: exactly one last-score line, with the server's score`,
        (await lastLine.count()) === 1 && (await lastLine.innerText()).includes(`${score} of ${served?.[0]?.total}`))
      for (const k of keys.slice(0, -1)) await page.check(`#site19-${k}-${fx.key[k]}`)
      ok(`criterion 10 @${width}: Submit stays disabled until the tenth pick`, await submit.isDisabled())
      await page.check(`#site19-${lastK}-${fx.key[lastK]}`)
      ok(`criterion 10 @${width}: and enables on it`, await submit.isEnabled())
      await page.screenshot({ path: `${SHOTS}/retaking-${width}.png`, fullPage: true })
      await submit.click()
      await page.waitForSelector('[data-quiz-state="complete"]', { timeout: 15000 }).catch(() => {})
      ok(`criterion 10 @${width}: ten of ten reaches the complete state`, (await page.locator('[data-quiz-state="complete"]').count()) === 1)
      const done = page.locator('[data-quiz-complete]')
      const doneText = (await done.count()) ? await done.innerText() : ''
      const completeNode = (nodeText('portal.quiz.complete') ?? '').split('{date}')[0]
      ok(`criterion 11 @${width}: complete renders the portal.quiz.complete text with a date`, completeNode.length > 0 && doneText.startsWith(completeNode) && /\d{4}/.test(doneText))
      await page.screenshot({ path: `${SHOTS}/complete-${width}.png`, fullPage: true })
      await page.reload({ waitUntil: 'networkidle' })
      await page.waitForSelector('[data-quiz-state="complete"]', { timeout: 15000 }).catch(() => {})
      ok(`criterion 10 @${width}: a reload lands in complete again`, (await page.locator('[data-quiz-state="complete"]').count()) === 1)
      ok(`criterion 10 @${width}: no horizontal overflow when complete`, await noOverflow(page))
      await ctx.close()
    }

    // ---- criterion 11: an unknown quiz key.
    {
      const ctx = await browser.newContext()
      const page = await ctx.newPage()
      await signIn(page, addr('c'))
      await page.goto(`${BASE}/portal/q/${PREFIX}${RUN}-nosuch`, { waitUntil: 'networkidle' })
      await page.waitForSelector('[data-quiz-state="unknown"]', { timeout: 15000 }).catch(() => {})
      const s = await nodeIn(page, '[data-quiz-state="unknown"]', 'portal.quiz.unknown')
      ok('criterion 11: an unknown quiz key renders portal.quiz.unknown', s.n === 1 && s.text === nodeText('portal.quiz.unknown'))
      await page.goto(`${BASE}/portal/q/${QUIZ_OFF}`, { waitUntil: 'networkidle' })
      await page.waitForSelector('[data-quiz-state="unknown"]', { timeout: 15000 }).catch(() => {})
      ok('criterion 11: and so does a withdrawn (inactive) quiz', (await page.locator('[data-quiz-state="unknown"]').count()) === 1)
      await page.screenshot({ path: `${SHOTS}/unknown.png`, fullPage: true })

      // ---- criterion 16: the Review 1 link opens the quiz in the served build.
      const real = await sql(`select quiz_key, title from public.quiz where review_block = 'bali.review1' and active`)
      ok('criterion 16: one active quiz is paired with bali.review1', real.length === 1, `rows=${real.length}`)
      if (real.length === 1) {
        await page.goto(`${BASE}${MEMBER_ROUTE}`, { waitUntil: 'networkidle' })
        await page.waitForTimeout(2000)
        const link = page.locator(`#r1-links a[href$="/portal/q/${real[0].quiz_key}"]`)
        const n = await link.count()
        const href = n ? await link.first().getAttribute('href') : ''
        ok('criterion 16: the bali.review1.links grid carries the quiz link', n === 1, `links=${n}`)
        ok('criterion 16: and its href keeps the Pages base path', !!href && href.startsWith('/obt-cdt-site/portal/q/'), `href=${href}`)
        if (n) {
          await link.first().click()
          await page.waitForSelector('[data-site19-quiz]', { timeout: 15000 }).catch(() => {})
          await page.waitForSelector('[data-site19-title]', { timeout: 15000 }).catch(() => {})
          const title = (await page.locator('[data-site19-title]').count()) ? await page.locator('[data-site19-title]').innerText() : ''
          ok('criterion 16: clicking it renders the quiz with the Quiz 1 title', title === real[0].title, `title=${title.slice(0, 40)}`)
          ok('criterion 16: and no 404 page', !(await page.innerText('body')).includes("This page doesn't exist"))
          await page.screenshot({ path: `${SHOTS}/review1-link.png`, fullPage: true })
        }
      }
      await ctx.close()
    }
  } finally {
    await browser.close()
    server.kill()
  }
}

// ---------------------------------------------- seed and completion steps

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' })
  return { code: r.status, out: `${r.stdout}${r.stderr}` }
}

async function seedStep() {
  console.log('=== seed step (criterion 13)')
  if (!existsSync(QUIZ1_SOURCE)) {
    ok('criterion 13: the Quiz 1 source is in the vault', false, QUIZ1_SOURCE)
    return
  }
  const dry = run('python3', ['scripts/seed_review_quiz.py', '--source', QUIZ1_SOURCE])
  const m = /parsed\s*: questions=(\d+) choices=(\d+) correct=(\d+) explanations=(\d+)/.exec(dry.out)
  ok('criterion 13: the dry run parses the real quiz and prints its counts', dry.code === 0 && !!m, dry.code === 0 ? (m?.[0] ?? '') : dry.out.slice(-200))
  const key = /^quiz_key:\s*(\S+)/m.exec(readFileSync(QUIZ1_SOURCE, 'utf8'))?.[1]
  if (m && key) {
    const d = (await sql(`select
      (select count(*)::int from public.quiz_question where quiz_key = ${q(key)}) as questions,
      (select count(*)::int from public.quiz_choice c join public.quiz_question qq on qq.id = c.question_id where qq.quiz_key = ${q(key)}) as choices,
      (select count(*)::int from public.quiz_choice c join public.quiz_question qq on qq.id = c.question_id where qq.quiz_key = ${q(key)} and c.is_correct) as correct,
      (select count(*)::int from public.quiz_question where quiz_key = ${q(key)} and explanation is not null) as explanations`))[0]
    const printed = { questions: +m[1], choices: +m[2], correct: +m[3], explanations: +m[4] }
    ok('criterion 13: the printed counts equal the database counts after --apply', JSON.stringify(printed) === JSON.stringify(d),
      `printed=${JSON.stringify(printed)} db=${JSON.stringify(d)}`)
    ok('criterion 13: correct choices equal questions', printed.correct === printed.questions)
  }
  // --apply on an unsigned copy is refused. The copy lives outside the repo.
  const dir = mkdtempSync(path.join(tmpdir(), 'site19-unsigned-'))
  try {
    const copy = path.join(dir, 'Quiz-unsigned.md')
    writeFileSync(copy, readFileSync(QUIZ1_SOURCE, 'utf8').replace(/^signed_off:.*$/m, 'signed_off: false'))
    const r = run('python3', ['scripts/seed_review_quiz.py', '--source', copy, '--apply'])
    ok('criterion 13: --apply on a copy with signed_off: false is refused', r.code === 1 && /signed_off is not true/.test(r.out), `exit=${r.code}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

async function completionStep(fx) {
  console.log('=== completion step (criterion 17)')
  const plain = run('node', ['scripts/site19-completions.mjs', '--quiz', QUIZ])
  const submitted = /submitted at least once\s+(\d+)/.exec(plain.out)?.[1]
  const complete = /complete\s+(\d+)\n/.exec(plain.out)?.[1]
  const db = (await sql(`select (select count(distinct profile_id)::int from public.quiz_attempt where quiz_key = ${q(QUIZ)}) as s,
                                (select count(*)::int from public.quiz_completion where quiz_key = ${q(QUIZ)}) as c`))[0]
  ok('criterion 17: the aggregate counts equal the rows the lane wrote', plain.code === 0 && +submitted === db.s && +complete === db.c,
    `printed submitted=${submitted} complete=${complete}; db ${db.s}/${db.c}`)
  const leaked = MEMBERS.some((m) => plain.out.includes(addr(m)) || plain.out.includes(`Site19 Fixture Member ${m.toUpperCase()}`))
  ok('criterion 17: and the default output carries no fixture address or name', !leaked)

  const named = run('node', ['scripts/site19-completions.mjs', '--quiz', QUIZ, '--names'])
  const lines = named.out.split('\n').filter((l) => l.includes('\t'))
  const truth = await sql(`select m.full_name as name, c.completed_at, c.attempts_to_complete,
      (select count(*)::int from public.quiz_attempt a2 where a2.quiz_key = ${q(QUIZ)} and a2.profile_id = a.profile_id) as attempts
    from (select distinct profile_id from public.quiz_attempt where quiz_key = ${q(QUIZ)}) a
    join public.profiles p on p.id = a.profile_id
    left join public.member_allowlist m on lower(m.email) = lower(p.email)
    left join public.quiz_completion c on c.quiz_key = ${q(QUIZ)} and c.profile_id = a.profile_id`)
  ok('criterion 17: --names prints exactly one line per member who submitted', lines.length === truth.length, `lines=${lines.length} members=${truth.length}`)
  const good = truth.every((t) => {
    const line = lines.find((l) => l.trim().startsWith(t.name))
    if (!line) return false
    const f = line.trim().split('\t')
    const done = t.completed_at ? String(t.completed_at).slice(0, 10) : 'not yet'
    const n = t.completed_at ? t.attempts_to_complete : t.attempts
    return f.length === 3 && f[0] === t.name && f[1] === done && +f[2] === n
  })
  ok('criterion 17: each line is exactly name, completion date or not yet, attempts, matching the database', good)
  const out = run('node', ['scripts/site19-completions.mjs', '--out', 'x'])
  ok('criterion 17: --out x exits non-zero', out.code !== 0, `exit=${out.code}`)
}

// --------------------------------------------------------------------- main

if (TEARDOWN_ONLY) {
  const n = await teardown()
  console.log(`teardown: ${n} fixture account(s) removed; residue ${JSON.stringify((await sql(RESIDUE_QUERY))[0])}`)
  process.exit(0)
}

console.log(`=== SITE-19 quiz lane, run ${RUN}`)
const residue0 = (await sql(RESIDUE_QUERY))[0]
if (Object.values(residue0).some((n) => n > 0)) {
  console.log(`  residue from an earlier run found (${JSON.stringify(residue0)}); removing it before measuring the baseline`)
  await teardown()
}
const baseline = (await sql(COUNT_QUERY))[0]
console.log(`  baseline: ${Object.entries(baseline).map(([k, v]) => `${k}=${v}`).join(' ')}`)

let crashed = null
try {
  const pub = await publishable()
  const fx = await setup()
  await sqlHalf(fx, pub.key)
  await browserHalf(fx, pub)
  await seedStep()
  await completionStep(fx)
} catch (e) {
  crashed = e
  console.error(`\nlane error: ${e instanceof Error ? e.stack : String(e)}`)
  fail++
} finally {
  console.log('=== teardown (criterion 19)')
  const removed = await teardown()
  console.log(`  ${removed} fixture account(s) removed`)
  let counts = null
  let residue = null
  for (let i = 0; i < 20; i++) {
    counts = (await sql(COUNT_QUERY))[0]
    residue = (await sql(RESIDUE_QUERY))[0]
    if (Object.values(residue).every((n) => n === 0) && Object.entries(baseline).every(([k, v]) => counts[k] === v)) break
    await new Promise((r) => setTimeout(r, 1500))
  }
  for (const [t, n] of Object.entries(residue)) ok(`criterion 19: no ${t} row carrying the ${PREFIX} prefix`, n === 0, `residue=${n}`)
  for (const [t, v] of Object.entries(baseline)) ok(`criterion 19: ${t} back to the baseline`, counts[t] === v, `before=${v} after=${counts[t]}`)
}

console.log(`\nSITE-19 lane: ${pass} pass / ${fail} fail${crashed ? ' (the lane crashed; see above)' : ''}`)
process.exit(fail === 0 ? 0 : 1)
