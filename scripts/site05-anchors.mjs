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
import { execFileSync } from 'node:child_process'
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

/**
 * Every `sectionNav` entry's `number` equals the `number` of the section its
 * anchor points at, and its `label` equals that section's `title`.
 *
 * Spec SITE-05's review finding 3. The split renumbered Cost from `06` to `05`
 * on the section and left `bali.contents.s06-cost.number` at `06`, so the
 * section chip and the desktop rail rendered `05` while the contents grid
 * rendered `06`, on the live page, in the same commit as a `docs/HANDBOOK.md`
 * paragraph stating the intent. Nothing saw it: criterion 3 compares ids and
 * href counts, criterion 10 checks chips on the member page, and criterion 12's
 * round trip covers only the moved sections.
 *
 * This is the general form rather than a check for that one field, because the
 * grid and the sections are two renderings of one outline and any disagreement
 * between them is a reader seeing two different documents.
 */
function navAgreesWithSections(node) {
  const sections = new Map(
    node.blocks.filter((b) => b.type === 'handbookSection').map((s) => [s.anchor ?? s.id, s]),
  )
  const nav = node.blocks.find((b) => b.type === 'sectionNav')
  const problems = []
  if (!nav) return { problems, checked: 0 }
  for (const item of nav.items ?? []) {
    const section = sections.get(item.anchor)
    if (!section) {
      problems.push(`nav entry ${item.id} points at ${item.anchor}, which is no section on this page`)
      continue
    }
    if (item.number !== section.number) {
      problems.push(
        `nav entry ${item.anchor} says number ${item.number} and its section says ${section.number}`,
      )
    }
    if (item.label !== section.title) {
      problems.push(
        `nav entry ${item.anchor} is labelled ${item.label} and its section is titled ${section.title}`,
      )
    }
  }
  // A section with no nav entry is the other direction, and it is why the
  // mobile jump grid silently loses a row.
  const linked = new Set((nav.items ?? []).map((i) => i.anchor))
  for (const anchor of sections.keys()) {
    if (!linked.has(anchor)) problems.push(`section ${anchor} has no contents entry`)
  }
  return { problems, checked: (nav.items ?? []).length }
}

/**
 * The member half's words, counted through the SEED'S OWN PARSER.
 *
 * Once the split is applied those words are not in `site-content.json` at all,
 * so a `--count` that only reads the JSON can no longer compare itself to D2's
 * 1,891 (review note 12).
 *
 * It shells to `seed_member_pages.py` rather than re-parsing the markdown here,
 * and that is the point rather than a shortcut: a second parser would give a
 * second answer, which is exactly the four-plausible-methods problem this whole
 * file exists to remove. A first attempt at a line-by-line count in JavaScript
 * returned 2,084 against D2's 1,891, and every one of those 193 words was an
 * artifact of the approximation.
 *
 * The two blocks that are new by design are excluded by id, because D2 counted
 * what MOVED and the hero and the provenance block did not move.
 */
const NEW_BY_DESIGN = ['bali.member.hero', 'bali.member.provenance']

function memberDocWords() {
  const doc = process.env.SITE05_MEMBER_DOC ?? defaultMemberDoc()
  if (!existsSync(doc)) return -1
  const script = [
    'import json,sys',
    `sys.path.insert(0, ${JSON.stringify(path.join(REPO, 'scripts'))})`,
    'import seed_member_pages as s',
    `d = s.load_doc(__import__('pathlib').Path(${JSON.stringify(doc)}))`,
    `print(json.dumps([b for b in d.blocks if b['id'] not in ${JSON.stringify(NEW_BY_DESIGN)}]))`,
  ].join('\n')
  try {
    const out = execFileSync('python3', ['-c', script], { cwd: REPO }).toString()
    return words(JSON.parse(out))
  } catch (e) {
    console.log(`  note  could not read the member document: ${String(e.message).slice(0, 90)}`)
    return -1
  }
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
  const { problems, checked } = navAgreesWithSections(node)
  console.log('')
  console.log(`  contents grid vs sections: ${checked} entry(s) compared on number and label`)
  if (problems.length) {
    for (const p of problems) console.log(`  FAIL  ${p}`)
  } else {
    console.log('   ok   the contents grid and the sections agree')
  }
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
    // Review note 12: this branch used to print two numbers and no comparison,
    // so criterion 2 stopped being re-runnable the moment the split landed. The
    // member side is now read from the member DOCUMENT, which is where those
    // words actually live once the move is done.
    const memberWords = memberDocWords()
    const publicTotal = words(node.blocks)
    const stubWords = words([stubSection])
    console.log('  the split has been applied; the stub section is present')
    console.log(`  public words (this node): ${publicTotal}`)
    console.log(`  stub section words      : ${stubWords}`)
    console.log(`  public words, less the stub section: ${publicTotal - stubWords}   (D2 says 2,277)`)
    console.log('    the difference is the hero rewrite, which D2 counted in its 2,277 and which')
    console.log('    finding 17 required changing: the body no longer advertises "where the base is".')
    console.log(`  member words (from the vault document): ${memberWords}   (D2 says 1,891)`)
    console.log(`  public sections: ${node.blocks.filter((b) => b.type === 'handbookSection').length}`)
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
  // Review note 9: this used to return `[...new Set(idSet)]` and nothing else,
  // so a DUPLICATED DOM id was invisible in both directions — and a duplicate is
  // the failure mode, because a fragment then resolves to whichever element the
  // browser reaches first. Occurrence counts travel beside the set now.
  const idCounts = {}
  for (const id of idSet) idCounts[id] = (idCounts[id] ?? 0) + 1
  return {
    source: path.relative(REPO, htmlPath),
    ids: [...new Set(idSet)].sort(),
    idOccurrences: idSet.length,
    duplicateIds: Object.entries(idCounts).filter(([, n]) => n > 1).map(([id, n]) => `${id} x${n}`),
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

  // Review note 9: set equality is satisfied by a page that renders one id
  // twice, and a duplicated id is the failure mode, because the fragment then
  // resolves to whichever element the browser reaches first.
  for (const [label, snap] of [['before', before], ['after', after]]) {
    const dupes = snap.duplicateIds ?? []
    const occ = snap.idOccurrences ?? snap.ids.length
    console.log(
      `  ${dupes.length ? 'FAIL' : ' ok '}  ${label}: ${occ} id occurrence(s) over ${snap.ids.length} ` +
        `distinct id(s)${dupes.length ? `, DUPLICATED: ${dupes.join(', ')}` : ', none duplicated'}`,
    )
    if (dupes.length) failures++
    if (snap.duplicateIds === undefined) {
      console.log(`  note  ${label} was captured before this check existed; re-capture to cover it`)
    }
  }

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
  const all = content()
  const node = all.workshops.find((w) => w.id === WORKSHOP_ID)
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
  // Review note 9's other half: Sets on both sides hid a duplicate. A repeated
  // `anchor:` in the member document would render one id twice and the fragment
  // would resolve to whichever came first.
  const dupDoc = docAnchors.filter((a, i) => docAnchors.indexOf(a) !== i)
  const dupStub = moved.map((m) => m.id).filter((a, i, arr) => arr.indexOf(a) !== i)
  if (dupDoc.length || dupStub.length) {
    failures++
    console.log(`  FAIL  duplicate anchor(s): document ${dupDoc.join(', ') || 'none'}, ` +
      `stubs ${dupStub.join(', ') || 'none'}`)
  } else {
    console.log(`   ok   no anchor is repeated, in the document (${docAnchors.length}) or the stubs (${moved.length})`)
  }
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

  /*
   * Every stub's `to` RESOLVES to a real member route, and every stub's `note`
   * is the one the content store holds for that id.
   *
   * Review note 8: the first version tested `!m.note || !m.note.trim()` on the
   * same object the id had just come from, so its only possible failure was a
   * blank string. That is not the "node-resolution pass of its own" the rubric
   * section claimed in place of `check-labels.mjs`, which cannot see any of
   * this. Two independent resolutions now: the route against the `pages` array,
   * and the note against a re-read of the file, keyed by id.
   */
  const memberRoutes = new Set(
    (all.pages ?? []).filter((page) => page.access === 'member').map((page) => page.route),
  )
  const reread = JSON.parse(readFileSync(CONTENT, 'utf8'))
  const rereadStubs = new Map(
    (reread.workshops.find((x) => x.id === WORKSHOP_ID)?.movedAnchors ?? []).map((m) => [m.id, m]),
  )
  const unresolved = []
  for (const stub of moved) {
    if (!memberRoutes.has(stub.to)) {
      unresolved.push(`${stub.id}: \`to\` is ${stub.to}, which no member page declares`)
      continue
    }
    const held = rereadStubs.get(stub.id)
    if (!held) {
      unresolved.push(`${stub.id}: no node with this id in site-content.json`)
    } else if (held.note !== stub.note) {
      unresolved.push(`${stub.id}: the sentence does not match the node's`)
    } else if (!held.note.trim()) {
      unresolved.push(`${stub.id}: the node's sentence is blank`)
    }
  }
  if (unresolved.length) {
    failures++
    console.log(`  FAIL  ${unresolved.length} stub(s) do not resolve:`)
    for (const u of unresolved.slice(0, 5)) console.log(`          ${u}`)
  } else {
    console.log(`   ok   all ${moved.length} stubs resolve: route to a declared member page, ` +
      `sentence to a node in site-content.json`)
    console.log(`          member routes declared: ${[...memberRoutes].join(', ')}`)
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
  /*
   * Stratified across BOTH moved sections, which is review finding 1.
   *
   * The first version took `sample.slice(0, 12)`: the first twelve substantial
   * lines in document order, which measured out as the hero line plus eleven
   * lines of section 04. ZERO came from "Life on the base", so rooming, meals,
   * laundry, connectivity and free-time prose was never asserted absent from
   * anything at all. The criterion says "from both moved sections" in as many
   * words, and a head slice of a document whose sections are contiguous can
   * only ever cover the first one.
   */
  const sectionOf = []
  {
    let current = 'preamble'
    for (const raw of docText.split('\n')) {
      const line = raw.trim()
      if (/^id:\s+bali\.s4\s*$/.test(line)) current = 'bali.s4'
      else if (/^id:\s+bali\.s5\s*$/.test(line)) current = 'bali.s5'
      else if (/^id:\s+bali\.member\./.test(line)) current = 'new-by-design'
      if (line && !/^(#|\||>|---|[a-zA-Z][a-zA-Z0-9_]*:\s)/.test(line) &&
          line.length >= 60 && line.split(/\s+/).length >= 10) {
        sectionOf.push([current, line])
      }
    }
  }
  const perSection = { 'bali.s4': [], 'bali.s5': [] }
  for (const [where, line] of sectionOf) if (perSection[where]) perSection[where].push(line)
  const PER = 6
  const sample = [...perSection['bali.s4'].slice(0, PER), ...perSection['bali.s5'].slice(0, PER)]
  console.log(`  stratified: ${perSection['bali.s4'].length} line(s) available in bali.s4 and ` +
    `${perSection['bali.s5'].length} in bali.s5; ${PER} sampled from each`)
  if (!perSection['bali.s4'].length || !perSection['bali.s5'].length) {
    failures++
    console.log('  FAIL  one of the two moved sections contributed nothing to the sample')
  }
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
  /*
   * The POSITIVE CONTROL, and the review found it missing.
   *
   * An absence check over a population it cannot detect reports a clean sweep
   * either way. So before believing the zeros above, the same strings are run
   * against the PRE-SPLIT built page from git, where they were public: if the
   * matcher cannot find them there, it cannot have found them here.
   *
   * The pre-split `dist/` is gitignored and gone, so the comparison is against
   * the pre-split `site-content.json`, which is where the prose lived.
   */
  const presplit = presplitContent()
  if (presplit === null) {
    console.log('  note  no pre-split content in history; the positive control could not run')
  } else {
    const detectable = strings.filter((needle) => presplit.includes(needle))
    const ok = detectable.length >= strings.length - 1
    if (!ok) failures++
    console.log(`  ${ok ? ' ok ' : 'FAIL'}  positive control: ${detectable.length}/${strings.length} ` +
      `of the same strings ARE found in the pre-split content`)
    const missed = strings.filter((n) => !presplit.includes(n))
    for (const m of missed) {
      console.log(`          not in the pre-split content, expected for new prose: "${m.slice(0, 50)}…"`)
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

/**
 * `src/content/site-content.json` as it stood before the split, from git.
 *
 * Found rather than passed in: the newest commit touching `bali.s4` is the one
 * that removed it, so its parent still has it.
 */
function presplitContent() {
  try {
    const shas = execFileSync(
      'git',
      ['log', '--format=%H', '-S', '"id": "bali.s4"', '--', 'src/content/site-content.json'],
      { cwd: REPO },
    )
      .toString()
      .split('\n')
      .filter(Boolean)
    if (!shas.length) return null
    return execFileSync('git', ['show', `${shas[0]}^:src/content/site-content.json`], {
      cwd: REPO,
      maxBuffer: 32 * 1024 * 1024,
    }).toString()
  } catch {
    return null
  }
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
