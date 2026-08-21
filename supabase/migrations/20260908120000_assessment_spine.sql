-- OBT-CDT — the assignment and submission spine.
--
-- Spec CDT-02. This is schema migration 2 of the assessment system, and it owns
-- both storage buckets. CDT-01's 20260907120000_competency_registry.sql applies
-- first: every unit and category reference below is a foreign key into it.
--
-- The goal in one sentence: an assessment session can be set up, sat, written up
-- and approved, with the database refusing every version of it that would be
-- wrong. Five refusals and one record.
--
-- ## STATUS: APPLIED 2026-08-21 to lvzwmzqqvbnurumygcnt (sil-obt-cdt website)
--
-- Applied with scripts/apply-migration.mjs, which does NOT record the file in
-- supabase_migrations.schema_migrations. Before the next `db push` on a linked
-- machine: `supabase migration repair --status applied 20260908120000`.
--
-- ## File order, which is load-bearing
--
-- The three read helpers are `language sql`, and a `language sql` body is parsed
-- for table existence at CREATE time, unlike plpgsql. So this file is ordered
-- tables, then functions, then policies, rather than grouping each table with its
-- own policy. The first draft grouped them and failed with
-- `42P01 relation "assignment" does not exist` on may_see_subject. Keeping the
-- helpers as `language sql` matters: `set search_path` on a SQL function blocks
-- inlining, and inlining is what would re-expose the policy recursion loop.
--
-- ## Objects this migration owns
--
-- Fourteen tables. Twelve are the spec's; `head_mentor` and `bundle_grant` are
-- the other two, both resolved spec gaps, see the notes below.
--
--   consultant                 the assessor side, and is_cbc_mentor
--   consultant_qualification   who may assess what, at three scope levels
--   cit_enrollment             the round's roster, as a query not a list
--   assessment_bundle          the four intake occasions
--   bundle_unit                which units each occasion rates
--   bundle_grant               the vocabulary for scope_kind = 'bundle'
--   bundle_qualification       the disjunction that qualifies for a bundle
--   assignment                 one pairing, one occasion
--   assignment_event           append-only audit, no client write grant
--   submission                 the write-up, and where approval lives
--   submission_rating          the per-unit payload (decision 1)
--   submission_file            attachments and their retention
--   platform_setting           one key: head_mentor_approval_mode
--   head_mentor                backs is_head_mentor(); see the gap note
--
-- Functions: is_head_mentor, approval_state_for, may_see_subject,
-- may_see_assignment, may_see_submission, may_write_assignment_path,
-- create_assignment, approve_submission, return_submission, set_platform_setting,
-- plus six trigger functions (qualification_scope_guard,
-- assignment_qualification_guard, assignment_change_guard, assignment_audit,
-- submission_set_approval_state, refuse_change_after_approval) and two orphan
-- guards (refuse_orphaning_category_delete, refuse_orphaning_bundle_delete).
--
-- No view. Stated rather than skipped, because "no view" is the answer to
-- CDT-00's question 4 and silence is not.
--
-- ## Four gaps in the spec, resolved here and named
--
-- 0. **`scope_kind = 'bundle'` had two readings and the artifacts disagreed.** The
--    spec's D2 and criterion 3 read `scope_key` as a `bundle_key`; the Bundle-Map
--    and `seed_bundles.py` read it as a named credential validated against the
--    seed's own `BUNDLE_SCOPE_KEYS`. Under the spec's reading the map's real I-4
--    row is refused and **no consultant can ever be assigned to I-4**, which the
--    scope guard caught on its first run against real data. Put to Joshua on
--    2026-08-21; he chose the credential reading, so `bundle_grant` is the
--    vocabulary and the spec's criterion 3 wording is amended. Full reasoning is on
--    the `bundle_grant` table below.
--
-- 1. **`is_head_mentor()` has no backing table in the spec.** D6 says only "same
--    shape as is_portal_admin()". portal_admin is a table, so this adds
--    `head_mentor (profile_id, added_by, added_at)` and reads it. The alternative
--    considered and rejected was a flag on `consultant`: the head mentor approves
--    write-ups and flips the approval mode, so it is an oversight role rather than
--    an assessor attribute, and putting it on `consultant` would place a privilege
--    flag on a row whose subject can be the same person. That is the
--    `profiles.role` lesson the baseline migration was written to record.
--
-- 2. **`events.id` is `text`, not `uuid`.** Verified in the live catalog on
--    2026-08-21. D2 writes `cohort_event_id references events` without a type, and
--    a uuid column would have failed at definition time. It is `text` here.
--
-- 3. **No aal2 bootstrap DO-block, unlike 20260821120000_admin_mfa.sql.** That
--    migration refuses to apply until an administrator has a verified MFA factor,
--    which is right for a migration whose only job is to tighten three helpers.
--    Copying it here would block the entire assessment schema on a TOTP enrolment
--    and leave the round with nowhere to put a write-up. So `is_head_mentor()`
--    carries the aal2 clause from birth, and the enrolment ordering is documented
--    rather than enforced: until a head mentor holds a verified factor, every
--    head-mentor read returns zero rows and every head-mentor RPC refuses. That
--    will look like a bug the first time it happens, which is why it is written
--    here and in docs/ASSESSMENT.md.
--
-- ## CDT-00's seven questions, table by table
--
-- 1. RLS enabled, and `revoke all` from **public, anon, authenticated** before any
--    grant? YES for all fourteen. All three roles are named every time. A bare
--    `revoke ... from public` leaves Supabase's direct grants to anon and
--    authenticated standing; 20260817120100_portal_admin.sql:42-47 records that as
--    a mistake already shipped in the sibling project, and this build session found
--    it shipped here too, in 20260817120200_publication.sql:247, on
--    admin_unmatched_publications. Fixed in 20260908120100_fix_view_overgrant.sql.
-- 2. `with check` on every `for update` policy? YES, on all four of them. The rules
--    that compare OLD to NEW cannot live in `with check`, which sees only NEW; they
--    are in assignment_change_guard and refuse_change_after_approval.
-- 3. Column-level rules as grants rather than policies? YES, and this is the
--    load-bearing one. `assignment` grants update on exactly four columns and
--    `submission` on nine. RLS cannot restrict columns, so a consultant's attempt
--    to move an assignment to another consultant, or to write approval_state,
--    fails at the grant with 42501 before any policy runs.
-- 4. `security_invoker` on every view? NOT APPLICABLE: no view.
-- 5. `security definer` functions with `set search_path`, EXECUTE revoked from
--    public and anon then granted? YES for all of them, one pair of lines each.
--    Postgres grants EXECUTE to PUBLIC by default, so a function missing those two
--    lines is anon-callable. The six trigger functions are the exception and are
--    revoked from every role including authenticated: a trigger function is called
--    by the trigger, never by a client.
-- 6. Does any table let its own subject write the field that decides their
--    privilege? NO. `consultant.is_cbc_mentor` decides whether `auto-accepted` is
--    reachable and has no client write path at all. `submission.approval_state` is
--    outside the nine granted columns. `consultant_qualification` has no write
--    policy and no write grant.
-- 7. Can any client role read a table whose contents disclose cohort membership?
--    Only through the three read helpers and the consultant-self expression. The
--    four reference-shaped tables name no people and are readable by every
--    signed-in user, because a CIT must be able to read the instrument they sit.
--    `platform_setting` is readable by nobody.

begin;

-- ###########################################################################
-- SECTION 1. head_mentor and is_head_mentor(), which everything else reads.
-- ###########################################################################

create table if not exists public.head_mentor (
  profile_id  uuid primary key references public.profiles (id) on delete cascade,
  added_by    uuid references public.profiles (id),
  added_at    timestamptz not null default now()
);

alter table public.head_mentor enable row level security;
revoke all on table public.head_mentor from public, anon, authenticated;
grant select on table public.head_mentor to authenticated;

-- `coalesce(..., 'aal1')` fails closed: a token with no aal claim is single-factor
-- rather than waved through. Copied deliberately from is_portal_admin() rather
-- than reinvented, so the two read identically at a glance.
create or replace function public.is_head_mentor()
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2'
     and exists (select 1 from head_mentor where profile_id = auth.uid());
$$;

revoke execute on function public.is_head_mentor() from public, anon;
grant execute on function public.is_head_mentor() to authenticated;

-- ###########################################################################
-- SECTION 2. Tables and grants. No policies yet; they are in section 4.
-- ###########################################################################

-- ------------------------------------------------------------- D2. People

create table if not exists public.consultant (
  profile_id     uuid primary key references public.profiles (id) on delete cascade,
  is_cbc_mentor  boolean not null default false,
  languages      text[] not null default '{}',
  status         text not null default 'active' check (status in ('active','paused','retired')),
  note           text not null default ''
);

alter table public.consultant enable row level security;
revoke all on table public.consultant from public, anon, authenticated;
grant select on table public.consultant to authenticated;
-- No update grant of any kind. is_cbc_mentor is the flag that makes
-- 'auto-accepted' reachable, so it is admin-set. This is the profiles.role lesson
-- applied to the second place it would have happened.

create table if not exists public.consultant_qualification (
  id          uuid primary key default gen_random_uuid(),
  profile_id  uuid not null references public.consultant (profile_id) on delete cascade,
  scope_kind  text not null check (scope_kind in ('domain','category','bundle')),
  scope_key   text not null,
  -- Required and free text, because "on what basis" is the question the
  -- recruitment letter asks and the answer is prose.
  basis       text not null check (length(btrim(basis)) > 0),
  added_by    uuid references public.profiles (id),
  added_at    timestamptz not null default now(),
  unique (profile_id, scope_kind, scope_key)
);

alter table public.consultant_qualification enable row level security;
revoke all on table public.consultant_qualification from public, anon, authenticated;
grant select on table public.consultant_qualification to authenticated;

create table if not exists public.cit_enrollment (
  profile_id          uuid primary key references public.profiles (id) on delete cascade,
  participant_kind    text not null check (participant_kind in ('cit','consultant')),
  track_membership    text not null check (track_membership in ('sil-obt-cdt','guest')),
  -- events.id is text in this project, verified in the live catalog 2026-08-21.
  cohort_event_id     text references public.events (id),
  -- Without this, consultant.languages has nothing to match against and
  -- same-language pairing has consultant-side data only.
  assessment_language text,
  enrolled_at         timestamptz not null default now(),
  note                text not null default ''
);

alter table public.cit_enrollment enable row level security;
revoke all on table public.cit_enrollment from public, anon, authenticated;
grant select on table public.cit_enrollment to authenticated;

-- ------------------------------------------------------------ D3. Bundles

create table if not exists public.assessment_bundle (
  bundle_key       text primary key check (bundle_key ~ '^I-[0-9]+$'),
  name             text not null,
  format           text not null,
  minutes          integer not null check (minutes > 0),
  prep_minutes     integer not null default 0 check (prep_minutes >= 0),
  writeup_minutes  integer not null default 0 check (writeup_minutes >= 0),
  ordinal          smallint not null unique,
  active           boolean not null default true
);

alter table public.assessment_bundle enable row level security;
revoke all on table public.assessment_bundle from public, anon, authenticated;
grant select on table public.assessment_bundle to authenticated;

-- The composite primary key is load-bearing: submission_rating's second foreign
-- key points at it, and that is what stops a rating escaping its bundle.
create table if not exists public.bundle_unit (
  bundle_key  text not null references public.assessment_bundle (bundle_key) on delete cascade,
  unit_key    text not null references public.competency_unit (unit_key),
  is_primary  boolean not null,
  primary key (bundle_key, unit_key)
);

alter table public.bundle_unit enable row level security;
revoke all on table public.bundle_unit from public, anon, authenticated;
grant select on table public.bundle_unit to authenticated;

-- The vocabulary for `scope_kind = 'bundle'`, and the reason it exists.
--
-- `scope_kind` is one column referencing three things, and each kind is checked
-- against its own: 'domain' against competency_domain, 'category' against
-- competency_category, and 'bundle' against THIS table. The spec's D2 says the
-- third is assessment_bundle, and its criterion 3 tests `('bundle','I-4')`. That
-- reading was put to Joshua on 2026-08-21 against the reading the Bundle-Map and
-- seed_bundles.py already implement, and he chose this one: a bundle-scoped grant
-- names a **credential**, not an occasion.
--
-- Why that is the better design. One credential can unlock several occasions, and
-- `bundle_qualification.bundle_key` already does the scoping, so the credential
-- does not need to repeat it. Under the other reading the qualifying row for I-4
-- would have been `('I-4','bundle','I-4')`, which is very nearly a tautology, and
-- the credential's name would have survived only in a consultant's free-text
-- `basis` where nothing could check it.
--
-- The table is what keeps the scope guard total. Without it, 'bundle' would be
-- the one scope whose key is unchecked free text, and a typo there seeds a grant
-- nobody holds, which refuses every assignment to that occasion. That is the
-- failure mode the seed's own comment on BUNDLE_SCOPE_KEYS describes.
create table if not exists public.bundle_grant (
  grant_key  text primary key check (grant_key ~ '^[a-z0-9-]+$'),
  label      text not null,
  note       text not null default ''
);

alter table public.bundle_grant enable row level security;
revoke all on table public.bundle_grant from public, anon, authenticated;
grant select on table public.bundle_grant to authenticated;

-- Finding 2. The disjunction the assignment RPC and the guard trigger both read.
-- A row added here WIDENS who may assess whom, and no other control catches it.
-- Viji's review of these rows is the control, not the schema. docs/ASSESSMENT.md
-- says so in those words.
create table if not exists public.bundle_qualification (
  bundle_key  text not null references public.assessment_bundle (bundle_key) on delete cascade,
  scope_kind  text not null check (scope_kind in ('domain','category','bundle')),
  scope_key   text not null,
  primary key (bundle_key, scope_kind, scope_key)
);

alter table public.bundle_qualification enable row level security;
revoke all on table public.bundle_qualification from public, anon, authenticated;
grant select on table public.bundle_qualification to authenticated;

-- --------------------------------------------------- D6. platform_setting

create table if not exists public.platform_setting (
  key         text primary key,
  value       jsonb not null,
  updated_by  uuid references public.profiles (id),
  updated_at  timestamptz not null default now()
);

alter table public.platform_setting enable row level security;
-- Readable by NOBODY through the API, and it gets no policy in section 4.
-- approval_state_for() reads it as definer, which is the whole reason a
-- consultant can insert a submission at all.
revoke all on table public.platform_setting from public, anon, authenticated;

-- The safe default: nothing auto-accepts until Joshua deliberately turns it on.
insert into public.platform_setting (key, value)
values ('head_mentor_approval_mode', '"approve-all"'::jsonb)
on conflict (key) do nothing;

-- --------------------------------------------------------- D4. Assignment

create table if not exists public.assignment (
  id                    uuid primary key default gen_random_uuid(),
  subject_profile_id    uuid not null references public.profiles (id),
  consultant_profile_id uuid not null references public.consultant (profile_id),
  bundle_key            text not null references public.assessment_bundle (bundle_key),
  state                 text not null default 'proposed'
                          check (state in ('proposed','scheduled','held','submitted','returned','closed','cancelled')),
  scheduled_at          timestamptz,
  meeting_language      text,
  subject_l1            boolean,
  meeting_url           text,
  qualification_basis   text not null default '',
  rating_role           text not null default 'primary' check (rating_role in ('primary','second')),
  second_of             uuid references public.assignment (id),
  created_by            uuid references public.profiles (id),
  created_at            timestamptz not null default now(),
  -- A scheduled assignment with no date is the second refusal in the goal.
  constraint scheduled_needs_a_date check (state <> 'scheduled' or scheduled_at is not null),
  -- second_of is non-null exactly when rating_role = 'second'. Without this pair,
  -- two recommended_level values arrive for the same unit with no relationship
  -- between them and no rule for which reaches CBC.
  constraint second_of_matches_role check ((rating_role = 'second') = (second_of is not null)),
  constraint no_self_second check (second_of is null or second_of <> id),
  -- Exists only so submission's composite foreign key has something to point at.
  unique (id, bundle_key)
);

create index if not exists assignment_subject_idx on public.assignment (subject_profile_id);
create index if not exists assignment_consultant_idx on public.assignment (consultant_profile_id);

alter table public.assignment enable row level security;

-- Writes are closed by default and opened by column. No insert and no delete
-- grant to any client role: an assignment is created only by create_assignment().
-- An enforcement that lives only in an RPC is not an enforcement, because the
-- table is still there.
revoke all on table public.assignment from public, anon, authenticated;
grant select on table public.assignment to authenticated;
grant update (state, scheduled_at, meeting_url, meeting_language) on public.assignment to authenticated;

create table if not exists public.assignment_event (
  id             bigserial primary key,
  assignment_id  uuid not null references public.assignment (id) on delete cascade,
  kind           text not null check (kind in ('created','state-changed','rescheduled','meeting-url-set','language-set')),
  detail         jsonb not null default '{}'::jsonb,
  actor          uuid,
  at             timestamptz not null default now()
);

create index if not exists assignment_event_assignment_idx on public.assignment_event (assignment_id);

alter table public.assignment_event enable row level security;
-- No client write grant at all, on publication_event's precedent. If clients
-- could insert, a consultant could forge "the CIT agreed this date"; if they
-- cannot and no trigger writes, a consultant sets a date and nothing is recorded,
-- which is the likelier failure. Hence assignment_audit below.
revoke all on table public.assignment_event from public, anon, authenticated;
grant select on table public.assignment_event to authenticated;

-- --------------------------------------------------------- D5. The write-up

create table if not exists public.submission (
  id                    uuid primary key default gen_random_uuid(),
  assignment_id         uuid not null,
  bundle_key            text not null,
  consultant_profile_id uuid not null references public.consultant (profile_id),
  body_md               text not null default '',
  strength_note         text,
  growth_note_1         text,
  growth_note_2         text,
  context_note          text,
  connection_quality    text check (connection_quality in ('good','patchy','poor')),
  -- No default, so absence cannot mean yes.
  consent_recorded      boolean not null,
  -- Never collapses manual-upload and a future zoom-api into one value.
  transcript_source     text not null default 'none' check (transcript_source in ('manual-upload','none')),
  submitted_at          timestamptz,
  -- Null means the CIT sees nothing. Release is mandatory before a rating reaches
  -- CBC: you cannot recommend a certification score the person never saw.
  released_at           timestamptz,
  approval_state        text not null default 'awaiting-head-mentor'
                          check (approval_state in ('awaiting-head-mentor','auto-accepted','approved','returned')),
  approved_by           uuid references public.profiles (id),
  approved_at           timestamptz,
  return_reason         text,
  foreign key (assignment_id, bundle_key) references public.assignment (id, bundle_key),
  unique (id, bundle_key)
);

create index if not exists submission_assignment_idx on public.submission (assignment_id);

alter table public.submission enable row level security;
revoke all on table public.submission from public, anon, authenticated;
grant select, insert on table public.submission to authenticated;
-- approval_state, approved_by and approved_at are NOT in this list. A consultant
-- writing them directly is refused at the grant with 42501, which fires before
-- any policy is consulted and is the louder failure.
grant update (body_md, strength_note, growth_note_1, growth_note_2, context_note,
              connection_quality, transcript_source, submitted_at, released_at)
  on public.submission to authenticated;

-- The per-unit payload, and the table the approved plan was missing.
create table if not exists public.submission_rating (
  submission_id        uuid not null,
  bundle_key           text not null,
  unit_key             text not null,
  -- Separate columns, because the write-up form asks for both and a system
  -- storing one has lost the distinction between what the evaluator saw and what
  -- they think CBC should record.
  observed_level       smallint not null check (observed_level between 0 and 3),
  recommended_level    smallint not null check (recommended_level between 0 and 3),
  confidence           text not null check (confidence in ('low','medium','high')),
  -- not null, because the form's discipline is "one sentence naming the specific
  -- thing said or done" and a nullable column is an optional field.
  evidence_sentence    text not null check (length(btrim(evidence_sentence)) > 0),
  -- Its own column rather than a line in the prose: decision 5 makes it the
  -- primary depth signal, and a signal buried in free text cannot be counted at
  -- calibration.
  plain_language_check text not null check (plain_language_check in ('yes','partly','no')),
  plain_language_note  text,
  escalate             boolean not null default false,
  primary key (submission_id, unit_key),
  -- A rating cannot escape its bundle. A CHECK cannot contain a subquery, so the
  -- first draft's "check constraint refuses a rating whose unit_key is not in the
  -- assignment's bundle" would have failed at definition time. Two composite
  -- foreign keys do it declaratively instead. The chain runs submission_rating ->
  -- submission -> assignment -> assessment_bundle, and assignment_change_guard
  -- forbids moving an assignment between bundles, so an update cannot dodge it.
  foreign key (submission_id, bundle_key) references public.submission (id, bundle_key),
  foreign key (bundle_key, unit_key) references public.bundle_unit (bundle_key, unit_key)
);

alter table public.submission_rating enable row level security;
revoke all on table public.submission_rating from public, anon, authenticated;
grant select, insert on table public.submission_rating to authenticated;
grant update (observed_level, recommended_level, confidence, evidence_sentence,
              plain_language_check, plain_language_note, escalate)
  on public.submission_rating to authenticated;

create table if not exists public.submission_file (
  id             uuid primary key default gen_random_uuid(),
  submission_id  uuid not null references public.submission (id) on delete cascade,
  kind           text not null check (kind in ('transcript','writeup','other')),
  storage_path   text,
  -- Exists so the wave-1 Google Doc fallback migrates without retyping: the doc's
  -- markdown export becomes submission.body_md and its URL becomes a row here.
  source_url     text,
  filename       text not null,
  bytes          bigint check (bytes >= 0),
  mime           text,
  uploaded_at    timestamptz not null default now(),
  retain_until   date
);

alter table public.submission_file enable row level security;
revoke all on table public.submission_file from public, anon, authenticated;
grant select, insert on table public.submission_file to authenticated;

-- ###########################################################################
-- SECTION 3. Functions. After the tables, because `language sql` bodies are
-- parsed for table existence at CREATE time.
-- ###########################################################################

-- `stable security definer`, not "pure" (which is not a Postgres property) and
-- not invoker-rights. It reads platform_setting, which every client role is
-- revoked from, so an invoker-rights function would fail 42501 inside the
-- submission trigger and no write-up could ever be saved. The definer rights are
-- the whole reason a consultant can insert a submission at all.
--
-- Its own function so all four combinations can be tested without inserting a
-- submission, and so CDT-03's verification trigger calls the same rule rather
-- than reimplementing it.
create or replace function public.approval_state_for(_evaluator uuid)
returns text language sql stable security definer set search_path = public
as $$
  select case
    when (select value #>> '{}' from platform_setting where key = 'head_mentor_approval_mode') = 'trust-mentors'
     and coalesce((select is_cbc_mentor from consultant where profile_id = _evaluator), false)
    then 'auto-accepted'
    else 'awaiting-head-mentor'
  end;
$$;

revoke execute on function public.approval_state_for(uuid) from public, anon;
grant execute on function public.approval_state_for(uuid) to authenticated;

-- ------------------------------------- the qualification rule, in one place
--
-- The rule the assignment RPC and the guard trigger both need, factored out so
-- the two doors cannot drift and so criterion 3 can test it without inserting an
-- assignment.
--
-- **Scope matching is a hierarchy, not equality, and getting this wrong is
-- invisible.** The first draft of this migration joined on
-- `scope_kind = scope_kind and scope_key = scope_key`, which looks right and
-- silently breaks the spec's own worked example: I-1's rows are the six domains,
-- the adult-education case holds `('category','gc-adult-education')`, and under
--   equality it is
-- refused on I-1. Criterion 3 names her as accepted. So the three cases:
--
--   * exact (kind, key) — a grant that names what the bundle names.
--   * a CATEGORY grant satisfies a DOMAIN row it sits inside. This is what admits
--     an adult-education specialist to I-1, and it is the case equality misses.
--   * a DOMAIN grant satisfies a CATEGORY row inside it. This is finding 1's
--     over-grant, kept deliberately: a broad qualification really does cover its
--     categories. The mitigation is that whoever records a grant picks the
--     narrowest scope that is true, and that criterion 3 prints I-1's permissive
--     rows rather than hiding them.
--
--   * 'bundle' matches only 'bundle', by exact grant_key. A credential is not in
--     the domain hierarchy, which is the point of scoping I-4 that way.
--
-- It reads `category_domain`, using ALL links rather than only primaries. One
-- category is double-listed across two domains on purpose, and a consultant
-- holding either domain genuinely covers it.
create or replace function public.qualification_covers(_consultant uuid, _bundle_key text)
returns boolean language sql stable security definer set search_path = public
as $$
  select exists (
    select 1
      from consultant_qualification cq
      join bundle_qualification bq on bq.bundle_key = _bundle_key
     where cq.profile_id = _consultant
       and (
            (cq.scope_kind = bq.scope_kind and cq.scope_key = bq.scope_key)
         or (cq.scope_kind = 'category' and bq.scope_kind = 'domain'
             and exists (select 1 from category_domain cd
                          where cd.category_key = cq.scope_key
                            and cd.domain_key = bq.scope_key))
         or (cq.scope_kind = 'domain' and bq.scope_kind = 'category'
             and exists (select 1 from category_domain cd
                          where cd.category_key = bq.scope_key
                            and cd.domain_key = cq.scope_key))
       )
  );
$$;

revoke execute on function public.qualification_covers(uuid, text) from public, anon;
grant execute on function public.qualification_covers(uuid, text) to authenticated;

-- ------------------------------------------- D7. The three read helpers
--
-- All three are `security definer`, which is what prevents infinite recursion:
-- they query `assignment`, whose own read policy calls helper 2, and a definer
-- function runs as the owner and bypasses RLS. `set search_path` also blocks SQL
-- inlining, which would re-expose the loop. Removing `security definer`, or
-- adding `force row level security` to assignment, turns this into
-- `42P17 infinite recursion detected in policy`.

-- 1. Ledger reach. The subject, anyone currently assessing them, and oversight.
--    A consultant keeps reach after an assignment closes, deliberately: a
--    consultant who cannot reread the record cannot answer a question about it.
create or replace function public.may_see_subject(_subject uuid)
returns boolean language sql stable security definer set search_path = public
as $$
  select _subject = auth.uid()
      or exists (select 1 from assignment
                  where subject_profile_id = _subject
                    and consultant_profile_id = auth.uid())
      or is_head_mentor() or is_portal_admin();
$$;

-- 2. One assignment and its audit trail. Its two parties, and oversight.
create or replace function public.may_see_assignment(_assignment_id uuid)
returns boolean language sql stable security definer set search_path = public
as $$
  select exists (select 1 from assignment a
                  where a.id = _assignment_id
                    and (a.subject_profile_id = auth.uid()
                      or a.consultant_profile_id = auth.uid()))
      or is_head_mentor() or is_portal_admin();
$$;

-- 3. A write-up. Its OWN author, oversight, and the subject only after release.
--    This is what keeps a second rater blind, and that is its point. Under a
--    subject-scoped rule, a consultant assigned to CIT X could read every other
--    consultant's submission for X, including their recommended_level. A second
--    rater who can read the first rater's number before submitting theirs is not
--    a second rater, and the plan spends 15 hours of this round on that coverage.
create or replace function public.may_see_submission(_submission_id uuid)
returns boolean language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from submission s join assignment a on a.id = s.assignment_id
     where s.id = _submission_id
       and (s.consultant_profile_id = auth.uid()
         or (a.subject_profile_id = auth.uid() and s.released_at is not null))
  ) or is_head_mentor() or is_portal_admin();
$$;

revoke execute on function public.may_see_subject(uuid) from public, anon;
grant execute on function public.may_see_subject(uuid) to authenticated;
revoke execute on function public.may_see_assignment(uuid) from public, anon;
grant execute on function public.may_see_assignment(uuid) to authenticated;
revoke execute on function public.may_see_submission(uuid) from public, anon;
grant execute on function public.may_see_submission(uuid) to authenticated;

-- ###########################################################################
-- SECTION 4. Policies. Every read policy is exactly one of five named
-- expressions, and criterion 6 asserts that from the catalog.
--
--   E1 may_see_subject(...)          cit_enrollment
--   E2 may_see_assignment(...)       assignment, assignment_event
--   E3 may_see_submission(...)       submission, submission_rating, submission_file
--   E4 the consultant-self clause    consultant, consultant_qualification
--   E5 literal true                  the four reference-shaped tables
--
-- The spec's criterion 6 names four. E5 is the fifth and is called out rather
-- than folded in: `assessment_bundle`, `bundle_unit`, `bundle_qualification` and
-- `head_mentor` name no participants and must be readable by every signed-in
-- user, because a CIT must be able to read the instrument they sit. Asserting
-- five named classes and failing on anything unclassified is stronger than
-- asserting four and quietly exempting the rest. `platform_setting` gets no
-- policy at all, which is its design.
-- ###########################################################################

-- E5, the reference-shaped tables.
drop policy if exists "head mentors are visible to signed-in users" on public.head_mentor;
create policy "head mentors are visible to signed-in users" on public.head_mentor
  for select to authenticated using (true);

drop policy if exists "bundles are readable by signed-in users" on public.assessment_bundle;
create policy "bundles are readable by signed-in users" on public.assessment_bundle
  for select to authenticated using (true);

drop policy if exists "bundle units are readable by signed-in users" on public.bundle_unit;
create policy "bundle units are readable by signed-in users" on public.bundle_unit
  for select to authenticated using (true);

drop policy if exists "bundle qualifications are readable by signed-in users" on public.bundle_qualification;
create policy "bundle qualifications are readable by signed-in users" on public.bundle_qualification
  for select to authenticated using (true);

drop policy if exists "bundle grants are readable by signed-in users" on public.bundle_grant;
create policy "bundle grants are readable by signed-in users" on public.bundle_grant
  for select to authenticated using (true);

-- E4, the consultant-self clause. `consultant` and `consultant_qualification` are
-- not subject-keyed: their profile_id is a consultant, so may_see_subject() here
-- would be a category error.
drop policy if exists "a consultant sees their own record, and oversight sees all" on public.consultant;
create policy "a consultant sees their own record, and oversight sees all" on public.consultant
  for select to authenticated
  using (profile_id = auth.uid() or is_head_mentor() or is_portal_admin());

drop policy if exists "a consultant sees their own grants, and oversight sees all" on public.consultant_qualification;
create policy "a consultant sees their own grants, and oversight sees all" on public.consultant_qualification
  for select to authenticated
  using (profile_id = auth.uid() or is_head_mentor() or is_portal_admin());

-- E1.
drop policy if exists "an enrollment is visible to its subject and oversight" on public.cit_enrollment;
create policy "an enrollment is visible to its subject and oversight" on public.cit_enrollment
  for select to authenticated using (may_see_subject(profile_id));

-- E2.
drop policy if exists "an assignment is visible to its two parties and oversight" on public.assignment;
create policy "an assignment is visible to its two parties and oversight" on public.assignment
  for select to authenticated using (may_see_assignment(id));

drop policy if exists "an assignment is updatable by its two parties and oversight" on public.assignment;
create policy "an assignment is updatable by its two parties and oversight" on public.assignment
  for update to authenticated
  using (may_see_assignment(id))
  with check (may_see_assignment(id));

drop policy if exists "an audit trail follows its assignment" on public.assignment_event;
create policy "an audit trail follows its assignment" on public.assignment_event
  for select to authenticated using (may_see_assignment(assignment_id));

-- E3.
drop policy if exists "a write-up is visible to its author, oversight, and the subject after release" on public.submission;
create policy "a write-up is visible to its author, oversight, and the subject after release" on public.submission
  for select to authenticated using (may_see_submission(id));

drop policy if exists "a consultant writes up their own assignment" on public.submission;
create policy "a consultant writes up their own assignment" on public.submission
  for insert to authenticated
  with check (
    consultant_profile_id = auth.uid()
    and exists (select 1 from assignment a
                 where a.id = assignment_id
                   and a.consultant_profile_id = auth.uid())
  );

drop policy if exists "a write-up is editable by its own author" on public.submission;
create policy "a write-up is editable by its own author" on public.submission
  for update to authenticated
  using (may_see_submission(id))
  with check (may_see_submission(id));

drop policy if exists "a rating follows its write-up" on public.submission_rating;
create policy "a rating follows its write-up" on public.submission_rating
  for select to authenticated using (may_see_submission(submission_id));

drop policy if exists "a rating is written by its write-up's author" on public.submission_rating;
create policy "a rating is written by its write-up's author" on public.submission_rating
  for insert to authenticated
  with check (exists (select 1 from submission s
                       where s.id = submission_id
                         and s.consultant_profile_id = auth.uid()));

drop policy if exists "a rating is edited by its write-up's author" on public.submission_rating;
create policy "a rating is edited by its write-up's author" on public.submission_rating
  for update to authenticated
  using (may_see_submission(submission_id))
  with check (may_see_submission(submission_id));

drop policy if exists "an attachment follows its write-up" on public.submission_file;
create policy "an attachment follows its write-up" on public.submission_file
  for select to authenticated using (may_see_submission(submission_id));

drop policy if exists "an attachment is added by its write-up's author" on public.submission_file;
create policy "an attachment is added by its write-up's author" on public.submission_file
  for insert to authenticated
  with check (exists (select 1 from submission s
                       where s.id = submission_id
                         and s.consultant_profile_id = auth.uid()));

-- ###########################################################################
-- SECTION 5. Triggers and RPCs.
-- ###########################################################################

-- ------------------------ one column referencing three tables, so no FK

create or replace function public.qualification_scope_guard()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  if new.scope_kind = 'domain' then
    if not exists (select 1 from competency_domain where domain_key = new.scope_key) then
      raise exception 'no such domain: %', new.scope_key using errcode = 'foreign_key_violation';
    end if;
  elsif new.scope_kind = 'category' then
    if not exists (select 1 from competency_category where category_key = new.scope_key) then
      raise exception 'no such category: %', new.scope_key using errcode = 'foreign_key_violation';
    end if;
  elsif new.scope_kind = 'bundle' then
    -- Against bundle_grant, not assessment_bundle. See that table's comment.
    if not exists (select 1 from bundle_grant where grant_key = new.scope_key) then
      raise exception
        'no such bundle-scoped grant: %. A grant nobody holds refuses every assignment.', new.scope_key
        using errcode = 'foreign_key_violation';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists consultant_qualification_scope on public.consultant_qualification;
create trigger consultant_qualification_scope
  before insert or update on public.consultant_qualification
  for each row execute function public.qualification_scope_guard();

drop trigger if exists bundle_qualification_scope on public.bundle_qualification;
create trigger bundle_qualification_scope
  before insert or update on public.bundle_qualification
  for each row execute function public.qualification_scope_guard();

-- The other direction: a delete that would orphan a grant is refused. CDT-01's
-- seed prints "rows that would disappear", so a category delete is a real event
-- and not a hypothetical.
create or replace function public.refuse_orphaning_category_delete()
returns trigger language plpgsql security definer set search_path = public
as $$
declare _n integer;
begin
  select count(*) into _n from consultant_qualification
   where scope_kind = 'category' and scope_key = old.category_key;
  if _n > 0 then
    raise exception 'category % still backs % qualification grant(s)', old.category_key, _n
      using errcode = 'foreign_key_violation';
  end if;
  select count(*) into _n from bundle_qualification
   where scope_kind = 'category' and scope_key = old.category_key;
  if _n > 0 then
    raise exception 'category % still qualifies % bundle row(s)', old.category_key, _n
      using errcode = 'foreign_key_violation';
  end if;
  return old;
end;
$$;

drop trigger if exists category_delete_guard on public.competency_category;
create trigger category_delete_guard
  before delete on public.competency_category
  for each row execute function public.refuse_orphaning_category_delete();

-- On bundle_grant, not assessment_bundle: a 'bundle'-scoped grant's scope_key is
-- a grant_key, so deleting a bundle_grant is what orphans it. Deleting an
-- assessment_bundle is already refused by real foreign keys from bundle_unit,
-- bundle_qualification and assignment, so it needs no trigger.
create or replace function public.refuse_orphaning_bundle_delete()
returns trigger language plpgsql security definer set search_path = public
as $$
declare _n integer;
begin
  select count(*) into _n from consultant_qualification
   where scope_kind = 'bundle' and scope_key = old.grant_key;
  if _n > 0 then
    raise exception 'grant % is still held by % consultant(s)', old.grant_key, _n
      using errcode = 'foreign_key_violation';
  end if;
  select count(*) into _n from bundle_qualification
   where scope_kind = 'bundle' and scope_key = old.grant_key;
  if _n > 0 then
    raise exception 'grant % still qualifies % bundle row(s)', old.grant_key, _n
      using errcode = 'foreign_key_violation';
  end if;
  return old;
end;
$$;

drop trigger if exists bundle_delete_guard on public.assessment_bundle;
drop trigger if exists bundle_grant_delete_guard on public.bundle_grant;
create trigger bundle_grant_delete_guard
  before delete on public.bundle_grant
  for each row execute function public.refuse_orphaning_bundle_delete();

-- ---------------------------------------------------------- the double door
--
-- The RPC is the door a person uses; the trigger is the door a service-role
-- script or a hand-typed statement uses, and only one of those gets reviewed.

create or replace function public.assignment_qualification_guard()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  -- The rule itself is qualification_covers(); this trigger is only the door.
  if not qualification_covers(new.consultant_profile_id, new.bundle_key) then
    raise exception
      'consultant % holds no qualification that covers bundle %', new.consultant_profile_id, new.bundle_key
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

drop trigger if exists assignment_qualification on public.assignment;
create trigger assignment_qualification
  before insert or update on public.assignment
  for each row execute function public.assignment_qualification_guard();

-- Two rules a policy cannot hold. The identity rules compare OLD to NEW, and
-- `with check` sees only NEW. The transition rule is about order, and the closed
-- vocabulary in the CHECK constrains the values and not the order, so without
-- this `proposed` jumps to `closed` and `submitted` reverts to avoid a return.
create or replace function public.assignment_change_guard()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  if new.consultant_profile_id <> old.consultant_profile_id
     or new.subject_profile_id <> old.subject_profile_id
     or new.bundle_key <> old.bundle_key
     or new.rating_role <> old.rating_role
     or coalesce(new.second_of::text, '') <> coalesce(old.second_of::text, '') then
    raise exception
      'an assignment''s parties, bundle and rating role are fixed once created; create a new assignment instead'
      using errcode = 'check_violation';
  end if;

  if new.state <> old.state then
    if not (
         (old.state = 'proposed'  and new.state in ('scheduled','cancelled'))
      or (old.state = 'scheduled' and new.state in ('held','cancelled'))
      or (old.state = 'held'      and new.state in ('submitted','cancelled'))
      or (old.state = 'submitted' and new.state in ('returned','closed'))
      or (old.state = 'returned'  and new.state = 'submitted')
    ) then
      raise exception 'illegal state transition: % -> %', old.state, new.state
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists assignment_change on public.assignment;
create trigger assignment_change
  before update on public.assignment
  for each row execute function public.assignment_change_guard();

-- Scheduling is manual this round, so the event log is the only record that a
-- date was agreed rather than imposed.
create or replace function public.assignment_audit()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    insert into assignment_event (assignment_id, kind, detail, actor)
    values (new.id, 'created',
            jsonb_build_object('bundle_key', new.bundle_key, 'rating_role', new.rating_role),
            auth.uid());
    return new;
  end if;

  if new.state is distinct from old.state then
    insert into assignment_event (assignment_id, kind, detail, actor)
    values (new.id, 'state-changed',
            jsonb_build_object('from', old.state, 'to', new.state), auth.uid());
  end if;
  if new.scheduled_at is distinct from old.scheduled_at then
    insert into assignment_event (assignment_id, kind, detail, actor)
    values (new.id, 'rescheduled',
            jsonb_build_object('from', old.scheduled_at, 'to', new.scheduled_at), auth.uid());
  end if;
  if new.meeting_url is distinct from old.meeting_url then
    insert into assignment_event (assignment_id, kind, detail, actor)
    values (new.id, 'meeting-url-set', '{}'::jsonb, auth.uid());
  end if;
  if new.meeting_language is distinct from old.meeting_language then
    insert into assignment_event (assignment_id, kind, detail, actor)
    values (new.id, 'language-set',
            jsonb_build_object('to', new.meeting_language), auth.uid());
  end if;
  return new;
end;
$$;

drop trigger if exists assignment_audit_trail on public.assignment;
create trigger assignment_audit_trail
  after insert or update on public.assignment
  for each row execute function public.assignment_audit();

create or replace function public.create_assignment(
  _subject uuid,
  _consultant uuid,
  _bundle_key text,
  _qualification_basis text,
  _rating_role text default 'primary',
  _second_of uuid default null
) returns uuid
language plpgsql security definer set search_path = public
as $$
declare _id uuid;
begin
  if not (is_portal_admin() or is_head_mentor()) then
    raise exception 'Only a portal administrator or head mentor can create an assignment.'
      using errcode = 'insufficient_privilege';
  end if;

  -- The qualification rule is NOT repeated here. assignment_qualification_guard
  -- fires on this insert, so the RPC and the direct statement are refused by the
  -- same code, and the rule cannot drift between the two doors.
  insert into assignment (subject_profile_id, consultant_profile_id, bundle_key,
                          qualification_basis, rating_role, second_of, created_by)
  values (_subject, _consultant, _bundle_key,
          coalesce(_qualification_basis, ''), _rating_role, _second_of, auth.uid())
  returning id into _id;

  return _id;
end;
$$;

revoke execute on function public.create_assignment(uuid, uuid, text, text, text, uuid) from public, anon;
grant execute on function public.create_assignment(uuid, uuid, text, text, text, uuid) to authenticated;

-- --------------------------------------------------- approval and the lock

create or replace function public.submission_set_approval_state()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  new.approval_state := approval_state_for(new.consultant_profile_id);
  new.approved_by := null;
  new.approved_at := null;
  return new;
end;
$$;

drop trigger if exists submission_approval_state on public.submission;
create trigger submission_approval_state
  before insert on public.submission
  for each row execute function public.submission_set_approval_state();

-- Nothing is editable after approval, otherwise the approval trail records
-- agreement to a document that no longer exists. The head-mentor RPCs set a
-- transaction-local flag to do their own work; `current_setting(..., true)`
-- returns null rather than raising when the flag was never set.
create or replace function public.refuse_change_after_approval()
returns trigger language plpgsql security definer set search_path = public
as $$
declare _approved_at timestamptz;
begin
  if coalesce(current_setting('cdt.approval_override', true), '') = 'on' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  if tg_table_name = 'submission' then
    _approved_at := old.approved_at;
  else
    select s.approved_at into _approved_at from submission s where s.id = old.submission_id;
  end if;

  if _approved_at is not null then
    raise exception
      'this write-up was approved at % and is now read-only; a head mentor must return it first', _approved_at
      using errcode = 'check_violation';
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists submission_locked_after_approval on public.submission;
create trigger submission_locked_after_approval
  before update or delete on public.submission
  for each row execute function public.refuse_change_after_approval();

drop trigger if exists submission_rating_locked_after_approval on public.submission_rating;
create trigger submission_rating_locked_after_approval
  before update or delete on public.submission_rating
  for each row execute function public.refuse_change_after_approval();

create or replace function public.approve_submission(_submission_id uuid)
returns void language plpgsql security definer set search_path = public
as $$
begin
  if not is_head_mentor() then
    raise exception 'Only a head mentor in a two-factor session can approve a write-up.'
      using errcode = 'insufficient_privilege';
  end if;
  -- You cannot recommend a certification score the person never saw.
  if not exists (select 1 from submission where id = _submission_id and released_at is not null) then
    raise exception 'a write-up must be released to its subject before it can be approved'
      using errcode = 'check_violation';
  end if;
  perform set_config('cdt.approval_override', 'on', true);
  update submission
     set approval_state = 'approved', approved_by = auth.uid(), approved_at = now(),
         return_reason = null
   where id = _submission_id;
  perform set_config('cdt.approval_override', 'off', true);
end;
$$;

revoke execute on function public.approve_submission(uuid) from public, anon;
grant execute on function public.approve_submission(uuid) to authenticated;

create or replace function public.return_submission(_submission_id uuid, _reason text)
returns void language plpgsql security definer set search_path = public
as $$
begin
  if not is_head_mentor() then
    raise exception 'Only a head mentor in a two-factor session can return a write-up.'
      using errcode = 'insufficient_privilege';
  end if;
  if coalesce(btrim(_reason), '') = '' then
    raise exception 'a returned write-up needs a reason' using errcode = 'check_violation';
  end if;
  perform set_config('cdt.approval_override', 'on', true);
  update submission
     set approval_state = 'returned', approved_by = null, approved_at = null,
         return_reason = _reason
   where id = _submission_id;
  perform set_config('cdt.approval_override', 'off', true);
end;
$$;

revoke execute on function public.return_submission(uuid, text) from public, anon;
grant execute on function public.return_submission(uuid, text) to authenticated;

create or replace function public.set_platform_setting(_key text, _value jsonb)
returns void language plpgsql security definer set search_path = public
as $$
begin
  if not is_head_mentor() then
    raise exception 'Only a head mentor in a two-factor session can change a platform setting.'
      using errcode = 'insufficient_privilege';
  end if;
  insert into platform_setting (key, value, updated_by, updated_at)
  values (_key, _value, auth.uid(), now())
  on conflict (key) do update
    set value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at;
end;
$$;

revoke execute on function public.set_platform_setting(text, jsonb) from public, anon;
grant execute on function public.set_platform_setting(text, jsonb) to authenticated;

-- A trigger function is called by its trigger, never by a client. Revoking from
-- authenticated too is the difference between "no client needs this" and "no
-- client can call this".
revoke execute on function public.qualification_scope_guard() from public, anon, authenticated;
revoke execute on function public.refuse_orphaning_category_delete() from public, anon, authenticated;
revoke execute on function public.refuse_orphaning_bundle_delete() from public, anon, authenticated;
revoke execute on function public.assignment_qualification_guard() from public, anon, authenticated;
revoke execute on function public.assignment_change_guard() from public, anon, authenticated;
revoke execute on function public.assignment_audit() from public, anon, authenticated;
revoke execute on function public.submission_set_approval_state() from public, anon, authenticated;
revoke execute on function public.refuse_change_after_approval() from public, anon, authenticated;

-- ###########################################################################
-- SECTION 6. D8. Storage. Two private buckets with different boundary shapes.
--
-- No audio and no video in either allowlist, and here is where that control
-- ends. Supabase Storage validates the Content-Type the UPLOADER declares. A
-- consultant who renames session.mp3 to session.pdf and sends application/pdf
-- stores audio in the bucket. Real enforcement needs magic-byte inspection and
-- this host has no server to do it in. So: the allowlist stops the accident and
-- the handbook stops the rest, with retain_until as the backstop.
-- docs/ASSESSMENT.md carries that sentence too, because a threat model that
-- overstates its protection is worse than none.
-- ###########################################################################

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'cdt-evidence', 'cdt-evidence', false, 10485760,
  array['application/pdf',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'text/plain','text/markdown','image/png','image/jpeg']
)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'cdt-submissions', 'cdt-submissions', false, 26214400,
  array['application/pdf',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'text/plain','text/markdown','text/vtt','application/x-subrip']
)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- The submissions bucket's first path segment is an assignment id, not the
-- caller, so it needs an indirection. The regex guard runs BEFORE the cast:
-- without it a non-uuid first segment raises `invalid input syntax for type
-- uuid`, which is an error page rather than a refusal.
create or replace function public.may_write_assignment_path(_first_segment text)
returns boolean language plpgsql stable security definer set search_path = public
as $$
begin
  if _first_segment is null
     or _first_segment !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;
  return exists (
    select 1 from assignment
     where id = _first_segment::uuid
       and consultant_profile_id = auth.uid()
  );
end;
$$;

revoke execute on function public.may_write_assignment_path(text) from public, anon;
grant execute on function public.may_write_assignment_path(text) to authenticated;

-- cdt-evidence: a direct comparison, because the first segment IS the caller.
drop policy if exists "evidence is written by its owner" on storage.objects;
create policy "evidence is written by its owner" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'cdt-evidence'
              and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "evidence is read by its owner and oversight" on storage.objects;
create policy "evidence is read by its owner and oversight" on storage.objects
  for select to authenticated
  using (bucket_id = 'cdt-evidence'
         and ((storage.foldername(name))[1] = auth.uid()::text
              or is_head_mentor() or is_portal_admin()));

-- cdt-submissions: an indirection through assignment.
drop policy if exists "a submission file is written by its assignment's consultant" on storage.objects;
create policy "a submission file is written by its assignment's consultant" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'cdt-submissions'
              and may_write_assignment_path((storage.foldername(name))[1]));

drop policy if exists "a submission file is read by its assignment's parties" on storage.objects;
create policy "a submission file is read by its assignment's parties" on storage.objects
  for select to authenticated
  using (bucket_id = 'cdt-submissions'
         and (may_write_assignment_path((storage.foldername(name))[1])
              or is_head_mentor() or is_portal_admin()));

commit;
