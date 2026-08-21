/**
 * Enrol an OBT-CDT portal administrator in TOTP, and prove the session reaches
 * `aal2`. Spec CDT-00 D6.
 *
 * Why this exists as a script rather than a thing done once by hand: a password
 * sign-in returns `aal1` even when a verified factor exists. `aal2` is reached
 * only by going through mfa.challenge() and mfa.verify(), which mint a new
 * session. So "sign in twice and check" is not a procedure that can work, and
 * the migration that requires aal2 cannot be applied until somebody has actually
 * produced such a session. This is how.
 *
 * It is also the only enrolment path until CDT-05 builds a UI, so a second
 * administrator needs this run for them.
 *
 * Prerequisites, in order:
 *   1. TOTP (app authenticator) enrolment is ENABLED in the project's Auth
 *      settings. Without it enroll() fails and the message does not say why.
 *   2. The account already exists and is on member_allowlist.
 *
 * Usage:
 *   export VITE_SUPABASE_URL=https://<ref>.supabase.co
 *   export VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
 *   node scripts/mfa-enrol.mjs --email someone@example.org
 *
 *   node scripts/mfa-enrol.mjs --email someone@example.org --status
 *      # list existing factors and the current session's aal, enrol nothing
 *
 * The password and the TOTP code are read from the terminal and never taken as
 * arguments, so neither lands in shell history.
 */

import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { createClient } from '@supabase/supabase-js'

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}
const statusOnly = process.argv.includes('--status')

const URL_ = process.env.VITE_SUPABASE_URL
const KEY =
  process.env.VITE_SUPABASE_PUBLISHABLE_KEY || process.env.VITE_SUPABASE_ANON_KEY
const email = arg('email', null)

if (!URL_ || !KEY) {
  console.error('Set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY first.')
  console.error('They are the same two values the deploy uses; see docs/PORTAL.md step 6.')
  process.exit(2)
}
if (!email) {
  console.error('Pass --email <address>.')
  process.exit(2)
}

const rl = createInterface({ input: stdin, output: stdout })

/** Read a secret without echoing it. */
async function secret(prompt) {
  stdout.write(prompt)
  const wasRaw = stdin.isRaw
  if (stdin.isTTY) stdin.setRawMode(true)
  let value = ''
  await new Promise((resolve) => {
    const onData = (buf) => {
      const s = buf.toString('utf8')
      for (const ch of s) {
        if (ch === '\r' || ch === '\n') {
          stdin.off('data', onData)
          stdout.write('\n')
          resolve()
          return
        }
        if (ch === '\u0003') {
          // Ctrl-C. Raw mode swallows the usual signal, so handle it here or the
          // prompt cannot be escaped.
          if (stdin.isTTY) stdin.setRawMode(false)
          stdout.write('\n')
          process.exit(130)
        }
        if (ch === '\u007f' || ch === '\b') {
          value = value.slice(0, -1)
        } else {
          value += ch
        }
      }
    }
    stdin.on('data', onData)
  })
  if (stdin.isTTY) stdin.setRawMode(Boolean(wasRaw))
  return value
}

const decodeAal = (accessToken) => {
  try {
    const [, payload] = accessToken.split('.')
    const json = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    return { aal: json.aal, amr: json.amr, exp: json.exp, sub: json.sub }
  } catch {
    return { aal: '(undecodable)' }
  }
}

const supabase = createClient(URL_, KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
})

console.log(`project: ${URL_}`)
console.log(`account: ${email}\n`)

const password = await secret('password: ')
const { data: signIn, error: signInErr } = await supabase.auth.signInWithPassword({
  email,
  password,
})
if (signInErr) {
  console.error(`sign-in failed: ${signInErr.message}`)
  process.exit(1)
}

const afterPassword = decodeAal(signIn.session.access_token)
console.log(`\nafter password sign-in: aal=${afterPassword.aal} amr=${JSON.stringify(afterPassword.amr)}`)
console.log('  This is why the spec\'s original "sign in twice" step could not work:')
console.log('  a password sign-in is aal1 even once a verified factor exists.')

const { data: factors, error: factorsErr } = await supabase.auth.mfa.listFactors()
if (factorsErr) {
  console.error(`could not list factors: ${factorsErr.message}`)
  process.exit(1)
}
const totp = factors.totp || []
console.log(`\nexisting TOTP factors: ${totp.length}`)
for (const f of totp) console.log(`  ${f.id}  ${f.friendly_name || '(unnamed)'}  ${f.status}`)

if (statusOnly) {
  await rl.close()
  process.exit(0)
}

let factorId = totp.find((f) => f.status === 'verified')?.id

if (!factorId) {
  console.log('\nenrolling a new TOTP factor…')
  const { data: enrolled, error: enrolErr } = await supabase.auth.mfa.enroll({
    factorType: 'totp',
    friendlyName: `obt-cdt-admin-${Date.now()}`,
  })
  if (enrolErr) {
    console.error(`enrol failed: ${enrolErr.message}`)
    console.error('If this says the factor type is disabled, enable TOTP (app')
    console.error('authenticator) in the project Auth settings first. That setting is')
    console.error('a prerequisite and its absence is not obvious from the error.')
    process.exit(1)
  }
  factorId = enrolled.id
  console.log('\nScan this with an authenticator app, or type the secret in manually.')
  console.log(`  secret: ${enrolled.totp.secret}`)
  console.log(`  uri:    ${enrolled.totp.uri}`)
  console.log('\nThe secret is shown once. Store it in a password manager, not in this repo.')

  const code = await rl.question('\nsix-digit code from the app: ')
  const { error: verifyErr } = await supabase.auth.mfa.challengeAndVerify({
    factorId,
    code: code.trim(),
  })
  if (verifyErr) {
    console.error(`verify failed: ${verifyErr.message}`)
    console.error('The factor stays unverified. Re-run to try again.')
    process.exit(1)
  }
  console.log('factor verified.')
} else {
  console.log(`\nusing the existing verified factor ${factorId}`)
  const code = await rl.question('six-digit code from the app: ')
  const { error: verifyErr } = await supabase.auth.mfa.challengeAndVerify({
    factorId,
    code: code.trim(),
  })
  if (verifyErr) {
    console.error(`verify failed: ${verifyErr.message}`)
    process.exit(1)
  }
}

const { data: session } = await supabase.auth.getSession()
const after = decodeAal(session.session.access_token)
console.log(`\nafter MFA verify: aal=${after.aal} amr=${JSON.stringify(after.amr)}`)

if (after.aal !== 'aal2') {
  console.error('\nFAILED: the session is not aal2. Do NOT apply 20260821120000_admin_mfa.sql;')
  console.error('its safety gate should refuse anyway, but the enrolment is what is wrong.')
  await rl.close()
  process.exit(1)
}

console.log('\nPASSED: this session is aal2.')
console.log('Paste the two aal lines above into docs/SECURITY.md, then apply')
console.log('supabase/migrations/20260821120000_admin_mfa.sql (see its header for order).')
console.log('\nA fresh password sign-in will be aal1 again. That is expected: the app')
console.log('has to challenge the factor each session, and CDT-05 owns the UI for it.')

await rl.close()
