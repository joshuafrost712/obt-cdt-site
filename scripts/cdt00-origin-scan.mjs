/**
 * Spec CDT-00 criterion 1: how many external origins does the built site
 * actually contact, and are they the ones the design admits?
 *
 * The distinction this script exists to keep straight: a CSP governs what the
 * page FETCHES, not where a link NAVIGATES. So an <a href> to youtube.com is not
 * an origin the site contacts, and counting it would produce a scary number that
 * means nothing. But leaving it out silently would look like the scan had missed
 * it, so every outbound link host is enumerated and shown as excluded, with the
 * reason. Rubric row 1 counts contacted origins; the referrer policy is what
 * governs the links.
 *
 * Contact channels checked:
 *   - <script src>, <link href> with rel stylesheet/preconnect/preload/dns-prefetch
 *   - <img src>, <img srcset>, <source src|srcset>, <video>, <audio>, <iframe src>
 *   - CSS url(...) in stylesheets and in style attributes
 *   - @font-face src
 *   - absolute URLs appearing in JS as fetch/XHR/WebSocket targets
 *
 * Usage:
 *   node scripts/cdt00-origin-scan.mjs                    # scan dist/
 *   node scripts/cdt00-origin-scan.mjs --dist some/dir
 *   node scripts/cdt00-origin-scan.mjs --url https://joshuafrost712.github.io/obt-cdt-site/
 *        (fetches the deployed bundle instead: index.html plus every asset it
 *         references, which is the artifact visitors actually receive)
 */

import { readFile, readdir, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}

const DIST = path.resolve(arg('dist', 'dist'))
const LIVE = arg('url', null)
const OUT_JSON = arg('json', null)

// Origins the design admits, each with the decision that admitted it.
const ADMITTED = {
  'script.google.com': 'CDT-00 decision 2: the Apps Script feedback sink (devfeedback/send.ts)',
  'script.googleusercontent.com': 'CDT-00 decision 2: the same sink, redirect target',
}
const ADMITTED_SUFFIX = {
  '.supabase.co': 'the portal project, over https and wss (connect-src)',
}

// Hosts the site links to. A link is navigation, not contact. Verified against
// src/content/site-content.json; the referrer policy is what covers these.
const KNOWN_LINK_HOSTS = [
  'youtube.com',
  'www.youtube.com',
  'docs.google.com',
  'forms.gle',
  'wa.me',
  'maps.app.goo.gl',
  'www.google.com',
  'lovebali.baliprov.go.id',
  'evisa.imigrasi.go.id',
  'mechon-mamre.org',
  // The spec's list of ten wrote two of these without the www label they carry
  // in the content. Both forms are kept so a re-measure does not read as drift.
  'www.mechon-mamre.org',
]

/**
 * Spec SITE-06 D7. The suggested-resources page's link hosts are generated, not
 * hand-maintained, so they arrive from a manifest written by the same run that
 * writes the page. The eleven hand-written entries above keep their comment and
 * their meaning; this only widens the set.
 *
 * This changes nothing about what FAILS the scan. Only a contacted origin exits
 * 1, and an `<a href>` is navigation. What the manifest buys is that a new
 * reading-list host does not print as NEW every time the register grows.
 */
const GENERATED_LINK_HOSTS = (() => {
  const file = new URL('./resource-link-hosts.json', import.meta.url)
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return Array.isArray(parsed.hosts) ? parsed.hosts : []
  } catch {
    // Absent is normal: the manifest does not exist until the resources page has
    // been generated once. Silence here would hide a deleted manifest, so say so.
    console.log('note: scripts/resource-link-hosts.json is absent; no generated link hosts')
    return []
  }
})()

const ALL_LINK_HOSTS = [...new Set([...KNOWN_LINK_HOSTS, ...GENERATED_LINK_HOSTS])]

// The site's own origin. Canonical and OG tags point at it on every page, so
// without this it shows up as an external link host on all fourteen files.
const SELF_ORIGINS = [
  new URL(process.env.VITE_SITE_ORIGIN || 'https://joshuafrost712.github.io').host,
]

const URL_RE = /https?:\/\/[^\s"'()<>\\`]+/g

// A fetch/socket target in built JS, as opposed to a string that is only ever
// used as a link. Both are reported; only the first counts as contact.
const FETCH_HINT = /(fetch|XMLHttpRequest|WebSocket|new\s+EventSource|\.open\()/

async function walk(dir) {
  const out = []
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...(await walk(p)))
    else out.push(p)
  }
  return out
}

/** Pull every URL out of one file, tagged with the channel it appeared in. */
function extract(name, text) {
  const hits = []
  const push = (channel, url, context) => hits.push({ channel, url, context, file: name })

  if (/\.html?$/.test(name)) {
    for (const m of text.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi))
      push('script-src', m[1], m[0].slice(0, 90))
    for (const m of text.matchAll(/<link\b[^>]*>/gi)) {
      const rel = (m[0].match(/\brel=["']([^"']+)["']/i) || [])[1] || ''
      const href = (m[0].match(/\bhref=["']([^"']+)["']/i) || [])[1]
      if (!href) continue
      if (/stylesheet|preconnect|preload|dns-prefetch|modulepreload|prefetch/i.test(rel))
        push(`link:${rel}`, href, m[0].slice(0, 90))
      else push(`link:${rel || 'other'}`, href, m[0].slice(0, 90))
    }
    for (const m of text.matchAll(/<(?:img|source|video|audio|iframe|embed)\b[^>]*>/gi)) {
      for (const attr of ['src', 'srcset', 'poster', 'data']) {
        const v = (m[0].match(new RegExp(`\\b${attr}=["']([^"']+)["']`, 'i')) || [])[1]
        if (v) push(`${m[0].match(/<(\w+)/)[1].toLowerCase()}:${attr}`, v, m[0].slice(0, 90))
      }
    }
    for (const m of text.matchAll(/<a\b[^>]*\bhref=["']([^"']+)["']/gi))
      push('a-href', m[1], '')
    for (const m of text.matchAll(/url\(([^)]+)\)/gi)) push('css-url', m[1].replace(/["']/g, ''), '')
  }

  if (/\.css$/.test(name)) {
    for (const m of text.matchAll(/url\(([^)]+)\)/gi)) push('css-url', m[1].replace(/["']/g, ''), '')
    for (const m of text.matchAll(/@import\s+["']([^"']+)["']/gi)) push('css-import', m[1], '')
  }

  if (/\.(m?js|json|xml|txt|webmanifest)$/.test(name)) {
    for (const m of text.matchAll(URL_RE)) {
      const around = text.slice(Math.max(0, m.index - 120), m.index + 120)
      push(FETCH_HINT.test(around) ? 'js-fetch' : 'js-string', m[0], '')
    }
  }

  return hits
}

let files
if (LIVE) {
  // Fetch the deployed index.html, then every same-origin asset it names.
  const base = LIVE.replace(/\/$/, '') + '/'
  const index = await fetch(base).then((r) => r.text())
  const assets = new Set()
  for (const m of index.matchAll(/(?:src|href)=["']([^"']+\.(?:js|css))["']/gi)) assets.add(m[1])
  files = [{ name: 'index.html (live)', text: index }]
  for (const a of assets) {
    const u = new URL(a, base).href
    files.push({ name: a + ' (live)', text: await fetch(u).then((r) => r.text()) })
  }
  console.log(`fetched the deployed bundle: index.html plus ${assets.size} asset(s)`)
} else {
  const paths = (await walk(DIST)).filter((p) =>
    /\.(html?|css|m?js|json|xml|txt|webmanifest)$/.test(p),
  )
  files = await Promise.all(
    paths.map(async (p) => ({
      name: path.relative(DIST, p),
      text: await readFile(p, 'utf8'),
    })),
  )
  console.log(`scanned ${files.length} text files under ${path.relative(process.cwd(), DIST)}`)
}

const all = files.flatMap((f) => extract(f.name, f.text))

const CONTACT_CHANNELS = new Set([
  'script-src',
  'link:stylesheet',
  'link:preconnect',
  'link:preload',
  'link:dns-prefetch',
  'link:modulepreload',
  'link:prefetch',
  'css-url',
  'css-import',
  'js-fetch',
  'img:src',
  'img:srcset',
  'source:src',
  'source:srcset',
  'video:src',
  'video:poster',
  'audio:src',
  'iframe:src',
  'embed:src',
])

const external = all.filter((h) => /^https?:\/\//.test(h.url))
const contacted = new Map() // host -> Set(channel)
const linked = new Map()
const jsStrings = new Map()

for (const h of external) {
  let host
  try {
    host = new URL(h.url).host
  } catch {
    continue
  }
  if (SELF_ORIGINS.includes(host)) continue
  const bucket = CONTACT_CHANNELS.has(h.channel)
    ? contacted
    : h.channel === 'js-string'
      ? jsStrings
      : linked
  if (!bucket.has(host)) bucket.set(host, new Set())
  bucket.get(host).add(`${h.channel} in ${h.file}`)
}

const verdictFor = (host) => {
  if (ADMITTED[host]) return ['ADMITTED', ADMITTED[host]]
  for (const [suffix, why] of Object.entries(ADMITTED_SUFFIX))
    if (host.endsWith(suffix)) return ['ADMITTED', why]
  return ['UNEXPECTED', 'not named in CDT-00 D2; a new origin is a decision, not a change']
}

console.log('\nORIGINS THE SITE CONTACTS (these are what the CSP governs)')
let unexpected = 0
if (contacted.size === 0) {
  console.log('  none. Every fetched resource is same-origin.')
}
for (const [host, where] of [...contacted].sort()) {
  const [verdict, why] = verdictFor(host)
  if (verdict === 'UNEXPECTED') unexpected++
  console.log(`  ${verdict.padEnd(10)} ${host}`)
  console.log(`             ${why}`)
  for (const w of [...where].slice(0, 3)) console.log(`             via ${w}`)
}

console.log('\nHOSTS THE SITE LINKS TO (excluded: a CSP does not govern navigation)')
console.log('  The referrer policy is the control here, not the CSP.')
const linkHosts = [...linked.keys()].sort()
for (const host of linkHosts) {
  const known = ALL_LINK_HOSTS.includes(host)
  console.log(`  ${known ? 'known ' : 'NEW   '} ${host}`)
}
const newLinks = linkHosts.filter((h) => !ALL_LINK_HOSTS.includes(h))
const missingLinks = ALL_LINK_HOSTS.filter((h) => !linkHosts.includes(h))
if (missingLinks.length)
  console.log(`  (enumerated but not present in this build: ${missingLinks.join(', ')})`)

if (jsStrings.size) {
  console.log('\nABSOLUTE URLS IN JS WITH NO FETCH NEARBY (reported, not counted)')
  for (const [host, where] of [...jsStrings].sort()) {
    console.log(`  ${host}  — e.g. ${[...where][0]}`)
  }
}

const summary = {
  target: LIVE || path.relative(process.cwd(), DIST),
  contacted: Object.fromEntries([...contacted].map(([k, v]) => [k, [...v]])),
  linked: linkHosts,
  jsStrings: [...jsStrings.keys()],
  unexpected,
  newLinkHosts: newLinks,
}
if (OUT_JSON) await writeFile(OUT_JSON, JSON.stringify(summary, null, 2))

console.log(
  `\nSUMMARY  contacted=${contacted.size}  unexpected=${unexpected}  ` +
    `link-hosts=${linkHosts.length}  new-link-hosts=${newLinks.length}`,
)
if (unexpected) {
  console.error('FAIL: an origin the design does not admit is contacted by the built site.')
  process.exit(1)
}
console.log('PASS: every contacted origin is one CDT-00 D2 admits.')
