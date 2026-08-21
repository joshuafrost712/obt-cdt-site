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
- `Projects/OBT/OBT Consultant Track/Intake Assessments/Domain-Map.md`, the
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

## What has and has not run, as of 2026-08-21

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
