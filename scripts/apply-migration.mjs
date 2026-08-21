/**
 * Apply one migration file to the OBT-CDT portal's Supabase project.
 *
 * Ported from cairn/scripts/apply-migration.mjs (spec CDT-01 D4). `supabase db
 * push` is the normal path and stays the documented one in docs/PORTAL.md. This
 * exists because the CLI is not always linked on this machine while a management
 * API token is available, and because a migration applied here runs as
 * `postgres`, the same footing the CLI uses.
 *
 *   node scripts/apply-migration.mjs supabase/migrations/<file>.sql
 *
 * ## Two traps the port closes, both of them real
 *
 * The original hard-coded `const PROJECT = 'vdbirmjvjzfdgajwgowj'`, which is
 * HONEST EVAL's project. Copying the file and forgetting that line sends an
 * OBT-CDT migration into the evaluation database of a different product. So the
 * ref comes from the environment with **no default**.
 *
 * But "no default" is weaker than it looks, and this is the part worth reading. A
 * shell that has run anything in the cairn repo may already export
 * SUPABASE_PROJECT_REF pointing at Honest Eval, and this script would then do
 * exactly the wrong thing without complaining. This repo has no
 * supabase/config.toml to cross-check against. So the ref is **refused by name**:
 * Honest Eval's project is a hard-coded denylist entry, and that is the one place
 * that string should appear in this repo.
 *
 * It also does NOT record the file in supabase_migrations.schema_migrations, so it
 * prints the `supabase migration repair` line the next `db push` needs. A tool
 * that leaves the migration ledger inconsistent should say so at the moment it
 * does it, rather than leaving a future session to discover a schema that
 * disagrees with the repo.
 *
 * ## Where the token comes from
 *
 * ~/.claude/secrets/obt-cdt-supabase.env, holding OBT_CDT_SUPABASE_ACCESS_TOKEN
 * for the dedicated OBT-CDT Supabase account, which is the account that owns the
 * portal project. It falls back to ~/.claude/secrets/supabase.env only if the
 * OBT-CDT file is absent, and says which one it used, because applying a
 * migration with the wrong account's token fails in a way that reads like a
 * permissions bug.
 */
import { readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import path from 'node:path'

// The one project this script must never touch. Honest Eval is a different
// product with a different database; see the header.
const FORBIDDEN_REFS = {
  vdbirmjvjzfdgajwgowj:
    "Honest Eval (repo `cairn`). A migration from this repo must never reach it: " +
    'it is a different product, and its schema shares names with this one.',
  ckorlrchryswnnrmuctr: 'the Local Genres Research app, a different project again.',
}

const file = process.argv[2]
if (!file) {
  console.error('usage: node scripts/apply-migration.mjs <path to .sql>')
  process.exit(2)
}
if (!existsSync(file)) {
  console.error(`no such file: ${file}`)
  process.exit(2)
}

const ref = (process.env.SUPABASE_PROJECT_REF || '').trim()
if (!ref) {
  console.error(
    'SUPABASE_PROJECT_REF is not set, and this script has no default on purpose.\n' +
      '  The original it was ported from hard-coded Honest Eval\'s project ref, and a\n' +
      '  copied default is how an OBT-CDT migration reaches the wrong database.\n' +
      '  Set it to the portal project in the dedicated OBT-CDT Supabase account.',
  )
  process.exit(2)
}
if (FORBIDDEN_REFS[ref]) {
  console.error(
    `REFUSED: SUPABASE_PROJECT_REF is ${ref}, which is ${FORBIDDEN_REFS[ref]}\n` +
      '  This is a named refusal, not a missing default. A shell that has run\n' +
      '  anything in a sibling repo may still export that variable, and this repo\n' +
      '  has no supabase/config.toml to cross-check against, so the check is here.',
  )
  process.exit(1)
}
if (!/^[a-z]{20}$/.test(ref)) {
  console.error(
    `REFUSED: ${JSON.stringify(ref)} is not the shape of a Supabase project ref, ` +
      'which is 20 lowercase letters.',
  )
  process.exit(1)
}

const SECRET_FILES = [
  path.join(homedir(), '.claude/secrets/obt-cdt-supabase.env'),
  path.join(homedir(), '.claude/secrets/supabase.env'),
]
const secretFile = SECRET_FILES.find((p) => existsSync(p))
if (!secretFile) {
  console.error(
    'no access token file found. Expected one of:\n  ' +
      SECRET_FILES.join('\n  ') +
      '\n  The OBT-CDT portal project belongs to the dedicated OBT-CDT Supabase account,\n' +
      '  so it needs that account\'s own token in the first file.',
  )
  process.exit(2)
}

const accessToken = execFileSync('/bin/zsh', [
  '-c',
  `set -a; . ${JSON.stringify(secretFile)}; set +a; ` +
    'printf %s "${OBT_CDT_SUPABASE_ACCESS_TOKEN:-$SUPABASE_ACCESS_TOKEN}"',
])
  .toString()
  .trim()

if (!accessToken) {
  console.error(
    `${secretFile} holds neither OBT_CDT_SUPABASE_ACCESS_TOKEN nor SUPABASE_ACCESS_TOKEN.`,
  )
  process.exit(2)
}

console.log(`project ${ref}`)
console.log(`token   ${path.basename(secretFile)} (${accessToken.slice(0, 6)}…)`)
console.log(`file    ${file}`)

// Confirm the ref belongs to the account whose token we are holding. Without
// this, a token for one account and a ref for another produces a 404 that reads
// like the project does not exist.
const projects = await fetch('https://api.supabase.com/v1/projects', {
  headers: { Authorization: `Bearer ${accessToken}` },
}).then((r) => (r.ok ? r.json() : null))
if (Array.isArray(projects)) {
  const match = projects.find((p) => p.id === ref)
  if (!match) {
    console.error(
      `REFUSED: this token's account does not own ${ref}.\n  It owns: ` +
        projects.map((p) => `${p.id} (${p.name})`).join(', ') +
        '\n  Applying with the wrong account\'s token returns a 404 that reads like a\n' +
        '  missing project, so the check is here instead.',
    )
    process.exit(1)
  }
  console.log(`name    ${match.name}`)
}

const query = readFileSync(file, 'utf8')
const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query }),
})
const text = await res.text()
if (!res.ok) {
  console.error(`FAILED ${res.status}\n${text}`)
  process.exit(1)
}
console.log(`\napplied ${file}`)
// Full result, not a preview: some of these files end with a report statement,
// and a truncated report is a report you cannot read.
if (text.trim() && text.trim() !== '[]') console.log(text)

const version = path.basename(file).split('_')[0]
console.log(
  `\nThis did NOT record the migration in supabase_migrations.schema_migrations.\n` +
    `Before the next \`db push\` on a machine where the CLI is linked, run:\n\n` +
    `  supabase migration repair --status applied ${version}\n`,
)
