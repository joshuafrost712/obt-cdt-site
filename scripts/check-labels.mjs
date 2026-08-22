/**
 * Fail the build when on-screen copy points at a content node that is not there.
 * Spec CDT-04 D7.
 *
 *   node scripts/check-labels.mjs            # in the build chain, after tsc
 *   node scripts/check-labels.mjs --quiet    # failures only
 *
 * ## Why a gate at all
 *
 * `siteLabel()` returns its call-site fallback when the node is missing
 * (`src/lib/content/loader.ts:52-55`). So a `portal.assess.*` id typed with one
 * character wrong renders correctly, forever, and Joshua's edit to that node
 * changes nothing on screen. The failure is silent by construction, which is
 * exactly the class that needs a build gate rather than a review.
 *
 * ## Why it parses, and why it does not try to trace dataflow
 *
 * A `grep "siteLabel('"` would have missed eight call sites when this spec was
 * drafted: five put the id on the FOLLOWING line, and three resolve through a
 * table (`SIGNIN_ERROR_NODE[kind]`, the four `portal.signin.error.*` refusal
 * strings, which is where wording matters most). CDT-04 then added a fourth
 * shape, `<L id="…" />`, and inside it two more: `id={cond ? 'a' : 'b'}` and
 * `id={STATE_NODE[s].id}`.
 *
 * The first version of this file tried to resolve each call site's id expression
 * back to a literal. It refused thirteen sites it could not trace, and every one
 * was legitimate: a loop variable over a local table (`s.node`, `o.node`), or a
 * prop passed down into a wrapper (`<Fact labelId="portal.…">` → `<L id={labelId}>`).
 * Real dataflow analysis would be both expensive and fragile, and a gate that is
 * fragile gets an exclusion added to it, which is how gates die.
 *
 * So the check is made TOTAL instead of clever, in two passes:
 *
 *   **Pass A, the substantive one.** Every string literal anywhere in `src/`
 *   whose first dotted segment is a content root (`site`, `portal`, a page id …)
 *   must resolve to a node. No tracing at all, so a literal inside a table, an
 *   options array, a conditional, a `labelId` prop or a multi-line call is
 *   checked by exactly the same rule. This is what catches a misspelling.
 *
 *   **Pass B, the anti-vacuity one.** Every id-carrying site is classified:
 *   literal, conditional of literals, enumerated table, or a prop pass-through
 *   whose own callers pass literals that Pass A checked. Anything else — a
 *   concatenated id, a template string, an id from a network value — FAILS.
 *   Pass B exists because Pass A can only see ids that are written down, and an
 *   id assembled at runtime is invisible to it.
 *
 * Neither pass skips anything, and the counts for both are printed so the output
 * can be reread to see what was covered rather than only what failed.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const REPO = path.resolve(import.meta.dirname, '..')
const SRC = path.join(REPO, 'src')
const CONTENT = path.join(REPO, 'src/content/site-content.json')
const quiet = process.argv.includes('--quiet')

/**
 * Which JSX attributes carry a CONTENT node id, as opposed to a DOM id or a node
 * object. Getting this wrong in either direction was the first draft's mistake:
 *
 *   * `<L id="portal.…">` — a content id, because that is L's whole contract.
 *   * `<Area id="cdt-ev-U03">` — a DOM id, for the label's htmlFor. Not ours.
 *   * `<Txt node={site}>` — a node OBJECT; Txt reads `.id` off it, and the id
 *     came from the content file rather than from source, so there is nothing
 *     here to check.
 *   * `labelId` / `helpId` on any component — always a content id.
 *
 * So `id` counts only on `<L>`, and the two explicit *Id props count anywhere.
 */
const ID_ATTR_ANY_TAG = new Set(['labelId', 'helpId'])
const ID_ATTR_BY_TAG = { L: new Set(['id']) }

// ------------------------------------------------------- every id in the content

function collectIds(node, into) {
  if (Array.isArray(node)) {
    for (const n of node) collectIds(n, into)
    return
  }
  if (node && typeof node === 'object') {
    if (typeof node.id === 'string') into.add(node.id)
    for (const v of Object.values(node)) collectIds(v, into)
  }
}

const content = JSON.parse(readFileSync(CONTENT, 'utf8'))
const knownIds = new Set()
collectIds([content.site, ...content.pages, ...content.workshops], knownIds)

// The first dotted segment of every known id. A literal whose first segment is in
// this set is claiming to be a content id, and is held to it.
const ROOTS = new Set([...knownIds].map((id) => id.split('.')[0]).filter((r) => r))

const LOOKS_LIKE_ID = (s) => s.includes('.') && ROOTS.has(s.split('.')[0]) && !/[\s/\\]/.test(s)

// --------------------------------------------------------------- source files

function walkDir(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = path.join(dir, entry)
    if (statSync(p).isDirectory()) walkDir(p, out)
    else if (/\.tsx?$/.test(entry)) out.push(p)
  }
  return out
}

const files = walkDir(SRC).sort()
const sources = new Map(
  files.map((f) => [
    f,
    ts.createSourceFile(f, readFileSync(f, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX),
  ]),
)

// ------------------------------------------------- PASS A: every id-shaped literal

const literalSites = []

for (const [file, sf] of sources) {
  const rel = path.relative(REPO, file)
  const visit = (node) => {
    if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      LOOKS_LIKE_ID(node.text)
    ) {
      // Import specifiers and JSX class names never look like ids under the ROOTS
      // rule, but an import path could in principle, so exclude them by parent.
      const parent = node.parent
      const isImport =
        parent && (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent) || ts.isCallExpression(parent) && parent.expression.kind === ts.SyntaxKind.ImportKeyword)
      if (!isImport) {
        literalSites.push({
          file: rel,
          line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
          id: node.text,
        })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
}

// ------------------------------------------------- PASS B: every id-carrying site

/** Parameter names of the function enclosing a node, for pass-through detection. */
function enclosingParams(node, sf) {
  const names = new Set()
  let n = node
  while (n) {
    if (
      ts.isFunctionDeclaration(n) ||
      ts.isFunctionExpression(n) ||
      ts.isArrowFunction(n) ||
      ts.isMethodDeclaration(n)
    ) {
      for (const p of n.parameters) {
        if (ts.isIdentifier(p.name)) names.add(p.name.text)
        else if (ts.isObjectBindingPattern(p.name)) {
          for (const el of p.name.elements) {
            if (ts.isIdentifier(el.name)) names.add(el.name.text)
          }
        }
      }
    }
    n = n.parent
  }
  return names
}

/**
 * Object-literal-ish declarations by identifier name, for table enumeration, and
 * every local `const x = <expr>` initializer, so one hop of indirection resolves:
 * `const state = STATE_NODE[a.state]` followed by `<L id={state.id}>`.
 *
 * One hop rather than a fixed point, deliberately. Two hops is the beginning of
 * dataflow analysis, and the whole reason pass A exists is so that pass B does
 * not have to do any.
 */
const tables = new Map()
const localConsts = new Map()
for (const [, sf] of sources) {
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const strings = []
      const grab = (n) => {
        if (ts.isStringLiteral(n)) strings.push(n.text)
        ts.forEachChild(n, grab)
      }
      grab(node.initializer)
      const ids = strings.filter(LOOKS_LIKE_ID)
      if (ids.length) tables.set(node.name.text, ids)
      localConsts.set(node.name.text, { expr: node.initializer, sf })
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
}

function classify(expr, sf, params, depth = 0) {
  if (ts.isJsxExpression(expr)) {
    return expr.expression ? classify(expr.expression, sf, params, depth) : { fail: 'empty JSX expression' }
  }
  if (ts.isParenthesizedExpression(expr)) return classify(expr.expression, sf, params)
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
    return { how: 'literal' }
  }
  if (ts.isConditionalExpression(expr)) {
    const a = classify(expr.whenTrue, sf, params, depth)
    if (a.fail) return a
    const b = classify(expr.whenFalse, sf, params, depth)
    if (b.fail) return b
    return { how: 'conditional' }
  }
  // A bare parameter, or a member access rooted at one: the value arrives from a
  // caller, and every caller's own attribute is checked by this same pass, while
  // the literals themselves are checked by pass A.
  let root = expr
  while (
    ts.isElementAccessExpression(root) ||
    ts.isPropertyAccessExpression(root) ||
    ts.isNonNullExpression(root)
  ) {
    root = root.expression
  }
  if (ts.isIdentifier(root)) {
    if (tables.has(root.text)) return { how: `table ${root.text}` }
    if (params.has(root.text)) return { how: 'pass-through' }
    const local = localConsts.get(root.text)
    if (local && depth < 1) {
      const via = classify(local.expr, local.sf, params, depth + 1)
      if (!via.fail) return { how: `via ${root.text} → ${via.how}` }
    }
    return { fail: `${root.text} is neither a table with ids, a parameter, nor a local const resolving to one` }
  }
  // A template literal or a concatenation: an id assembled at runtime cannot be
  // checked by any pass, so it is refused rather than waved through.
  return { fail: `id is computed, not written down: ${expr.getText(sf).slice(0, 60)}` }
}

const idSites = []

for (const [file, sf] of sources) {
  const rel = path.relative(REPO, file)
  const visit = (node) => {
    const line = () => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1

    if (
      ts.isCallExpression(node) &&
      ((ts.isIdentifier(node.expression) && node.expression.text === 'siteLabel') ||
        (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'siteLabel'))
    ) {
      const arg = node.arguments[0]
      idSites.push({
        file: rel,
        line: line(),
        kind: 'siteLabel()',
        ...(arg
          ? classify(arg, sf, enclosingParams(node, sf))
          : { fail: 'siteLabel called with no id' }),
      })
    }

    if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
      const tag = node.tagName.getText(sf)
      for (const p of node.attributes.properties) {
        if (!ts.isJsxAttribute(p)) continue
        const name = p.name.getText(sf)
        const isContentId =
          ID_ATTR_ANY_TAG.has(name) || (ID_ATTR_BY_TAG[tag]?.has(name) ?? false)
        if (!isContentId) continue
        if (!p.initializer) {
          idSites.push({ file: rel, line: line(), kind: `<${tag} ${name}>`, fail: 'no value' })
          continue
        }
        idSites.push({
          file: rel,
          line: line(),
          kind: `<${tag} ${name}>`,
          ...classify(p.initializer, sf, enclosingParams(node, sf)),
        })
      }
    }

    ts.forEachChild(node, visit)
  }
  visit(sf)
}

// -------------------------------------------------------------------- report

const missing = literalSites.filter((s) => !knownIds.has(s.id))
const unresolvable = idSites.filter((s) => s.fail)
const byHow = {}
for (const s of idSites) if (!s.fail) byHow[s.how] = (byHow[s.how] ?? 0) + 1
const distinct = new Set(literalSites.map((s) => s.id))

if (!quiet) {
  console.log(`check-labels: ${files.length} source files, ${knownIds.size} nodes in site-content.json`)
  console.log(`  pass A  ${literalSites.length} id-shaped literals, ${distinct.size} distinct, roots [${[...ROOTS].sort().join(', ')}]`)
  console.log(`  pass B  ${idSites.length} id-carrying sites`)
  console.log(`          ${Object.entries(byHow).sort().map(([k, v]) => `${k}=${v}`).join('  ')}`)
  console.log(`  skipped 0 in both passes: an id this gate cannot account for is a failure, never a skip`)
}

for (const s of unresolvable) console.error(`FAIL ${s.file}:${s.line}  ${s.kind}: ${s.fail}`)
for (const m of missing) console.error(`FAIL ${m.file}:${m.line}  id "${m.id}" is not a node in site-content.json`)

if (unresolvable.length || missing.length) {
  console.error(
    `\ncheck-labels FAILED: ${missing.length} missing node(s), ${unresolvable.length} unaccountable id(s).\n` +
      'Add the node to src/content/site-content.json, or fix the id. Do not add an exclusion.',
  )
  process.exit(1)
}

if (!quiet) console.log('check-labels: every id resolves to a node.')
