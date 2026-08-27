/**
 * Fail the build when a members-only page is not actually members-only.
 *
 * Spec SITE-03 D5. Runs last in `npm run build`, after csp-hashes.mjs, because
 * half of it reads `dist/`.
 *
 *   node scripts/member-content-gate.mjs
 *   node scripts/member-content-gate.mjs --quiet     # failures only
 *
 * ## Two halves, because neither alone covers what the other does
 *
 * **The structural half is exact and needs nothing external.** For every node
 * marked `access: "member"` in site-content.json: its `blocks` array is empty;
 * it has no directory in `dist/`; it has no `index.html`; it is in no
 * `sitemap.xml` entry. The blocks check comes FIRST because it is the interface
 * the whole boundary runs through — `PageDef` requires `blocks`, so nothing
 * otherwise stops the next author leaving a handbook's 22 subsections in there
 * while flipping the flag, with every other check still passing.
 *
 * **The sentinel half catches member prose pasted into the content layer or a
 * component.** One opaque token per member document, written by
 * scripts/seed_member_pages.py into scripts/member-sentinels.json, greped across
 * every file under `dist/` (all of it, asset chunks included, not just the entry
 * chunk) and every file under `src/`.
 *
 * ## Both halves fail on a zero population, and that is the point
 *
 * SITE-03 finding 5: nothing in site-content.json carried `access` when this was
 * designed, so a gate that iterated the member nodes would have found none,
 * printed success and certified an empty set. That is the same shape as the
 * sibling campaign's `grep -L` over an empty file list, which reads stdin and
 * returns nothing. So each half prints its population and exits non-zero when it
 * is empty. Removing the last member page is a decision, and it should cost a
 * red build and a deliberate edit to this file rather than passing quietly.
 *
 * ## History is checked by `--history`, and deliberately not by the build
 *
 * A public repository's history does not retract. A commit that added member
 * prose and a later commit that removed it is permanent exposure, so the
 * response is disclosure and rotation, never a rewrite — the same rule
 * scripts/cdt00-history-scan.mjs is built around, and the reason it is not in
 * the build chain: a red build demands a fix, and there is no fix, only a
 * decision. Run it when a member document is created or moved.
 *
 * ## What this does not check at all
 *
 * The vault-aware half of the gate — which greps the site repo for any
 * substantial LINE of a member document, and is stronger than the sentinel —
 * lives in seed_member_pages.py, because that is the only place the private
 * vault is readable.
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'

const REPO = path.resolve(import.meta.dirname, '..')
const DIST = path.join(REPO, 'dist')
const SRC = path.join(REPO, 'src')
const CONTENT = path.join(REPO, 'src/content/site-content.json')
const MANIFEST = path.join(REPO, 'scripts/member-sentinels.json')
const quiet = process.argv.includes('--quiet')

let failures = 0
const say = (line) => {
  if (!quiet) console.log(line)
}
const fail = (line) => {
  failures++
  console.log(`FAIL  ${line}`)
}
const pass = (line) => say(`  ok    ${line}`)

/** Every file under a directory, recursively. */
function walk(dir) {
  if (!existsSync(dir)) return []
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

const content = JSON.parse(readFileSync(CONTENT, 'utf8'))
const memberPages = content.pages.filter((p) => p.access === 'member')
const memberWorkshops = content.workshops.filter((w) => w.access === 'member')
const memberNodes = [...memberPages, ...memberWorkshops]

// ---------------------------------------------------------------------------
// Half one: structural.
// ---------------------------------------------------------------------------
console.log(
  `member-content-gate: structural half, population ${memberNodes.length} ` +
    `(${memberPages.length} page(s), ${memberWorkshops.length} workshop(s))`,
)
for (const node of memberNodes) say(`        ${node.route}  ${node.id}`)

if (memberNodes.length === 0) {
  fail(
    'no node carries access: "member", so this half has nothing to check and would ' +
      'certify an empty set. If the last member page was removed deliberately, say so here.',
  )
}

const sitemapPath = path.join(DIST, 'sitemap.xml')
const sitemap = existsSync(sitemapPath) ? readFileSync(sitemapPath, 'utf8') : null
if (sitemap === null && memberNodes.length > 0) {
  fail(`no ${path.relative(REPO, sitemapPath)}; run the full build before this gate`)
}

for (const node of memberNodes) {
  // 1. The blocks array, first, because it is the likeliest mistake.
  if (!Array.isArray(node.blocks) || node.blocks.length !== 0) {
    fail(
      `${node.route} is access: "member" but carries ${node.blocks?.length ?? '?'} block(s) in ` +
        'site-content.json. A member body lives in member_block, behind RLS. Anything in ' +
        'this file is inlined into the bundle, prerendered to static HTML and committed ' +
        'to a public repository.',
    )
  } else {
    pass(`${node.route} carries blocks: []`)
  }

  // 2. No prerendered artifact, asserted PER ROUTE BY NAME. Not a file count:
  //    the first draft compared an HTML count against a formula whose two sides
  //    both derive from allRoutes(), so it moved together with the leak.
  const dir = path.join(DIST, node.route.replace(/^\//, ''))
  const index = path.join(dir, 'index.html')
  if (existsSync(index)) fail(`${node.route} has a prerendered ${path.relative(REPO, index)}`)
  else if (existsSync(dir)) fail(`${node.route} has a directory at ${path.relative(REPO, dir)}`)
  else pass(`${node.route} has no directory and no index.html under dist/`)

  // 3. No sitemap entry.
  if (sitemap !== null) {
    if (sitemap.includes(`${node.route}<`) || sitemap.includes(`${node.route}/<`)) {
      fail(`${node.route} is listed in dist/sitemap.xml`)
    } else {
      pass(`${node.route} is absent from dist/sitemap.xml`)
    }
  }
}

// 4. The route arithmetic, run rather than reimplemented.
try {
  execFileSync('node', [path.join(REPO, 'scripts/cdt04-bundle-check.mjs')], { stdio: quiet ? 'ignore' : 'inherit' })
  pass('cdt04-bundle-check.mjs passes (route arithmetic, chunk split, CSP-only project reference)')
} catch {
  fail('cdt04-bundle-check.mjs failed; its own output says why')
}

// ---------------------------------------------------------------------------
// Half two: sentinels.
// ---------------------------------------------------------------------------
const manifest = existsSync(MANIFEST)
  ? JSON.parse(readFileSync(MANIFEST, 'utf8')).sentinels ?? {}
  : {}
const tokens = Object.entries(manifest)

const distFiles = walk(DIST)
const srcFiles = walk(SRC)
console.log(
  `\nmember-content-gate: sentinel half, population ${tokens.length} token(s) ` +
    `over ${distFiles.length} file(s) in dist/ and ${srcFiles.length} in src/`,
)
for (const [route] of tokens) say(`        ${route}`)

if (tokens.length === 0) {
  fail(
    `${path.relative(REPO, MANIFEST)} holds no tokens, so this half greps for nothing and ` +
      'reports a clean sweep. Run scripts/seed_member_pages.py --apply.',
  )
}

// A member PAGE with no token has never had its prose checked by anything.
// A member WORKSHOP has no token by design: it is refused rather than rendered,
// so it has no body to leak.
for (const node of memberPages) {
  if (!manifest[node.route]) {
    fail(
      `${node.route} is a member page with no sentinel in ${path.relative(REPO, MANIFEST)}. ` +
        'Its body has never been seeded, so nothing has ever checked it.',
    )
  }
}
for (const node of memberWorkshops) {
  if (manifest[node.route]) {
    fail(`${node.route} is a member workshop and must not carry a sentinel; it renders nothing`)
  }
}

const haystack = [...distFiles, ...srcFiles]
for (const [route, token] of tokens) {
  const hits = haystack.filter((file) => readFileSync(file, 'utf8').includes(token))
  if (hits.length > 0) {
    fail(
      `the sentinel for ${route} is in ${hits.length} public artifact(s): ` +
        hits.map((f) => path.relative(REPO, f)).join(', ') +
        '. Member prose has been pasted into the content layer or a component.',
    )
  } else {
    pass(`${route}: its sentinel is in no file under dist/ or src/`)
  }
}

// ---------------------------------------------------------------------------
// Half three, opt-in: history.
// ---------------------------------------------------------------------------
if (process.argv.includes('--history')) {
  console.log(`\nmember-content-gate: history scan, ${tokens.length} token(s) over every commit`)
  if (tokens.length === 0) fail('no tokens, so the history scan has nothing to look for')

  /** Every commit that added or removed this string, anywhere in the repo. */
  const commitsTouching = (needle) =>
    execFileSync('git', ['log', '--all', '--format=%h', `-S${needle}`], { cwd: REPO })
      .toString()
      .split('\n')
      .filter(Boolean)

  // A positive control, because an absence check with no control cannot be told
  // apart from a broken command. This string is in the repo's own history.
  const control = commitsTouching('Content-Security-Policy')
  if (control.length === 0) {
    fail('the history scan found nothing for a string that IS in history; the command is broken')
  } else {
    pass(`positive control: "Content-Security-Policy" appears in ${control.length} commit(s)`)
  }

  for (const [route, token] of tokens) {
    const hits = commitsTouching(token)
    if (hits.length > 0) {
      fail(
        `the sentinel for ${route} is in ${hits.length} commit(s): ${hits.join(', ')}. ` +
          'History does not retract on a public repo: disclose and re-seed the document with a ' +
          'new sentinel. Do NOT rewrite history — every clone already has it.',
      )
    } else {
      pass(`${route}: its sentinel is in no commit on any branch`)
    }
  }
}

console.log(
  failures
    ? `\nmember-content-gate FAILED: ${failures} problem(s).`
    : `\nmember-content-gate: both halves pass, over ${memberNodes.length} member node(s) and ${tokens.length} sentinel(s).`,
)
process.exit(failures ? 1 : 0)
