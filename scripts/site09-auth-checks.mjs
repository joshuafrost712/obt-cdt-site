/**
 * SITE-09 contract c3: every password field refuses what the project would refuse.
 *
 *   node scripts/site09-auth-checks.mjs --assert
 *
 * ## What this asserts, and why it reads the floor live
 *
 * The browser cannot read `password_min_length`; it lives in the project's auth
 * config behind the management API. So `src/lib/backend/passwordPolicy.ts` is
 * necessarily a COPY of a live value, and a copy can drift. This lane is the
 * guard: it reads the live floor through the management API and asserts that
 * every password input in the built bundle carries exactly that number.
 *
 * Program finding 65 is what it is guarding against. On 2026-09-10 the form
 * carried `minLength={8}` against a live floor of 12, so a nine-character
 * password passed the browser and came back as a raw server error.
 *
 * ## Why the built bundle and not the source
 *
 * Because the source is not what a participant runs. Asserting on `dist/` also
 * catches a build that drops the attribute, which a source grep cannot see.
 *
 * ## Mutation (contract c3)
 *
 * Change `PASSWORD_MIN_LENGTH` to any value other than the live floor, rebuild,
 * and this lane must go red on the "every password input" check.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

const ASSERT = process.argv.includes('--assert')
if (!ASSERT) {
  console.error('usage: node scripts/site09-auth-checks.mjs --assert')
  process.exit(2)
}

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

// ------------------------------------------------------------- credentials
// Same shape as cdt06-fixtures.mjs: the secrets file is outside the repo and is
// never printed. Only the project ref and the access token are needed here; no
// service-role key is used, because this lane reads config and never writes.
function creds() {
  const file = path.join(homedir(), '.claude/secrets/obt-cdt-supabase.env')
  if (!existsSync(file)) {
    console.error(`missing ${file}`)
    process.exit(2)
  }
  const out = execFileSync('/bin/zsh', [
    '-c',
    `set -a; . ${JSON.stringify(file)}; set +a; ` +
      'printf "%s\\n%s" "$OBT_CDT_SUPABASE_PROJECT_REF" "$OBT_CDT_SUPABASE_ACCESS_TOKEN"',
  ])
    .toString()
    .split('\n')
    .map((s) => s.trim())
  const [ref, token] = out
  if (!ref || !token) {
    console.error(`empty OBT_CDT_SUPABASE_PROJECT_REF or _ACCESS_TOKEN in ${file}`)
    process.exit(2)
  }
  return { ref, token }
}

const { ref, token } = creds()

const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/config/auth`, {
  headers: { Authorization: `Bearer ${token}` },
})
if (!res.ok) {
  console.error(`auth config read failed: ${res.status}`)
  process.exit(2)
}
const cfg = await res.json()
const liveFloor = cfg.password_min_length
console.log(`live password_min_length = ${liveFloor}`)

// ------------------------------------------------- the constant matches live
const policySrc = readFileSync('src/lib/backend/passwordPolicy.ts', 'utf8')
const declared = Number(/PASSWORD_MIN_LENGTH\s*=\s*(\d+)/.exec(policySrc)?.[1])
ok(
  'the exported constant equals the live project floor',
  declared === liveFloor,
  `constant=${declared} live=${liveFloor}`,
)

// ------------------------------------------- every built input carries it
// The portal chunk is whichever built chunk holds the sign-in card. Discovered
// rather than named, so a chunk rename does not silently pass this lane.
const assets = readdirSync('dist/assets').filter((f) => f.endsWith('.js'))
const withInputs = assets.filter((f) =>
  readFileSync(path.join('dist/assets', f), 'utf8').includes('portal-recovery-password'),
)
ok('exactly one built chunk carries the recovery form', withInputs.length === 1, `found=${withInputs.length}`)

const chunk = withInputs[0]
const built = chunk ? readFileSync(path.join('dist/assets', chunk), 'utf8') : ''

// Every minLength in the portal chunk must be the live floor. A per-input
// literal is exactly what contract c3 forbids, so this counts ALL of them
// rather than looking for the three we know about.
const found = [...built.matchAll(/minLength:\s*(\d+)/g)].map((m) => Number(m[1]))
ok('at least three password inputs carry a minLength', found.length >= 3, `found=${found.length} values=${found.join(',')}`)
ok(
  'every password input equals the live floor',
  found.length > 0 && found.every((n) => n === liveFloor),
  `values=${found.join(',')} live=${liveFloor}`,
)
ok('no input carries the old literal 8', !found.includes(8), `values=${found.join(',')}`)

// --------------------------------------------- the recovery flow is wired
ok('the built chunk calls updateUser', /updateUser/.test(built))
ok('the built chunk carries the recovery discriminator', built.includes('recovery-done'))

// ------------------------------------------- c2: one node for both branches
// The off-list refusal and the success branch must resolve to the SAME content
// node, or the form answers "is this address in the cohort?". Asserted on the
// source, because both branches set the same state value and the built chunk
// cannot distinguish them.
const sharedSrc = readFileSync('src/pages/backend/shared.tsx', 'utf8')
const notOnList = /if \(kind === 'not-on-list'\) \{\s*setStatus\('registered'\)/.test(sharedSrc)
ok("the not-on-list branch resolves to the same state as success", notOnList)

console.log(`\nsite09-auth-checks: pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)
