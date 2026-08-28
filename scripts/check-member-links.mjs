/**
 * Check every link in the vault's Links-Register against what Drive actually says.
 *
 * Spec SITE-04 D4.
 *
 *   node scripts/check-member-links.mjs                 # check, print, write the report
 *   node scripts/check-member-links.mjs --no-report     # check and print only
 *   node scripts/check-member-links.mjs --row <label>   # one row, for a mutation test
 *
 * ## Why this is a permission check and not a status check
 *
 * Finding 2, re-measured in the build session. Signed out, an OPEN Google Doc
 * returns 200; an owner-only form edit URL also returns 200, after a redirect;
 * an owner-only sheet returns 401. So a status code does not separate a file a
 * participant can open from one that shows them a request-access screen. The
 * body-marker workaround fails the other way: the OPEN document's HTML contains
 * `accounts.google.com`, because every Google page carries sign-in chrome, so a
 * sign-in grep flags the working link and not the broken one.
 *
 * The decidable question is what Drive says, so this reads permissions.
 *
 * ## The transport, and why it is not the MCP connector
 *
 * D0 asked for a transport and named two candidates. The Google Drive MCP
 * connector answers a permissions read correctly and CANNOT BE CALLED FROM A
 * SCRIPT, which makes it a probe rather than a transport. rclone already holds
 * an OAuth token for `gdrive:` with full drive scope, so this refreshes that
 * token and calls Drive API v3 directly. It also returns strictly more than the
 * connector does: `permissionDetails` says whether an `anyone` grant sits on the
 * file or is inherited from its folder, which is how the build learned that the
 * seven Bahasa decks are open by way of an open FOLDER.
 *
 * ## Three ways this could report a wrong answer, and what each one does instead
 *
 * 1. **A 403 from Drive is ambiguous.** Measured in this build: a burst of 38
 *    permission reads returned `403 rateLimitExceeded` on 37 of them. A checker
 *    that reads 403 as "you cannot see this file" would have reported the whole
 *    register closed and been believed. So 403 is classified by its `reason`,
 *    rate limits are retried with backoff, and an unclassifiable 403 is reported
 *    as an ERROR rather than as an access word.
 *
 * 2. **A permissions read by a mere reader is not authoritative.** Drive returns
 *    a TRUNCATED list to a caller who cannot share the file, and a truncated list
 *    has no `anyone` entry whether or not the file has one. That looks exactly
 *    like a closed file. So every row first reads `capabilities.canShare`, and a
 *    file this account cannot share is reported `indeterminate`, never
 *    `named-people`. This is D0's untested case, and it turned out to return a
 *    plausible wrong answer rather than a refusal.
 *
 * 3. **This script cannot repair anything, and must not.** It has no authority
 *    over other people's teaching materials, and a script that could flip a
 *    sharing setting on somebody's deck is a worse object than a locked link. A
 *    mismatch is reported as a message addressed to a person.
 *
 * ## Where the report goes
 *
 * Beside the register IN THE VAULT, never into this repository (finding 5): for
 * an anyone-with-link file the URL is the credential, so a file listing the
 * register's URLs is member content in the strict sense even though it contains
 * no prose. The script refuses a `--report` path inside the repo.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

const REPO = path.resolve(import.meta.dirname, '..')
const VAULT = process.env.OBT_CDT_VAULT
  || path.join(homedir(), 'Documents/Josh & Katie Vault/Claude Can Access PARA')
const HUB = path.join(VAULT, 'Projects/OBT/OBT-CDT Central Hub')
const REGISTER = path.join(HUB, 'Member Pages/Links-Register.md')
const REPORT = path.join(HUB, 'Member Pages/Links-Register-check.md')

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = args.indexOf(name)
  return i === -1 ? fallback : args[i + 1]
}
const registerPath = flag('--register', REGISTER)
const reportPath = flag('--report', REPORT)
const onlyRow = flag('--row', null)
const noReport = args.includes('--no-report')

if (!noReport && path.resolve(reportPath).startsWith(REPO + path.sep)) {
  console.error(
    `REFUSED: --report ${reportPath} is inside the site repository.\n` +
    '  For an anyone-with-link Drive file the URL is the credential, so a report\n' +
    '  listing the register\'s URLs belongs in the private vault (finding 5).'
  )
  process.exit(1)
}

// ----------------------------------------------------------- the access vocabulary
// Kept in step with ACCESS in scripts/build_links_register.py. The badge strings
// live only in the vault register and never here, per criterion 3.
const EXPECTED_DRIVE = {
  'open-link': 'anyone',
  'named-people': 'no-anyone',
  'request-access': 'no-anyone',
  'sil-only': 'domain',
  'app-account': null,
  unchecked: null,
}

// ----------------------------------------------------------- the register
function parseRegister(file) {
  const text = readFileSync(file, 'utf8')
  const end = text.indexOf('\n---\n', 3)
  if (!text.startsWith('---\n') || end === -1) {
    throw new Error(`${file}: no closed front matter`)
  }
  const body = text.slice(end + 5)
  const rows = []
  let header = null
  for (const line of body.split('\n')) {
    const t = line.trim()
    if (!t.startsWith('|')) { header = null; continue }
    const cells = t.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim())
    if (!header) { header = cells.map((c) => c.replace(/`/g, '')); continue }
    if (cells.every((c) => /^[-: ]*$/.test(c))) continue
    if (cells.length !== header.length) continue
    const row = Object.fromEntries(header.map((h, i) => [h, cells[i]]))
    if (!row.label || !('access' in row)) continue
    const active = (row.active || 'auto') === 'auto'
      ? Boolean(row.url || row.ref)
      : ['true', 'yes'].includes((row.active || '').toLowerCase())
    rows.push({ ...row, active })
  }
  return rows
}

// ----------------------------------------------------------- Drive
function driveToken() {
  // A cheap call first, so rclone refreshes an expired token before we read it.
  try { execFileSync('rclone', ['about', 'gdrive:'], { stdio: 'ignore' }) } catch { /* offline is caught below */ }
  const dump = JSON.parse(execFileSync('rclone', ['config', 'dump'], { encoding: 'utf8' }))
  if (!dump.gdrive) throw new Error('rclone has no `gdrive:` remote configured')
  const tok = JSON.parse(dump.gdrive.token).access_token
  if (!tok) throw new Error('rclone\'s gdrive token carries no access_token')
  return tok
}

const FILE_ID = /\/(?:document|spreadsheets|presentation|forms|file)\/d\/([A-Za-z0-9_-]{20,})|\/folders\/([A-Za-z0-9_-]{20,})/

function fileIdOf(url) {
  const m = FILE_ID.exec(url || '')
  return m ? (m[1] || m[2]) : null
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function driveGet(url, tok, tries = 6) {
  let delay = 2500
  for (let attempt = 0; attempt < tries; attempt++) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${tok}` } })
    if (res.ok) return { ok: true, body: await res.json() }
    let reason = ''
    let text = ''
    try {
      text = await res.text()
      reason = JSON.parse(text)?.error?.errors?.[0]?.reason || ''
    } catch { /* keep the raw text */ }
    const transient = [429, 500, 503].includes(res.status)
      || ['rateLimitExceeded', 'userRateLimitExceeded', 'backendError'].includes(reason)
    if (transient && attempt < tries - 1) { await sleep(delay); delay *= 2; continue }
    return { ok: false, status: res.status, reason, text: text.slice(0, 160) }
  }
  return { ok: false, status: 0, reason: 'exhausted retries', text: '' }
}

async function driveAccess(fileId, tok) {
  const meta = await driveGet(
    `https://www.googleapis.com/drive/v3/files/${fileId}`
    + '?supportsAllDrives=true&fields=id,name,ownedByMe,driveId,capabilities(canShare)',
    tok,
  )
  if (!meta.ok) {
    return { word: 'ERROR', detail: `files.get ${meta.status} ${meta.reason || meta.text}` }
  }
  if (meta.body.capabilities?.canShare === false) {
    return {
      word: 'indeterminate',
      name: meta.body.name,
      detail: 'this account cannot share the file, so Drive returns a truncated '
        + 'permission list and an absent `anyone` grant proves nothing',
    }
  }
  const perms = await driveGet(
    `https://www.googleapis.com/drive/v3/files/${fileId}/permissions`
    + '?supportsAllDrives=true&fields=permissions(id,type,role,domain,permissionDetails)',
    tok,
  )
  if (!perms.ok) {
    return { word: 'ERROR', name: meta.body.name, detail: `permissions.list ${perms.status} ${perms.reason || perms.text}` }
  }
  const list = perms.body.permissions || []
  const anyone = list.find((p) => p.type === 'anyone')
  const domain = list.find((p) => p.type === 'domain')
  if (anyone) {
    const direct = (anyone.permissionDetails || [{}]).some((d) => !d.inherited)
    return {
      word: 'anyone',
      name: meta.body.name,
      role: anyone.role,
      inherited: !direct,
      detail: direct ? 'granted on the file' : 'INHERITED from a parent folder, which is therefore link-open too',
    }
  }
  if (domain) {
    return { word: 'domain', name: meta.body.name, role: domain.role, detail: `domain ${domain.domain}` }
  }
  return { word: 'no-anyone', name: meta.body.name, detail: `${list.length} named grant(s), no anyone grant` }
}

// ----------------------------------------------------------- non-Drive liveness
//
// SITE-06 owns `check-resource-links.mjs` and has not built yet, so this does the
// same one-line fetch here and states the same two residuals it states: a 200
// does not mean the resource is still the resource, and a redirect to a login
// page is a 200 as well. Delegate when that script exists.
const SITE06 = path.join(REPO, 'scripts/check-resource-links.mjs')

async function liveness(url) {
  try {
    const res = await fetch(url, { redirect: 'follow' })
    return { word: res.ok ? 'live' : 'ERROR', detail: `HTTP ${res.status}` }
  } catch (e) {
    return { word: 'ERROR', detail: String(e?.message || e) }
  }
}

// ----------------------------------------------------------- the badge grep
//
// Criterion 3. The six badge strings are the page's only on-screen vocabulary and
// they come from the register through the generator, so none of them may exist as
// a literal anywhere in `src/`. A component that hardcoded one would render
// correctly today and stop tracking the register forever, which is the same
// silent-divergence failure `check-labels.mjs` exists for and which no build gate
// covers, because member rows live in the database rather than in the content file.
//
// The first draft of this criterion grepped the vocabulary SLUGS (`open-link`),
// which are absent under either design and so could never fail. It greps the
// display phrases instead, read from the generator rather than restated here, so
// this file cannot drift from the vocabulary it is policing.
function badgeGrep() {
  const badges = execFileSync(
    'python3', [path.join(REPO, 'scripts/build_links_register.py'), '--print-badges'],
    { encoding: 'utf8' },
  ).trim().split('\n').filter(Boolean)
  if (badges.length === 0) throw new Error('the generator printed no badge strings')
  const hits = []
  for (const badge of badges) {
    let found = ''
    try {
      found = execFileSync('git', ['grep', '-l', '--untracked', '-F', '--', badge, '--', 'src'],
        { cwd: REPO, encoding: 'utf8' }).trim()
    } catch { /* git grep exits 1 when it finds nothing, which is the good case */ }
    if (found) hits.push([badge, found.split('\n')])
  }
  console.log(`  badge grep: ${badges.length} string(s) checked against src/, ${hits.length} hit(s)`)
  if (hits.length) {
    for (const [badge, files] of hits) {
      console.error(`  HARDCODED BADGE: ${JSON.stringify(badge)} in ${files.join(', ')}`)
    }
    console.error('  A badge on screen must come from the register. Remove the literal.')
    process.exit(3)
  }
}

// ------------------------------------------------- criterion 5: the URL absence check
//
// For an anyone-with-link Drive file the URL is the access control, so a register
// URL in a public artifact publishes the file (finding 5). This asserts every
// active `url`, and the bare file id inside it, is absent from `dist/**`, from
// `src/**` and from the working tree.
//
// Two properties it must have, both learned from findings the reviews produced.
// The population is PRINTED, checked and exempt separately, because an absence
// check whose population is not printed cannot be told apart from one that had
// nothing to look at. And it FAILS ON A ZERO CHECKED POPULATION, for the same
// reason: a register that has been emptied would otherwise report success.
//
// A row carrying a `ref` is out of the population by construction rather than by
// exemption (finding 12): it re-uses a content node that is already public, so no
// new URL enters the picture and there is nothing to be absent.
function absenceCheck(exempt) {
  const all = parseRegister(registerPath).filter((r) => r.active && r.url)
  const exemptSet = new Set(exempt.map((e) => e.line))
  const checked = all.filter((r) => !exemptSet.has(r.url))
  const skipped = all.filter((r) => exemptSet.has(r.url))

  console.log(`  absence check: ${all.length} active url(s), ${checked.length} checked, ${skipped.length} exempt`)
  for (const e of exempt) console.log(`    exempt ${e.line.slice(0, 60)} — ${e.reason}`)
  if (checked.length === 0) {
    console.error('REFUSED: zero URLs to check, so this assertion proves nothing.')
    process.exit(1)
  }

  const needles = []
  for (const r of checked) {
    needles.push(r.url)
    const id = fileIdOf(r.url)
    if (id) needles.push(id)
  }
  // --scope exists for criterion 5's mutation, which has to watch the dist/ half
  // go red BY ITSELF. A leak pasted into a content node is in src/ too, so a
  // combined run would go red without proving the dist/ grep ever read a real
  // built artifact — the sibling campaign's finding 25 arriving here.
  const scope = flag('--scope', 'all')
  const targets = (scope === 'all' ? ['dist', 'src'] : [scope]).filter((d) => d !== 'worktree')
  const hits = []
  for (const needle of needles) {
    for (const dir of targets) {
      if (dir === 'dist' && !existsSync(path.join(REPO, 'dist'))) continue
      let found = ''
      try {
        found = execFileSync(
          'grep', ['-rlF', '--', needle, path.join(REPO, dir)], { encoding: 'utf8' },
        ).trim()
      } catch { /* grep exits 1 on no match, which is the good case */ }
      if (found) hits.push([needle, dir, found.split('\n')])
    }
    let tracked = ''
    try {
      if (scope !== 'all' && scope !== 'worktree') throw new Error('skip')
      tracked = execFileSync('git', ['grep', '-l', '--untracked', '-F', '--', needle],
        { cwd: REPO, encoding: 'utf8' }).trim()
    } catch { /* nothing */ }
    if (tracked) hits.push([needle, 'worktree', tracked.split('\n')])
  }
  const distExists = existsSync(path.join(REPO, 'dist'))
  const where = targets.map((d) => `${d}/`).concat(scope === 'all' ? ['the worktree'] : []).join(', ')
  console.log(`  ${needles.length} needle(s) (url + file id) against ${where}${distExists || !targets.includes('dist') ? '' : ' (dist/ NOT BUILT, so that half proves nothing)'}`)
  for (const [needle, where, files] of hits) {
    console.error(`  LEAK in ${where}: ${needle.slice(0, 72)} -> ${files.join(', ')}`)
  }
  if (hits.length) {
    console.error('  Either remove it, or add it to the register\'s `exempt:` with a reason.')
    process.exit(4)
  }
  console.log('  no register URL reaches a public artifact')
}

if (args.includes('--absence')) {
  badgeGrep()
  const text = readFileSync(registerPath, 'utf8')
  const fm = text.slice(4, text.indexOf('\n---\n', 3))
  const exempt = []
  const re = /- line:\s*(.+)\n\s+reason:\s*(.+)/g
  let m
  while ((m = re.exec(fm))) {
    exempt.push({ line: m[1].trim().replace(/^["']|["']$/g, ''), reason: m[2].trim().replace(/^["']|["']$/g, '') })
  }
  absenceCheck(exempt)
  process.exit(0)
}

badgeGrep()

// ----------------------------------------------------------- run
const rows = parseRegister(registerPath).filter((r) => r.active)
const scope = onlyRow ? rows.filter((r) => r.label === onlyRow) : rows
if (onlyRow && scope.length === 0) {
  console.error(`REFUSED: no active row labelled ${JSON.stringify(onlyRow)}`)
  process.exit(1)
}
if (scope.length === 0) {
  console.error('REFUSED: zero active rows to check. An empty population cannot fail.')
  process.exit(1)
}

const tok = driveToken()
const results = []
let drive = 0
let other = 0
let refs = 0

for (const row of scope) {
  if (row.ref) {
    refs++
    results.push({ ...row, verdict: 'ref', detail: `references content node ${row.ref}` })
    continue
  }
  const id = fileIdOf(row.url)
  if (id) {
    drive++
    // Paced deliberately, and the number was measured rather than guessed. An
    // unpaced burst of 38 reads returned `403 rateLimitExceeded` on 37 of them;
    // at 150ms with a 600ms backoff, two rows of 24 still failed on every run.
    // Two reads per row are unavoidable, because `files.get?fields=permissions`
    // returns an EMPTY array for a shared-drive file and only `permissions.list`
    // answers. Half a minute for the whole register is cheap; a wrong "closed"
    // verdict costs a message to a colleague about a file that was never closed.
    await sleep(700)
    const got = await driveAccess(id, tok)
    const want = EXPECTED_DRIVE[row.access]
    const ok = got.word === 'ERROR' || got.word === 'indeterminate' ? null : got.word === want
    results.push({ ...row, fileId: id, verdict: got.word, detail: got.detail, name: got.name, inherited: got.inherited, ok })
  } else {
    other++
    const got = await liveness(row.url)
    results.push({ ...row, verdict: got.word, detail: got.detail, ok: got.word === 'live' ? true : null })
  }
}

const mismatches = results.filter((r) => r.ok === false)
const unknown = results.filter((r) => r.ok === null && r.verdict !== 'ref')

console.log(`  register ${registerPath}`)
console.log(`  ${scope.length} active row(s): ${drive} Drive, ${other} other host, ${refs} by ref`)
for (const r of results) {
  const mark = r.ok === false ? 'MISMATCH' : r.ok === null && r.verdict !== 'ref' ? 'UNKNOWN ' : 'ok      '
  console.log(`    ${mark} ${r.label.slice(0, 48).padEnd(48)} declared ${r.access.padEnd(15)} drive ${r.verdict}${r.inherited ? ' (inherited)' : ''}`)
  if (r.ok === null && r.verdict !== 'ref') console.log(`             ${r.detail}`)
}

for (const r of mismatches) {
  console.log('')
  console.log(`  MISMATCH: ${r.label}`)
  console.log(`    file      ${r.fileId}${r.name ? `  (${r.name})` : ''}`)
  console.log(`    declared  ${r.access}`)
  console.log(`    Drive     ${r.verdict} — ${r.detail}`)
  console.log(`    ask       ${r.owner || '(no owner on this row, which is its own defect)'}`)
  console.log('    The remedy is a message to that person, not a change to this script.')
}

if (!noReport) {
  const today = new Date().toISOString().slice(0, 10)
  const lines = [
    '# Links-Register access check',
    '',
    `Written by \`obt-cdt-site/scripts/check-member-links.mjs\` on ${today}. This file`,
    'lives in the vault and not in the site repository, because for a file that opens',
    'to anyone holding its link the link is the credential.',
    '',
    `Checked ${scope.length} active rows: ${drive} Drive files, ${other} other hosts, ${refs} by reference.`,
    `Mismatches: ${mismatches.length}. Rows Drive could not answer for: ${unknown.length}.`,
    '',
    '| Row | Declared | Drive says | Verdict |',
    '| --- | --- | --- | --- |',
    ...results.map((r) => `| ${r.label} | \`${r.access}\` | ${r.verdict}${r.inherited ? ' (inherited)' : ''} | ${r.ok === false ? 'MISMATCH' : r.ok === null && r.verdict !== 'ref' ? 'unknown' : 'ok'} |`),
    '',
  ]
  writeFileSync(reportPath, lines.join('\n'), 'utf8')
  console.log(`\n  report written to ${reportPath}`)
}

if (existsSync(SITE06)) {
  console.log('  note: scripts/check-resource-links.mjs now exists; the liveness half should delegate to it.')
}

/**
 * A row this script could not decide must never read as a row it checked.
 *
 * The first version exited 0 whenever there were no mismatches, so a run in
 * which Drive rate-limited every single read printed UNKNOWN against all of them
 * and then reported success. That is the class this campaign keeps finding: a
 * gate that is green while the thing it exists to catch is untouched. An
 * undecided row is now as fatal as a wrong one, and the two exit codes differ so
 * a caller can tell "the register is wrong" from "the register is unverified".
 */
if (unknown.length > 0) {
  console.log('')
  console.log(`  ${unknown.length} row(s) could not be decided, so this run verified nothing about them:`)
  for (const r of unknown) console.log(`    ${r.label} — ${r.detail}`)
  console.log('  Re-run. A rate-limited read is the common cause and it is transient.')
}
process.exit(mismatches.length > 0 ? 1 : unknown.length > 0 ? 2 : 0)
