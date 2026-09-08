#!/usr/bin/env node
/**
 * SITE-07 lane A: the built artifact says the Psalms workshop is finished.
 *
 *   npm run build && node scripts/site07-status.mjs
 *
 * Deliberately over `dist/` and not over `site-content.json`, because the spec's
 * finding 1 is about what is SERVED. A JSON edit that never reaches a rendered
 * page has not fixed anything a visitor can see.
 *
 * Three campaign rules are built in rather than remembered.
 *
 * Every absence check PRINTS ITS POPULATION (program finding 12): a criterion
 * whose population is not printed cannot be told apart from one that had nothing
 * to look at. Every file searched and every match found is named.
 *
 * Every absence check is CASE-INSENSITIVE. The spec's own review found a
 * case-sensitive grep for "Fully booked" that was blind to the lowercase
 * "fully booked" inside the very block being rewritten.
 *
 * And a population of zero is a FAILURE, not a pass. `[].every()` is true, and
 * this campaign has already shipped one gate that iterated an empty set and
 * printed success. Every check here asserts its population is non-empty first.
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const REPO = path.resolve(import.meta.dirname, '..')
const DIST = path.join(REPO, 'dist')

const PSALMS = path.join(DIST, 'workshops/psalms-bali-2026/index.html')
const INDEX = path.join(DIST, 'workshops/index.html')

const OLD_NAME = 'Legal Texts in the Torah'
const NEW_NAME = 'Legal and Cultic Texts in the Torah'

const CONTENT_PATH = path.join(REPO, 'src/content/site-content.json')
const contentText = fs.readFileSync(CONTENT_PATH, 'utf8')
const content = JSON.parse(contentText)

let failures = 0
let checks = 0

function ok(label, detail = '') {
  checks++
  console.log(`   ok   ${label}${detail ? `  ${detail}` : ''}`)
}

function bad(label, detail = '') {
  checks++
  failures++
  console.log(`  FAIL  ${label}${detail ? `  ${detail}` : ''}`)
}

function assertEq(label, actual, expected) {
  if (actual === expected) ok(label, `expected=${expected} actual=${actual}`)
  else bad(label, `expected=${expected} actual=${actual}`)
}

function read(file) {
  if (!fs.existsSync(file)) {
    bad(`${path.relative(REPO, file)} exists`)
    return ''
  }
  return fs.readFileSync(file, 'utf8')
}

/** Case-insensitive count of a literal phrase, whitespace-tolerant. */
function countPhrase(haystack, phrase) {
  const re = new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '[\\s\\u00a0]+'), 'gi')
  return (haystack.match(re) ?? []).length
}

console.log('SITE-07 lane A, over dist/\n')

// --------------------------------------------------------------------------
// criterion 2: neither public page says fully booked, in any case
// --------------------------------------------------------------------------
console.log('criterion 2  no public page says fully booked, in any case')
const pages = [
  ['dist/workshops/psalms-bali-2026/index.html', read(PSALMS), 3, 4],
  ['dist/workshops/index.html', read(INDEX), 3, 3],
]
for (const [label, html, baseSensitive, baseInsensitive] of pages) {
  if (html.length === 0) {
    bad(`${label} has content`)
    continue
  }
  const sensitive = (html.match(/Fully booked/g) ?? []).length
  const insensitive = countPhrase(html, 'fully booked')
  console.log(`        ${label}: ${html.length} bytes searched`)
  console.log(`        live baseline 2026-09-08 was ${baseSensitive} case-sensitive, ${baseInsensitive} case-insensitive`)
  if (insensitive > 0) {
    for (const m of html.matchAll(/.{0,90}fully[\s ]+booked.{0,90}/gi)) {
      console.log(`        match: …${m[0].replace(/\s+/g, ' ')}…`)
    }
  }
  assertEq(`${label} case-sensitive "Fully booked"`, sensitive, 0)
  assertEq(`${label} case-insensitive "fully booked"`, insensitive, 0)
}

// --------------------------------------------------------------------------
// criterion 3: three workshops carry the completed badge
// --------------------------------------------------------------------------
console.log('\ncriterion 3  three completed badges on the index')
const indexHtml = read(INDEX)
const badges = (indexHtml.match(/bg-brand-soft text-brand/g) ?? []).length
const rawCompleted = countPhrase(indexHtml, 'completed')
console.log(`        raw case-insensitive "completed" count, printed and NOT asserted: ${rawCompleted}`)
console.log('        (it moves with prose wording; the badge pill class is the stable discriminator)')
// Three, because three of the five workshops in the series are finished. When a
// fourth finishes this goes red, and the fix is to change the 3 — not to widen
// the check. Recurring class 1: a frozen number is only safe when the file says
// what to do on the day it disagrees.
const COMPLETED_WORKSHOPS = content.workshops.filter(
  (w) => w.facts?.status === 'complete' && w.access !== 'member',
).length
assertEq('completed workshops in the content file', badges, COMPLETED_WORKSHOPS)
assertEq('completed badge pills on dist/workshops/index.html', badges, 3)

// the badge on the Psalms page's own hero
const psalmsHtml = read(PSALMS)
const psalmsBadges = (psalmsHtml.match(/bg-brand-soft text-brand/g) ?? []).length
if (psalmsBadges >= 1) ok('the Psalms hero carries a completed badge', `count=${psalmsBadges}`)
else bad('the Psalms hero carries a completed badge', `count=${psalmsBadges}`)

// --------------------------------------------------------------------------
// criterion 4: the old workshop-4 name is gone, population printed
// --------------------------------------------------------------------------
console.log('\ncriterion 4  the old workshop-4 name is gone from every artifact this spec owns')
const owned = [
  ...walk(DIST).filter((f) => /\.(html|js|css|xml|txt|json)$/.test(f)),
  path.join(REPO, 'src/content/site-content.json'),
  path.join(REPO, 'docs/HANDBOOK.md'),
  path.join(REPO, 'src/pages/HandbookPage.tsx'),
]
const VAULT = process.env.OBT_CDT_VAULT ?? path.join(process.env.HOME, 'Documents/Josh & Katie Vault/Claude Can Access PARA')
const IN_SCOPE_VAULT = [
  'Projects/OBT/OBT Consultant Track/OBT Consultant Track Dashboard.md',
  'Projects/OBT/OBT Consultant Track/OBTCDT - Overview of the Role of Workshops.md',
]
/**
 * The held-back set is DISCOVERED, never listed. D0 baseline 3 required the
 * population "from the grep and not from a hand list", and the first version of
 * this file hard-coded three paths — so it could not have found the SIXTH file
 * the stage-6 review turned up, a funder-facing grant case under
 * `Projects/Claude Access/`, invisible to the shell's `grep` because that is a
 * ugrep function honouring `.gitignore`, which covers that folder. Two greps,
 * two different answers, and the criterion had been written against the smaller.
 *
 * So: /usr/bin/grep, explicitly, and anything it finds that this spec did not
 * edit is reported for triage rather than assumed to be one of the three.
 */
function discoverVaultHits() {
  if (!fs.existsSync(VAULT)) return null
  try {
    const out = execFileSync(
      '/usr/bin/grep',
      ['-rl', '--include=*.md', '--exclude-dir=.claude', OLD_NAME, '.'],
      { cwd: VAULT, encoding: 'utf8', maxBuffer: 8 << 20 },
    )
    return out.split('\n').filter(Boolean).map((s) => s.replace(/^\.\//, ''))
  } catch (e) {
    if (e.status === 1) return [] // grep exits 1 on no match, which is the good case
    throw e
  }
}

let vaultReachable = true
for (const rel of IN_SCOPE_VAULT) {
  const p = path.join(VAULT, rel)
  if (fs.existsSync(p)) owned.push(p)
  else vaultReachable = false
}
if (!vaultReachable) bad('the two in-scope vault files are reachable', `VAULT=${VAULT}`)

if (owned.length === 0) bad('criterion 4 population is non-empty')
else ok('criterion 4 population is non-empty', `${owned.length} file(s)`)

const hits = []
for (const f of owned) {
  const text = fs.readFileSync(f, 'utf8')
  const n = countPhrase(text, OLD_NAME)
  if (n > 0) hits.push([path.relative(REPO, f), n])
}
const vaultSearched = vaultReachable ? IN_SCOPE_VAULT.length : 0
console.log(
  `        searched ${owned.length} file(s): ${walkCount(DIST)} under dist/, 3 in the repo, ` +
    `${vaultSearched} in the vault${vaultReachable ? '' : ' (VAULT UNREACHABLE, so zero)'}`,
)
for (const [rel, n] of hits) console.log(`        HIT  ${rel}  ×${n}`)
assertEq(`files still carrying "${OLD_NAME}"`, hits.length, 0)

// The held-back population, discovered and printed, never assumed.
console.log('\n        the vault files still carrying the old name, DISCOVERED with /usr/bin/grep:')
const discovered = discoverVaultHits()
if (discovered === null) {
  bad('the vault is reachable for the held-back sweep', `VAULT=${VAULT}`)
} else {
  const spec = discovered.filter((f) => f.includes('Site and Feedback Specs'))
  const real = discovered.filter((f) => !f.includes('Site and Feedback Specs'))
  for (const f of real) console.log(`          HELD BACK  ${f}`)
  for (const f of spec) console.log(`          (this spec's own documents, which quote the old name)  ${f}`)
  console.log(
    `        ${real.length} document(s) held back for Joshua's decision, per decision 7 and\n` +
      '        tracker open item 11. Each is circulated or funder-facing; renaming inside one\n' +
      '        is a different act from correcting a live tracker.',
  )
  if (real.length === 0) bad('the held-back population is non-empty', 'nothing to triage means the grep found nothing at all')
  else ok('the held-back population is discovered and non-empty', `${real.length} file(s)`)
}

// --------------------------------------------------------------------------
// criterion 5: the new name appears in exactly the expected population
// --------------------------------------------------------------------------
console.log('\ncriterion 5  the new name appears in exactly the expected population')
const newCount = countPhrase(contentText, NEW_NAME)
// D0 baseline 2, re-measured in session on 2026-09-08. It is a frozen number:
// four site strings named the workshop before this spec, and psalms.cta makes
// five. If a later spec adds a sixth mention this goes red, and the fix is to
// re-measure the baseline and say so in the build record — not to relax the
// assertion to `>=`, which is what would make it stop checking.
const BASELINE = 4
console.log(`        D0 baseline 2 = ${BASELINE}; the +1 is psalms.cta, which D4 requires`)
const psalmsWorkshop = content.workshops.find((w) => w.id === 'psalms-bali-2026')
const ctaBlock = psalmsWorkshop.blocks.find((b) => b.id === 'psalms.cta')
if (ctaBlock && ctaBlock.body.includes(NEW_NAME)) ok('psalms.cta carries the full new name')
else bad('psalms.cta carries the full new name', JSON.stringify(ctaBlock?.body))
assertEq(`"${NEW_NAME}" in site-content.json`, newCount, BASELINE + 1)

// --------------------------------------------------------------------------
// the workshop-4 row is marked next
// --------------------------------------------------------------------------
console.log('\nthe series reads as a series in motion')
const series = content.pages
  .find((p) => p.route === '/workshops')
  .blocks.find((b) => b.id === 'workshops-index.series')
const kickers = series.items.map((i) => [i.id, i.kicker])
for (const [id, k] of kickers) console.log(`        ${id.padEnd(34)} ${k}`)
const legal = kickers.find(([id]) => id === 'workshops-index.series.legal')
if (/next/i.test(legal[1])) ok('workshop 4 is marked next', legal[1])
else bad('workshop 4 is marked next', legal[1])
const psalmsKicker = kickers.find(([id]) => id === 'workshops-index.series.psalms')
if (/completed/i.test(psalmsKicker[1])) ok('workshop 3 is marked completed', psalmsKicker[1])
else bad('workshop 3 is marked completed', psalmsKicker[1])
// and it renders, not just sits in the JSON
if (indexHtml.includes(legal[1])) ok('the workshop-4 kicker is in the built index')
else bad('the workshop-4 kicker is in the built index')

// --------------------------------------------------------------------------
// the enum, and the two vocabularies (D1)
// --------------------------------------------------------------------------
console.log('\nD1  the site enum, which is `complete` and not the database\'s `completed`')
assertEq('workshops[psalms].facts.status', psalmsWorkshop.facts.status, 'complete')
assertEq('workshops[psalms].facts.dateLabel', psalmsWorkshop.facts.dateLabel, 'August to September 2026')

// --------------------------------------------------------------------------
// criterion 7: the content file round-trips
// --------------------------------------------------------------------------
console.log('\ncriterion 7  the content file round-trips at indent=2, ensure_ascii=False')
const roundTrip = JSON.stringify(content, null, 2) + '\n'
if (roundTrip === contentText) ok('site-content.json survives a read/write round trip')
else bad('site-content.json survives a read/write round trip', `${roundTrip.length} vs ${contentText.length} bytes`)

console.log(`\n${checks} check(s), ${failures} failure(s).`)
process.exit(failures === 0 ? 0 : 1)

function walk(dir) {
  const out = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(p))
    else out.push(p)
  }
  return out
}

function walkCount(dir) {
  return walk(dir).filter((f) => /\.(html|js|css|xml|txt|json)$/.test(f)).length
}
