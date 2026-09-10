#!/usr/bin/env node
/**
 * SITE-08 criterion 18: no participant name, roster string or typed name may
 * reach a changed file in this public repository.
 *
 *     node scripts/site08-name-scan.mjs            # scan staged + unstaged work
 *     node scripts/site08-name-scan.mjs --since 52a67d8
 *
 * ## Why this is a script and not a grep in a build record
 *
 * It was written after the defect it catches. During SITE-08's own build a
 * real participant's name went into a code comment in this repository, and the
 * hand-typed grep that should have caught it ran AFTER the commit rather than
 * before it, against a list of names somebody typed from memory rather than
 * against the roster. The commit was still local so nothing leaked, and the
 * name was amended out of history rather than removed in a later commit.
 *
 * Two rules follow, and this file is both of them.
 *
 * The population is DISCOVERED, never listed. It reads the roster mapping and
 * derives every full name, every surname-length name part and every address
 * from it, so a name nobody thought to type is still covered. Program finding
 * 48's rule about discovering a population rather than carrying it.
 *
 * And it runs BEFORE the commit. A scan that runs after one is a report, not a
 * gate.
 *
 * ## What it deliberately allows
 *
 * Joshua's own name. He owns the repository, he is named in its commit
 * trailers already, and D2's normalisation examples are written with it in the
 * spec itself. Allowing it by name is honest; the alternative is a scan
 * everybody learns to ignore.
 *
 * ## The roster file is not in this repo and must never be
 *
 * It lives at ~/Documents/obt-cdt-allowlist-names-2026-09-10.csv, mode 600,
 * outside every repository. If it is absent this script REFUSES rather than
 * passing, because a scan with no population to check is not a green scan.
 * That is program finding 47 and SITE-04's finding 22 in one line: an
 * undecided row must be as fatal as a wrong one.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

const ROSTER = path.join(homedir(), 'Documents/obt-cdt-allowlist-names-2026-09-10.csv')

// Allowed because he owns the repo and the spec's own examples use it.
const ALLOWED = new Set(['joshua', 'frost', 'joshua frost', 'josh frost', 'josh_frost@sil.org'])

if (!existsSync(ROSTER)) {
  console.error(`REFUSED: no roster at ${ROSTER}`)
  console.error('  A scan with no population to check is not a green scan. If the roster')
  console.error('  has moved, point this script at it; do not skip the check.')
  process.exit(2)
}

// Parse the CSV without a dependency. Fields here never contain commas or
// quotes; if that ever changes this refuses rather than mis-parsing.
const lines = readFileSync(ROSTER, 'utf8').trim().split('\n')
const header = lines[0].split(',')
const iEmail = header.indexOf('email')
const iName = header.indexOf('full_name')
if (iEmail < 0 || iName < 0) {
  console.error('REFUSED: the roster has no email/full_name header')
  process.exit(2)
}

const terms = new Set()
for (const line of lines.slice(1)) {
  if (!line.trim()) continue
  if ((line.match(/"/g) ?? []).length) {
    console.error(`REFUSED: quoted field in the roster, which this parser cannot read safely:\n  ${line}`)
    process.exit(2)
  }
  const cells = line.split(',')
  const email = (cells[iEmail] ?? '').trim()
  const name = (cells[iName] ?? '').trim()
  if (email) terms.add(email)
  if (name) {
    terms.add(name)
    // Name PARTS too, because a comment saying only a surname is still a name
    // in a public repo. Three characters or fewer are skipped as too generic
    // to distinguish from ordinary prose.
    for (const part of name.split(/\s+/)) if (part.length > 3) terms.add(part)
  }
}

const sinceIdx = process.argv.indexOf('--since')
const range = sinceIdx > -1 ? `${process.argv[sinceIdx + 1]}..HEAD` : null
const diff = range
  ? execFileSync('git', ['diff', range], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  : execFileSync('git', ['diff', 'HEAD'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })

// Added lines only. A line this work REMOVES is not a leak it created.
const added = diff.split('\n').filter((l) => l.startsWith('+')).join('\n')

/**
 * Word boundaries, because a gate that cries wolf gets overridden.
 *
 * The first version matched substrings, so one roster surname fired on an
 * ordinary English word that merely contains it — the name is deliberately not
 * repeated here, because this is a public repository and the gate below would
 * be right to refuse it. A false positive is not harmless either:
 * the next person to see one learns to pass over the refusal, and then the
 * real leak goes through too. So a name matches as a NAME.
 *
 * `\b` is used rather than a whitespace class so a name in quotes, parentheses
 * or a comma list still matches, which is how one would actually appear. For
 * an address the boundary is only leading, since the local part and domain
 * carry their own punctuation.
 */
const hits = []
for (const t of terms) {
  if (ALLOWED.has(t.toLowerCase())) continue
  const esc = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = t.includes('@')
    ? new RegExp(`\\b${esc}`, 'i')
    : new RegExp(`\\b${esc}\\b`, 'i')
  if (re.test(added)) hits.push(t)
}

console.log(`roster terms checked: ${terms.size} (${ALLOWED.size} allowed by name)`)
console.log(`scanned: ${range ?? 'working tree against HEAD'}`)

if (hits.length) {
  console.error(`\nREFUSED: ${hits.length} roster term(s) in added lines:`)
  for (const h of hits.sort()) {
    console.error(`  ${h}`)
    for (const line of added.split('\n')) {
      const hesc = h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const hre = h.includes('@') ? new RegExp(`\\b${hesc}`, 'i') : new RegExp(`\\b${hesc}\\b`, 'i')
      if (hre.test(line)) {
        console.error(`      ${line.slice(0, 120)}`)
      }
    }
  }
  console.error('\nThis is a PUBLIC repository. Remove the name before committing.')
  process.exit(1)
}

console.log('clean: no roster name or address in any added line')
