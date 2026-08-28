# The competency registry, and the rules the ledger inherits

Written 2026-08-21 by spec CDT-01. This is the document CDT-03, CDT-07, CDT-08,
CDT-10 and CDT-12 read **before** touching the assessment ledger. It says five
things. Each one is here because getting it wrong is expensive and because none
of them is guessable from the schema alone.

Read `docs/PORTAL.md` for what the member portal is and where the Honest Eval
boundary sits. Read `docs/SECURITY.md` for the read posture every table here
answers to. This file does not restate either.

## 1. The four competency states are four things, never one status string

A unit's standing for a person is made of four separate facts, and they are
recorded separately:

- what the person **claims** about themselves (`self_assessment_intake` today,
  `self_assessment` once CDT-03 lands),
- what an evaluator **observed** in a session,
- what an evaluator **recommends** to CBC,
- whether a head mentor has **approved** that recommendation.

The rule: **the API returns four separately named fields and never one `status`
string, and no column named `status` ever carries more than one of them.** A UI
renders four distinct words.

The reason is that collapsing them destroys the round's design. A recommendation
that has not been approved is not a rating; an observation without a
recommendation is not a claim about certification; and a claim by the CIT is not
evidence. Merging any pair produces a number that reads as authoritative and is
not. The campaign's rubric row 4 is this rule, and it is checkable: no field name
may carry two of the four.

## 2. The registry is derived. The vault is the source

The 41 units, 26 categories, 194 descriptors, six domains and 27 category-domain
links are **not authored in the database**. They are parsed out of:

- `Projects/cbc-competency/cbc-matrix/`, holding 26 sub-matrix files plus
  `CBC_Master_Matrix.md`, in the vault,
- `Projects/OBT/OBT Consultant Track/Intake Assessment/Instruments/Domain-Map.md`, the
  macro-domain grouping, which appears nowhere in the matrix.

`scripts/seed_competency_registry.py` reads all 28, gates them, and writes. So:

**A correction goes into the vault file and the seed re-runs. An `update` typed
into the SQL editor is a defect.** It appears to work. The next seed reverts it,
and nobody sees the revert, because the seed reports "no change" when the source
digest is unchanged and the digest is over the files, not the rows.

This is the rule most likely to be broken, because typing the update is faster
and looks like it held.

Three properties follow, and later specs depend on them:

**The seed refuses rather than guesses.** Eight counts are gated (41 units, 41
statements, 26 categories, 4 scale points, 194 descriptor bullets, 41 descriptor
blocks, 6 domains, 27 links), plus the per-file descriptor vector, because a total
of 194 can be right while blocks are attached to the wrong units. A count that has
moved is a real event: read the diff, do not edit the constant.

**The descriptor count has a stated selector**, and it is the one thing here most
likely to be re-measured wrongly. It is *bullets between a
`**Component descriptors:**` marker and the next line beginning `**`*. Counting
every top-level bullet gives **298**, because all 26 files repeat a four-bullet
Rating Scale block. Counting to the next `##` gives 194 today but **196** as soon
as one Evidence field holds a bulleted list, which will happen when Joshua fills
in his ratings. Verified 2026-08-21 by planting a bulleted Evidence block in three
files: the stated selector still returned 194.

**The seed cannot read Rating, Evidence or Gap.** Parsing for a unit stops at the
first of those markers and does not resume. Those fields are one person's
assessment data, not registry content, and the protection is structural rather
than a matter of not asking. Proven by planting canary strings in all three fields
and finding none of them in any parsed value.

## 3. `unit_key` is `U01` to `U41`, and two other schemes exist

The registry keys units as `U01`-`U41`, from the master matrix's own numbering,
because that is how people talk: the plan says "unit 28" throughout, and unit 28
(Biblical Languages) is the gate on Hebrew-workshop entry.

Two other schemes are in play and neither is the key:

**`GC-1`-`GC-25` and `BT-26`-`BT-41`.** Used by
`Projects/cbc-competency/progress.md` and
`Claude Access/Claude Outputs/research/cbc-competency/evidence-map.json`, which
already carries **101 entries with `claimed_level`**, which is Joshua's own prior
self-assessment. The mapping is deterministic and is the reason this section
exists, so that data stays importable:

    U01..U25  <->  GC-1..GC-25       (ordinal n  <->  GC-n)
    U26..U41  <->  BT-26..BT-41      (ordinal n  <->  BT-n)

**`C01`-`C22`.** A **superseded** 22-competency scheme, in `active-brief.md`,
`cbc-matrix/_INSTRUCTIONS.md` and `progress.md`. The seed excludes those files by
an explicit 28-name list, not by a glob with exclusions. A future session that
"improves" the list into a pattern will seed the wrong registry and it will look
tidy.

A semantic key (`bt-discourse`) was considered and is carried alongside as
`competency_category.category_key`, so a semantic lookup is one join away without
the ledger keying on a slug that a rename would break.

## 4. There are TWO domain aggregations, and conflating them reports a 42-unit registry

This is the one that will bite. `category_domain` is a join table because the
grouping has one deliberate double-listing: **Modes of Communication** is primary
in M4, with communication theory, and also listed in M5, because for an OBT
consultant it is craft.

So there are two different sums and they are both correct:

| | over | total | per domain (M1..M6) |
|---|---|---|---|
| **the invariant** | `is_primary` rows only | **41** | 5, 5, 5, 7, 5, 14 |
| **the display set** | every row | **42** | 5, 5, 5, 7, 6, 14 |

Which one to use, by consumer:

- **Any "total units" figure, and any completeness check**, uses the invariant. It
  must equal 41. A rollup that sums over `category_domain` without choosing
  reports 42, and that looks like an off-by-one rather than a design decision.
- **A domain's displayed unit list and its rollup statistic** use the display set,
  so M5 shows 6 units and Modes of Communication appears in both M4's and M5's
  medians. That is the entire purpose of the exception.
- **A domain-scoped qualification check** (CDT-02's
  `consultant_qualification.scope_kind='domain'`) uses the **display set**, because
  a grant in M5 should cover what M5 is shown as containing.

**The rollup statistic is the median** of the domain's displayed units, shown with
the count, and flagged thin when the count is 0 or 1. Median rather than mean
because one 0 on a niche unit should not drag a domain down, and not max because
max hides gaps. Worth noticing before designing any display: **M6 carries 14 of
the 41 units**, so a median over 14 behaves very differently from a median over 5,
and "Consulting as a Profession" will move slowly for everyone.

CDT-02 also inherits a check that is **not** this spec's gate: I-1 to I-4 must
cover all 41 units, and that is **set equality, not a count**. A bundle map
covering 40 units and double-counting one has the right total and is wrong.
Reusing the registry's count gate there would pass it.

## 5. The Honest Eval boundary, and where a claim may live

In one paragraph, because `docs/PORTAL.md` is authoritative and this only says
what it means for the ledger: **the portal may own claims about a person; it may
never hold Honest Eval's observations of an event.** A publication that crossed
the signed push is frozen prose plus routing identity, and nothing more.

Two consequences for schema:

`source` stays a closed vocabulary that keeps provenances distinguishable, on
`publication.source`'s pattern. When a real import from an external assessment
system arrives, it goes to its **own table**, not into a column beside a
consultant's own entry. One carries a cryptographic claim about its origin and
the other carries a human's word for it.

**No `cbc_export_state` column** until CBC's import format is actually known. A
state column for a transport nobody has specified becomes a field that means
whatever the last script to touch it meant.

## The wave-1 staging table, and why it stops existing

`self_assessment_intake` is not the ledger. CDT-03's `self_assessment` is, and
CDT-03 is October, while the round starts in September and the first roughly eight
sessions run on paper and a spreadsheet.

So: `scripts/seed_competency_registry.py --emit-sheet` generates the CIT workbook
with **every unit key machine-written**, `scripts/import_self_assessment.py` loads
a filled copy, and **CDT-03's migration drains this table into the real ledger and
owns the column rename.** The emitted sheet matches the staging table, not the
ledger, because the ledger did not exist when the sheet was designed. One table
that stops existing in November is the price of a September import that is
genuinely exercised rather than written and untested.

Two rules the importer enforces, and both matter more than they look:

**An empty cell is not a zero.** `claim_status` carries the distinction:
`no-claim` with a null level means "I considered this and claim nothing";
`claimed` with level 0 means "I claim none of this competency". Those are
different statements about a person. A database constraint enforces the pairing,
so a `claimed` row without a level cannot be stored at all.

**An unknown `unit_key` refuses the WHOLE file.** Not "imports the rows that
matched". The rows that failed to land read as no-claim, and no-claim is a state an
evaluator acts on, so a partial import produces a wrong conversation about
someone's competence. Verified 2026-08-21: one corrupted key in a 41-row sheet
refuses all 41 and names the row.

`self_assessment_intake` holds participant email addresses before any profile
exists to match them to, so it is the one table in this migration **revoked from
every client role with no grant at all**. That is CDT-00's question 7 answered in
the direction the question asks about. No filled workbook may ever enter this
repo; the importer refuses a path inside it.

## 6. Who may assess whom: the schema enforces less than it looks like it does

CDT-02's `consultant_qualification` decides who may sit in judgment on an occasion,
and three things about it must be read together or the guarantee is overstated.

**Scope matching is a hierarchy, not equality.** A grant at `('category',
'gc-adult-education')` satisfies a bundle row at `('domain','M2')`, because the
category sits inside that domain. It runs the other way too: a `('domain','M2')`
grant satisfies a `('category','gc-mentoring')` row. That second direction is a
deliberate over-grant. A broad qualification really does cover its categories, so
the control is not the schema, it is that **whoever records a grant picks the
narrowest scope that is true**. The category level exists so that narrow scope is
available; it does not force anyone to use it.

**The disjunction moves the over-grant risk from the grant to the bundle map.** A
consultant qualifies for a bundle if they hold **at least one** row that
`bundle_qualification` lists for it. So a row added to that table widens who may
assess whom, and **no other control catches it**. Viji's review of
`bundle_qualification`'s rows is the control. That is a review task, not a schema
property, and it is the part of `Bundle-Map.md` most worth her time.

**I-1 is permissive and is named as such rather than made to look tight.** Its
qualification sentence is "Consultant qualified in the dossier's domains", which is
a property of the CIT's dossier and not of the bundle. So I-1 lists all six
domains, and any consultant holding any domain or category grant passes the schema
check for it. The pairing's real justification is recorded in
`assignment.qualification_basis` for audit. CDT-05 owns tightening this once
dossiers exist, and a session that assumes I-1 is already enforced will not add the
check. CDT-02's criterion 3 prints I-1's rows beside its result so the
permissiveness is visible rather than implied.

**`scope_kind = 'bundle'` names a credential, not an occasion.** Settled by Joshua
on 2026-08-21 after the two readings were found to disagree. `bundle_grant` is the
vocabulary, `obt-cdt-facilitator` is its one row today, and the scope guard
validates against it. Under the rejected reading I-4's qualifying row would have
been unenforceable and **no consultant could ever have been assigned to I-4**.

## 7. Storage stops the accident. The handbook stops the rest

Both buckets are private and neither MIME allowlist contains audio or video.
`cdt-evidence` takes pdf, docx, txt, md, png and jpeg at 10 MB; `cdt-submissions`
takes pdf, docx, txt, md, vtt and srt at 25 MB.

**Here is where that control ends.** Supabase Storage validates the `Content-Type`
the *uploader declares*. A consultant who renames `session.mp3` to `session.pdf`
and sends `application/pdf` stores audio in the bucket. Real enforcement needs
magic-byte inspection and this host has no server to do it in. So the allowlist
stops the accident and the handbook stops the deliberate case, with
`submission_file.retain_until` as the backstop. This is written down because
CDT-00's own standard is that a threat model overstating its protection is worse
than none.

The two buckets' policies are **not symmetrical**, and that is not an oversight.
`cdt-evidence`'s first path segment is the owner's own profile id, so its rule is a
direct comparison. `cdt-submissions`'s first segment is an assignment id, so its
rule is an indirection through `assignment` via `may_write_assignment_path()`,
which regex-guards the uuid shape **before** casting. Without that guard a non-uuid
first segment raises `invalid input syntax for type uuid`, which is an error page
rather than a refusal.

## 8. A head mentor without two-factor authentication sees nothing

`is_head_mentor()` carries the same `aal2` requirement as `is_portal_admin()`, and
it fails closed: a token with no `aal` claim is treated as single-factor. Since it
appears in all three read helpers and in every head-mentor RPC, a head mentor whose
session has not completed two-factor authentication **reads zero rows everywhere
and is refused by every approval call**.

That will look like a bug the first time it happens, and it is not. It is also
ordering-sensitive in the same way CDT-00 D6 is: enrol first, then rely on it.
`20260821120000_admin_mfa.sql` still refuses to apply until some portal
administrator holds a verified factor, which as of 2026-08-21 none does.

## What has and has not run, as of 2026-08-21

**Superseded in part. The schema IS applied.** The paragraph below was written
before the dedicated account's token was available; it now is, and five migrations
plus CDT-02's own have been applied to `lvzwmzqqvbnurumygcnt` (`sil-obt-cdt
website`). What remains unwritten is **rows**, not schema. See "As of the CDT-02
build session" at the end of this file.

The migration and both scripts are written and reviewed. The **schema has not been
applied and no row has been written**, because the portal's Supabase project lives
in the dedicated OBT-CDT Supabase account and no token on the build machine reaches
it.

What was proven without a database: the gate refuses five distinct malformations
with five distinct messages; all eight counts and both per-file descriptor vectors
re-measure exactly; the seed cannot read planted rating, evidence or gap data and
the descriptor count survives a bulleted Evidence block; the emitted sheet
round-trips with an explicit 0 kept distinct from an empty cell; a corrupted key
refuses the whole file; and `apply-migration.mjs` refuses an unset ref, refuses
Honest Eval's ref by name, and refuses a ref the token's account does not own.

What waits on the project: applying the migration, the idempotency and digest
checks, the read-posture assertions over all ten tables, the renumber refusal
against live rows, and the prerequisite sentence rendered from a real join.

**`Domain-Map.md` is not signed off.** It is scheduled for Viji's review on
2026-08-26 with the bundle map, and five of its 26 assignments are called arguable.
Its groupings are transcribed from the approved plan rather than invented, so
everything above could be built and dry-run, and the seed **refuses to write**
while `signed_off: false` unless passed `--allow-unsigned-domain-map`.

## As of the CDT-02 build session, 2026-08-21

**The database exists and the schema is on it.** The portal project was created
2026-08-17 but its `public` schema was empty until this session: phase 1 had
shipped as code, never as a running system. Applied in order, with
`scripts/apply-migration.mjs`: the baseline, `portal_admin`, `publication`, CDT-01's
`competency_registry`, CDT-02's `assessment_spine`, and a fix migration described
below. None is recorded in `supabase_migrations.schema_migrations`, so a linked
machine needs `supabase migration repair --status applied <version>` for each
before its next `db push`.

**`20260821120000_admin_mfa.sql` is still unapplied, and refused correctly.** Its
own DO block stops it until a portal administrator holds a verified MFA factor.
There are no `auth.users` rows at all, so nothing can hold one yet. Enable TOTP in
the project's Auth settings, run `scripts/mfa-enrol.mjs`, confirm an `aal2` token,
then apply it.

**No rows are seeded, and that is deliberate.** Both source documents are unsigned
(`Domain-Map.md` and `Bundle-Map.md`, both due for Viji's review 2026-08-26), and
rows that decide who may assess whom are not written from an unreviewed document.
The only durable row in the whole assessment schema is `platform_setting`'s
`head_mentor_approval_mode = "approve-all"`, seeded by the migration because the
safe default has to exist before anything can read it.

**The criteria still ran against the real data.** Both seeds gained `--emit-sql`,
which runs the seed's own gate and then writes its rows as SQL without touching a
database or reading a credential. `scripts/cdt02-assertions.mjs` prepends those
rows to `scripts/cdt02-assertions.sql` and posts the lot inside a transaction it
**rolls back**. So criteria 3 to 10 were asserted against the real 41-unit registry
and the real I-1 to I-4 rows, with nothing persisted. Re-run it any time with
`node scripts/cdt02-assertions.mjs`; it needs no arguments.

Result: **61 checks, 61 passed**, including six mutation tests. Each mutation drops
a control, watches the check go red, restores it, and then asserts the restoration,
because a harness that leaves a guard off is worse than one that never dropped it.

**One shipped defect was found, by criterion 11 on its first real run.**
`20260817120200_publication.sql:247` revoked `admin_unmatched_publications` from
`public, anon` and **not `authenticated`**, so Supabase's default grants stood and
`authenticated` held INSERT, UPDATE, DELETE and TRUNCATE on the view. This is
exactly the mistake `20260817120100_portal_admin.sql:42-47` documents as having
already shipped once in the sibling project; the warning existed as prose and never
as an assertion. Exposure was **latent, not live**: the view carries
`security_invoker = on` and `authenticated` holds only SELECT on the underlying
`publication`, so a delete attempt was refused with 42501, verified against the live
project. But it sat two independent changes away from being real. Fixed in
`20260908120100_fix_view_overgrant.sql`, which asserts the outcome with
`has_table_privilege` rather than trusting its own revoke.

Two things the criteria do **not** prove, stated rather than folded into the pass
count. The `aal2` checks forge `request.jwt.claims`, which tests the predicate a
policy evaluates and not Supabase Auth's issuing of a real two-factor token; that
needs the TOTP enrolment above. And `src/lib/backend/assessApi.ts` typechecks and
builds but appears in no bundle chunk, because nothing imports it yet. CDT-04 builds
the UI that will.

## The consultant's queue and the write-up form (CDT-04, 2026-08-22)

`assessApi.ts` now has the UI that imports it. Two routes, both inside the
`backendEnabled` block and both lazy: `/portal/assignments` is the queue, and
**`/portal/a/:assignmentId` is the permanent anchor**. Once an invitation email
carries that URL its shape cannot change, so the id is the opaque uuid from
`assignment.id` and never a name-derived slug.

### A draft is a device event, not a system event

`submission.consent_recorded` is `not null` with no default and
`submission_rating.evidence_sentence` is `not null` per unit, so the schema
accepts nothing until everything exists. I-1 is 16 units at seven fields each over
nine header fields: **121 inputs**, filled after a two-hour conversation. The form
therefore saves every keystroke to `localStorage` under `cdt04.draft.<uuid>`.

**That draft lives in one browser on one device and nowhere else.** It is not on
the server, clearing browser data removes it, and Safari and iOS evict
unvisited-origin storage after seven days. The UI says "Saved on this device" for
exactly this reason. A consultant who loses a draft will ask whether the system had
it, and the honest answer is no. The draft is cleared only after the write returns
successfully, so a refused submit keeps the work.

### One write-up per assignment, filed in one call

`submit_writeup()` (`20260909120000_writeup_submit.sql`) takes the whole write-up
and every rating in a single call, because PostgREST gives the client no
transaction and three separate inserts leave a reachable `submission` with zero
ratings the first time a connection drops mid-file.

It also holds the rule the form can only ask for politely: **a write-up rates every
unit in its bundle, or it is refused.** A form check is a courtesy; a database
check is a rule, and this is the thing a rushed consultant at 10pm can otherwise
get wrong on the way to CBC.

A `returned` write-up is revised in place rather than re-filed, and
`20260909120200_one_writeup_per_assignment.sql` makes that structural: one
submission per assignment, enforced by a unique index. A second rating is a second
**assignment** carrying `rating_role = 'second'`, with its own submission, so the
second-rating design is untouched by this.

### A consultant can now see who their CIT is

`profiles` read reach used to be `auth.uid() = id`, which is right for a member
portal and wrong for an assessment round: it meant nothing anywhere told a
consultant the name of the person they were about to examine.
`20260909120100_profile_counterparty_read.sql` opens exactly one step of reach,
following an assignment in both directions, plus oversight. There is no
"all participants" read, and `member_allowlist` stays revoked from every client
role, so the cohort roster is still not readable by anyone.

### If a boundary turns out not to hold mid-round

Joshua's decision, 2026-08-21: **patch and continue, pause only on disclosure.** A
hole that let one consultant read another's write-up for the same CIT pauses the
affected pairings, because the second-rating design depends on that blindness.
Anything else is patched and the affected checks are re-run.

## The boundary harness (CDT-06a, 2026-08-22)

`scripts/cdt06-rls-tests.sql` and `scripts/cdt06-ui.mjs` are the standing gate over
the merged tree. Run them before the round opens and after any schema change:

```
node scripts/cdt06-fixtures.mjs --setup
node scripts/cdt06-fixtures.mjs --sql scripts/cdt06-rls-tests.sql
node --dns-result-order=ipv4first scripts/cdt06-ui.mjs
node scripts/cdt06-fixtures.mjs --sql scripts/cdt06-rls-restore.sql
node scripts/cdt06-fixtures.mjs --teardown
```

Read the restore step as mandatory rather than tidy: the UI half replaces
`may_see_submission()` on the live project and puts it back, and a run that dies
in between leaves it widened. `docs/SECURITY.md` records the same thing.

**What it proved on 2026-08-22.** Second rating is blind: a second rater on the
same CIT reads zero of the primary's write-ups, both on the rendered page and on
their own session's wire read, and widening the helper opens it, which is what
shows the blindness is the database's doing. A CIT cannot read a write-up before
release, and cannot drive their own assignment through the state graph. A
consultant cannot see the name of a CIT they have no assignment with. `anon` reads
nothing anywhere, `member_allowlist` refuses every client role with `42501`, and
so does `self_assessment_intake`, which is where a participant's email address
lands.

**What it found, and it is the one thing to fix before the round.** An
administrator holding only a password reads the whole cohort, because
`is_portal_admin()` has no assurance clause on the live project. The head mentor
is gated correctly; the administrator is not. `docs/SECURITY.md` carries the
measurement and the reason. Seed the allowlist and apply
`20260821120000_admin_mfa.sql` in the same sitting.

**One number to distrust.** `member_alias` and `unit_revision` hold zero rows, so
their "reads nothing" cells pass for free. The harness prints which tables those
are on every run, under section 8, rather than folding them into the pass total.
