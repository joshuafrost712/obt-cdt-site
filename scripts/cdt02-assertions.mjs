/**
 * Run CDT-02's runtime acceptance criteria against the live portal project.
 *
 *   node scripts/cdt02-assertions.mjs
 *
 * ## What it does, and why it is shaped this way
 *
 * The criteria must run against the REAL four bundles and the REAL 41-unit
 * registry ("no invented bundles", criterion 3). But `Bundle-Map.md` and
 * `Domain-Map.md` are both UNSIGNED as of 2026-08-21, and rows that decide who may
 * assess whom are not written from an unreviewed document. Joshua's instruction on
 * 2026-08-21 was dry-run only for the bundle seed.
 *
 * So this wrapper:
 *   1. asks each seed for its rows as SQL (`--emit-sql`), which runs the seed's
 *      own gate first and needs no credentials,
 *   2. concatenates registry rows, bundle rows and scripts/cdt02-assertions.sql,
 *   3. wraps the whole thing in `begin; … rollback;`.
 *
 * Nothing persists. The schema is durable, the fixtures and the unsigned rows are
 * not, which is exactly the spec's "the schema lands, the seed does not".
 *
 * Reusing each seed's `--emit-sql` rather than parsing the maps again is
 * deliberate: a second parser is the 41-chances-to-mis-key failure `seed_bundles.py`
 * was written to prevent.
 *
 * ## The one thing this does NOT prove
 *
 * The aal2 checks forge `request.jwt.claims`. That tests the predicate a policy
 * evaluates, not Supabase Auth's issuing of a real two-factor token. The latter
 * needs a TOTP enrolment and is CDT-00 D6's outstanding check. Reported as such
 * rather than folded into the pass count.
 */
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'

const REPO = path.resolve(import.meta.dirname, '..')
const FORBIDDEN_REFS = {
  vdbirmjvjzfdgajwgowj: 'Honest Eval (repo `cairn`)',
  ckorlrchryswnnrmuctr: 'the Local Genres Research app',
}

const secretFile = path.join(homedir(), '.claude/secrets/obt-cdt-supabase.env')
const env = execFileSync('/bin/zsh', [
  '-c',
  `set -a; . ${JSON.stringify(secretFile)}; set +a; ` +
    'printf "%s\\n%s" "$OBT_CDT_SUPABASE_PROJECT_REF" "$OBT_CDT_SUPABASE_ACCESS_TOKEN"',
])
  .toString()
  .split('\n')
const ref = (env[0] || '').trim()
const token = (env[1] || '').trim()

if (!ref || !token) {
  console.error(`missing OBT_CDT_SUPABASE_PROJECT_REF or _ACCESS_TOKEN in ${secretFile}`)
  process.exit(2)
}
if (FORBIDDEN_REFS[ref]) {
  console.error(`REFUSED: ${ref} is ${FORBIDDEN_REFS[ref]}, a different product.`)
  process.exit(1)
}

const scratch = mkdtempSync(path.join(tmpdir(), 'cdt02-'))
const regSql = path.join(scratch, 'reg.sql')
const bunSql = path.join(scratch, 'bun.sql')

// Each seed gates its sources before emitting, so a map that fails its gate stops
// the run here rather than producing a half-seeded assertion pass.
for (const [script, out] of [
  ['seed_competency_registry.py', regSql],
  ['seed_bundles.py', bunSql],
]) {
  console.log(`--- ${script} --emit-sql`)
  try {
    execFileSync('python3', [path.join(REPO, 'scripts', script), '--emit-sql', out], {
      cwd: REPO,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (e) {
    console.error(`${script} refused, so nothing was asserted:\n${e.stderr?.toString() ?? e}`)
    process.exit(1)
  }
}

const sql = [
  'begin;',
  readFileSync(regSql, 'utf8'),
  readFileSync(bunSql, 'utf8'),
  readFileSync(path.join(REPO, 'scripts/cdt02-assertions.sql'), 'utf8'),
  'rollback;',
].join('\n')

writeFileSync(path.join(scratch, 'all.sql'), sql)
console.log(`\nassembled ${sql.split('\n').length} lines; posting as one transaction`)

const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: sql }),
})
const text = await res.text()

if (!res.ok) {
  console.error(`\nFAILED ${res.status}\n${text}`)
  console.error(`\nthe assembled SQL is at ${path.join(scratch, 'all.sql')}`)
  process.exit(1)
}

let rows
try {
  rows = JSON.parse(text)
} catch {
  console.error(`\nunexpected response:\n${text}`)
  process.exit(1)
}
if (!Array.isArray(rows)) {
  console.error(`\nexpected the report rows, got:\n${text}`)
  process.exit(1)
}

const pad = (s, n) => String(s ?? '').padEnd(n)
let pass = 0
let fail = 0
let lastCriterion = null
console.log('')
for (const r of rows) {
  if (r.criterion !== lastCriterion) {
    console.log(`\n=== criterion ${r.criterion}`)
    lastCriterion = r.criterion
  }
  if (r.verdict === 'PASS') pass++
  else fail++
  const mark = r.verdict === 'PASS' ? '  ok  ' : ' FAIL '
  console.log(`${mark}${pad(r.name, 56)} expected=${pad(r.expected, 24)} actual=${r.actual}`)
}

console.log(`\n${pass} passed, ${fail} failed, ${rows.length} checks`)
console.log('transaction rolled back: no fixture and no unsigned row persisted.')
if (fail > 0) {
  console.log(`the assembled SQL is at ${path.join(scratch, 'all.sql')}`)
  process.exit(1)
}
