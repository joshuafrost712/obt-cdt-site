/**
 * Spec CDT-00 D2 and D4: write one Content-Security-Policy and one referrer
 * policy into every generated HTML file, and fail the build rather than ship a
 * page the policy would break.
 *
 * Runs last in `npm run build`, after scripts/prerender.mjs, and patches
 * dist/**\/*.html. It is not a hand-typed meta tag in index.html, for three
 * reasons that each cost a build session to rediscover:
 *
 *   1. prerender.mjs writes three classes of HTML and only one derives from
 *      index.html. The retired-route redirect stubs and the /dev/ entry are
 *      complete documents built from template literals, so a policy living in
 *      the template would silently miss them. /dev/ is the door to the review
 *      tools and is the one that matters.
 *   2. The Supabase origin is a build-time value. A policy written against an
 *      unset variable ships `connect-src 'self'`, which blocks the portal
 *      silently on the day someone turns it on.
 *   3. The /dev/ entry interpolates the base path, so its inline script's
 *      SHA-256 differs between a local build (`/`) and CI (`/obt-cdt-site/`).
 *      A hash baked into source would be wrong in exactly one of the two.
 *
 * The build fails when an inline script has no matching hash. That is the point:
 * it is what stops the site white-screening six months from now because someone
 * added a one-line inline script and nobody re-read this file.
 *
 * Usage: node scripts/csp-hashes.mjs [--dist dist] [--print]
 */

import { readFile, writeFile, readdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}

const DIST = path.resolve(arg('dist', 'dist'))
const printOnly = process.argv.includes('--print')

// --- The origins this site is allowed to contact -----------------------------
//
// Every entry is a decision recorded in docs/SECURITY.md, not a convenience.
// Adding one is a decision too: rubric row 1 counts origins, and a new origin
// needs a line saying who learns what about whom.

const supabaseUrl = (process.env.VITE_SUPABASE_URL || '').trim()
const supabaseKey = (
  process.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
  process.env.VITE_SUPABASE_ANON_KEY ||
  ''
).trim()

// Decision 2 (CDT-00): the Apps Script feedback sink keeps its origin, and the
// exposure is written down rather than left implicit. src/devfeedback/send.ts
// POSTs here, and its failure path is a silent fall-through to a file download,
// so a CSP block would read as "offline" rather than as an error.
const FEEDBACK_ORIGINS = ['https://script.google.com', 'https://script.googleusercontent.com']

const connectSrc = ["'self'", ...FEEDBACK_ORIGINS]
let backendState

if (supabaseUrl && supabaseKey) {
  let host
  try {
    host = new URL(supabaseUrl).host
  } catch {
    throw new Error(
      `csp-hashes: VITE_SUPABASE_URL is not a URL: ${JSON.stringify(supabaseUrl)}.\n` +
        'Expected https://<project-ref>.supabase.co (see .env.example).',
    )
  }
  // wss: is listed separately because CSP scheme matching does not let an
  // https: source match a wss: URL. Supabase Realtime is unused today; listing
  // it now costs nothing, and the "new origin needs a decision" rule would not
  // have fired for it, Realtime not being a new origin.
  connectSrc.push(`https://${host}`, `wss://${host}`)
  backendState = `enabled, connect-src carries https://${host} and wss://${host}`
} else if (supabaseUrl || supabaseKey) {
  // Half-configured is the booby trap this script exists to refuse. backendEnabled
  // needs both, so a build with one set produces a static site whose policy looks
  // portal-ready, or a portal whose origin is missing from the policy.
  throw new Error(
    'csp-hashes: the Supabase configuration is half set.\n' +
      `  VITE_SUPABASE_URL           ${supabaseUrl ? 'set' : 'MISSING'}\n` +
      `  VITE_SUPABASE_PUBLISHABLE_KEY ${supabaseKey ? 'set' : 'MISSING'}\n` +
      'Set both or neither. src/lib/backend/config.ts requires both for\n' +
      'backendEnabled, so a half-set pair ships a policy that does not match\n' +
      'the bundle. See spec CDT-00 D0 and docs/PORTAL.md step 6.',
  )
} else {
  backendState = 'not configured, connect-src carries no Supabase origin'
}

// --- The policy --------------------------------------------------------------

function policy(hashes) {
  return [
    "default-src 'self'",
    `script-src 'self' ${hashes.map((h) => `'${h}'`).join(' ')}`.trim(),
    // 'unsafe-inline' is a stated departure, not an oversight. React writes the
    // site's 16 `style={{}}` usages as style attributes, which style-src-attr
    // governs; removing them is a refactor of unrelated components. The cost is
    // recorded in docs/SECURITY.md: an attacker who has already achieved
    // execution can restyle the page, which is defacement and not disclosure.
    "style-src 'self' 'unsafe-inline'",
    // data: is required by the SVG favicon and Vite's inlined assets. blob: is
    // deliberately absent: send.ts's URL.createObjectURL download is not
    // governed by any directive here, so do not add it on a guess.
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src ${connectSrc.join(' ')}`,
    "form-action 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-src 'none'",
    // Ignored in a meta tag; browsers honour frame-ancestors only from a
    // response header, and Pages cannot send one. It stays because it costs
    // nothing and becomes live behind Cloudflare. src/lib/frameBuster.ts is the
    // interim control and docs/SECURITY.md says so plainly.
    "frame-ancestors 'none'",
  ].join('; ')
}

const sha256 = (s) => 'sha256-' + createHash('sha256').update(s, 'utf8').digest('base64')

// --- The allowlist, and why hashing the bytes is not enough ------------------
//
// A first version of this script collected every inline script it found and put
// all of their hashes in the policy. That gate could never fail: adding a new
// inline script simply got it admitted, which is worse than no gate, because the
// build prints a reassuring line either way.
//
// So the real gate is a committed allowlist. An inline script that is not on it
// fails the build, which makes adding one a deliberate edit to a reviewable file
// rather than a side effect.
//
// The allowlist cannot key on the raw sha256, because the /dev/ entry
// interpolates the base path and its bytes therefore differ between a local
// build (`/`) and CI (`/obt-cdt-site/`). A raw hash would be wrong in exactly one
// of the two, and a build that "fails only in CI" gets worked around rather than
// understood. So the allowlist keys on a NORMALIZED hash, with the base path and
// asset digests templated out. The policy still carries the real hash of the real
// bytes, because that is what the browser checks.

const ALLOWLIST_PATH = path.join(process.cwd(), 'scripts', 'csp-allowed-inline.json')
const updateAllowlist = process.argv.includes('--update-allowlist')

const base = process.env.VITE_BASE || '/'

function normalize(body) {
  let s = body

  // Any quoted absolute path made of whole segments becomes __BASE__. This is
  // deliberately derived from the TEXT and not from process.env.VITE_BASE: an
  // env-dependent normalization gives a different key depending on which shell
  // ran the script, which is how the allowlist first disagreed with itself
  // between `npm run build` and a bare `--update-allowlist` run.
  //   '/'               -> '__BASE__'
  //   '/obt-cdt-site/'  -> '__BASE__'
  s = s.replace(/(['"`])\/(?:[A-Za-z0-9._-]+\/)*(['"`])/g, '$1__BASE__$2')

  // Belt and braces for a base that appears unquoted, longest form first so
  // '/obt-cdt-site/' is not reduced to '/' on the way through.
  for (const b of [base, base.replace(/\/$/, '')].sort((a, z) => z.length - a.length)) {
    if (b && b !== '/') s = s.split(b).join('__BASE__')
  }

  // Vite content digests in asset names.
  s = s.replace(/-[A-Za-z0-9_-]{8}\.(js|css)/g, '-__HASH__.$1')
  return s.replace(/\s+/g, ' ').trim()
}

const normHash = (body) =>
  createHash('sha256').update(normalize(body), 'utf8').digest('hex').slice(0, 32)

async function htmlFiles(dir) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await htmlFiles(p)))
    else if (entry.name.endsWith('.html')) out.push(p)
  }
  return out.sort()
}

// Inline scripts only: a <script> with a src attribute is covered by 'self'.
const INLINE_SCRIPT = /<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/gi

const files = await htmlFiles(DIST)
if (files.length === 0) {
  throw new Error(`csp-hashes: no HTML files under ${DIST}. Did the build emit anything?`)
}

// Pass one: collect every inline script in every file, so the single policy
// covers all of them, and check each against the allowlist.
let allowed = {}
try {
  allowed = JSON.parse(await readFile(ALLOWLIST_PATH, 'utf8')).allowed || {}
} catch {
  if (!updateAllowlist) {
    throw new Error(
      `csp-hashes: ${path.relative(process.cwd(), ALLOWLIST_PATH)} is missing or unreadable.\n` +
        'Run `node scripts/csp-hashes.mjs --update-allowlist` after a build and commit the result.',
    )
  }
}

const found = new Map() // sha256 -> {norm, files:[{file, preview}]}
for (const file of files) {
  const html = await readFile(file, 'utf8')
  for (const m of html.matchAll(INLINE_SCRIPT)) {
    const body = m[2]
    if (!body.trim()) continue
    const h = sha256(body)
    if (!found.has(h)) found.set(h, { norm: normHash(body), files: [] })
    found.get(h).files.push({
      file: path.relative(DIST, file),
      preview: body.trim().replace(/\s+/g, ' ').slice(0, 70),
    })
  }
}

const unlisted = [...found].filter(([, v]) => !allowed[v.norm])

if (updateAllowlist) {
  const next = {
    _comment:
      'Inline scripts the CSP admits. Keyed on a normalized hash so the /dev/ ' +
      "entry's base-path interpolation does not change the key between a local " +
      'build and CI. Adding an entry is a deliberate decision: see docs/SECURITY.md. ' +
      'Regenerate with `npm run build` then `node scripts/csp-hashes.mjs --update-allowlist`.',
    allowed: Object.fromEntries(
      [...found].map(([, v]) => [
        v.norm,
        { description: v.files[0].preview, files: v.files.length },
      ]),
    ),
  }
  await writeFile(ALLOWLIST_PATH, JSON.stringify(next, null, 2) + '\n')
  console.log(
    `csp-hashes: wrote ${Object.keys(next.allowed).length} entries to ` +
      path.relative(process.cwd(), ALLOWLIST_PATH),
  )
  console.log('Review the diff before committing it. Each entry is a script the CSP will admit.')
  process.exit(0)
}

if (unlisted.length) {
  console.error(`csp-hashes: ${unlisted.length} inline script(s) NOT on the allowlist\n`)
  for (const [h, v] of unlisted) {
    console.error(`  ${v.files[0].file}`)
    console.error(`    ${v.files[0].preview}`)
    console.error(`    sha256      ${h}`)
    console.error(`    allowlist key ${v.norm}`)
  }
  console.error(
    '\nAn inline script must be on scripts/csp-allowed-inline.json or moved into a\n' +
      'file. This gate is spec CDT-00 D2. It fails the build instead of letting the\n' +
      'page white-screen in production, and it is deliberately not self-updating:\n' +
      'a gate that admits whatever it finds cannot fail.\n' +
      'If the script is legitimate, run:\n' +
      '  node scripts/csp-hashes.mjs --update-allowlist\n' +
      'and commit the change, which puts it in front of a reviewer.',
  )
  process.exit(1)
}

const hashes = [...found.keys()].sort()
const CSP = policy(hashes)

console.log(`csp-hashes: ${files.length} HTML files, ${hashes.length} distinct inline scripts`)
for (const [h, v] of found) {
  console.log(`  ${h}`)
  console.log(`      allowlisted as ${v.norm}`)
  console.log(`      ${v.files.length} file(s), e.g. ${v.files[0].file}: ${v.files[0].preview}`)
}
console.log(`  backend: ${backendState}`)
if (!supabaseUrl && !supabaseKey) {
  console.log(
    '  NOTE  The portal is not configured on this build, so connect-src names no\n' +
      '        Supabase origin. This is correct for a static build and WRONG to\n' +
      '        deploy alongside a live portal. Whoever sets the repo Actions\n' +
      '        variables (docs/PORTAL.md step 6) must redeploy so this policy is\n' +
      '        regenerated. Spec CDT-00 D0.',
  )
}

if (printOnly) {
  console.log('\n' + CSP)
  process.exit(0)
}

// Pass two: write the policy in, then re-verify from what is on disk.
const CSP_TAG = `<meta http-equiv="Content-Security-Policy" content="${CSP}" />`
const REFERRER_TAG = `<meta name="referrer" content="no-referrer" />`

let patched = 0
for (const file of files) {
  let html = await readFile(file, 'utf8')
  html = html.replace(
    /\s*<meta http-equiv="Content-Security-Policy"[^>]*>/gi,
    '',
  )
  html = html.replace(/\s*<meta name="referrer"[^>]*>/gi, '')

  // Immediately after <head> so the policy is in force before any other
  // element in the document can request anything.
  const at = html.search(/<head[^>]*>/i)
  if (at === -1) throw new Error(`csp-hashes: ${file} has no <head>`)
  const insertAt = html.indexOf('>', at) + 1
  html =
    html.slice(0, insertAt) +
    `\n    ${CSP_TAG}\n    ${REFERRER_TAG}` +
    html.slice(insertAt)
  await writeFile(file, html)
  patched++
}

// --- The gate ----------------------------------------------------------------
//
// Re-read from disk. A check that trusts the variable it just wrote proves
// nothing, and criterion 2 asks for a check that cannot pass vacuously.

let failures = 0
for (const file of files) {
  const html = await readFile(file, 'utf8')
  const tags = [...html.matchAll(/<meta http-equiv="Content-Security-Policy" content="([^"]*)"/gi)]
  const rel = path.relative(DIST, file)
  if (tags.length !== 1) {
    console.error(`  FAIL ${rel}: ${tags.length} CSP tags, expected exactly 1`)
    failures++
    continue
  }
  if (tags[0][1] !== CSP) {
    console.error(`  FAIL ${rel}: policy does not match the expected string`)
    failures++
  }
  if (!/<meta name="referrer" content="no-referrer"/i.test(html)) {
    console.error(`  FAIL ${rel}: no referrer policy`)
    failures++
  }
  for (const m of html.matchAll(INLINE_SCRIPT)) {
    const body = m[2]
    if (!body.trim()) continue
    const h = sha256(body)
    if (!hashes.includes(h)) {
      console.error(
        `  FAIL ${rel}: inline script with no hash in the policy.\n` +
          `       ${h}\n` +
          `       ${body.trim().replace(/\s+/g, ' ').slice(0, 100)}\n` +
          '       An inline script must be hashed or moved to a file. This gate\n' +
          '       is from spec CDT-00 D2; it fails the build instead of letting\n' +
          '       the page white-screen in production.',
      )
      failures++
    }
  }
}

console.log(`csp-hashes: patched ${patched} files`)
if (failures) {
  console.error(`csp-hashes: ${failures} failure(s) — build stopped`)
  process.exit(1)
}
console.log('csp-hashes: every generated HTML file carries the same policy')
