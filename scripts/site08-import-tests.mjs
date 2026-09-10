#!/usr/bin/env node
/**
 * SITE-08 criteria 2 and 3: the importer carries the typed name, and counts it.
 *
 *     node scripts/site08-import-tests.mjs
 *
 * ## Why this file exists at all
 *
 * It was missing. SITE-08's build verified criteria 2 and 3 from a hand-edited
 * CSV in a scratch directory and reported them passing, and the stage-6 review
 * of that build found there was no committed harness and no committed tool that
 * could even generate the input: `site01-fake-export.py` wrote a name into
 * every row unconditionally. So the claim was true and unreproducible, which
 * campaign finding 57 says is the kind of claim a tracker then carries as
 * verified.
 *
 * Both halves are fixed here: that script gained `--blank-names` and
 * `--whitespace-names`, and this lane exercises the criteria from the repo.
 *
 * ## What criterion 2 actually requires
 *
 * Two exports, and the count computed FROM THE CSV in the same command rather
 * than typed, because a criterion that states a bare integer is a defect (D9,
 * rubric row 10).
 *
 * **Case A, no `Email Address` column** — the shape of the real round-1 export
 * (finding 8). Every non-blank name after trimming becomes exactly one
 * `evaluation_response_identity` row.
 *
 * **Case B, an `Email Address` column present.** A row whose address matches an
 * allowlisted account matches on email, so `profile_id` is non-null after
 * matching and D3's third rule says it gets NO identity row. The expected count
 * is therefore non-blank names MINUS email-matched rows, which is what makes
 * that rule tested rather than stated. Both exports are generated fixtures;
 * neither is the real Bali export, so this does not contradict D0's stop 1.
 *
 * ## The mutation
 *
 * D9's table allocates criterion 2 one mutation: delete the identity insert
 * from `build_sql()`, watch BOTH cases' counts disagree, restore. It is a
 * mutation of the SYSTEM and not of the fixture, and it is watched going red.
 * The restore is asserted.
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const IMPORTER = path.join(REPO, 'scripts/import_evaluation_responses.py')
const GENERATOR = path.join(REPO, 'scripts/site01-fake-export.py')
const WORK = mkdtempSync(path.join(tmpdir(), 'site08-import-'))

// An address that is on the live allowlist AND has an account, so case B has
// something real to match on. Read from the database rather than typed, per
// D9's rule that no expected string is hardcoded from participant prose — and
// this one would be a real person's address.
function creds() {
  const out = execFileSync('/bin/zsh', ['-c',
    `set -a; . ${JSON.stringify(path.join(homedir(), '.claude/secrets/obt-cdt-supabase.env'))}; set +a; ` +
    'printf "%s\\n%s" "$OBT_CDT_SUPABASE_PROJECT_REF" "$OBT_CDT_SUPABASE_ACCESS_TOKEN"',
  ]).toString().split('\n').map((s) => s.trim())
  return { ref: out[0], token: out[1] }
}
const { ref, token } = creds()
async function sql(query) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`SQL ${res.status}: ${text}`)
  try { return JSON.parse(text) } catch { return [] }
}

const results = []
const checkThat = (crit, label, ok, detail = '') => {
  results.push({ ok: !!ok, crit, label })
  console.log(`  ${ok ? ' ok ' : 'FAIL'}  c${crit} ${label}${detail ? `  — ${detail}` : ''}`)
}

/** The count of non-blank names, computed FROM THE CSV, never typed. */
function csvNameStats(file, matchAddr) {
  const text = readFileSync(file, 'utf8')
  const rows = []
  // A minimal RFC4180 reader: these fixtures carry quoted headers with commas.
  let field = '', row = [], inQ = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQ) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++ }
      else if (c === '"') inQ = false
      else field += c
    } else if (c === '"') inQ = true
    else if (c === ',') { row.push(field); field = '' }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = '' }
    else if (c !== '\r') field += c
  }
  if (field || row.length) { row.push(field); rows.push(row) }
  const header = rows[0]
  const iName = header.findIndex((h) => h.startsWith('Your name'))
  const iEmail = header.indexOf('Email Address')
  const data = rows.slice(1).filter((r) => r.some((x) => x.trim()))
  const named = data.filter((r) => (r[iName] ?? '').trim()).length
  const namedAndMatched = iEmail < 0 ? 0
    : data.filter((r) => (r[iName] ?? '').trim() && (r[iEmail] ?? '').trim().toLowerCase() === matchAddr).length
  return { total: data.length, named, namedAndMatched, hasEmailColumn: iEmail >= 0 }
}

function generate(name, extra = []) {
  const out = path.join(WORK, `${name}.csv`)
  execFileSync('python3', [GENERATOR, '--round', 'w1', '--rows', '8',
    '--blank-names', '1', '--whitespace-names', '1', '--out', out, ...extra],
    { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] })
  return out
}

/** Runs the importer in --emit-sql and returns its stdout plus the emitted SQL. */
function runImporter(csv, label) {
  const sqlOut = path.join(WORK, `${label}.sql`)
  const stdout = execFileSync('python3', [IMPORTER, '--round', 'w1', '--csv', csv,
    '--emit-sql', sqlOut, '--operator', 'site08-import-tests'],
    { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  const emitted = readFileSync(sqlOut, 'utf8')
  const identityRows = (emitted.match(/insert into public\.evaluation_response_identity/g) ?? []).length
  const printed = /^names\s+(\d+) of (\d+)/m.exec(stdout)
  return { stdout, emitted, identityRows, printedNamed: printed ? Number(printed[1]) : null }
}

console.log('=== criteria 2 and 3: the importer')

// A real allowlisted address with an account, for case B's email match.
const [acct] = await sql(`
  select lower(p.email) as email from public.profiles p
  join public.member_allowlist m on lower(m.email) = lower(p.email)
  order by p.created_at limit 1`)
if (!acct) {
  console.error('REFUSED: no allowlisted account exists, so case B has nothing to match on.')
  process.exit(2)
}
const matchAddr = acct.email

// ------------------------------------------------------------------ case A
const caseA = generate('caseA')
{
  const stats = csvNameStats(caseA, matchAddr)
  checkThat(2, 'case A has no Email Address column, as the real round-1 export does not',
    stats.hasEmailColumn === false)
  checkThat(2, 'case A carries a known mix: named, blank and whitespace-only',
    stats.named === stats.total - 2, `${stats.named} named of ${stats.total}`)
  const run = runImporter(caseA, 'caseA')
  checkThat(2, 'case A: identity rows EQUAL the CSV\'s non-blank names, counted from the CSV',
    run.identityRows === stats.named, `${run.identityRows} emitted vs ${stats.named} in the CSV`)
  checkThat(2, 'case A: the printed count agrees with the CSV',
    run.printedNamed === stats.named, `printed ${run.printedNamed}`)
}

// ------------------------------------------------------------------ case B
// A MIX, deliberately: one real allowlisted address plus three that match
// nothing. With every named row matching on email the expected identity count
// is zero, which cannot tell D3's third rule apart from an insert that never
// fires. The mix makes the subtraction meaningful, so the answer has to land
// strictly between the two trivial ones.
const caseB = generate('caseB', ['--with-email', '--emails',
  [matchAddr, 'site08-nobody-a@example.org', 'site08-nobody-b@example.org',
   'site08-nobody-c@example.org'].join(',')])
{
  const stats = csvNameStats(caseB, matchAddr)
  checkThat(2, 'case B has an Email Address column', stats.hasEmailColumn === true)
  checkThat(2, 'case B has at least one named row on a real allowlisted account',
    stats.namedAndMatched > 0, `${stats.namedAndMatched} matchable`)
  checkThat(2, 'case B has named rows on BOTH sides of the email match',
    stats.namedAndMatched > 0 && stats.namedAndMatched < stats.named,
    `${stats.namedAndMatched} matched of ${stats.named} named`)
  const run = runImporter(caseB, 'caseB')
  const expected = stats.named - stats.namedAndMatched
  // D3's third rule, tested rather than stated: a row that matched on email is
  // already attached, so the identity row would be evidence for a decision
  // nobody needs to make.
  checkThat(2, 'case B: the expected count is strictly between the trivial answers',
    expected > 0 && expected < stats.named,
    `${expected}, which is neither 0 nor all ${stats.named}`)
  checkThat(2, 'case B: identity rows are non-blank names MINUS email-matched rows',
    run.identityRows === expected,
    `${run.identityRows} emitted vs ${stats.named} named − ${stats.namedAndMatched} matched = ${expected}`)
  checkThat(2, 'case B: the count line still reports every non-blank name',
    run.printedNamed === stats.named, `printed ${run.printedNamed}`)
}

// ------------------------------------------------------- criterion 3
{
  const zero = generate('zero', ['--blank-names', '8', '--whitespace-names', '0'])
  const stats = csvNameStats(zero, matchAddr)
  checkThat(3, 'the zero-population export really carries no name',
    stats.named === 0, `${stats.named} named of ${stats.total}`)
  // The mode is named per rubric row 10. The default mode IS the dry run: the
  // importer has no --dry-run flag, which the review found the spec and a code
  // comment both claiming. It writes nothing and says so.
  const stdout = execFileSync('python3', [IMPORTER, '--round', 'w1', '--csv', zero,
    '--operator', 'site08-import-tests'], { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  checkThat(3, 'the count line prints on a ZERO population rather than not printing',
    /^names\s+0 of 8/m.test(stdout), (stdout.match(/^names.*/m) ?? ['(absent)'])[0].trim())
  checkThat(3, 'and the run is the one that writes nothing, and says so',
    /DRY RUN\. Nothing was written\./.test(stdout))
}

// -------------------------------------------------------------- the mutation
// D9 allocates criterion 2 one mutation: delete the identity insert from
// build_sql(). It is a mutation of the SYSTEM, watched going red in BOTH cases,
// and the restore is asserted.
{
  const backup = path.join(WORK, 'importer.bak')
  copyFileSync(IMPORTER, backup)
  try {
    const src = readFileSync(IMPORTER, 'utf8')
    const mutated = src.replace('        if typed and not r.get("profile_id"):', '        if False:')
    if (mutated === src) {
      checkThat(2, 'MUTATION applied to the identity insert', false, 'the anchor line was not found')
    } else {
      writeFileSync(IMPORTER, mutated)
      const a = runImporter(caseA, 'mutA')
      const b = runImporter(caseB, 'mutB')
      const statsA = csvNameStats(caseA, matchAddr)
      checkThat(2, 'MUTATION case A: the emitted identity rows disagree with the CSV count',
        a.identityRows === 0 && statsA.named > 0,
        `${a.identityRows} emitted against ${statsA.named} named — the assertion goes red`)
      checkThat(2, 'MUTATION case B: the same, so neither case can pass on its own',
        b.identityRows === 0)
      checkThat(2, 'MUTATION the count line still prints, so the disagreement is visible',
        a.printedNamed === statsA.named, `printed ${a.printedNamed}`)
    }
  } finally {
    copyFileSync(backup, IMPORTER)
  }
  const restored = runImporter(caseA, 'restoreA')
  const statsA = csvNameStats(caseA, matchAddr)
  checkThat(2, 'RESTORED the identity rows match the CSV again',
    restored.identityRows === statsA.named, `${restored.identityRows} of ${statsA.named}`)
  // Compared against the PRE-MUTATION bytes, not against HEAD. The first
  // version diffed against HEAD, which fails on any legitimate uncommitted
  // edit to the importer and so tests the working tree's cleanliness rather
  // than whether this lane undid its own mutation. Those are different
  // questions, and only the second one is this lane's business.
  checkThat(2, 'RESTORED the importer is byte-identical to its pre-mutation state',
    readFileSync(IMPORTER, 'utf8') === readFileSync(backup, 'utf8'),
    'the mutation left no residue')
}

// The assertion count is itself an assertion, per D9 and per the review's B1.
const EXPECTED_ASSERTIONS = 18
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length} assertion(s): ${results.length - failed.length} pass, ${failed.length} fail`)
if (results.length !== EXPECTED_ASSERTIONS) {
  console.error(`REFUSED: ${results.length} assertion(s), expected exactly ${EXPECTED_ASSERTIONS}.`)
  process.exit(1)
}
if (failed.length) process.exit(1)
