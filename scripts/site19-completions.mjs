/**
 * SITE-19 D6: who has completed a review quiz, for Joshua, read as postgres.
 *
 *   node scripts/site19-completions.mjs                       # every quiz, counts only
 *   node scripts/site19-completions.mjs --quiz psalms-bali-2026-q1
 *   node scripts/site19-completions.mjs --quiz psalms-bali-2026-q1 --names
 *
 * ## Why a script and not an admin screen
 *
 * Admin MFA went live on 2026-10-15: `is_portal_admin()` requires `aal2`, and no
 * browser can reach `aal2` until CDT-10's TOTP challenge lands. An admin screen
 * would render empty for Joshua today. This reads through the management API as
 * `postgres`, on `apply-migration.mjs`'s footing and denylist.
 *
 * ## Counts by default, names only on request, and never to a file
 *
 * The site's rule is aggregates only. `--names` adds one line per member who has
 * submitted, with the attested name from `member_allowlist.full_name` (program
 * finding 51), the completion date or `not yet`, and the attempts it took or the
 * attempts so far (decision 5, 2026-10-15). Each line is three tab-separated
 * fields. It prints to stdout only: there is no `--out`, and any argument this
 * script does not know is refused, so a name list cannot be written into the
 * repo by a flag that happened to be accepted.
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

const FORBIDDEN_REFS = {
  vdbirmjvjzfdgajwgowj: 'Honest Eval (repo `cairn`)',
  ckorlrchryswnnrmuctr: 'the Local Genres Research app',
}

const argv = process.argv.slice(2)
let quiz = null
let names = false
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--names') names = true
  else if (a === '--quiz' && argv[i + 1] && !argv[i + 1].startsWith('--')) quiz = argv[++i]
  else {
    console.error(`REFUSED: unknown argument ${JSON.stringify(a)}. Known: --quiz <key>, --names. There is no file output.`)
    process.exit(2)
  }
}
if (quiz !== null && !/^[a-z0-9-]+$/.test(quiz)) {
  console.error(`REFUSED: ${JSON.stringify(quiz)} is not a quiz key`)
  process.exit(2)
}

const file = path.join(homedir(), '.claude/secrets/obt-cdt-supabase.env')
if (!existsSync(file)) {
  console.error(`missing ${file}`)
  process.exit(2)
}
const [ref, token] = execFileSync('/bin/zsh', [
  '-c',
  `set -a; . ${JSON.stringify(file)}; set +a; printf "%s\\n%s" "$OBT_CDT_SUPABASE_PROJECT_REF" "$OBT_CDT_SUPABASE_ACCESS_TOKEN"`,
])
  .toString()
  .split('\n')
  .map((s) => s.trim())
if (!ref || !token) {
  console.error(`incomplete credentials in ${file}`)
  process.exit(2)
}
if (FORBIDDEN_REFS[ref]) {
  console.error(`REFUSED: ${ref} is ${FORBIDDEN_REFS[ref]}, a different product.`)
  process.exit(1)
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
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`

const quizzes = quiz
  ? await sql(`select quiz_key, title from public.quiz where quiz_key = ${lit(quiz)}`)
  : await sql('select quiz_key, title from public.quiz order by quiz_key')
if (quizzes.length === 0) {
  console.error(quiz ? `REFUSED: no quiz called ${quiz}` : 'no quizzes are seeded')
  process.exit(1)
}

const accounts = (
  await sql(`select count(*)::int as n from public.profiles p
             join public.member_allowlist m on lower(m.email) = lower(p.email)`)
)[0].n

for (const q of quizzes) {
  const key = lit(q.quiz_key)
  const agg = (
    await sql(`select
      (select count(distinct profile_id)::int from public.quiz_attempt where quiz_key = ${key}) as submitted,
      (select count(*)::int from public.quiz_completion where quiz_key = ${key}) as complete,
      (select percentile_cont(0.5) within group (order by attempts_to_complete)
         from public.quiz_completion where quiz_key = ${key}) as median_attempts`)
  )[0]
  console.log(`quiz ${q.quiz_key}: ${q.title}`)
  console.log(`  members with an account   ${accounts}`)
  console.log(`  submitted at least once   ${agg.submitted}`)
  console.log(`  complete                  ${agg.complete}`)
  console.log(`  median attempts to complete  ${agg.median_attempts ?? 'none yet'}`)

  if (names) {
    const rows = await sql(`select
        coalesce(nullif(btrim(m.full_name), ''), '(no attested name)') as name,
        c.completed_at,
        c.attempts_to_complete,
        (select count(*)::int from public.quiz_attempt a2
          where a2.quiz_key = ${key} and a2.profile_id = a.profile_id) as attempts
      from (select distinct profile_id from public.quiz_attempt where quiz_key = ${key}) a
      join public.profiles p on p.id = a.profile_id
      left join public.member_allowlist m on lower(m.email) = lower(p.email)
      left join public.quiz_completion c on c.quiz_key = ${key} and c.profile_id = a.profile_id
      order by 1`)
    console.log(`  by name (name, completed, attempts):`)
    for (const r of rows) {
      const done = r.completed_at ? String(r.completed_at).slice(0, 10) : 'not yet'
      const n = r.completed_at ? r.attempts_to_complete : r.attempts
      console.log(`  ${r.name}\t${done}\t${n}`)
    }
  }
}
