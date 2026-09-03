/**
 * SITE-05's measuring instrument: the anchor sets, the word counts, and the
 * comparison between a before and an after.
 *
 *   node scripts/site05-anchors.mjs --count                     # criterion 2
 *   node scripts/site05-anchors.mjs --capture before.json       # criterion 3, from dist/
 *   node scripts/site05-anchors.mjs --compare before.json after.json
 *   node scripts/site05-anchors.mjs --stubs                     # criterion 7
 *
 * ## Why the counting function lives here and not in a session's head
 *
 * Spec finding 13's arithmetic has at least four plausible methods and the
 * spec's own review said so. Counting `body` alone gives 3,340 for this page;
 * `body` plus `title` gives 3,616; `docs/HANDBOOK.md` says 3,700. A number with
 * four methods and no named one is recurring class 1's second half, so D2's
 * figures are THIS function's output and criterion 2 re-runs it rather than
 * recounting by another method. The method: whitespace-delimited tokens over the
 * `title`, `body`, `label`, `note`, `kicker` and `value` string fields of the
 * block tree, recursing into `items`.
 *
 * ## The anchor sets come from the BUILT page, not from the JSON
 *
 * Finding 3: a `handbookSection` gets a DOM id whether or not it carries an
 * `anchor` (`HandbookBlocks.tsx:37` falls back to `block.id`). So a section that
 * loses its anchor in the move still renders an id, the page still works, and
 * the emailed fragment dies silently. Only the rendered document can tell those
 * apart, which is why `--capture` reads `dist/` and not `site-content.json`.
 *
 * And it reads a FETCHED document rather than a driven browser: the "↑ Contents"
 * button appears once `progress > 0.04` and would add `href="#handbook-top"` to
 * a driven page, so the two sets would not be comparable.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import path from 'node:path'

const REPO = path.resolve(import.meta.dirname, '..')
const CONTENT = path.join(REPO, 'src/content/site-content.json')
const PUBLIC_HTML = path.join(REPO, 'dist/workshops/psalms-bali-2026/index.html')
const WORKSHOP_ID = 'psalms-bali-2026'

/** The six string fields D2's figures are summed over. Named, not implied. */
const TEXT_FIELDS = ['title', 'body', 'label', 'note', 'kicker', 'value']

function content() {
  return JSON.parse(readFileSync(CONTENT, 'utf8'))
}

function workshop() {
  const node = content().workshops.find((w) => w.id === WORKSHOP_ID)
  if (!node) throw new Error(`no workshop ${WORKSHOP_ID} in site-content.json`)
  return node
}

// ------------------------------------------------------------------ counting

/** Whitespace-delimited tokens over TEXT_FIELDS, recursing into `items`. */
export function words(blocks) {
  let n = 0
  for (const block of blocks) {
    for (const field of TEXT_FIELDS) {
      const value = block[field]
      if (typeof value === 'string' && value.trim()) n += value.trim().split(/\s+/).length
    }
    if (Array.isArray(block.items)) n += words(block.items)
  }
  return n
}

/** Every distinct `type` in a block tree. */
export function types(blocks, out = new Set()) {
  for (const block of blocks) {
    if (block.type) out.add(block.type)
    if (Array.isArray(block.items)) types(block.items, out)
  }
  return out
}

/** Every `anchor` in a block tree, in reading order. */
export function anchors(blocks, out = []) {
  for (const block of blocks) {
    if (block.anchor) out.push(block.anchor)
    if (Array.isArray(block.items)) anchors(block.items, out)
  }
  return out
}

/** Every `id` in a block tree, in reading order. */
export function ids(blocks, out = []) {
  for (const block of blocks) {
    if (block.id) out.push(block.id)
    if (Array.isArray(block.items)) ids(block.items, out)
  }
  return out
}

function countMode() {
  const node = workshop()
  const sections = node.blocks.filter((b) => b.type === 'handbookSection')
  console.log('site05-anchors --count, over src/content/site-content.json')
  console.log(`  method: whitespace tokens over ${TEXT_FIELDS.join(', ')}, recursing into items`)
  console.log('')
  console.log(`  whole page words        : ${words(node.blocks)}`)
  console.log(`  handbookSection blocks  : ${sections.length}`)
  console.log(`  distinct block types    : ${[...types(node.blocks)].sort().join(', ')}`)
  console.log(`  anchors in the node     : ${anchors(node.blocks).length}`)
  console.log(`  block ids in the node   : ${ids(node.blocks).length}`)
  console.log('')
  for (const section of sections) {
    console.log(
      `  ${section.id.padEnd(9)} ${String(section.anchor).padEnd(16)} ` +
        `${String(words([section])).padStart(5)} words  ` +
        `${String(anchors([section]).length).padStart(2)} anchors  ` +
        `${[...types([section])].length} types`,
    )
  }
  console.log('')
  // The public/member split, computed from where each section actually sits
  // today rather than from a list this file hardcodes: a section is "member" if
  // it is absent from the node and present in the member document's id set.
  const stubSection = node.blocks.find((b) => b.type === 'handbookSection' && b.id === 'bali.s45')
  if (stubSection) {
    console.log('  the split has been applied; the stub section is present')
    console.log(`  public words (this node): ${words(node.blocks)}`)
    console.log(`  stub section words      : ${words([stubSection])}`)
  } else {
    const member = node.blocks.filter((b) => b.id === 'bali.s4' || b.id === 'bali.s5')
    const publicSide = node.blocks.filter((b) => b.id !== 'bali.s4' && b.id !== 'bali.s5')
    console.log('  the split has NOT been applied; projecting it')
    console.log(`  public words   : ${words(publicSide)}   (D2 says 2,277)`)
    console.log(`  member words   : ${words(member)}   (D2 says 1,891)`)
    console.log(`  public sections: ${publicSide.filter((b) => b.type === 'handbookSection').length}`)
    console.log(`  member anchors : ${anchors(member).length}`)
    console.log(`  member types   : ${[...types(member)].sort().join(', ')}`)
  }
}

// ------------------------------------------------------------------- anchors

/**
 * The id and href sets of the built public page.
 *
 * `root` and `handbook-top` are the app shell's own ids and are excluded: they
 * are not anchors anyone was ever emailed, and counting them would put the
 * comparison two out from finding 2's numbers in both directions.
 */
const SHELL_IDS = new Set(['root', 'handbook-top'])

export function capture(htmlPath = PUBLIC_HTML) {
  const html = readFileSync(htmlPath, 'utf8')
  const idSet = [...html.matchAll(/id="([^"]*)"/g)].map((m) => m[1]).filter((id) => !SHELL_IDS.has(id))
  const hrefs = [...html.matchAll(/href="#([^"]*)"/g)].map((m) => m[1])
  const hrefCounts = {}
  for (const h of hrefs) hrefCounts[h] = (hrefCounts[h] ?? 0) + 1
  return {
    source: path.relative(REPO, htmlPath),
    ids: [...new Set(idSet)].sort(),
    hrefCounts: Object.fromEntries(Object.entries(hrefCounts).sort()),
  }
}

function captureMode(out) {
  const snap = capture()
  writeFileSync(out, JSON.stringify(snap, null, 2) + '\n')
  console.log(`site05-anchors --capture ${out}`)
  console.log(`  source     : ${snap.source}`)
  console.log(`  ids        : ${snap.ids.length}`)
  console.log(`  href frags : ${Object.keys(snap.hrefCounts).length}, ` +
    `${JSON.stringify(snap.hrefCounts)}`)
  console.log(`  ${snap.ids.join(' ')}`)
}

function compareMode(beforePath, afterPath) {
  const before = JSON.parse(readFileSync(beforePath, 'utf8'))
  const after = JSON.parse(readFileSync(afterPath, 'utf8'))
  const b = new Set(before.ids)
  const a = new Set(after.ids)
  const lost = before.ids.filter((id) => !a.has(id))
  const gained = after.ids.filter((id) => !b.has(id))

  console.log('site05-anchors --compare, criterion 3')
  console.log(`  before: ${before.ids.length} ids   after: ${after.ids.length} ids`)
  let failures = 0

  if (lost.length) {
    failures++
    console.log(`  FAIL  ${lost.length} anchor(s) present before and absent after:`)
    // Name the block that carried each, which is what the criterion asks for.
    const node = workshop()
    for (const anchor of lost) {
      const carrier = findAnchorCarrier(node.blocks, anchor)
      console.log(`          ${anchor}  (was ${carrier ?? 'not in the node either'})`)
    }
  } else {
    console.log(`   ok   no anchor was lost`)
  }
  if (gained.length) {
    console.log(`  note  ${gained.length} new id(s): ${gained.join(', ')}`)
  }
  const setEqual = lost.length === 0 && gained.length === 0
  console.log(`  ${setEqual ? ' ok ' : 'FAIL'}  the id set is EQUAL before and after`)
  if (!setEqual) failures++

  const bh = Object.keys(before.hrefCounts).sort()
  const ah = Object.keys(after.hrefCounts).sort()
  const droppedHref = bh.filter((h) => !ah.includes(h))
  console.log(`  href fragments: ${bh.length} before, ${ah.length} after` +
    (droppedHref.length ? `, dropped: ${droppedHref.join(', ')}` : ''))
  const allTwice = Object.values(after.hrefCounts).every((n) => n === 2)
  console.log(`  ${allTwice ? ' ok ' : 'FAIL'}  every surviving fragment is rendered exactly twice ` +
    `(the contents grid and the desktop rail)`)
  if (!allTwice) failures++

  console.log(failures ? `\n  ${failures} check(s) FAILED` : '\n  criterion 3: all checks pass.')
  return failures
}

function findAnchorCarrier(blocks, anchor, trail = []) {
  for (const block of blocks) {
    if (block.anchor === anchor) return [...trail, block.id].join(' > ')
    if (Array.isArray(block.items)) {
      const hit = findAnchorCarrier(block.items, anchor, [...trail, block.id])
      if (hit) return hit
    }
  }
  return null
}

// --------------------------------------------------------------------- stubs

/**
 * Criterion 7. The stub ids and the member document's moved-anchor set are
 * asserted equal in BOTH directions, and every stub sentence is resolved to a
 * node in site-content.json by lookup.
 *
 * `check-labels.mjs` cannot see either half: it runs two passes over string
 * literals in `src/` (`check-labels.mjs:33-45`), and `grep -rn "bali\." src`
 * returns zero, so no node on this page is covered by it and nothing this spec
 * adds to site-content.json will be. That is why this exists.
 */
function stubsMode() {
  const node = workshop()
  const moved = node.movedAnchors ?? []
  const memberDoc = process.env.SITE05_MEMBER_DOC ?? defaultMemberDoc()
  const docText = readFileSync(memberDoc, 'utf8')
  // Every `anchor:` key line in the member document, which is the set that
  // actually moved. Read from the document rather than from a list here, so a
  // stub cannot exist for an anchor that did not move.
  const docAnchors = [...docText.matchAll(/^anchor:\s+(\S+)\s*$/gm)].map((m) => m[1])
  const sectionAnchor = node.blocks.find((b) => b.id === 'bali.s45')?.anchor

  console.log('site05-anchors --stubs, criterion 7')
  console.log(`  member document      : ${path.basename(memberDoc)}`)
  console.log(`  anchors in it        : ${docAnchors.length}  ${docAnchors.join(' ')}`)
  console.log(`  movedAnchors declared: ${moved.length}  ${moved.map((m) => m.id).join(' ')}`)
  console.log(`  stub section anchor  : ${sectionAnchor}`)

  let failures = 0
  // The section's own anchor is one of the moved fourteen and resolves as the
  // section rather than as a stub (D6), so it is expected on the document side
  // and absent from the stub list.
  const expectedStubs = new Set(docAnchors.filter((a) => a !== sectionAnchor))
  const declared = new Set(moved.map((m) => m.id))
  const missing = [...expectedStubs].filter((a) => !declared.has(a))
  const extra = [...declared].filter((a) => !expectedStubs.has(a))

  if (missing.length) {
    failures++
    console.log(`  FAIL  ${missing.length} moved anchor(s) have no stub: ${missing.join(', ')}`)
  } else {
    console.log(`   ok   every moved anchor has a stub (${expectedStubs.size})`)
  }
  if (extra.length) {
    failures++
    console.log(`  FAIL  ${extra.length} stub(s) name an anchor that did not move: ${extra.join(', ')}`)
  } else {
    console.log(`   ok   no stub names an anchor that did not move`)
  }
  if (!expectedStubs.size) {
    failures++
    console.log(`  FAIL  zero population: this check would pass over nothing`)
  }

  // Every stub sentence resolves to a node in site-content.json by lookup: the
  // note is READ from the content store here rather than compared to a literal
  // in this file, which is the half check-labels.mjs would otherwise cover.
  const unresolved = moved.filter((m) => !m.note || !m.note.trim() || !m.to || !m.to.startsWith('/members/'))
  if (unresolved.length) {
    failures++
    console.log(`  FAIL  ${unresolved.length} stub(s) carry no sentence or no member route`)
  } else {
    console.log(`   ok   every stub resolves to a node with a sentence and a /members/ route`)
  }
  const generic = moved.filter((m, i) => moved.findIndex((o) => o.note === m.note) !== i)
  if (generic.length) {
    failures++
    console.log(`  FAIL  ${generic.length} stub sentence(s) are duplicates; D6 asks for per-anchor wording`)
  } else {
    console.log(`   ok   all ${moved.length} sentences are distinct (D6's per-anchor rule)`)
  }

  console.log(failures ? `\n  ${failures} check(s) FAILED` : '\n  criterion 7: all checks pass.')
  return failures
}

// ------------------------------------------------------------------ absence

/**
 * Criterion 8. The moved text and the four named nodes are gone from the live
 * artifacts, and history is DISCLOSED rather than asserted absent.
 *
 * Finding 7 is why the two halves are different in kind. Moving a section
 * behind the gate does not unpublish it: the base's address is in this
 * repository's history and in the deployed bundle until the next deploy, and
 * history on a public repo does not retract. What the split buys is that the
 * LIVE page stops being the source and the NEXT cohort's specifics are never
 * published at all. A build record claiming "the address is now private" would
 * be false, so this prints the history count instead of asserting a zero.
 */
function absenceMode() {
  const node = workshop()
  let failures = 0
  console.log('site05-anchors --absence, criterion 8')

  // The sample: substantial lines of the moved sections, read from the member
  // document, plus the street line in full.
  const memberDoc = process.env.SITE05_MEMBER_DOC ?? defaultMemberDoc()
  const docText = readFileSync(memberDoc, 'utf8')
  const sample = docText
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^(#|\||>|---|[a-zA-Z][a-zA-Z0-9_]*:\s)/.test(l))
    .filter((l) => l.length >= 60 && l.split(/\s+/).length >= 10)
  /*
   * The street line is READ from the member document, never written here.
   *
   * The first version of this check hardcoded a fragment of it, and the check
   * then found itself: this file is in a public repository, so the address
   * written into it is the exact leak the whole spec exists to prevent, and it
   * would have jammed the seed too — the line would then be in a TRACKED file,
   * so the vault-aware gate would refuse to re-seed the document it came from.
   * SITE-03's harness recorded the same lesson about a member sentence. The
   * harness holds no member prose at rest.
   */
  const addressRow = docText
    .split('\n')
    .find((l) => l.includes('bali.03.venue.address'))
  if (!addressRow) {
    failures++
    console.log('  FAIL  no bali.03.venue.address row in the member document; nothing to check')
  }
  const street = addressRow?.split('|').map((c) => c.trim()).filter(Boolean).at(-1) ?? ''
  const strings = [...sample.slice(0, 12), street].filter(Boolean)
  console.log(`  population: ${strings.length} string(s) — ${sample.length} substantial lines available, ` +
    `12 sampled, plus the street line in full`)
  if (strings.length < 5) {
    failures++
    console.log('  FAIL  the population is too small for this check to mean anything')
  }

  const trees = ['dist', 'src', 'docs', 'scripts']
  for (const needle of strings) {
    const hits = []
    for (const tree of trees) {
      const dir = path.join(REPO, tree)
      if (!existsSync(dir)) continue
      const found = grepTree(dir, needle)
      hits.push(...found)
    }
    if (hits.length) {
      failures++
      console.log(`  FAIL  present in ${hits.length} file(s): ${needle.slice(0, 50)}…`)
      for (const h of hits.slice(0, 4)) console.log(`          ${h}`)
    }
  }
  if (!failures) {
    console.log(`   ok   all ${strings.length} string(s) absent from dist/, src/, docs/ and scripts/`)
    // Printed as a length and a first word, not in full: a build record is
    // pasted into a session log and a vault note, and the point of the check is
    // that this string has one home.
    console.log(`   ok   including the street line in full ` +
      `(${street.split(/\s+/).length} words, ${street.length} chars, begins "${street.split(' ')[0]}")`)
  }

  // The four named nodes of finding 17, asserted INDIVIDUALLY by id. An absence
  // scoped to "the address string" would go green with the venue name, the area
  // and the promise that logistics are here, all still public.
  console.log('\n  the four named nodes of finding 17, by id')
  const all = content()
  const venue = findById(all, 'bali.hero.venue')
  const ccVenue = findById(all, 'cc.hero.venue')
  const card = findById(all, 'cc.03.next.psalms')
  const hero = findById(all, 'bali.hero')

  const NAME = 'University of the Nations'
  const forms = new Set([venue?.label, ccVenue?.label].filter(Boolean))
  failures += report('bali.hero.venue and cc.hero.venue carry ONE normalised form',
    forms.size === 1 && [...forms][0].startsWith(NAME))
  console.log(`          the form: ${[...forms][0]}`)
  failures += report('and neither says "YWAM"', ![...forms][0].includes('YWAM'))
  failures += report('the hero body no longer advertises "where the base is"',
    !hero?.body?.includes('where the base is'))
  failures += report('the metaDescription no longer claims to be the participant handbook',
    !node.metaDescription.includes('This page is also the participant handbook'))
  failures += report("cc.03.next.psalms no longer promises that logistics live there",
    !card?.note?.includes('Logistics live here') && !card?.body?.includes('laundry'))

  // The third venue node moved, so it is asserted where it now lives.
  const memberVenue = docText.includes(`${NAME} base, Jimbaran, Bali`)
  failures += report('bali.03.venue.venue, now gated, carries the same normalised form', memberVenue)

  console.log(failures ? `\n  ${failures} check(s) FAILED` : '\n  criterion 8: all checks pass.')
  console.log('\n  History is DISCLOSED and not asserted absent (finding 7). Run:')
  console.log('    node scripts/cdt00-history-scan.mjs')
  return failures
}

function report(name, ok) {
  console.log(`  ${ok ? ' ok ' : 'FAIL'}  ${name}`)
  return ok ? 0 : 1
}

function findById(tree, id) {
  if (Array.isArray(tree)) {
    for (const item of tree) {
      const hit = findById(item, id)
      if (hit) return hit
    }
    return null
  }
  if (tree && typeof tree === 'object') {
    if (tree.id === id) return tree
    for (const value of Object.values(tree)) {
      const hit = findById(value, id)
      if (hit) return hit
    }
  }
  return null
}

/**
 * A directory grep, deliberately: `dist/` is gitignored but on disk, and it is
 * the artifact this criterion is about (finding 18 is the same fact pointed the
 * other way, for the seed's gate, where a directory grep would be wrong).
 */
function grepTree(dir, needle) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...grepTree(full, needle))
      continue
    }
    if (/\.(png|jpg|jpeg|webp|woff2?|ico|pdf)$/i.test(entry.name)) continue
    let text
    try {
      text = readFileSync(full, 'utf8')
    } catch {
      continue
    }
    if (text.includes(needle)) out.push(path.relative(REPO, full))
  }
  return out
}

function defaultMemberDoc() {
  const vault = process.env.OBT_CDT_VAULT ??
    path.join(process.env.HOME, 'Documents/Josh & Katie Vault/Claude Can Access PARA')
  return path.join(vault, 'Projects/OBT/OBT-CDT Central Hub/Member Pages/Psalms-Handbook-Member.md')
}

// ---------------------------------------------------------------------- main

const argv = process.argv.slice(2)
const mode = argv[0]
if (mode === '--count') countMode()
else if (mode === '--capture') captureMode(argv[1] ?? 'anchors.json')
else if (mode === '--compare') process.exit(compareMode(argv[1], argv[2]) ? 1 : 0)
else if (mode === '--stubs') process.exit(stubsMode() ? 1 : 0)
else if (mode === '--absence') process.exit(absenceMode() ? 1 : 0)
else {
  console.error('usage: site05-anchors.mjs --count | --capture FILE | --compare A B | --stubs | --absence')
  process.exit(2)
}
