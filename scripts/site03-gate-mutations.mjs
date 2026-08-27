/**
 * SITE-03 criterion 6: both halves of the build gate fail when they should, and
 * neither passes on an empty set.
 *
 *   node scripts/site03-gate-mutations.mjs
 *
 * ## Why this is a file and not four commands in a build record
 *
 * A mutation test that only ever ran once is a claim, not a control. Every later
 * spec in this campaign adds a member document through the same gate, and the
 * cheapest way for the gate to stop working is for someone to change it while
 * believing the criteria still hold. This is re-runnable.
 *
 * It is deliberately NOT a mode of `member-content-gate.mjs`: that file runs in
 * CI on every build, and a gate that can rewrite source is a gate that will one
 * day rewrite source.
 *
 * ## The four mutations
 *
 *   1. blocks put back on a member node        → structural half red
 *   2. a member route returned by allRoutes()  → structural half red (needs a build)
 *   3. a sentinel pasted into a content node   → sentinel half red
 *   4. every member node un-marked             → BOTH halves red on zero population
 *
 * Number 4 is the one the review added and the one that matters most. Nothing in
 * site-content.json carried `access` when this spec was drafted, so a gate that
 * iterated the member nodes would have found none, printed success, and
 * certified an empty set for the weeks between this spec and SITE-04.
 *
 * Originals are restored in a finally block and again on process exit.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import path from 'node:path'

const REPO = path.resolve(import.meta.dirname, '..')
const CONTENT = path.join(REPO, 'src/content/site-content.json')
const LOADER = path.join(REPO, 'src/lib/content/loader.ts')
const MANIFEST = path.join(REPO, 'scripts/member-sentinels.json')

let failures = 0
function check(name, actual, expected) {
  const ok = String(actual) === String(expected)
  if (!ok) failures++
  console.log(`  ${ok ? ' ok ' : 'FAIL'}  ${name}  expected=${expected} actual=${actual}`)
}

const originals = new Map()
function hold(file) {
  if (!originals.has(file)) originals.set(file, readFileSync(file, 'utf8'))
}
function restoreAll() {
  for (const [file, text] of originals) writeFileSync(file, text)
}
process.on('exit', restoreAll)

function creds() {
  const file = path.join(homedir(), '.claude/secrets/obt-cdt-supabase.env')
  const out = execFileSync('/bin/zsh', [
    '-c',
    `set -a; . ${JSON.stringify(file)}; set +a; printf "%s\\n%s" "$OBT_CDT_SUPABASE_URL" "$OBT_CDT_SUPABASE_PUBLISHABLE_KEY"`,
  ])
    .toString()
    .split('\n')
    .map((s) => s.trim())
  return { url: out[0], key: out[1] }
}
const { url, key } = creds()

/** Build with the gate removed from the chain, so the gate can be run and judged. */
function buildWithoutGate() {
  const pkg = path.join(REPO, 'package.json')
  hold(pkg)
  const original = readFileSync(pkg, 'utf8')
  writeFileSync(pkg, original.replace(' && node scripts/member-content-gate.mjs', ''))
  try {
    execFileSync('npm', ['run', 'build'], {
      cwd: REPO,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        VITE_BASE: '/obt-cdt-site/',
        VITE_SITE_ORIGIN: 'https://joshuafrost712.github.io',
        VITE_SUPABASE_URL: url,
        VITE_SUPABASE_PUBLISHABLE_KEY: key,
      },
    })
  } finally {
    writeFileSync(pkg, original)
  }
}

/** Run the gate. Returns { code, out }. */
function runGate() {
  try {
    const out = execFileSync('node', [path.join(REPO, 'scripts/member-content-gate.mjs')], {
      cwd: REPO,
    }).toString()
    return { code: 0, out }
  } catch (e) {
    return { code: e.status ?? 1, out: String(e.stdout ?? '') + String(e.stderr ?? '') }
  }
}

const readJson = (f) => JSON.parse(readFileSync(f, 'utf8'))
const writeJson = (f, d) => writeFileSync(f, JSON.stringify(d, null, 2) + '\n')

try {
  console.log('=== baseline: the gate passes on the tree as it stands')
  {
    const { code, out } = runGate()
    check('the gate exits 0', code, 0)
    check('and it says so, so a silent pass is distinguishable', out.includes('both halves pass'), true)
    const pop = out.match(/structural half, population (\d+)/)
    check('the structural population is non-zero', Number(pop?.[1] ?? 0) > 0, true)
  }

  console.log('\n=== mutation 1: blocks put back on a member node')
  {
    hold(CONTENT)
    const d = readJson(CONTENT)
    d.pages.find((p) => p.access === 'member').blocks = [
      // Synthetic, never a real member sentence: this file is in a public repo,
      // and the vault-aware grep would then refuse to re-seed the document the
      // sentence came from. Found by criterion 12's diff scan on the sibling
      // harness, which had made exactly that mistake.
      { id: 'members.mutation', type: 'prose', body: 'MUTATION-BLOCK-BODY-SITE03, standing in for a member paragraph.' },
    ]
    writeJson(CONTENT, d)
    const { code, out } = runGate()
    check('the gate exits non-zero', code !== 0, true)
    check('and names the blocks as the reason', out.includes('block(s) in'), true)
    restoreAll()
    check('restored: the gate exits 0 again', runGate().code, 0)
  }

  console.log('\n=== mutation 2: a member route returned by allRoutes(), so it gets prerendered')
  {
    hold(LOADER)
    const original = readFileSync(LOADER, 'utf8')
    const target = "    ...content.pages.filter((p) => p.access !== 'member').map((p) => p.route),"
    if (!original.includes(target)) throw new Error('mutation 2 target not found in loader.ts')
    writeFileSync(LOADER, original.replace(target, '    ...content.pages.map((p) => p.route),'))
    buildWithoutGate()
    const { code, out } = runGate()
    check('the gate exits non-zero', code !== 0, true)
    check('and names the prerendered file per route', out.includes('has a prerendered'), true)
    restoreAll()
    buildWithoutGate()
    check('restored: the gate exits 0 again', runGate().code, 0)
  }

  console.log('\n=== mutation 3: a sentinel pasted into a content node')
  {
    const token = Object.values(readJson(MANIFEST).sentinels)[0]
    check('there is a token to paste, so this cannot pass vacuously', Boolean(token), true)
    hold(CONTENT)
    const d = readJson(CONTENT)
    d.site.items.push({ id: 'site.site03.mutation', type: 'labelToken', label: `pasted ${token}` })
    writeJson(CONTENT, d)
    const { code, out } = runGate()
    check('the gate exits non-zero', code !== 0, true)
    check('and names the artifact the sentinel is in', out.includes('site-content.json'), true)
    restoreAll()
    check('restored: the gate exits 0 again', runGate().code, 0)
  }

  console.log('\n=== mutation 4: every member node un-marked, so both halves face an empty set')
  {
    hold(CONTENT)
    hold(MANIFEST)
    const d = readJson(CONTENT)
    for (const node of [...d.pages, ...d.workshops]) delete node.access
    writeJson(CONTENT, d)
    writeJson(MANIFEST, { ...readJson(MANIFEST), sentinels: {} })
    const { code, out } = runGate()
    check('the gate exits non-zero rather than reporting a clean sweep', code !== 0, true)
    check('the structural half says its population is zero', out.includes('population 0 '), true)
    check('the structural half refuses an empty set', out.includes('certify an empty set'), true)
    check('the sentinel half refuses an empty manifest', out.includes('holds no tokens'), true)
    restoreAll()
    check('restored: the gate exits 0 again', runGate().code, 0)
  }
} finally {
  restoreAll()
  // The last mutation rebuilt nothing, but mutation 2 did; leave dist/ matching
  // the restored tree so the next thing to read it is not reading a mutant.
  buildWithoutGate()
  if (!existsSync(path.join(REPO, 'dist/404.html'))) {
    console.log('  note: dist/404.html is missing after the restoring build')
    failures++
  }
}

console.log(failures ? `\nsite03-gate-mutations FAILED: ${failures} check(s)` : '\nsite03-gate-mutations: all checks pass.')
process.exit(failures ? 1 : 0)
