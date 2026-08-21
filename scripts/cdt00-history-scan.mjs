/**
 * Spec CDT-00 D9 and criterion 10: scan the FULL history of this public repo for
 * secrets and for participant data.
 *
 * Two rules this script is built around.
 *
 * A finding is a ROTATION, never a deletion. This repo is public, so its history
 * is already cloned, forked and mirrored by anyone who wanted it. Rewriting
 * history removes the evidence and not the exposure, and it breaks every clone.
 * So the output is a list of things to rotate, and the script never offers to
 * rewrite anything.
 *
 * Addresses are compared by HASH, not by grep. You cannot grep a history for the
 * hash of a value, so the direction is reversed: pull every address-shaped token
 * out of history, hash those, and compare against a hashed roster. The roster
 * never enters this repo and is never passed as an argument in the clear.
 *
 * Usage:
 *   node scripts/cdt00-history-scan.mjs
 *   node scripts/cdt00-history-scan.mjs --roster /path/outside/repo/roster.txt
 *   node scripts/cdt00-history-scan.mjs --self-test
 *
 * --self-test proves the scanner works, using a synthetic address on a LOCAL-ONLY
 * branch that is never pushed and is deleted afterwards. It has to be local-only
 * for D9's own reason: a pushed-then-deleted branch stays retrievable by SHA.
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}
const selfTest = process.argv.includes('--self-test')
const rosterPath = arg('roster', null)

const git = (...args) =>
  execFileSync('git', args, { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 })

const sha = (s) => createHash('sha256').update(s.trim().toLowerCase()).digest('hex')

// Secret shapes. Each one is a thing that, if found, has to be rotated.
const SECRET_PATTERNS = [
  { name: 'Supabase secret key', re: /\bsb_secret_[A-Za-z0-9_-]{8,}/g },
  { name: 'Supabase publishable key', re: /\bsb_publishable_[A-Za-z0-9_-]{8,}/g },
  // A bare mention of the words is not a leak: docs/PORTAL.md says the
  // service-role key must never appear here, and src/lib/backend/config.ts names
  // the env vars it reads. So the pattern requires a value that looks like a
  // key, not the identifier on its own. Bare mentions are counted separately as
  // MENTIONS and never trigger a rotation.
  {
    name: 'service_role key value',
    re: /service_role["'\s:=]+[A-Za-z0-9._-]{24,}/g,
  },
  // A JWT: three base64url segments. The legacy anon/service keys are JWTs.
  { name: 'JWT', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  // Requires a literal value. `SUPABASE_URL = import.meta.env.VITE_...` is
  // source code reading a variable, not a secret in the history.
  {
    name: 'SUPABASE_ env assignment with a literal value',
    re: /\bSUPABASE_[A-Z_]*\s*=\s*['"]?(?!import\.|process\.|\$|<)[A-Za-z0-9._-]{16,}/g,
  },
  { name: 'Postgres connection string', re: /postgres(?:ql)?:\/\/[^\s"'<>]{12,}/g },
  { name: 'Brevo / SMTP key', re: /\bxsmtpsib-[A-Za-z0-9]{16,}/g },
  { name: 'Anthropic key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}/g },
  { name: 'private key block', re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
]

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g

// Words that indicate the surrounding text is documentation ABOUT secrets rather
// than a secret. Reported as mentions so the scan is auditable, never as a
// rotation.
const MENTION_PATTERNS = [
  { name: 'service_role mentioned in prose or code', re: /\bservice_role\b/g },
  { name: 'SUPABASE_ variable name', re: /\bVITE_SUPABASE_[A-Z_]+/g },
]

// Addresses that are not participant data. Kept narrow and explained, because a
// generous allowlist here is how a real address gets waved through.
const NOT_PARTICIPANT = [
  /@example\.(com|org|net)$/i,
  /@(localhost|test|invalid)$/i,
  /^(noreply|no-reply|support|info|hello)@/i,
  // npm / package metadata authors, and the site's own contact addresses which
  // are published on the site on purpose.
  /@sil\.org$/i,
]

function historyBlobs() {
  // Every blob ever committed, including on branches and dangling objects that
  // are still reachable. `--all` covers refs; unreachable objects are out of
  // scope because a fresh clone cannot fetch them.
  const out = git('rev-list', '--objects', '--all')
  const blobs = []
  for (const line of out.split('\n')) {
    const [oid, ...rest] = line.split(' ')
    if (!oid) continue
    blobs.push({ oid, path: rest.join(' ') })
  }
  return blobs
}

function blobTypesAndSizes(oids) {
  const input = oids.join('\n') + '\n'
  const out = execFileSync('git', ['cat-file', '--batch-check'], {
    input,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  })
  const info = new Map()
  for (const line of out.split('\n')) {
    const [oid, type, size] = line.split(' ')
    if (oid && type) info.set(oid, { type, size: Number(size) })
  }
  return info
}

const BINARY = /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|otf|eot|pdf|zip|gz|mp4|mp3|docx?|xlsx?)$/i

async function scan() {
  const commits = git('rev-list', '--all', '--count').trim()
  const blobs = historyBlobs().filter((b) => b.path && !BINARY.test(b.path))
  const info = blobTypesAndSizes([...new Set(blobs.map((b) => b.oid))])
  const textBlobs = blobs.filter(
    (b) => info.get(b.oid)?.type === 'blob' && info.get(b.oid).size < 4 * 1024 * 1024,
  )

  console.log(`history: ${commits} commits, ${textBlobs.length} text blob versions to read`)

  const secretHits = []
  const mentions = []
  const addresses = new Map() // address -> Set(path)
  const seen = new Set()

  for (const b of textBlobs) {
    if (seen.has(b.oid)) continue
    seen.add(b.oid)
    let text
    try {
      text = git('cat-file', 'blob', b.oid)
    } catch {
      continue
    }
    for (const { name, re } of SECRET_PATTERNS) {
      for (const m of text.matchAll(re)) {
        secretHits.push({ kind: name, path: b.path, oid: b.oid, sample: m[0].slice(0, 24) })
      }
    }
    for (const { name, re } of MENTION_PATTERNS) {
      for (const m of text.matchAll(re)) {
        mentions.push({ kind: name, path: b.path, sample: m[0].slice(0, 40) })
      }
    }
    for (const m of text.matchAll(EMAIL_RE)) {
      const addr = m[0].toLowerCase()
      if (NOT_PARTICIPANT.some((re) => re.test(addr))) continue
      if (!addresses.has(addr)) addresses.set(addr, new Set())
      addresses.get(addr).add(b.path)
    }
  }

  return { commits, blobCount: seen.size, secretHits, mentions, addresses }
}

const mask = (addr) => {
  const [local, domain] = addr.split('@')
  return `${local.slice(0, 2)}${'*'.repeat(Math.max(1, local.length - 2))}@${domain}`
}

// --- self test ---------------------------------------------------------------
if (selfTest) {
  // The canary is planted in a THROWAWAY GIT WORKTREE, not in the working tree.
  // An earlier version stashed the working tree and switched branches, which is
  // an unacceptable thing for a verification script to do to a session that has
  // uncommitted work in flight. A worktree shares the object store, so a commit
  // made there is visible to `rev-list --all` from anywhere in the repo, which is
  // all the scan needs.
  const branch = 'cdt00-canary-local-only'
  const canary = 'canary.participant.9f31@example-canary-domain.test'
  const secret = 'sb_secret_CANARYCANARY123456'
  const wt = path.join(tmpdir(), `cdt00-canary-${process.pid}`)
  console.log('self-test: planting a synthetic canary on a LOCAL-ONLY branch')
  console.log(`  worktree ${wt}`)
  console.log(`  branch   ${branch}, never pushed, deleted at the end`)

  let planted = false
  try {
    git('worktree', 'add', '--detach', wt, 'HEAD')
    await writeFile(
      path.join(wt, 'CDT00-CANARY.txt'),
      `synthetic canary, spec CDT-00 D9\n${canary}\n${secret}\n`,
    )
    execFileSync('git', ['checkout', '-b', branch], { cwd: wt, encoding: 'utf8' })
    execFileSync('git', ['add', 'CDT00-CANARY.txt'], { cwd: wt, encoding: 'utf8' })
    execFileSync(
      'git',
      ['-c', 'user.name=cdt00', '-c', 'user.email=cdt00@local', 'commit', '-m', 'canary (local only)'],
      { cwd: wt, encoding: 'utf8' },
    )
    planted = true

    const r = await scan()
    const foundAddr = [...r.addresses.keys()].includes(canary)
    const foundSecret = r.secretHits.some((h) => h.sample.includes('sb_secret_CANARY'))
    console.log(`  canary address found in history: ${foundAddr ? 'YES' : 'NO'}`)
    console.log(`  canary secret found in history:  ${foundSecret ? 'YES' : 'NO'}`)
    const ok = foundAddr && foundSecret
    console.log(
      ok
        ? '  self-test PASSED: the scanner detects both shapes anywhere in history'
        : '  self-test FAILED: the scanner would have missed a real finding',
    )
    process.exitCode = ok ? 0 : 1
  } finally {
    try {
      git('worktree', 'remove', '--force', wt)
    } catch {}
    if (planted) {
      try {
        git('branch', '-D', branch)
      } catch {}
    }
    const still = git('branch', '--list', branch).trim()
    const unpushed = git('log', '--oneline', 'origin/main..HEAD').trim()
    console.log(`  cleanup: branch ${branch} ${still ? 'STILL PRESENT — remove it' : 'deleted'}`)
    console.log(`  cleanup: nothing was pushed. Unpushed commits on HEAD: ${unpushed || 'none'}`)
    const canaryLeft = git('rev-list', '--all', '--objects')
      .split('\n')
      .filter((l) => l.includes('CDT00-CANARY'))
    console.log(`  cleanup: canary blobs still reachable: ${canaryLeft.length}`)
  }
} else {
  const isPrivate = JSON.parse(
    execFileSync('gh', ['repo', 'view', '--json', 'isPrivate'], { encoding: 'utf8' }),
  ).isPrivate
  console.log(`repo visibility: ${isPrivate ? 'PRIVATE' : 'PUBLIC'}`)
  if (!isPrivate) {
    console.log('  Public, so treat every finding as already disclosed. Rotate, do not delete.')
  }

  const { commits, blobCount, secretHits, mentions, addresses } = await scan()

  console.log(`\nSECRET SHAPES (${secretHits.length} hit(s))`)
  if (!secretHits.length) console.log('  none')
  const byKind = new Map()
  for (const h of secretHits) {
    if (!byKind.has(h.kind)) byKind.set(h.kind, [])
    byKind.get(h.kind).push(h)
  }
  for (const [kind, hits] of byKind) {
    console.log(`  ${kind}: ${hits.length}`)
    for (const h of hits.slice(0, 6)) console.log(`      ${h.path}  ${h.sample}…`)
    if (hits.length > 6) console.log(`      … and ${hits.length - 6} more`)
  }

  const mentionKinds = new Map()
  for (const m of mentions) mentionKinds.set(m.kind, (mentionKinds.get(m.kind) || 0) + 1)
  console.log(`\nMENTIONS, not secrets (${mentions.length} total, no rotation)`)
  if (!mentions.length) console.log('  none')
  for (const [kind, n] of mentionKinds) console.log(`  ${kind}: ${n}`)

  console.log(`\nADDRESS-SHAPED TOKENS (${addresses.size} distinct, local parts masked)`)
  if (!addresses.size) console.log('  none outside the excluded set')
  for (const [addr, paths] of [...addresses].sort()) {
    console.log(`  ${mask(addr)}   in ${[...paths].slice(0, 3).join(', ')}`)
  }

  if (rosterPath) {
    const roster = (await readFile(rosterPath, 'utf8'))
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.includes('@'))
    const rosterHashes = new Set(roster.map(sha))
    const matches = [...addresses.keys()].filter((a) => rosterHashes.has(sha(a)))
    console.log(`\nROSTER COMPARISON (${roster.length} roster entries, compared by sha256)`)
    console.log(
      matches.length
        ? `  ${matches.length} participant address(es) present in history: ${matches.map(mask).join(', ')}`
        : '  no roster address appears anywhere in this history',
    )
    if (matches.length) process.exitCode = 1
  } else {
    console.log('\nROSTER COMPARISON  skipped: no --roster given.')
    console.log('  Export the sign-up workbook OUTSIDE this repo and pass its path to')
    console.log('  compare by hash. The addresses above are what a comparison would')
    console.log('  be run against.')
  }

  console.log(`\nscanned ${blobCount} unique blobs across ${commits} commits`)
  if (secretHits.length) {
    console.error('ACTION: rotate every key above. Do not rewrite history.')
    process.exitCode = 1
  }
}
