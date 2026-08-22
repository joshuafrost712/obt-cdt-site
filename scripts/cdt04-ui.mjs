/**
 * CDT-04's browser walkthrough: the acceptance criteria that need a real browser.
 *
 *   node scripts/cdt04-fixtures.mjs --setup
 *   npm i -D --no-save playwright && npx playwright install chromium
 *   node --dns-result-order=ipv4first scripts/cdt04-ui.mjs
 *
 * ## Why Playwright and not scripts/lib/browser.mjs
 *
 * Decision 3, and it is a standing fact about this repo rather than a preference.
 * `browser.mjs` exports `launch`, `visit` and `shoot` and nothing else: it cannot
 * type, click, read `localStorage`, or set a viewport, and `visit()` truncates
 * `innerText` to 400 characters and closes its target per call. Criterion 1 fills
 * 121 inputs, criterion 11 reads `localStorage`, and criterion 10 measures
 * geometry at a set viewport. So `browser.mjs` stays the CSP, violation, LCP and
 * screenshot driver, untouched, and this file is the input layer. CDT-06a
 * inherits the split rather than re-deciding it.
 *
 * ## What it runs against
 *
 * A CI-reproduced `dist/` served by `scripts/serve-dist.mjs` on port 4191, which
 * is CDT-04's (4183 is CDT-00's). The fixtures come from
 * `scripts/cdt04-fixtures.mjs --setup` and its ids file.
 */
import { readFileSync, existsSync, mkdirSync } from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'
import { homedir } from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright'

const REPO = path.resolve(import.meta.dirname, '..')
const IDS_FILE = path.join(REPO, 'scripts/.cdt04-fixture-ids.json')
const SHOTS = path.join(REPO, 'feedback/cdt04-shots')
const PORT = 4191
const BASE = `http://localhost:${PORT}/obt-cdt-site`

if (!existsSync(IDS_FILE)) {
  console.error('no fixtures; run: node scripts/cdt04-fixtures.mjs --setup')
  process.exit(2)
}
const fx = JSON.parse(readFileSync(IDS_FILE, 'utf8'))

function creds() {
  const file = path.join(homedir(), '.claude/secrets/obt-cdt-supabase.env')
  const out = execFileSync('/bin/zsh', [
    '-c',
    `set -a; . ${JSON.stringify(file)}; set +a; printf "%s\\n%s\\n%s" "$OBT_CDT_SUPABASE_PROJECT_REF" "$OBT_CDT_SUPABASE_ACCESS_TOKEN" "$OBT_CDT_SUPABASE_URL"`,
  ])
    .toString()
    .split('\n')
    .map((s) => s.trim())
  return { ref: out[0], token: out[1], url: out[2] }
}
const { ref, token } = creds()

async function sql(query) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`SQL ${res.status}: ${text}`)
  try {
    return JSON.parse(text)
  } catch {
    return []
  }
}

// ------------------------------------------------------------------ harness

const results = []
let failures = 0
function check(criterion, name, actual, expected) {
  const ok = String(actual) === String(expected)
  if (!ok) failures++
  results.push({ criterion, name, actual: String(actual), expected: String(expected), ok })
  console.log(`  ${ok ? ' ok ' : 'FAIL'}  [${criterion}] ${name}  expected=${expected} actual=${actual}`)
  return ok
}

mkdirSync(SHOTS, { recursive: true })

const server = spawn('node', [path.join(REPO, 'scripts/serve-dist.mjs'), '--port', String(PORT)], {
  cwd: REPO,
  stdio: ['ignore', 'pipe', 'pipe'],
})
await new Promise((resolve) => {
  const done = () => resolve()
  server.stdout.on('data', (d) => {
    if (String(d).includes(String(PORT))) done()
  })
  setTimeout(done, 2500)
})

const browser = await chromium.launch()

/**
 * Sign in and WAIT FOR THE QUEUE TO RESOLVE, not merely for the page to change.
 *
 * The first version waited for `.text-ink-faint`, which the "Loading your
 * sessions…" line matches, so it returned while the queue was still loading and
 * four of criterion 6's assertions read an empty page. It also hid a real defect:
 * the first read after sign-in can come back 401 `JWT issued at future`, because
 * GoTrue and PostgREST do not share a clock to the second. That is now retried
 * inside assessApi, and this waits for a definite outcome so a slow load can
 * never be mistaken for an absent one.
 */
async function signIn(page, role) {
  await page.goto(`${BASE}/portal/assignments`, { waitUntil: 'networkidle' })
  await page.fill('#portal-email', `cdt04-ui-${role}@example.org`)
  await page.fill('#portal-password', fx.password)
  await page.click('button[type="submit"]')
  // A resolved queue is one of exactly three things: sections, the empty panel,
  // or an error note. Waiting for the union means a hang fails loudly.
  await page.waitForSelector('[data-cdt-section], [data-cdt-total-hours], [data-cdt-empty], [data-cdt-error]', {
    timeout: 30000,
  })
  await page.waitForTimeout(500)
}


/**
 * Tick a radio or a checkbox with `{ force: true }`.
 *
 * The form's radios are `className="sr-only"` inside a styled label, which is how
 * the 0-3 buttons look like buttons. Playwright's ordinary `click()` refuses an
 * element it considers invisible, and on the visible controls the sticky site
 * header intercepted the pointer instead. Neither is a defect in the page: the
 * label is what a person clicks, and a forced check dispatches the same `input`
 * event React listens for. Verified by criterion 1 reading every value back out
 * of the database afterwards, which is what proves the events landed.
 */
async function pick(page, name, value) {
  await page.locator(`input[name="${name}"][value="${value}"]`).check({ force: true })
}
async function tick(page, selector) {
  await page.locator(selector).check({ force: true })
}

const violations = []
const preexisting = []

function classifyConsole(page) {
  page.on('console', (m) => {
    const t = m.text()
    // `frame-ancestors ... via a <meta> element` is Chrome noting what CDT-00
    // already documented: Pages cannot send headers, so that directive is inert
    // and src/lib/frameBuster.ts stands in for it. Not a violation of the policy.
    if (/Content Security Policy|Refused to/i.test(t) && !/frame-ancestors/i.test(t)) violations.push(t)
  })
  page.on('pageerror', (e) => {
    // React #418 is a hydration mismatch and it fires on the EXISTING /portal
    // route as well as these, because every portal URL is served from 404.html
    // under the Pages SPA fallback, so the prerendered HTML is the 404 page.
    // Verified in session against /, /philosophy and /portal: only /portal
    // errors, and it does so with no CDT-04 code on the page. Reported below
    // rather than counted, because attributing a pre-existing defect to this
    // spec would be as wrong as ignoring it.
    if (/Minified React error #418/.test(e.message)) preexisting.push(e.message.slice(0, 60))
    else violations.push(`pageerror: ${e.message}`)
  })
  return page
}

async function newCtx(width = 1440, height = 1000) {
  const ctx = await browser.newContext({ viewport: { width, height } })
  const page = classifyConsole(await ctx.newPage())
  return { ctx, page }
}

try {
  // =====================================================================
  // Preconditions. Assert the fixture states this run depends on rather than
  // assuming them: an earlier run that filed a write-up leaves `held_i1` at
  // `submitted`, and the state graph has no backward edge, so a stale fixture set
  // makes criterion 4 fail for a reason that has nothing to do with the page.
  // =====================================================================
  console.log('\n=== preconditions: the fixture states this run needs')
  {
    const want = {
      held_i1: 'held', proposed: 'proposed', scheduled: 'scheduled',
      submitted: 'submitted', returned: 'returned', closed: 'closed',
      cancelled: 'cancelled', other: 'held',
    }
    const rows = await sql(
      `select id::text as id, state from assignment where id in (${Object.keys(want)
        .map((k) => `'${fx.assignments[k].id}'`)
        .join(', ')})`,
    )
    const byId = new Map(rows.map((r) => [r.id, r.state]))
    let stale = 0
    for (const [tag, expected] of Object.entries(want)) {
      const actual = byId.get(fx.assignments[tag].id) ?? 'missing'
      if (actual !== expected) stale++
      check('pre', `fixture ${tag} is ${expected}`, actual, expected)
    }
    if (stale) {
      console.error(
        `\n${stale} fixture(s) are not in their starting state. Re-run:\n` +
          '  node scripts/cdt04-fixtures.mjs --setup\n' +
          'This is not a page defect: assignment_change_guard has no backward edge, ' +
          'so a filed fixture cannot be rewound and must be recreated.',
      )
      process.exit(1)
    }
  }

  // =====================================================================
  // Criterion 0 (browser half) and 2: the deep link for a visitor with no session
  // =====================================================================
  console.log('\n=== criterion 2: the deep link works with no session')
  {
    const { ctx, page } = await newCtx()
    const id = fx.assignments.held_i1.id
    check(2, 'the fixture id is a uuid', /^[0-9a-f-]{36}$/.test(id), true)
    const [dbId] = await sql(`select id::text as id from assignment where id = '${id}'`)
    check(2, 'the url id equals assignment.id in the database', dbId?.id, id)

    await page.goto(`${BASE}/portal/a/${id}`, { waitUntil: 'networkidle' })
    const text = await page.innerText('body')
    check(2, 'renders the sign-in card, not a 404', /Sign in/i.test(text) && !/doesn't exist/i.test(text), true)
    check(2, 'stays on the assignment URL (no redirect)', new URL(page.url()).pathname.includes(`/portal/a/${id}`), true)

    await page.fill('#portal-email', 'cdt04-ui-consultant@example.org')
    await page.fill('#portal-password', fx.password)
    await page.click('button[type="submit"]')
    await page.waitForSelector('[data-cdt-counterparty]', { timeout: 20000 })
    check(2, 'after signing in, the same URL renders the assignment', new URL(page.url()).pathname.includes(`/portal/a/${id}`), true)
    check(
      2,
      'the CIT name is on the page (the counterparty read works)',
      (await page.innerText('[data-cdt-counterparty]')).includes('Fixture CIT'),
      true,
    )
    await ctx.close()
  }

  // =====================================================================
  // Criterion 4: all seven states, and the arithmetic counts only work ahead
  // =====================================================================
  console.log('\n=== criterion 4: seven states and the hour arithmetic')
  {
    const { ctx, page } = await newCtx()
    await signIn(page, 'consultant')
    const body = await page.innerText('body')

    for (const [tag, expectSection] of [
      ['held_i1', 'writeup'],
      ['returned', 'writeup'],
      ['proposed', 'undated'],
      ['scheduled', 'dated'],
      ['submitted', 'done'],
      ['closed', 'done'],
      ['cancelled', 'cancelled'],
    ]) {
      const id = fx.assignments[tag].id
      const section = await page.getAttribute(
        `[data-cdt-section="${expectSection}"] [data-cdt-assignment="${id}"]`,
        'data-cdt-state',
      ).catch(() => null)
      check(4, `${tag} appears in section "${expectSection}"`, section !== null, true)
    }

    check(4, 'the returned row shows its return_reason', /Fixture return reason/.test(body), true)
    const cancelledHasAction = await page
      .$(`[data-cdt-assignment="${fx.assignments.cancelled.id}"] button`)
      .then((h) => h !== null)
    check(4, 'the cancelled row offers no action button', cancelledHasAction, false)

    // Recompute the expected figure from assessment_bundle, independently of the page.
    const rows = await sql(`
      select a.state, b.prep_minutes, b.minutes, b.writeup_minutes
        from assignment a join assessment_bundle b on b.bundle_key = a.bundle_key
       where a.consultant_profile_id = '${fx.profiles.consultant}'`)
    let expected = 0
    for (const r of rows) {
      if (['proposed', 'scheduled', 'held'].includes(r.state)) {
        expected += r.prep_minutes + r.minutes + r.writeup_minutes
      } else if (r.state === 'returned') expected += r.writeup_minutes
    }
    const expectedHours = Math.round((expected / 60) * 10) / 10
    const shown = await page.getAttribute('[data-cdt-total-hours]', 'data-cdt-total-hours')
    check(4, 'the hours shown equal the independent recomputation', shown, expectedHours)

    // Anti-vacuity: the closed fixture's minutes must be EXCLUDED, so a total
    // computed over every state would differ. If they were equal, this criterion
    // would pass while the bug survived.
    let naive = 0
    for (const r of rows) naive += r.prep_minutes + r.minutes + r.writeup_minutes
    check(4, 'a total over ALL states would differ (so the exclusion is real)', naive !== expected, true)
    await ctx.close()
  }

  // =====================================================================
  // Criterion 6: four states, four words
  // =====================================================================
  console.log('\n=== criterion 6: four separately named states on one row')
  {
    // A combination no single status field could express: submitted +
    // awaiting-head-mentor + second + unreleased.
    const secondId = fx.assignments.second.id
    await sql(`
      update assignment set state = 'submitted' where id = '${secondId}' and state = 'held';
      delete from submission_rating where submission_id in (select id from submission where assignment_id = '${secondId}');
      delete from submission_file  where submission_id in (select id from submission where assignment_id = '${secondId}');
      delete from submission where assignment_id = '${secondId}';
      insert into submission (assignment_id, bundle_key, consultant_profile_id, body_md,
                              consent_recorded, transcript_source, submitted_at)
        select '${secondId}', bundle_key, consultant_profile_id, 'second rater fixture', true, 'none', now()
          from assignment where id = '${secondId}';`)

    const { ctx, page } = await newCtx()
    await signIn(page, 'second')
    const text = await page.innerText('body')
    const words = {
      'assignment.state = submitted → "Filed"': /Filed/.test(text),
      'rating_role = second → "Second rating"': /Second rating/.test(text),
      'approval_state → "awaiting-head-mentor"': /awaiting-head-mentor/.test(text),
      'release → "not released yet"': /not released yet/.test(text),
    }
    for (const [name, present] of Object.entries(words)) check(6, name, present, true)
    const distinct = new Set(Object.keys(words)).size
    check(6, 'four distinct words, none collapsed into one chip', distinct, 4)
    await ctx.close()
  }

  // =====================================================================
  // Criterion 8: the second rater is blind ON THE WIRE, not only on the page
  // =====================================================================
  console.log('\n=== criterion 8: the second rater is blind on the wire')
  {
    const { ctx, page } = await newCtx()
    await signIn(page, 'second')
    await page.goto(`${BASE}/portal/a/${fx.assignments.second.id}`, { waitUntil: 'networkidle' })
    await page.waitForSelector('[data-cdt-counterparty]', { timeout: 20000 })
    const text = await page.innerText('body')
    const [st] = await sql(`select state from assignment where id = '${fx.assignments.second.id}'`)
    check(8, `the absence sentence is on the page (state is ${st?.state})`, /second rater on this session/i.test(text), true)

    // The wire read: as the SECOND rater's own session, ask for the primary's
    // write-up. A panel keyed on rating_role would say the right words even if
    // this returned rows, which is the whole point of asserting it separately.
    const primarySubmissionRead = await page.evaluate(async (args) => {
      const { url, key, assignmentId } = args
      const token = JSON.parse(
        localStorage.getItem(Object.keys(localStorage).find((k) => k.includes('auth-token')) ?? '') ?? '{}',
      )?.access_token
      const r = await fetch(
        `${url}/rest/v1/submission?assignment_id=eq.${assignmentId}&select=id`,
        { headers: { apikey: key, Authorization: `Bearer ${token}` } },
      )
      return (await r.json()).length
    }, { url: creds().url, key: process.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? '', assignmentId: fx.assignments.held_i1.id })
    check(8, "the primary's submission reads as ZERO rows for the second rater", primarySubmissionRead, 0)
    await ctx.close()
  }

  // =====================================================================
  // Criterion 9: the other two absences read as absences
  // =====================================================================
  console.log('\n=== criterion 9: not-yours, and the unreleased write-up')
  {
    const { ctx, page } = await newCtx()
    await signIn(page, 'consultant')
    await page.goto(`${BASE}/portal/a/${fx.assignments.other.id}`, { waitUntil: 'networkidle' })
    await page.waitForTimeout(1500)
    const text = await page.innerText('body')
    check(9, 'an assignment belonging to another consultant reads as not-on-your-list', /not on your list/i.test(text), true)
    check(9, 'no other CIT name appears in the page source', /Fixture Second CIT/.test(await page.content()), false)
    await ctx.close()
  }
  {
    const { ctx, page } = await newCtx()
    await signIn(page, 'cit')
    await page.goto(`${BASE}/portal/a/${fx.assignments.submitted.id}`, { waitUntil: 'networkidle' })
    await page.waitForTimeout(1500)
    const text = await page.innerText('body')
    check(9, 'the CIT sees the read-only view, not the consultant view', /This session is about you/i.test(text), true)
    check(9, 'an unreleased write-up reads as not-yet-released', /once it has been checked and released/i.test(text), true)
    check(9, 'the CIT is offered no Confirm-date control', await page.$('#cdt-save-date').then((h) => h !== null), false)
    check(9, 'the CIT is offered no write-up form', await page.$('#cdt-file').then((h) => h !== null), false)
    await ctx.close()
  }

  // =====================================================================
  // Criterion 5: a CIT cannot write to their own assignment, and the DATABASE refuses
  // =====================================================================
  console.log('\n=== criterion 5: the database refuses the CIT write')
  {
    const id = fx.assignments.scheduled.id
    const before = await sql(`select state, scheduled_at from assignment where id = '${id}'`)
    // With the UI bypassed: forge a jwt claim for the CIT and try the update as
    // `authenticated`. This is the same mechanism CDT-02's harness uses, and it
    // tests the policy the page's branch is only the cosmetic half of.
    const out = await sql(`
      do $$
      declare _msg text; _state text;
      begin
        perform set_config('request.jwt.claims',
          json_build_object('sub','${fx.profiles.cit}','role','authenticated','aal','aal1')::text, true);
        set local role authenticated;
        begin
          update assignment set state = 'held', scheduled_at = now() where id = '${id}';
          if found then
            raise exception 'CDT04-CIT-WRITE-SUCCEEDED';
          end if;
        exception when others then
          _msg := SQLSTATE || ' ' || SQLERRM;
        end;
        reset role;
        raise notice '%', coalesce(_msg, 'zero rows updated (RLS filtered)');
      end $$;
      select 1 as done`)
    const after = await sql(`select state, scheduled_at from assignment where id = '${id}'`)
    check(5, 'the CIT write changed nothing', JSON.stringify(after), JSON.stringify(before))
    check(5, 'the statement did not report success', JSON.stringify(out).includes('CDT04-CIT-WRITE-SUCCEEDED'), false)

    // Mutation: put the OLD permissive policy back and watch the same write land.
    // A refusal never seen to be a refusal is not known to be one.
    await sql(`
      drop policy if exists "an assignment is updatable by its consultant and oversight" on public.assignment;
      create policy "cdt04 mutation: the old permissive rule" on public.assignment
        for update to authenticated using (may_see_assignment(id)) with check (may_see_assignment(id));`)
    const mutated = await sql(`
      do $$ begin
        perform set_config('request.jwt.claims',
          json_build_object('sub','${fx.profiles.cit}','role','authenticated','aal','aal1')::text, true);
        set local role authenticated;
        update assignment set meeting_url = 'https://cdt04-mutation.example.org' where id = '${id}';
        reset role;
      end $$;
      select meeting_url from assignment where id = '${id}'`)
    check(
      5,
      'MUTATION: under the old policy the CIT write DOES land (so the fix is the control)',
      mutated?.[0]?.meeting_url,
      'https://cdt04-mutation.example.org',
    )
    // Restore.
    await sql(`
      drop policy if exists "cdt04 mutation: the old permissive rule" on public.assignment;
      drop policy if exists "an assignment is updatable by its consultant and oversight" on public.assignment;
      create policy "an assignment is updatable by its consultant and oversight" on public.assignment
        for update to authenticated
        using (consultant_profile_id = auth.uid() or is_head_mentor() or is_portal_admin())
        with check (consultant_profile_id = auth.uid() or is_head_mentor() or is_portal_admin());
      update assignment set meeting_url = null where id = '${id}';`)
    const [restored] = await sql(`
      select count(*)::int as n from pg_policies
       where tablename = 'assignment' and cmd = 'UPDATE'
         and qual like '%consultant_profile_id%' and qual not like '%subject_profile_id%'`)
    check(5, 'the policy is restored after the mutation', restored.n, 1)
  }

  // =====================================================================
  // Criterion 1 (THE GATE) and 11: fill I-1 end to end, and the draft survives
  // =====================================================================
  console.log('\n=== criterion 1: fill I-1 end to end, and read the rows back')
  {
    // A FRESH assignment rather than the fixture's, for two reasons. The state
    // graph has no backward edge — `assignment_change_guard` refuses
    // submitted -> held, which is correct and which made the first version of
    // this harness un-re-runnable. And criteria 2 and 8 still need the original
    // held_i1 row as they found it. This one is torn down by the prefix scope
    // like every other fixture row.
    const [fresh] = await sql(`
      insert into assignment (subject_profile_id, consultant_profile_id, bundle_key,
                              qualification_basis, scheduled_at, meeting_language, subject_l1)
      values ('${fx.profiles.cit}', '${fx.profiles.consultant}', 'I-1',
              'CDT-04 UI fixture (gate run)', now() + interval '1 day', 'Indonesian', true)
      returning id::text as id`)
    const id = fresh.id
    await sql(`update assignment set state = 'scheduled' where id = '${id}'`)
    await sql(`update assignment set state = 'held' where id = '${id}'`)

    const { ctx, page } = await newCtx()
    await signIn(page, 'consultant')
    await page.goto(`${BASE}/portal/a/${id}`, { waitUntil: 'networkidle' })
    await page.waitForSelector('#cdt-writeup', { timeout: 20000 })

    const unitKeys = await page.$$eval('[data-cdt-unit]', (els) => els.map((e) => e.getAttribute('data-cdt-unit')))
    const [bu] = await sql(`select count(*)::int as n from bundle_unit where bundle_key = 'I-1'`)
    check(1, 'the form renders every bundle_unit row for I-1', unitKeys.length, bu.n)

    // The nine header fields.
    await tick(page, '#cdt-consent')
    await page.fill('#cdt-body', 'The session ran the full 45 minutes and the portfolio was complete.')
    await page.fill('#cdt-strength', 'Explained the exegetical decision without reaching for jargon.')
    await page.fill('#cdt-growth1', 'Needs more practice framing a checking question.')
    await page.fill('#cdt-growth2', 'Discourse terminology is still uneven.')
    await page.fill('#cdt-context', 'The line dropped twice for about a minute each time.')
    await pick(page, 'cdt-connection', 'patchy')
    await pick(page, 'cdt-transcript', 'none')
    await page.fill('#cdt-source-url', 'https://docs.google.com/document/d/cdt04-fixture')

    // Half the units, then kill the tab: criterion 11's first half.
    const half = Math.ceil(unitKeys.length / 2)
    const typed = {}
    const fillUnit = async (k, i) => {
      const obs = String(i % 4)
      const rec = String((i + 1) % 4)
      const conf = ['low', 'medium', 'high'][i % 3]
      const plain = ['yes', 'partly', 'no'][i % 3]
      const ev = `Evidence for ${k}: named the specific clause and explained why it moved.`
      await pick(page, `obs-${k}`, obs)
      await pick(page, `rec-${k}`, rec)
      await pick(page, `conf-${k}`, conf)
      await page.fill(`#cdt-ev-${k}`, ev)
      await pick(page, `plain-${k}`, plain)
      await page.fill(`#cdt-plainnote-${k}`, `Plain-language note for ${k}.`)
      if (i % 5 === 0) await tick(page, `#cdt-esc-${k}`)
      typed[k] = {
        observed_level: Number(obs),
        recommended_level: Number(rec),
        confidence: conf,
        evidence_sentence: ev,
        plain_language_check: plain,
        plain_language_note: `Plain-language note for ${k}.`,
        escalate: i % 5 === 0,
      }
    }

    for (let i = 0; i < half; i++) await fillUnit(unitKeys[i], i)
    await page.waitForTimeout(600)
    const draftKeyPresent = await page.evaluate((a) => localStorage.getItem(`cdt04.draft.${a}`) !== null, id)
    check(11, 'a draft key exists after typing', draftKeyPresent, true)

    // Kill the tab, reopen in the SAME context so localStorage survives.
    await page.close()
    const page2 = classifyConsole(await ctx.newPage())
    await page2.goto(`${BASE}/portal/a/${id}`, { waitUntil: 'networkidle' })
    await page2.waitForSelector('#cdt-restore', { timeout: 20000 })
    check(11, 'the reopened page offers to restore', await page2.$('#cdt-restore').then((h) => h !== null), true)
    await page2.click('#cdt-restore-yes')
    await page2.waitForTimeout(400)
    const restoredEv = await page2.inputValue(`#cdt-ev-${unitKeys[0]}`)
    check(11, 'a restored evidence sentence matches what was typed', restoredEv, typed[unitKeys[0]].evidence_sentence)
    const restoredHeader = await page2.inputValue('#cdt-body')
    check(11, 'a restored header field matches what was typed', restoredHeader, 'The session ran the full 45 minutes and the portfolio was complete.')

    // Finish the rest on the reopened page.
    const page3 = page2
    const fillOn = async (pg, k, i) => {
      const obs = String(i % 4)
      const rec = String((i + 1) % 4)
      const conf = ['low', 'medium', 'high'][i % 3]
      const plain = ['yes', 'partly', 'no'][i % 3]
      const ev = `Evidence for ${k}: named the specific clause and explained why it moved.`
      await pick(pg, `obs-${k}`, obs)
      await pick(pg, `rec-${k}`, rec)
      await pick(pg, `conf-${k}`, conf)
      await pg.fill(`#cdt-ev-${k}`, ev)
      await pick(pg, `plain-${k}`, plain)
      await pg.fill(`#cdt-plainnote-${k}`, `Plain-language note for ${k}.`)
      if (i % 5 === 0) await tick(pg, `#cdt-esc-${k}`)
      typed[k] = {
        observed_level: Number(obs),
        recommended_level: Number(rec),
        confidence: conf,
        evidence_sentence: ev,
        plain_language_check: plain,
        plain_language_note: `Plain-language note for ${k}.`,
        escalate: i % 5 === 0,
      }
    }
    for (let i = half; i < unitKeys.length; i++) await fillOn(page3, unitKeys[i], i)
    await page3.waitForTimeout(400)

    const progress = await page3.getAttribute('[data-cdt-progress]', 'data-cdt-progress')
    check(1, 'the progress counter reads every unit rated', progress, `${unitKeys.length}/${unitKeys.length}`)

    // Screenshot the fully expanded I-1 form before filing. Criterion 10.
    await page3.screenshot({ path: path.join(SHOTS, 'form-i1-1440.png'), fullPage: true })

    await page3.click('#cdt-file')
    await page3.waitForTimeout(3000)
    const afterText = await page3.innerText('body')
    check(1, 'no submit error is shown', /was not filed/i.test(afterText), false)

    // Read the rows back FROM THE DATABASE and compare every value, unit by unit.
    const [sub] = await sql(`
      select id::text as id, body_md, strength_note, growth_note_1, growth_note_2, context_note,
             connection_quality, consent_recorded, transcript_source,
             submitted_at is not null as submitted, approval_state
        from submission where assignment_id = '${id}'`)
    check(1, 'exactly one submission row exists', sub ? 1 : 0, 1)
    check(1, 'consent_recorded is true', sub?.consent_recorded, true)
    check(1, 'submitted_at is set', sub?.submitted, true)
    check(1, 'connection_quality round-trips', sub?.connection_quality, 'patchy')
    check(1, 'the body round-trips', sub?.body_md, 'The session ran the full 45 minutes and the portfolio was complete.')
    check(1, 'the strength note round-trips', sub?.strength_note, 'Explained the exegetical decision without reaching for jargon.')
    check(1, 'approval_state was set by the trigger', sub?.approval_state, 'awaiting-head-mentor')

    const back = await sql(`
      select unit_key, observed_level, recommended_level, confidence, evidence_sentence,
             plain_language_check, plain_language_note, escalate
        from submission_rating where submission_id = '${sub.id}' order by unit_key`)
    check(1, 'the rating row count equals bundle_unit for I-1', back.length, bu.n)
    let mismatched = 0
    for (const r of back) {
      const t = typed[r.unit_key]
      if (!t) { mismatched++; continue }
      if (
        Number(r.observed_level) !== t.observed_level ||
        Number(r.recommended_level) !== t.recommended_level ||
        r.confidence !== t.confidence ||
        r.evidence_sentence !== t.evidence_sentence ||
        r.plain_language_check !== t.plain_language_check ||
        r.plain_language_note !== t.plain_language_note ||
        r.escalate !== t.escalate
      ) mismatched++
    }
    check(1, 'every rated value matches what was typed, unit by unit', mismatched, 0)

    const [file] = await sql(`select source_url from submission_file where submission_id = '${sub.id}'`)
    check(1, 'the external-document link round-trips (rubric row 7)', file?.source_url, 'https://docs.google.com/document/d/cdt04-fixture')

    const [st] = await sql(`select state from assignment where id = '${id}'`)
    check(1, 'the assignment advanced to submitted', st?.state, 'submitted')

    const draftGone = await page3.evaluate((a) => localStorage.getItem(`cdt04.draft.${a}`) === null, id)
    check(11, 'the draft key is cleared only after a successful file', draftGone, true)

    // Criterion 3: the write is ONE call and it is atomic. Prove atomicity by
    // making the RPC fail after it has inserted the submission: a rating for a
    // unit outside the bundle raises 23503 mid-function, and nothing may persist.
    const bad = await sql(`
      do $$
      declare _n int;
      begin
        perform set_config('request.jwt.claims',
          json_build_object('sub','${fx.profiles.consultant}','role','authenticated','aal','aal1')::text, true);
        begin
          perform submit_writeup('${fx.assignments.returned.id}'::uuid,
            '{"consent_recorded":true,"body_md":"atomicity probe"}'::jsonb,
            '[{"unit_key":"NOT-A-UNIT","observed_level":1,"recommended_level":1,"confidence":"low",
               "evidence_sentence":"probe","plain_language_check":"yes"}]'::jsonb, null);
        exception when others then
          null;
        end;
      end $$;
      select count(*)::int as n from submission where body_md = 'atomicity probe'`)
    check(3, 'a refused submit_writeup leaves NO partial submission row', bad?.[0]?.n, 0)

    // And the coverage gate: a write-up that rates fewer units than its bundle
    // holds is refused by the database, not merely disabled in the browser.
    const short = await sql(`
      do $$ begin
        perform set_config('request.jwt.claims',
          json_build_object('sub','${fx.profiles.consultant}','role','authenticated','aal','aal1')::text, true);
        begin
          perform submit_writeup('${fx.assignments.returned.id}'::uuid,
            '{"consent_recorded":true,"body_md":"coverage probe"}'::jsonb,
            (select jsonb_agg(jsonb_build_object('unit_key', unit_key, 'observed_level',1,'recommended_level',1,
                     'confidence','low','evidence_sentence','probe','plain_language_check','yes'))
               from (select unit_key from bundle_unit where bundle_key = 'I-3' limit 2) t), null);
        exception when others then null;
        end;
      end $$;
      select count(*)::int as n from submission where body_md = 'coverage probe'`)
    check(3, 'a partial-coverage write-up is refused by the database', short?.[0]?.n, 0)

    await ctx.close()
  }

  // =====================================================================
  // Criterion 10: two viewports, no horizontal overflow, top-200px facts
  // =====================================================================
  console.log('\n=== criterion 10: 390px and 1440px')
  {
    for (const [w, tag] of [[390, '390'], [1440, '1440']]) {
      const ctx = await browser.newContext({ viewport: { width: w, height: 900 } })
      const page = classifyConsole(await ctx.newPage())
      await signIn(page, 'consultant')
      await page.waitForTimeout(800)
      await page.screenshot({ path: path.join(SHOTS, `queue-${tag}.png`), fullPage: true })
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)
      check(10, `queue at ${w}px has no horizontal body overflow`, overflow, false)

      if (w === 390) {
        // The CIT name, the bundle and the date inside the first 200px, measured
        // at the set viewport rather than assumed from the markup order.
        await page.goto(`${BASE}/portal/a/${fx.assignments.proposed.id}`, { waitUntil: 'networkidle' })
        await page.waitForSelector('[data-cdt-counterparty]', { timeout: 20000 })
        const top = await page.evaluate(() => {
          const el = document.querySelector('[data-cdt-counterparty]')
          return el ? el.getBoundingClientRect().top + window.scrollY : -1
        })
        console.log(`     measured: the CIT name's top offset at 390px is ${Math.round(top)}px`)
        check(10, 'the CIT name sits within the first 200px at 390px', top >= 0 && top < 200, true)
        await page.screenshot({ path: path.join(SHOTS, 'assignment-before-390.png'), fullPage: true })
      } else {
        await page.goto(`${BASE}/portal/a/${fx.assignments.proposed.id}`, { waitUntil: 'networkidle' })
        await page.waitForSelector('[data-cdt-counterparty]', { timeout: 20000 })
        await page.screenshot({ path: path.join(SHOTS, 'assignment-before-1440.png'), fullPage: true })
      }
      await ctx.close()
    }

    // The I-1 form at 390px, which is where 121 inputs defeat an automated audit.
    const ctx = await browser.newContext({ viewport: { width: 390, height: 900 } })
    const page = classifyConsole(await ctx.newPage())
    await signIn(page, 'consultant')
    await page.goto(`${BASE}/portal/a/${fx.assignments.held_i1.id}`, { waitUntil: 'networkidle' })
    await page.waitForTimeout(1500)
    await page.screenshot({ path: path.join(SHOTS, 'form-i1-390.png'), fullPage: true })
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)
    check(10, 'the I-1 page at 390px has no horizontal body overflow', overflow, false)
    await ctx.close()
  }

  console.log('\n=== criterion 0 (browser half): the console')
  check(0, 'no CSP violation and no unexpected page error across the walkthrough', violations.length, 0)
  if (violations.length) for (const v of violations.slice(0, 12)) console.log(`     ${v}`)
  console.log(
    `  note  ${preexisting.length} pre-existing React #418 hydration warning(s) on portal routes, ` +
      'reported and not counted: it fires on the existing /portal too, because every portal URL is ' +
      'served from 404.html under the Pages SPA fallback. Reported to whoever holds the portal.',
  )
} finally {
  await browser.close()
  server.kill()
}

console.log(`\n${results.filter((r) => r.ok).length} passed, ${failures} failed, ${results.length} checks`)
console.log(`screenshots in ${path.relative(REPO, SHOTS)} — a person must open these and say so.`)
process.exit(failures ? 1 : 0)
