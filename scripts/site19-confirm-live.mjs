/**
 * SITE-19 criterion 20: prove the DEPLOYED site serves the quiz page, not merely
 * that the build was green.
 *
 *   node scripts/site19-confirm-live.mjs
 *
 * Exits 0 when the served QuizPage chunk carries `data-site19-quiz`, the entry
 * chunk registers `/portal/q/`, and no fetched chunk carries `is_correct`; 1 when
 * any of those fails; 2 when a chunk could not be resolved.
 *
 * No hash is typed here. The entry is resolved from the served `index.html` and
 * the QuizPage chunk from the entry's own import graph (SITE-15's lesson: a
 * hardcoded hash goes stale on the next content build).
 */
const LIVE = process.env.SITE19_LIVE ?? 'https://joshuafrost712.github.io/obt-cdt-site'

// Measured in SITE-19's D0 on 2026-10-15 against index-Blvac1xP.js, before any
// edit. The assertion is that the count ROSE from this.
const PRE_BUILD_ROUTE_COUNT = 0

const fail = (msg, code = 1) => {
  console.error(`FAIL  ${msg}`)
  process.exit(code)
}
const count = (text, needle) => text.split(needle).length - 1

const indexRes = await fetch(`${LIVE}/`)
if (!indexRes.ok) fail(`the served index returned http ${indexRes.status}`, 2)
const entry = /index-[A-Za-z0-9_-]+\.js/.exec(await indexRes.text())?.[0]
if (!entry) fail('could not resolve the entry chunk from the served index.html', 2)

const entryRes = await fetch(`${LIVE}/assets/${entry}`)
if (!entryRes.ok) fail(`the entry chunk returned http ${entryRes.status}`, 2)
const entryText = await entryRes.text()

const quizChunk = /QuizPage-[A-Za-z0-9_-]+\.js/.exec(entryText)?.[0]
if (!quizChunk) fail(`could not resolve a QuizPage- chunk from ${entry}`, 2)
const quizRes = await fetch(`${LIVE}/assets/${quizChunk}`)
const quizText = await quizRes.text()

// Every chunk the quiz chunk imports, so the is_correct check covers the API
// module wherever the bundler put it.
const imported = [...new Set(quizText.match(/[A-Za-z0-9_-]+-[A-Za-z0-9_-]{8}\.js/g) ?? [])]
const fetched = { [entry]: entryText, [quizChunk]: quizText }
for (const name of imported) {
  if (fetched[name]) continue
  const r = await fetch(`${LIVE}/assets/${name}`)
  if (r.ok) fetched[name] = await r.text()
}

const marker = count(quizText, 'data-site19-quiz')
const route = count(entryText, '/portal/q/')
const keyHits = Object.values(fetched).reduce((n, t) => n + count(t, 'is_correct'), 0)

console.log(`live      = ${LIVE}`)
console.log(`entry     = ${entry}`)
console.log(`quiz      = ${quizChunk} (http ${quizRes.status}, ${quizText.length} bytes)`)
console.log(`grep -c -F 'data-site19-quiz' ${quizChunk} = ${marker}`)
console.log(`grep -c -F '/portal/q/' ${entry} = ${route}   (pre-build: ${PRE_BUILD_ROUTE_COUNT})`)
console.log(`grep -c -F 'is_correct' over ${Object.keys(fetched).length} fetched chunk(s) = ${keyHits}`)

if (quizRes.status !== 200) fail(`the QuizPage chunk returned http ${quizRes.status}`)
if (marker < 1) fail('the served QuizPage chunk does not carry data-site19-quiz')
if (route <= PRE_BUILD_ROUTE_COUNT) fail(`/portal/q/ did not rise above ${PRE_BUILD_ROUTE_COUNT} in the entry chunk`)
if (keyHits !== 0) fail(`is_correct appears ${keyHits} time(s) in the served chunks`)

console.log('\nok    the deployed site serves the quiz page, and no served chunk names the answer key')
process.exit(0)
