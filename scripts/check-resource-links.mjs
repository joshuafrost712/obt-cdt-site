/**
 * Fetch every outbound URL on the suggested-resources page and report its status.
 *
 *   node scripts/check-resource-links.mjs
 *
 * Spec SITE-06 D6. **Deliberately not in the `npm run build` chain**, unlike
 * `check-labels.mjs`. A build that fetches a dozen remote hosts fails whenever a
 * publisher is down, which trains everyone to ignore a red build, and the CI
 * runner would make outbound requests on every deploy. This runs in a build
 * session, and it is the thing to re-run when the page is next touched.
 *
 * ## Two residuals, stated here rather than discovered later
 *
 * A `200` does not mean the resource is still the resource. A redirect chain
 * onto a parked domain returns `200`, and a publisher who has replaced a book's
 * page with a category listing returns `200` too. This script cannot tell.
 *
 * Some publishers refuse a scripted request, and SAGE is one of them. So a
 * non-2xx here is a REPORT and not a verdict, the exit code is 0 unless a URL is
 * malformed or every single fetch failed, and the build session records which
 * hosts refused. A checker whose failures are ambiguous and whose exit code is 1
 * gets run once and then never again.
 *
 * ## Why HEAD then GET
 *
 * Memory note `permission-denied-returns-wrong-answer`, and SITE-04's finding 22
 * on the Drive API: a refusal that looks like an answer is worse than an error.
 * A HEAD is cheap and many hosts answer it correctly; a host that 403s or 405s a
 * HEAD often serves a GET fine, so a HEAD-only checker reports a live page dead.
 * Both are tried before anything is called unreachable.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'

const REPO = path.resolve(import.meta.dirname, '..')
const content = JSON.parse(readFileSync(path.join(REPO, 'src/content/site-content.json'), 'utf8'))

const page = content.pages.find((p) => p.id === 'resources')
if (!page) {
  console.error('no `resources` page in site-content.json; run build_resources_page.py first')
  process.exit(2)
}

const targets = []
const walk = (node) => {
  if (node && typeof node === 'object') {
    if (typeof node.href === 'string' && /^https?:/.test(node.href)) {
      targets.push({ id: node.id, label: node.label, url: node.href })
    }
    for (const key of ['blocks', 'items']) for (const child of node[key] ?? []) walk(child)
  }
}
walk(page)

if (targets.length === 0) {
  console.error('the resources page carries no outbound URL. Refusing to report success over nothing.')
  process.exit(2)
}

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0 Safari/537.36 obt-cdt-link-check'

async function probe(url, method) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20000)
  try {
    const res = await fetch(url, {
      method,
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': UA, Accept: '*/*' },
    })
    return { status: res.status, finalUrl: res.url }
  } catch (error) {
    return { status: 0, error: String(error.name === 'AbortError' ? 'timeout' : error.message).slice(0, 60) }
  } finally {
    clearTimeout(timer)
  }
}

console.log(`${targets.length} outbound URL(s) on ${page.route}\n`)

const rows = []
for (const target of targets) {
  let result = await probe(target.url, 'HEAD')
  let via = 'HEAD'
  if (result.status === 0 || result.status === 403 || result.status === 405 || result.status >= 500) {
    const get = await probe(target.url, 'GET')
    if (get.status >= 200 && get.status < 400) { result = get; via = 'GET' }
    else { result = get.status ? get : result; via = 'GET' }
  }
  const redirected = result.finalUrl && result.finalUrl.replace(/\/$/, '') !== target.url.replace(/\/$/, '')
  rows.push({ ...target, ...result, via, redirected })

  const mark = result.status >= 200 && result.status < 400 ? ' ok ' : 'RPT '
  console.log(`  ${mark} ${String(result.status || '---').padStart(3)} ${via.padEnd(4)} ${target.url}`)
  if (result.error) console.log(`        ${result.error}`)
  if (redirected) console.log(`        redirected to: ${result.finalUrl}`)
  // Pace, so a host does not rate-limit the run and report its own page dead.
  await new Promise((r) => setTimeout(r, 400))
}

const ok = rows.filter((r) => r.status >= 200 && r.status < 400)
const reported = rows.filter((r) => !(r.status >= 200 && r.status < 400))

console.log(`\n${ok.length} resolved, ${reported.length} to triage by hand`)
if (reported.length) {
  console.log('\nEach of these is a REPORT and not a verdict. Open it in a browser before')
  console.log('changing the register: a scripted request is refused by several publishers.')
  for (const row of reported) {
    console.log(`  ${row.label}`)
    console.log(`    ${row.url}`)
    console.log(`    status ${row.status || 'no response'}${row.error ? ` (${row.error})` : ''}`)
  }
}

const hostsFile = path.join(REPO, 'scripts/resource-link-hosts.json')
const declared = JSON.parse(readFileSync(hostsFile, 'utf8')).hosts ?? []
const actual = [...new Set(targets.map((t) => new URL(t.url).hostname))].sort()
const undeclared = actual.filter((h) => !declared.includes(h))
console.log(`\n${declared.length} host(s) declared in resource-link-hosts.json, ${actual.length} on the page`)
if (undeclared.length) {
  console.log(`  MISMATCH, undeclared: ${undeclared.join(', ')}`)
  console.log('  Re-run build_resources_page.py; the manifest is written by the same run as the page.')
}

// Exit 1 only when the manifest disagrees with the page, or when nothing
// resolved at all. A single refusing publisher must not turn this red.
const fatal = undeclared.length > 0 || ok.length === 0
process.exit(fatal ? 1 : 0)
