-- OBT-CDT — the CBC competency registry: 41 scoring units as data.
--
-- Spec CDT-01. This is schema migration 1 of the assessment system. Everything
-- here is DERIVED: the rows come from the vault's CBC matrix and Domain-Map.md by
-- way of scripts/seed_competency_registry.py, and nothing downstream ever hand-
-- types a unit key. A correction goes into the matrix and the seed re-runs. An
-- `update` typed into the SQL editor is a defect, because the next seed reverts
-- it and nobody sees the revert. docs/ASSESSMENT.md is the standing statement of
-- that rule.
--
-- ## STATUS: NOT YET APPLIED (as of 2026-08-21)
--
-- The portal's Supabase project is in the dedicated OBT-CDT Supabase account, which no
-- token on the build machine reaches. So this file is written, reviewed and
-- dry-run against the sources, and unrun against a database. Apply with
-- `supabase db push`, or `node scripts/apply-migration.mjs` once
-- SUPABASE_PROJECT_REF names the portal project. CDT-00's migration
-- (20260821120000_admin_mfa.sql) applies first; the schema baton is serial.
--
-- ## Tables this migration owns
--
--   competency_scale        4 rows, the 0-3 definitions, verbatim
--   competency_domain       6 rows, from Domain-Map.md
--   competency_category    26 rows
--   category_domain        27 rows, the join that carries the double-listing
--   competency_unit        41 rows
--   unit_descriptor       194 rows, verbatim
--   unit_prerequisite       1 seeded row
--   registry_version        one row per seed run that changed something
--   unit_revision           append-only audit of identity-bearing unit changes
--   self_assessment_intake  wave-1 staging; the ONE table here holding addresses
--
-- It creates no view and no function. It also applies two grant corrections to
-- tables the baseline owns, and those are the only lines here touching an
-- existing object; see the note above them.
--
-- ## CDT-00's seven questions, answered table by table
--
-- 1. RLS enabled, and `revoke all` from **public, anon, authenticated** before any
--    grant? YES for all ten. All three roles are named, because Supabase grants
--    anon and authenticated directly and a bare `revoke ... from public` leaves
--    those standing. That mistake has shipped once already in the sibling
--    project; 20260817120100_portal_admin.sql:42-47 records it.
-- 2. `with check` on every `for update` policy? NOT APPLICABLE: there is no update
--    policy anywhere in this migration. No table here has a browser write path at
--    all, which is what makes CDT-13's edit-proposal design a later feature rather
--    than a hole to close.
-- 3. Column-level rules as grants rather than policies? NOT APPLICABLE: no table
--    here has a column whose visibility differs from its row's.
-- 4. `security_invoker` on every view? NOT APPLICABLE: no view. Stated rather than
--    skipped, because "no view" is the answer and silence is not.
-- 5. `security definer` functions with `set search_path`, EXECUTE revoked from
--    public and anon then granted? NOT APPLICABLE: no function. CDT-03 will add
--    the first one and inherits the rule.
-- 6. Does any table let its own subject write the field that decides their
--    privilege? NO. Nothing here is a privilege. `self_assessment_intake` holds a
--    person's own claims about themselves, and a claim is explicitly not a rating:
--    it carries no weight until an evaluator records one, which is CDT-03's table.
-- 7. Can any client role read a table whose contents disclose cohort membership?
--    This is the question that bites, and the answer differs by table. The nine
--    reference tables are readable by every signed-in user BY DESIGN: a CIT must
--    be able to read the standard they are assessed against, and the standard
--    names no people. `self_assessment_intake` is the exception and is readable by
--    NOBODY through the API. It holds participant email addresses before any
--    profile exists to match them to, which is exactly the disclosure question 7
--    asks about, so it is revoked from every client role with no grant at all.

-- =============================================================== the scale
-- A table rather than a `check` constraint, because these definitions are shown
-- to CITs and to evaluators, and a definition living only in a constraint cannot
-- be rendered. The four points are read verbatim from the Rating Scale block,
-- which is byte-identical in all 27 matrix files.
create table if not exists public.competency_scale (
  level       smallint primary key check (level between 0 and 3),
  label       text not null,
  definition  text not null
);

alter table public.competency_scale enable row level security;
revoke all on table public.competency_scale from public, anon, authenticated;
grant select on table public.competency_scale to authenticated;

drop policy if exists "the scale is readable by signed-in users" on public.competency_scale;
create policy "the scale is readable by signed-in users" on public.competency_scale
  for select to authenticated using (true);

-- ============================================================== the domains
-- Six macro domains, from Intake Assessments/Domain-Map.md. They appear nowhere
-- in the CBC matrix; the grouping is a judgment, which is why it lives in a
-- reviewed document inside the seed's digest rather than in the seed.
--
-- These keys are also the scope keys for CDT-02's consultant_qualification, so a
-- row here fixes what a domain-scoped grant covers.
create table if not exists public.competency_domain (
  domain_key  text primary key check (domain_key ~ '^M[0-9]+$'),
  name        text not null,
  ordinal     smallint not null unique
);

alter table public.competency_domain enable row level security;
revoke all on table public.competency_domain from public, anon, authenticated;
grant select on table public.competency_domain to authenticated;

drop policy if exists "domains are readable by signed-in users" on public.competency_domain;
create policy "domains are readable by signed-in users" on public.competency_domain
  for select to authenticated using (true);

-- =========================================================== the categories
-- 26 rows. `category_key` is the slug of the sub-matrix filename
-- (gc-adult-education, bt-discourse), which the seed derives rather than types;
-- verified that the filename slug equals the master matrix's Category-column slug
-- for all 26, including the awkward ones.
create table if not exists public.competency_category (
  category_key  text primary key check (category_key ~ '^(gc|bt)-[a-z0-9-]+$'),
  track         text not null check (track in ('gc', 'bt')),
  name          text not null,
  ordinal       smallint not null
);

create unique index if not exists competency_category_ordinal_idx
  on public.competency_category (track, ordinal);

alter table public.competency_category enable row level security;
revoke all on table public.competency_category from public, anon, authenticated;
grant select on table public.competency_category to authenticated;

drop policy if exists "categories are readable by signed-in users" on public.competency_category;
create policy "categories are readable by signed-in users" on public.competency_category
  for select to authenticated using (true);

-- ================================================= the join, and the exception
-- A join table rather than a `competency_category.domain_key` column, because the
-- grouping has one deliberate double-listing: Modes of Communication is primary
-- in M4 with communication theory and also listed in M5, because for an OBT
-- consultant it is craft. A single column cannot express that.
--
-- And the moment it is many-to-many, the obvious invariant breaks: units summed
-- over all rows gives 42 against a registry of 41. So there are two aggregations,
-- named separately in docs/ASSESSMENT.md and never conflated:
--
--   the INVARIANT  is over is_primary only and must equal 41
--   the DISPLAY SET is over every row, so M4 shows 7 units and M5 shows 6
--
-- A rollup that sums over this table without deciding which it wants reports a
-- 42-unit registry, and it looks like an off-by-one rather than a design choice.
create table if not exists public.category_domain (
  category_key  text not null references public.competency_category(category_key) on delete cascade,
  domain_key    text not null references public.competency_domain(domain_key) on delete restrict,
  is_primary    boolean not null default false,
  note          text not null default '',
  primary key (category_key, domain_key)
);

-- At MOST one primary per category, as a database fact. At LEAST one is not
-- expressible as an index and is asserted by the seed's gate instead; the seed
-- names the category when it fails.
create unique index if not exists category_domain_single_primary
  on public.category_domain (category_key) where is_primary;

create index if not exists category_domain_domain_idx
  on public.category_domain (domain_key);

alter table public.category_domain enable row level security;
revoke all on table public.category_domain from public, anon, authenticated;
grant select on table public.category_domain to authenticated;

drop policy if exists "category links are readable by signed-in users" on public.category_domain;
create policy "category links are readable by signed-in users" on public.category_domain
  for select to authenticated using (true);

-- ================================================================ the units
-- 41 rows. `unit_key` is U01 to U41 from the master matrix's own numbering,
-- because that is how people talk: the plan says "unit 28" throughout and unit 28
-- is the Hebrew-workshop gate. The category slug rides alongside, so a semantic
-- lookup is one join away.
--
-- A third numbering exists and is not used here: Projects/cbc-competency/
-- progress.md and evidence-map.json key the same 41 units as GC-1..GC-25 and
-- BT-26..BT-41, and already carry 101 entries of Joshua's own claimed levels. The
-- mapping is deterministic and is recorded in docs/ASSESSMENT.md so that data
-- stays importable.
--
-- `statement` comes from the SUB-MATRIX file, not the master. All 41 agree
-- verbatim between the two today, and the seed asserts that agreement, which
-- costs nothing and catches a half-applied edit.
create table if not exists public.competency_unit (
  unit_key      text primary key check (unit_key ~ '^U[0-9]{2}$'),
  category_key  text not null references public.competency_category(category_key) on delete restrict,
  -- The GC sub-area name. Null for a BT category, which has no sub-area: the two
  -- master tables genuinely have different column counts, 7 and 6.
  sub_area      text,
  statement     text not null,
  -- Nullable on purpose. 25 `**Rationale.**` lines exist, all in the ten GC
  -- files, none in the sixteen BT files. A parser that required it would refuse
  -- 16 of 26 sources.
  rationale     text,
  ordinal       smallint not null unique check (ordinal between 1 and 41)
);

create index if not exists competency_unit_category_idx
  on public.competency_unit (category_key, ordinal);

alter table public.competency_unit enable row level security;
revoke all on table public.competency_unit from public, anon, authenticated;
grant select on table public.competency_unit to authenticated;

drop policy if exists "units are readable by signed-in users" on public.competency_unit;
create policy "units are readable by signed-in users" on public.competency_unit
  for select to authenticated using (true);

-- ========================================================== the descriptors
-- 194 rows, reproduced verbatim on the sub-matrix files' own statement that they
-- are "reproduced verbatim from the CBC framework". Paraphrasing a certification
-- standard inside the database that scores against it would be the worst possible
-- place to introduce drift.
create table if not exists public.unit_descriptor (
  unit_key  text not null references public.competency_unit(unit_key) on delete cascade,
  ordinal   smallint not null,
  text      text not null,
  primary key (unit_key, ordinal)
);

alter table public.unit_descriptor enable row level security;
revoke all on table public.unit_descriptor from public, anon, authenticated;
grant select on table public.unit_descriptor to authenticated;

drop policy if exists "descriptors are readable by signed-in users" on public.unit_descriptor;
create policy "descriptors are readable by signed-in users" on public.unit_descriptor
  for select to authenticated using (true);

-- ========================================================= the prerequisites
-- The value "formation is caught, not just taught", in schema form. A level is
-- not a score, it is a thing that opens a door. One seeded row today: unit 28 at
-- level 1 gates entry to OBT-CDT Hebrew workshops. The CIT-facing ledger renders
-- this as what a level buys, which turns a bare 0 into a reason.
create table if not exists public.unit_prerequisite (
  unit_key   text not null references public.competency_unit(unit_key) on delete cascade,
  min_level  smallint not null references public.competency_scale(level),
  gates      text not null,
  primary key (unit_key, gates)
);

alter table public.unit_prerequisite enable row level security;
revoke all on table public.unit_prerequisite from public, anon, authenticated;
grant select on table public.unit_prerequisite to authenticated;

drop policy if exists "prerequisites are readable by signed-in users" on public.unit_prerequisite;
create policy "prerequisites are readable by signed-in users" on public.unit_prerequisite
  for select to authenticated using (true);

-- ============================================================ the versions
-- One row per seed run that changed anything. `source_digest` is SHA-256 over the
-- sorted contents of all 28 source files: the 26 sub-matrices, the master, and
-- Domain-Map.md. Domain-Map.md is inside the digest deliberately, so that editing
-- the grouping and re-running is detected; a grouping hard-coded in the seed
-- would print "no change" and the edit would not land.
--
-- Note what this table does and does not do. It records. It does NOT prevent a
-- renumber: a CBC renumber keeps 41/26/194, passes the gate, bumps the digest,
-- writes a row here, and rewrites `statement` under the same `unit_key` that
-- every existing rating points at. The protection against that is a REFUSAL in
-- the seed (`--allow-unit-change`) plus unit_revision below, not this table.
create table if not exists public.registry_version (
  version           bigserial primary key,
  source_digest     text not null,
  unit_count        smallint not null,
  category_count    smallint not null,
  descriptor_count  smallint not null,
  domain_count      smallint not null,
  link_count        smallint not null,
  seeded_at         timestamptz not null default now(),
  note              text not null default ''
);

alter table public.registry_version enable row level security;
revoke all on table public.registry_version from public, anon, authenticated;
grant select on table public.registry_version to authenticated;

drop policy if exists "registry versions are readable by signed-in users" on public.registry_version;
create policy "registry versions are readable by signed-in users" on public.registry_version
  for select to authenticated using (true);

-- ======================================================== the revision audit
-- Append-only, on publication_event's pattern. Written only when
-- `--allow-unit-change` permits a change to a unit's identity-bearing text, so
-- that a renumber leaves a trail rather than a diff nobody ran.
create table if not exists public.unit_revision (
  id                bigserial primary key,
  unit_key          text not null,
  field             text not null check (field in ('statement', 'category_key', 'ordinal')),
  old_value         text,
  new_value         text,
  registry_version  bigint references public.registry_version(version) on delete set null,
  at                timestamptz not null default now()
);

create index if not exists unit_revision_unit_idx on public.unit_revision (unit_key, at desc);

alter table public.unit_revision enable row level security;
revoke all on table public.unit_revision from public, anon, authenticated;
grant select on table public.unit_revision to authenticated;

drop policy if exists "revisions are readable by signed-in users" on public.unit_revision;
create policy "revisions are readable by signed-in users" on public.unit_revision
  for select to authenticated using (true);

-- ===================================================== wave-1 staging table
-- The ONE table in this migration with a closed read posture, and the reason is
-- CDT-00's question 7. It holds participant email addresses before any profile
-- exists to match them to, so it is revoked from every client role with NO GRANT
-- AT ALL. Service role only, written by scripts/import_self_assessment.py.
--
-- It keys on `subject_email` because Joshua answered CDT-00's decision 3 with
-- real names on 2026-08-21. Had that gone the other way this column would have
-- had to change before a single row was imported, rather than after eighty, which
-- is why the question was asked in CDT-00 and not here.
--
-- It exists because CDT-03's self_assessment is October and the round starts in
-- September. CDT-03's migration drains this into the real ledger with a
-- documented mapping and owns the column rename. One table that stops existing in
-- November is the cost of a September import that is genuinely exercised rather
-- than written and untested.
--
-- `claimed_level` is nullable and `claim_status` is what distinguishes an empty
-- cell from a claim of 0. That distinction is load-bearing: absence is not a
-- status, and a partial import whose missing rows read as "no claim" would be
-- worse than no import, because "no claim" means something.
create table if not exists public.self_assessment_intake (
  id             bigserial primary key,
  subject_email  text not null,
  unit_key       text not null references public.competency_unit(unit_key) on delete restrict,
  claimed_level  smallint references public.competency_scale(level),
  claim_status   text not null check (claim_status in ('claimed', 'no-claim', 'skipped')),
  note           text not null default '',
  source_sheet   text not null default '',
  imported_at    timestamptz not null default now(),
  -- A claim of a level must carry one; a no-claim must not. This is the
  -- absence-is-not-a-status rule as a constraint rather than as a convention.
  constraint claimed_level_matches_status check (
    (claim_status = 'claimed' and claimed_level is not null)
    or (claim_status <> 'claimed' and claimed_level is null)
  )
);

create index if not exists self_assessment_intake_subject_idx
  on public.self_assessment_intake (lower(subject_email), unit_key);

alter table public.self_assessment_intake enable row level security;
-- No grant follows. This is not an omission; see the header, question 7.
revoke all on table public.self_assessment_intake from public, anon, authenticated;

-- ================================================ two corrections to baseline
-- From CDT-00's D7 audit, finding A. These are the only lines in this migration
-- that touch an object another migration owns, and they are here because CDT-01
-- owns the next migration and the finding was routed to it.
--
-- `profiles` and `events` never revoked Supabase's default grants, which are
-- `select, insert, update, delete` to anon and authenticated on every new table in
-- `public`. So on those two tables RLS was the only line, where the other eight
-- had a grant boundary underneath it. Neither was exploitable: profiles has no
-- insert or delete policy, its update policy is false for anon, and events has no
-- write policy at all. But defence in depth is the whole point of the pattern.
--
-- Surgical, not `revoke all`. `authenticated` must keep SELECT on both (their read
-- policies depend on it) and must keep the baseline's column-level
-- `update (full_name, org)` on profiles, which is what actually stops a member
-- editing the email that incoming reports match on.
revoke insert, delete, truncate on table public.profiles from anon, authenticated;
revoke select, update on table public.profiles from anon;
revoke all on table public.profiles from public;

revoke insert, update, delete, truncate on table public.events from anon, authenticated;
revoke select on table public.events from anon;
revoke all on table public.events from public;

-- Sanity: the baseline's column grant must survive the revokes above. If this
-- raises, the revoke was too broad and a member can no longer edit their own
-- name, which is a real regression rather than a tightening.
do $$
begin
  if not has_column_privilege('authenticated', 'public.profiles', 'full_name', 'UPDATE') then
    raise exception 'profiles.full_name is no longer updatable by authenticated; the revoke above was too broad';
  end if;
  if not has_table_privilege('authenticated', 'public.profiles', 'SELECT') then
    raise exception 'profiles is no longer selectable by authenticated; the revoke above was too broad';
  end if;
  if has_column_privilege('authenticated', 'public.profiles', 'email', 'UPDATE') then
    raise exception 'profiles.email became updatable; the baseline column boundary is gone';
  end if;
end $$;
