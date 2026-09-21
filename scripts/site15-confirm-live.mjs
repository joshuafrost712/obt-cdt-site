/**
 * SITE-15 criterion 11: prove the DEPLOYED site actually serves the confirm
 * field, not merely that the build was green.
 *
 *   node scripts/site15-confirm-live.mjs
 *
 * Exits 0 when the served portal chunk carries the confirm node, 1 when it does
 * not, 2 when the chunk could not be resolved at all.
 *
 * ## Why this is not a grep of the entry chunk
 *
 * `shared.tsx` does not ship in the entry chunk. The portal code is in a
 * separate `shared-<hash>.js`, so a confirm-live grep pointed at `index-*.js`
 * reads 0 for a perfectly correct deploy. That is SITE-14's review finding, and
 * it is the delivery-contract protocol's own founding example: a confirm-live
 * command that cannot go green is worse than none, because it gets waived.
 *
 * ## Why no hash is typed anywhere
 *
 * Both hashes change on every content-touching build. The entry chunk changed
 * twice during SITE-15's own drafting and review, and `site09-recovery.mjs` still
 * carries a hardcoded `index-C6BLGjsx.js` that has since gone stale. So the entry
 * is resolved from the served `index.html`, and the portal chunk is resolved from
 * the entry's own import graph.
 *
 * ## Why it asserts nothing about /portal itself
 *
 * `curl` of `/portal` returns 404 by design: the SPA is served through
 * `404.html` on GitHub Pages. A lane asserting 200 on that page would be red on a
 * correct deploy, and a build session must not "fix" that 404.
 */
const LIVE = process.env.SITE15_LIVE ?? 'https://joshuafrost712.github.io/obt-cdt-site'

// The node id, not the English label: a copy edit to "Password again" must not
// turn the deploy proof red, and ids do reach the built chunk (measured: 20
// `portal.signin.*` ids in the live shared chunk).
const NEEDLE = 'portal.signin.confirm'

// Recorded in SITE-15's D0, measured on the live deployment of 4e241f1 before
// any edit. The assertion is that the count ROSE from this, so a lane that
// somehow read a pre-build artifact cannot pass.
const PRE_BUILD_COUNT = 0

const fail = (msg, code = 1) => {
  console.error(`FAIL  ${msg}`)
  process.exit(code)
}

const indexRes = await fetch(`${LIVE}/`)
if (!indexRes.ok) fail(`the served index returned http ${indexRes.status}`, 2)
const indexHtml = await indexRes.text()

const entry = /index-[A-Za-z0-9_-]+\.js/.exec(indexHtml)?.[0]
if (!entry) fail('could not resolve the entry chunk from the served index.html', 2)

const entryRes = await fetch(`${LIVE}/assets/${entry}`)
if (!entryRes.ok) fail(`the entry chunk returned http ${entryRes.status}`, 2)
const entryText = await entryRes.text()

const shared = /shared-[A-Za-z0-9_-]+\.js/.exec(entryText)?.[0]
if (!shared) fail(`could not resolve the portal chunk from ${entry}`, 2)

const sharedRes = await fetch(`${LIVE}/assets/${shared}`)
const sharedText = await sharedRes.text()

// Fixed-string count, never a regex: the needle contains dots.
const count = sharedText.split(NEEDLE).length - 1

console.log(`live      = ${LIVE}`)
console.log(`entry     = ${entry} (${entryText.length} bytes)`)
console.log(`portal    = ${shared} (${sharedText.length} bytes, http ${sharedRes.status})`)
console.log(`grep -c -F '${NEEDLE}' = ${count}   (pre-build: ${PRE_BUILD_COUNT})`)

if (sharedRes.status !== 200) fail(`the portal chunk returned http ${sharedRes.status}`)
if (count <= PRE_BUILD_COUNT) {
  fail(`the deploy has not carried the confirm field: count ${count} is not above the pre-build ${PRE_BUILD_COUNT}`)
}

console.log(`\nok    the served portal chunk carries ${NEEDLE}`)
process.exit(0)
