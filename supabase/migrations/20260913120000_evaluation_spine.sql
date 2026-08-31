-- ###########################################################################
-- SITE-01: the evaluation as data, and the two reads a facilitator gets.
--
-- Spec: Projects/OBT/OBT Consultant Track/Site and Feedback Specs/
--       SITE-01-evaluation-schema.md
-- Campaign tracker: 00-program-site.md in the same folder.
--
-- ELEVEN objects are created here, and the count is stated because the spec's
-- own count is wrong and this header is what criterion 1 is checked against.
-- D1 says "nine" and then lists ten; `evaluation_participant` was added by
-- SITE-02's review without the sentence above the list being updated, which is
-- the third time this campaign has miscounted its own tables. The eleventh,
-- `evaluation_respondent_group`, is new in the build and its reason is R1 below.
--
--   1  workshop_evaluation_round     a round, its window and its state
--   2  evaluation_respondent_group   the audience groups, from the contract
--   3  evaluation_item               a rateable thing from Session-Map.md
--   4  evaluation_question           a question from Question-Set.md
--   5  evaluation_response           one per participant per round
--   6  evaluation_item_rating        a rating of an item
--   7  evaluation_answer             an answer to a question, text or scale
--   8  evaluation_import             provenance of a Google Form import
--   9  evaluation_reader             who may call the facilitator reads
--  10  evaluation_salt               the per-round secret, revoked from all
--  11  evaluation_participant        who is in a round at all
--
-- ## Four reconciliations the build made, because the instrument moved after
-- ## this spec was frozen on 2026-08-25
--
-- SITE-00 was revised on 2026-08-26 and again on 2026-08-28. Both revisions
-- reach into this schema, and a session reading only the spec would build the
-- wrong thing.
--
-- R1. `respondent_group` is a foreign key to a seeded table, not a CHECK.
--     The audience groups went from three to four on 2026-08-28: `facilitator`
--     split into `consultant` and `consultant-evaluator`, because someone
--     evaluating the CiTs while a session runs is watching it from a different
--     seat. A CHECK would have made that a migration. The groups come from
--     Question-Set.md through seed_evaluation_instrument.py, exactly as items
--     and questions do, which is program rubric row 4 applied to a column the
--     spec did not anticipate. It has already changed once; assume it changes
--     again.
--
-- R2. An answer carries a scale as well as a body, and the shape is bound
--     declaratively rather than trusted. Round 1 is now `aggregate`: its three
--     ratings are `rating_choice` QUESTIONS, not per-session items, and round
--     2's `q-overall` is a `choice` question. So evaluation_answer must hold
--     (attended, rating) as well as body. `answer_shape` and `absence_allowed`
--     are generated on the question and denormalised onto the answer, bound by
--     a four-column foreign key on submission_rating's precedent
--     (assessment_spine.sql:414-442), because a CHECK cannot hold a subquery.
--     The answer's own CHECK is then total over its own columns.
--
-- R3. The summary takes a group and suppresses the cell it publishes, not the
--     item total. Question-Set.md writes forward: "SITE-01's aggregate and
--     comment feed must decide separately what its smallest publishable
--     denominator is, and a group of two or three is under any reasonable
--     line." `consultant-evaluator` may be two or three people on this
--     workshop. So min_n is applied to whatever population is returned.
--
-- R4. `suppressed` is its own column, because a null mean is now ambiguous.
--     Session-Map.md keeps every item active under `aggregate`, deliberately,
--     since the map is the record of what the workshop taught and the portal
--     asks per-session later. So round 1's items exist here with no ratings at
--     all, and "no data" became the common case rather than the edge case. A
--     reader cannot tell it from "suppressed" by looking at a null.
--
-- ## What is NOT here
--
-- No facilitator UI; the two functions are the whole facilitator surface. No
-- Honest Eval integration, per program finding 7. No competency self-rating,
-- per SITE-00 decision 3. And nothing is reachable by any human yet, because
-- member_allowlist holds zero rows: program finding 3, named in D0 rather than
-- discovered halfway.
-- ###########################################################################


-- ###########################################################################
-- SECTION 1. Tables.
-- ###########################################################################

-- --------------------------------------------------------------- 1. Round

create table if not exists public.workshop_evaluation_round (
  round_key    text primary key check (round_key = btrim(round_key) and length(round_key) > 0),
  workshop_key text not null references public.events (id),
  display_name text not null check (length(btrim(display_name)) > 0),
  opens_at     timestamptz not null,
  closes_at    timestamptz not null,
  -- The administrative override, distinct from the clock. A round can be held
  -- shut past opens_at, and can be declared closed early.
  --
  -- Open and closed are NOT complements, and that is deliberate: a `draft`
  -- round is neither. It accepts no submission and publishes no aggregate,
  -- which is what you want while a seed is being checked.
  state        text not null default 'draft' check (state in ('draft','open','closed')),
  created_at   timestamptz not null default now(),
  check (closes_at > opens_at)
);

comment on table public.workshop_evaluation_round is
  'One evaluation round of one workshop. Openness is state=open AND inside the '
  'window; closedness is state=closed OR past closes_at. See '
  'evaluation_round_is_open() and evaluation_round_is_closed(), which are the '
  'only two places that rule is written.';

-- ------------------------------------------------- 2. Respondent groups (R1)

create table if not exists public.evaluation_respondent_group (
  group_key text primary key check (group_key ~ '^[a-z][a-z0-9-]*$'),
  -- Unique because the LABEL is what arrives in a Google Form export. Two
  -- groups sharing one label cannot be told apart by the importer, which is the
  -- refusal build_evaluation_form.py already makes on the contract side.
  label     text not null unique check (length(btrim(label)) > 0),
  ordinal   integer not null,
  updated_at timestamptz not null default now()
);

comment on table public.evaluation_respondent_group is
  'The audience groups, seeded from Question-Set.md. R1: this is a table and '
  'not a CHECK because the set went from three to four on 2026-08-28, and a '
  'CHECK would have made the next change a migration.';

-- ---------------------------------------------------------------- 3. Items

create table if not exists public.evaluation_item (
  round_key   text not null references public.workshop_evaluation_round (round_key) on delete cascade,
  item_key    text not null check (item_key ~ '^w[0-9]+d[0-9]+-[a-z0-9]+$'),
  day         integer not null,
  part        text not null check (part in ('devotional','morning','afternoon','fullday')),
  kind        text not null check (kind in ('devotional','session','practicum','workblock','ceremony')),
  title       text not null default '',
  facilitator text not null default '',
  ordinal     integer not null,
  -- Session-Map.md's `auto` resolves to a boolean here: active if the row has a
  -- title. The map keeps the three-valued word; the database keeps the answer.
  active      boolean not null,
  note        text not null default '',
  updated_at  timestamptz not null default now(),
  primary key (round_key, item_key)
);

comment on table public.evaluation_item is
  'A rateable thing, seeded from Session-Map.md. Items exist for every round '
  'whatever that round''s Google Form shape was: R4. An `aggregate` round asks '
  'none of them on the form and the portal asks all of them later.';

-- ------------------------------------------------------------ 4. Questions

create table if not exists public.evaluation_question (
  round_key    text not null references public.workshop_evaluation_round (round_key) on delete cascade,
  question_key text not null check (question_key ~ '^q-[a-z0-9-]+$'),
  ordinal      integer not null,
  kind         text not null check (kind in ('long_text','short_text','choice','rating_choice')),
  required     boolean not null,
  prompt       text not null check (length(btrim(prompt)) > 0),
  active       boolean not null default true,
  -- R2. Generated, not written, so a seed cannot get them wrong, and STORED so
  -- they can carry a unique constraint an answer's foreign key references.
  --
  --   answer_shape     where the answer lives: a body, or a rating.
  --   absence_allowed   whether "I wasn't there" is on offer. A `choice` has no
  --                     absence option and a `rating_choice` does, so a null
  --                     rating is expected in one and impossible in the other.
  --                     An importer that could not tell them apart would read a
  --                     missing answer as a real one.
  answer_shape text generated always as (
    case when kind in ('choice','rating_choice') then 'scale' else 'text' end
  ) stored,
  absence_allowed boolean generated always as (kind = 'rating_choice') stored,
  updated_at   timestamptz not null default now(),
  primary key (round_key, question_key),
  -- The referent of evaluation_answer's four-column foreign key. Redundant as a
  -- uniqueness statement; it exists so the binding below is declarative.
  unique (round_key, question_key, answer_shape, absence_allowed)
);

comment on table public.evaluation_question is
  'A question, seeded from Question-Set.md. `choice` and `rating_choice` carry '
  'a rating rather than a body, which is what round 1''s aggregate shape made '
  'the common case: R2.';

-- ------------------------------------------------------------ 5. Responses

create table if not exists public.evaluation_response (
  id                uuid primary key default gen_random_uuid(),
  round_key         text not null references public.workshop_evaluation_round (round_key),
  -- Nullable, because D6 imports Google Form responses whose address is not on
  -- the allowlist and those are left unattached rather than guessed. What an
  -- unattached response loses is the participant's own ability to read it back,
  -- which is D8 sentence 6 and criterion 14.
  profile_id        uuid references public.profiles (id),
  respondent_group  text references public.evaluation_respondent_group (group_key),
  state             text not null default 'draft' check (state in ('draft','submitted')),
  -- Provenance. 'portal' is a filing through submit_evaluation(); 'manual' is a
  -- Google Form import, on docs/PORTAL.md:203's rule. An imported response is
  -- distinguishable from a portal filing forever.
  source            text not null default 'portal' check (source in ('portal','manual')),
  import_id         uuid,
  submitted_at      timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  -- Exists only so the composite foreign keys below can reference it.
  unique (id, round_key)
);

-- PARTIAL, and this is the whole point. A plain `unique (round_key,
-- profile_id)` would silently stop constraining anything the moment profile_id
-- went nullable, because Postgres admits unlimited nulls in a unique index, and
-- the constraint that reads as "one response per participant per round" would
-- be enforcing nothing for exactly the rows D6 creates.
create unique index if not exists evaluation_response_one_per_participant
  on public.evaluation_response (round_key, profile_id)
  where profile_id is not null;

create index if not exists evaluation_response_round_idx
  on public.evaluation_response (round_key);

-- ------------------------------------------------------- 6. Item ratings

create table if not exists public.evaluation_item_rating (
  response_id uuid not null,
  -- Denormalised so the two composite foreign keys below can exist. A rating
  -- keyed only (response_id, item_key) carries no round, so nothing declarative
  -- stops a rating citing another round's item_key: spec finding 2, and the
  -- same shape assessment_spine.sql:414-442 solved for submission_rating.
  round_key   text not null,
  item_key    text not null,
  attended    boolean not null,
  rating      smallint,
  comment     text,
  created_at  timestamptz not null default now(),
  primary key (response_id, item_key),
  -- Spec finding 1, and this form is the corrected one. The obvious
  --   check ((attended and rating between 1 and 5) or (not attended and rating is null))
  -- ACCEPTS (attended = true, rating = null): with a null rating the left
  -- branch is `true and NULL` which is NULL, the right branch is false, and
  -- `NULL or false` is NULL, which satisfies a CHECK. It therefore admits an
  -- attended item with no rating, the second of the two things it was written
  -- to forbid. `rating is not null` is what closes it, and criterion 4 tests
  -- all four corners rather than two.
  constraint evaluation_item_rating_scale check (
    (attended and rating is not null and rating between 1 and 5)
    or ((not attended) and rating is null)
  ),
  -- A form field submits '' and null is the honest value for "said nothing".
  constraint evaluation_item_rating_comment_nonblank check (
    comment is null or length(btrim(comment)) > 0
  ),
  foreign key (response_id, round_key) references public.evaluation_response (id, round_key) on delete cascade,
  foreign key (round_key, item_key) references public.evaluation_item (round_key, item_key)
);

create index if not exists evaluation_item_rating_item_idx
  on public.evaluation_item_rating (round_key, item_key);

-- ---------------------------------------------------------- 7. Answers

create table if not exists public.evaluation_answer (
  response_id     uuid not null,
  round_key       text not null,
  question_key    text not null,
  -- R2. Denormalised from the question so the CHECK below is total over this
  -- row's own columns, and bound to the question by the four-column foreign key
  -- so it cannot disagree with the question it answers.
  answer_shape    text not null check (answer_shape in ('text','scale')),
  absence_allowed boolean not null,
  body            text,
  attended        boolean,
  rating          smallint,
  created_at      timestamptz not null default now(),
  primary key (response_id, question_key),
  -- Total over the four combinations that matter, in one constraint per shape.
  constraint evaluation_answer_shape check (
    case answer_shape
      when 'text' then
        body is not null and length(btrim(body)) > 0
        and attended is null and rating is null
      when 'scale' then
        body is null
        and attended is not null
        and (
          (attended and rating is not null and rating between 1 and 5)
          or ((not attended) and rating is null)
        )
    end
  ),
  -- A `choice` question offers the five attended choices and no absence option,
  -- so `attended = false` against one is not a real answer. Declarative,
  -- because absence_allowed arrives through the foreign key from the question's
  -- own generated column and cannot be set independently.
  constraint evaluation_answer_absence check (
    absence_allowed or attended is null or attended
  ),
  foreign key (response_id, round_key) references public.evaluation_response (id, round_key) on delete cascade,
  -- Named, not left to Postgres. The generated name for a four-column foreign
  -- key is truncated to 63 characters in the middle of a column name, so
  -- anything that has to drop and restore it (the harness's mutation 8) would
  -- depend on guessing where the truncation fell.
  constraint evaluation_answer_shape_fkey
    foreign key (round_key, question_key, answer_shape, absence_allowed)
    references public.evaluation_question (round_key, question_key, answer_shape, absence_allowed)
);

create index if not exists evaluation_answer_question_idx
  on public.evaluation_answer (round_key, question_key);

-- ----------------------------------------------------------- 8. Imports

create table if not exists public.evaluation_import (
  id             uuid primary key default gen_random_uuid(),
  round_key      text not null references public.workshop_evaluation_round (round_key),
  source_file    text not null,
  source_digest  text not null,
  -- WHICH MANIFEST it mapped against, not which map. D6: the map that generated
  -- the 28 August form is guaranteed not to be the map read in September,
  -- because Joshua closes its blank rows on site.
  manifest_file  text not null,
  manifest_digest text not null,
  rows_read      integer not null,
  rows_imported  integer not null,
  rows_unattached integer not null,
  operator       text not null,
  imported_at    timestamptz not null default now()
);

alter table public.evaluation_response
  drop constraint if exists evaluation_response_import_fk;
alter table public.evaluation_response
  add constraint evaluation_response_import_fk
  foreign key (import_id) references public.evaluation_import (id);

-- A response is imported or it is not, and the two columns must agree. A
-- `manual` row with no import has lost its provenance; a `portal` row with one
-- is a contradiction.
alter table public.evaluation_response
  drop constraint if exists evaluation_response_source_provenance;
alter table public.evaluation_response
  add constraint evaluation_response_source_provenance check (
    (source = 'manual' and import_id is not null)
    or (source = 'portal' and import_id is null)
  );

-- ----------------------------------------------------------- 9. Readers

create table if not exists public.evaluation_reader (
  profile_id uuid primary key references public.profiles (id) on delete cascade,
  note       text not null default '',
  added_by   uuid references public.profiles (id),
  added_at   timestamptz not null default now()
);

comment on table public.evaluation_reader is
  'Who may call the two facilitator reads. Tracker open item 3 names the set. '
  'The disclosure panel promises a NAMED set, so a set that grows quietly stops '
  'being a promise: membership goes through add_evaluation_reader().';

-- -------------------------------------------------------------- 10. Salt

create table if not exists public.evaluation_salt (
  round_key  text primary key references public.workshop_evaluation_round (round_key) on delete cascade,
  salt       text not null default encode(gen_random_bytes(32), 'hex'),
  created_at timestamptz not null default now()
);

comment on table public.evaluation_salt is
  'The per-round secret that keys the comment feed''s permutation. Spec finding '
  '3: md5(response_id || item_key) is computable by anyone, and a facilitator '
  'who files a test response to see how the form works then holds the mapping '
  'for it and can exclude it to narrow the rest. Revoked from every client '
  'role and read only inside evaluation_comments().';

-- ------------------------------------------------------- 11. Participants

create table if not exists public.evaluation_participant (
  round_key  text not null references public.workshop_evaluation_round (round_key) on delete cascade,
  profile_id uuid not null references public.profiles (id) on delete cascade,
  added_at   timestamptz not null default now(),
  primary key (round_key, profile_id)
);

comment on table public.evaluation_participant is
  'Who is in a round at all. Added by SITE-02''s review: nothing else links a '
  'person to a round, so without it every portal member sees every round and a '
  'crash-course alumnus can file into the Psalms aggregate. Criterion 17.';


-- ###########################################################################
-- SECTION 2. Grants. Stated per table, because Supabase's default ACL grants
-- `anon` full write on every new public table: sibling finding 28 measured
-- `anon=arwdDxtm/postgres` in pg_default_acl for schema public ON THIS PROJECT.
-- A table that only enables RLS and says nothing about grants is not safe.
--
-- The three participant tables carry SELECT and nothing else, per spec finding
-- 5: an insert or update grant plus a policy lets a participant write straight
-- through PostgREST and every refusal inside submit_evaluation() becomes
-- optional. submit_evaluation() is the sole write path, so it is the rule
-- rather than a second opinion.
-- ###########################################################################

alter table public.workshop_evaluation_round    enable row level security;
alter table public.evaluation_respondent_group  enable row level security;
alter table public.evaluation_item              enable row level security;
alter table public.evaluation_question          enable row level security;
alter table public.evaluation_response          enable row level security;
alter table public.evaluation_item_rating       enable row level security;
alter table public.evaluation_answer            enable row level security;
alter table public.evaluation_import            enable row level security;
alter table public.evaluation_reader            enable row level security;
alter table public.evaluation_salt              enable row level security;
alter table public.evaluation_participant       enable row level security;

revoke all on table public.workshop_evaluation_round   from public, anon, authenticated;
revoke all on table public.evaluation_respondent_group from public, anon, authenticated;
revoke all on table public.evaluation_item             from public, anon, authenticated;
revoke all on table public.evaluation_question         from public, anon, authenticated;
revoke all on table public.evaluation_response         from public, anon, authenticated;
revoke all on table public.evaluation_item_rating      from public, anon, authenticated;
revoke all on table public.evaluation_answer           from public, anon, authenticated;
revoke all on table public.evaluation_import           from public, anon, authenticated;
revoke all on table public.evaluation_reader           from public, anon, authenticated;
revoke all on table public.evaluation_salt             from public, anon, authenticated;
revoke all on table public.evaluation_participant      from public, anon, authenticated;

-- The instrument. A participant has to see it to answer it, and none of it
-- carries anyone's data.
grant select on table public.workshop_evaluation_round   to authenticated;
grant select on table public.evaluation_respondent_group to authenticated;
grant select on table public.evaluation_item             to authenticated;
grant select on table public.evaluation_question         to authenticated;
grant select on table public.evaluation_participant      to authenticated;

-- The three participant tables. SELECT only. No insert, no update, no delete,
-- to any client role, ever.
grant select on table public.evaluation_response    to authenticated;
grant select on table public.evaluation_item_rating to authenticated;
grant select on table public.evaluation_answer      to authenticated;

-- evaluation_reader, evaluation_salt and evaluation_import get NO grant to any
-- client role, on member_allowlist's precedent. The salt is the one that would
-- actually cost something: it is the key to the comment feed's permutation.


-- ###########################################################################
-- SECTION 3. Functions. After the tables, because a `language sql` body is
-- parsed for table existence at CREATE time.
-- ###########################################################################

-- ------------------------------------------------- Round state, in one place

-- Two helpers rather than one, and they are not complements. A draft round is
-- neither open nor closed. Written once each so criterion 11's mutation has a
-- single place to break.
create or replace function public.evaluation_round_is_open(_round_key text)
returns boolean language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from workshop_evaluation_round
    where round_key = _round_key
      and state = 'open'
      and now() >= opens_at
      and now() < closes_at
  );
$$;

create or replace function public.evaluation_round_is_closed(_round_key text)
returns boolean language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from workshop_evaluation_round
    where round_key = _round_key
      and (state = 'closed' or now() >= closes_at)
  );
$$;

revoke execute on function public.evaluation_round_is_open(text)   from public, anon;
revoke execute on function public.evaluation_round_is_closed(text) from public, anon;
grant  execute on function public.evaluation_round_is_open(text)   to authenticated;
grant  execute on function public.evaluation_round_is_closed(text) to authenticated;

-- ------------------------------------------------------- Reader membership

-- `stable security definer`, and the definer rights are load-bearing rather
-- than decorative: evaluation_reader is revoked from every client role, so an
-- invoker-rights function would raise 42501 for every caller and BOTH
-- facilitator reads would fail for everyone. Same mechanism approval_state_for()
-- documents at assessment_spine.sql:476.
create or replace function public.is_evaluation_reader()
returns boolean language sql stable security definer set search_path = public
as $$
  select exists (select 1 from evaluation_reader where profile_id = auth.uid());
$$;

revoke execute on function public.is_evaluation_reader() from public, anon;
grant  execute on function public.is_evaluation_reader() to authenticated;

create or replace function public.add_evaluation_reader(_profile_id uuid, _note text default '')
returns void language plpgsql security definer set search_path = public
as $$
begin
  if not is_portal_admin() then
    raise exception 'Only a portal administrator can add an evaluation reader.'
      using errcode = 'insufficient_privilege';
  end if;
  insert into evaluation_reader (profile_id, note, added_by)
  values (_profile_id, coalesce(_note, ''), auth.uid())
  on conflict (profile_id) do update
    set note = excluded.note, added_by = excluded.added_by, added_at = now();
end;
$$;

create or replace function public.remove_evaluation_reader(_profile_id uuid)
returns void language plpgsql security definer set search_path = public
as $$
begin
  if not is_portal_admin() then
    raise exception 'Only a portal administrator can remove an evaluation reader.'
      using errcode = 'insufficient_privilege';
  end if;
  delete from evaluation_reader where profile_id = _profile_id;
end;
$$;

revoke execute on function public.add_evaluation_reader(uuid, text) from public, anon;
revoke execute on function public.remove_evaluation_reader(uuid)    from public, anon;
grant  execute on function public.add_evaluation_reader(uuid, text) to authenticated;
grant  execute on function public.remove_evaluation_reader(uuid)    to authenticated;

-- ------------------------------------------------------- The one write path

-- One call, because PostgREST gives the client no transaction and a form that
-- writes a response, then its ratings, then its answers over three round trips
-- can leave a half-filed evaluation behind when the third fails.
--
-- Correcting forward, not aborting: the revise path is reached BY COMPARISON
-- against the existing row, never by attempting an insert and catching the
-- unique violation. Spec finding 9, learned the hard way in CDT-03's review: a
-- uniqueness constraint used as a no-op mechanism is an abort mechanism.
create or replace function public.submit_evaluation(
  _round_key        text,
  _respondent_group text,
  _ratings          jsonb default '[]'::jsonb,
  _answers          jsonb default '[]'::jsonb,
  _finish           boolean default true
)
returns uuid language plpgsql security definer set search_path = public
as $$
declare
  _uid         uuid := auth.uid();
  _response_id uuid;
  _missing     text;
  _bad         text;
begin
  if _uid is null then
    raise exception 'You have to be signed in to file an evaluation.'
      using errcode = 'insufficient_privilege';
  end if;

  if not evaluation_round_is_open(_round_key) then
    raise exception 'The % round is not open.', _round_key
      using errcode = 'check_violation';
  end if;

  -- Criterion 17. Without this any portal member can file into any aggregate,
  -- which is a data-integrity failure and not a display bug.
  if not exists (
    select 1 from evaluation_participant
    where round_key = _round_key and profile_id = _uid
  ) then
    raise exception 'You are not on the participant list for the % round.', _round_key
      using errcode = 'insufficient_privilege';
  end if;

  if not exists (
    select 1 from evaluation_respondent_group where group_key = _respondent_group
  ) then
    raise exception 'Unknown respondent group %.', _respondent_group
      using errcode = 'foreign_key_violation';
  end if;

  -- Refusal 1: a rating for an item that is not active in this round. Named
  -- rather than counted, because "3 of your ratings were dropped" is not a
  -- message anyone can act on.
  -- coalesce, because a payload element with no `item_key` yields NULL, and
  -- string_agg skips nulls: without it the worst-formed payload in the set is
  -- the one that reports nothing wrong.
  select string_agg(coalesce(x.item_key, '(missing item_key)'), ', ' order by x.item_key) into _bad
  from jsonb_to_recordset(_ratings) as x(item_key text, attended boolean, rating smallint, comment text)
  where not exists (
    select 1 from evaluation_item i
    where i.round_key = _round_key and i.item_key = x.item_key and i.active
  );
  if _bad is not null then
    raise exception 'Not an active item in the % round: %', _round_key, _bad
      using errcode = 'foreign_key_violation';
  end if;

  select string_agg(coalesce(x.question_key, '(missing question_key)'), ', ' order by x.question_key) into _bad
  from jsonb_to_recordset(_answers) as x(question_key text, body text, attended boolean, rating smallint)
  where not exists (
    select 1 from evaluation_question q
    where q.round_key = _round_key and q.question_key = x.question_key and q.active
  );
  if _bad is not null then
    raise exception 'Not an active question in the % round: %', _round_key, _bad
      using errcode = 'foreign_key_violation';
  end if;

  -- The response, found and updated or inserted.
  --
  -- The insert carries `on conflict … do update` rather than relying on the
  -- select having been right. Review finding 7: a bare find-then-insert is a
  -- TOCTOU, and a double-clicked submit is the ordinary way to hit it — two
  -- concurrent calls from one uid both see null, both insert, and the partial
  -- unique index aborts one of them. That is the very abort-instead-of-correct
  -- behaviour finding 9 was written to avoid, arriving through the door the fix
  -- left open. The `where profile_id is not null` matches the partial index's
  -- own predicate, which is what makes it a usable conflict target.
  insert into evaluation_response (round_key, profile_id, respondent_group, state, source)
  values (_round_key, _uid, _respondent_group, 'draft', 'portal')
  on conflict (round_key, profile_id) where profile_id is not null
  do update set respondent_group = excluded.respondent_group, updated_at = now()
  returning id into _response_id;

  -- Replace by comparison. Delete what this filing no longer carries, then
  -- upsert what it does, so a participant who clears a rating actually clears
  -- it rather than leaving the old value behind.
  -- `not exists` and not `not in`. A payload element missing its key yields a
  -- NULL, `x not in (…, NULL)` evaluates to NULL rather than true, and the
  -- delete would then quietly remove nothing at all: the revise path would look
  -- like it worked while every cleared rating stayed behind.
  delete from evaluation_item_rating r
  where r.response_id = _response_id
    and not exists (
      select 1 from jsonb_to_recordset(_ratings) as x(item_key text)
      where x.item_key = r.item_key
    );

  -- `distinct on`, because two elements carrying the same item_key make
  -- `on conflict … do update` raise 21000, "cannot affect row a second time".
  -- A form that renders one item twice is a bug, but aborting the whole filing
  -- is the wrong response to it: the last value wins, which is what a person
  -- editing the same field twice would expect.
  insert into evaluation_item_rating (response_id, round_key, item_key, attended, rating, comment)
  select distinct on (x.item_key)
         _response_id, _round_key, x.item_key, x.attended, x.rating,
         nullif(btrim(coalesce(x.comment, '')), '')
  from jsonb_to_recordset(_ratings) as x(item_key text, attended boolean, rating smallint, comment text)
  on conflict (response_id, item_key) do update
    set attended = excluded.attended,
        rating   = excluded.rating,
        comment  = excluded.comment;

  delete from evaluation_answer a
  where a.response_id = _response_id
    and not exists (
      select 1 from jsonb_to_recordset(_answers) as x(question_key text)
      where x.question_key = a.question_key
    );

  -- answer_shape and absence_allowed are read from the question, never taken
  -- from the caller: the four-column foreign key would refuse a mismatch
  -- anyway, and a caller who could choose the shape could choose to store a
  -- rating in a text question.
  insert into evaluation_answer
    (response_id, round_key, question_key, answer_shape, absence_allowed, body, attended, rating)
  select distinct on (q.question_key)
         _response_id, _round_key, q.question_key, q.answer_shape, q.absence_allowed,
         case when q.answer_shape = 'text'
              then nullif(btrim(coalesce(x.body, '')), '') end,
         case when q.answer_shape = 'scale' then x.attended end,
         case when q.answer_shape = 'scale' then x.rating end
  from jsonb_to_recordset(_answers) as x(question_key text, body text, attended boolean, rating smallint)
  join evaluation_question q
    on q.round_key = _round_key and q.question_key = x.question_key
  on conflict (response_id, question_key) do update
    set body     = excluded.body,
        attended = excluded.attended,
        rating   = excluded.rating;

  -- Refusal 2: a required question with no answer. Checked LAST, against what
  -- actually landed, so it cannot be satisfied by a blank string that the
  -- nullif above turned into a null.
  -- The required-answer check runs when this call finishes the response AND
  -- whenever the response is ALREADY submitted.
  --
  -- Review finding 4: with the check gated on `_finish` alone, the sequence
  -- submit(finish := true) then submit(round, group, '[]', '[]', false) deleted
  -- every rating and every answer and left `state = 'submitted'` untouched. The
  -- summary and both feeds filter on that state, so the round's submitted count
  -- stayed whole while the content was gone, and nothing anywhere would have
  -- noticed. "Submitted implies the required questions are answered" has to be
  -- an invariant of the row, not a property of the instant it was written.
  if _finish or (select state from evaluation_response where id = _response_id) = 'submitted' then
    select string_agg(q.question_key, ', ' order by q.question_key) into _missing
    from evaluation_question q
    where q.round_key = _round_key and q.active and q.required
      and not exists (
        select 1 from evaluation_answer a
        where a.response_id = _response_id and a.question_key = q.question_key
      );
    if _missing is not null then
      raise exception 'These questions are required and have no answer: %', _missing
        using errcode = 'not_null_violation';
    end if;

    if _finish then
      update evaluation_response
        set state = 'submitted', submitted_at = coalesce(submitted_at, now()), updated_at = now()
        where id = _response_id;
    end if;
  end if;

  return _response_id;
end;
$$;

revoke execute on function public.submit_evaluation(text, text, jsonb, jsonb, boolean) from public, anon;
grant  execute on function public.submit_evaluation(text, text, jsonb, jsonb, boolean) to authenticated;

-- ------------------------------------------------------ The two reads

-- `plpgsql` and not `language sql`, because a sql function cannot `raise` and
-- both refusals here are explicit. A silent empty result would be read as "no
-- one has answered yet".
--
-- Both refuse until the round is CLOSED. Spec finding 4: ordering was never the
-- only correlation channel. A reader calling the feed at 14:00 and again at
-- 14:20 gets a diff that is exactly the responses filed in that window,
-- attributable to whoever they watched filling the form, and n_rated leaks the
-- same signal through the summary. Nothing about the ordering defeats a clock.
create or replace function public.evaluation_summary(
  _round_key text,
  _group_key text default null
)
returns table (
  item_key     text,
  item_title   text,
  kind         text,
  n_rated      bigint,
  n_absent     bigint,
  suppressed   boolean,
  mean_rating  numeric,
  dist_1       bigint,
  dist_2       bigint,
  dist_3       bigint,
  dist_4       bigint,
  dist_5       bigint
)
language plpgsql stable security definer set search_path = public
as $$
declare
  _min_n integer;
begin
  if not is_evaluation_reader() then
    raise exception 'The evaluation summary is for the named evaluation readers.'
      using errcode = 'insufficient_privilege';
  end if;
  if not evaluation_round_is_closed(_round_key) then
    raise exception 'The % round is still open. The summary is published once it closes.', _round_key
      using errcode = 'check_violation';
  end if;
  if _group_key is not null and not exists (
    select 1 from evaluation_respondent_group g where g.group_key = _group_key
  ) then
    raise exception 'Unknown respondent group %.', _group_key
      using errcode = 'foreign_key_violation';
  end if;

  -- A platform_setting row, so raising the threshold is a row and not a
  -- migration. R3: it is applied to the population actually returned, which is
  -- one group's cell when a group is asked for. A group of two or three is
  -- under any reasonable line, and `consultant-evaluator` may be that small.
  select coalesce((select (value #>> '{}')::int from platform_setting
                   where key = 'evaluation_min_n'), 4)
    into _min_n;

  return query
  with all_rated as (
    select r.item_key, r.attended, r.rating, resp.respondent_group
    from evaluation_item_rating r
    join evaluation_response resp on resp.id = r.response_id
    where r.round_key = _round_key and resp.state = 'submitted'
  ),
  -- COMPLEMENTARY SUPPRESSION, and without it the group split gives back
  -- exactly what the per-cell suppression withholds.
  --
  -- Reproduced on 2026-08-31 before this clause existed. One item, four groups
  -- sized 6/5/2/4, min_n 4. The total published `dist=4,3,4,3,3`; the
  -- two-person `consultant-evaluator` cell was suppressed and returned no
  -- distribution; and subtracting the three published cells from the published
  -- total returned `0,0,1,0,1`, which is those two people's exact ratings. A
  -- reader holding two permitted reads recovers what neither read discloses.
  --
  -- So an item's group split is published ONLY IF every group that actually
  -- rated it meets min_n. Either every cell is publishable or none is, which
  -- leaves nothing to subtract. The ungrouped total is unaffected and still
  -- publishes, because it is what facilitators mainly want and it leaks nothing
  -- on its own.
  --
  -- The alternative, suppressing the TOTAL whenever any group is small, was
  -- rejected: with roughly twenty-two people across four groups and
  -- `consultant-evaluator` at two or three, it would have withheld the total on
  -- most items forever, which is a large cost to pay for a split that can
  -- simply be withheld instead.
  group_sizes as (
    -- Every column qualified by its alias. `item_key` is also an OUT parameter
    -- of this function, so an unqualified reference is ambiguous between the
    -- PL/pgSQL variable and the column, and Postgres refuses with 42702 rather
    -- than guessing.
    select a.item_key, min(a.n) as min_group_n
    from (
      select ar.item_key, ar.respondent_group,
             count(*) filter (where ar.attended) as n
      from all_rated ar
      group by ar.item_key, ar.respondent_group
    ) a
    where a.n > 0
    group by a.item_key
  ),
  rated as (
    select a.item_key, a.attended, a.rating
    from all_rated a
    where _group_key is null or a.respondent_group = _group_key
  ),
  agg as (
    select i.item_key, i.title, i.kind,
           count(*) filter (where x.attended)       as n_rated,
           count(*) filter (where not x.attended)   as n_absent,
           avg(x.rating) filter (where x.attended)  as mean_rating,
           count(*) filter (where x.rating = 1)     as d1,
           count(*) filter (where x.rating = 2)     as d2,
           count(*) filter (where x.rating = 3)     as d3,
           count(*) filter (where x.rating = 4)     as d4,
           count(*) filter (where x.rating = 5)     as d5,
           -- Publishable when this cell is big enough AND, on a grouped read,
           -- when every OTHER group's cell for the same item is big enough too.
           (count(*) filter (where x.attended) >= _min_n
            and (_group_key is null
                 or coalesce((select g.min_group_n from group_sizes g
                               where g.item_key = i.item_key), 0) >= _min_n)) as publishable
    from evaluation_item i
    left join rated x on x.item_key = i.item_key
    where i.round_key = _round_key and i.active
    group by i.item_key, i.title, i.kind
  )
  select a.item_key, a.title, a.kind,
         -- Review finding 5. A suppressed cell withholds its COUNTS too.
         -- "consultant-evaluator: n_rated 1, n_absent 1" on a named session is
         -- attribution on a group of two, whatever the mean does, and the
         -- published n is also what made the differencing in finding 1 exact
         -- rather than approximate. R4 still works: an item nobody rated reads
         -- n_rated = 0 with suppressed = false, which is distinguishable from a
         -- suppressed cell reading null with suppressed = true.
         case when a.publishable or a.n_rated = 0 then a.n_rated end,
         case when a.publishable or a.n_rated = 0 then a.n_absent end,
         -- R4. Its own column, because a null mean is ambiguous between "nobody
         -- rated it" and "suppressed", and Session-Map keeps every item active
         -- under an aggregate round, so round 1 has no per-item ratings at all
         -- and "no data" is the common case rather than the edge case.
         (a.n_rated > 0 and not a.publishable) as suppressed,
         case when a.publishable then round(a.mean_rating, 2) end,
         case when a.publishable then a.d1 end,
         case when a.publishable then a.d2 end,
         case when a.publishable then a.d3 end,
         case when a.publishable then a.d4 end,
         case when a.publishable then a.d5 end
  from agg a
  order by a.item_key;
end;
$$;

-- Exactly four columns, and criterion 7 asserts that SET rather than screening
-- for three forbidden names. No profile_id, no name, no timestamp, and no
-- response identifier, because a response identifier is a correlation key
-- wearing a disguise: it lines every comment a person wrote up with every other
-- one, across every session, which is the thing this feed exists not to do.
create or replace function public.evaluation_comments(_round_key text)
returns table (
  item_key   text,
  item_title text,
  kind       text,
  comment    text
)
language plpgsql stable security definer set search_path = public
as $$
declare
  _salt text;
begin
  if not is_evaluation_reader() then
    raise exception 'The comment feed is for the named evaluation readers.'
      using errcode = 'insufficient_privilege';
  end if;
  if not evaluation_round_is_closed(_round_key) then
    raise exception 'The % round is still open. The comments are published once it closes.', _round_key
      using errcode = 'check_violation';
  end if;

  -- Read inside the definer function, from a table revoked from every client
  -- role. Spec finding 3: without a secret the permutation is public, and one
  -- known response_id unlocks the whole feed.
  select s.salt into _salt from evaluation_salt s where s.round_key = _round_key;
  if _salt is null then
    raise exception 'The % round has no permutation salt, so the comment feed cannot be ordered safely.', _round_key
      using errcode = 'check_violation';
  end if;

  return query
  select i.item_key, i.title, i.kind, r.comment
  from evaluation_item_rating r
  join evaluation_response resp on resp.id = r.response_id
  join evaluation_item i on i.round_key = r.round_key and i.item_key = r.item_key
  where r.round_key = _round_key
    and resp.state = 'submitted'
    and r.comment is not null
  order by md5(_salt || r.response_id::text || r.item_key);
end;
$$;

-- The written answers, same rule. A `long_text` answer is the only place a
-- specific session gets named on an aggregate round, per Question-Set.md's
-- "what the cut costs", so a feed that carried ratings and not answers would
-- omit the half that now matters most.
create or replace function public.evaluation_answers_feed(_round_key text)
returns table (
  question_key text,
  prompt       text,
  body         text
)
language plpgsql stable security definer set search_path = public
as $$
declare
  _salt text;
begin
  if not is_evaluation_reader() then
    raise exception 'The answer feed is for the named evaluation readers.'
      using errcode = 'insufficient_privilege';
  end if;
  if not evaluation_round_is_closed(_round_key) then
    raise exception 'The % round is still open. The answers are published once it closes.', _round_key
      using errcode = 'check_violation';
  end if;

  select s.salt into _salt from evaluation_salt s where s.round_key = _round_key;
  if _salt is null then
    raise exception 'The % round has no permutation salt, so the answer feed cannot be ordered safely.', _round_key
      using errcode = 'check_violation';
  end if;

  return query
  select q.question_key, q.prompt, a.body
  from evaluation_answer a
  join evaluation_response resp on resp.id = a.response_id
  join evaluation_question q on q.round_key = a.round_key and q.question_key = a.question_key
  where a.round_key = _round_key
    and resp.state = 'submitted'
    and a.answer_shape = 'text'
    and a.body is not null
  order by md5(_salt || a.response_id::text || a.question_key);
end;
$$;

revoke execute on function public.evaluation_summary(text, text)   from public, anon;
revoke execute on function public.evaluation_comments(text)        from public, anon;
revoke execute on function public.evaluation_answers_feed(text)    from public, anon;
grant  execute on function public.evaluation_summary(text, text)   to authenticated;
grant  execute on function public.evaluation_comments(text)        to authenticated;
grant  execute on function public.evaluation_answers_feed(text)    to authenticated;


-- ###########################################################################
-- SECTION 4. Policies.
--
-- Every one of these is a SELECT policy, because no client role holds an
-- insert, update or delete grant on anything here. A write policy would be a
-- second opinion on a grant that already refuses with 42501 before any policy
-- is consulted, which is the louder failure.
-- ###########################################################################

-- The instrument, readable by any signed-in member: a participant has to see it
-- to answer it, and none of it carries anyone's data.
drop policy if exists round_read on public.workshop_evaluation_round;
create policy round_read on public.workshop_evaluation_round
  for select to authenticated using (true);

drop policy if exists group_read on public.evaluation_respondent_group;
create policy group_read on public.evaluation_respondent_group
  for select to authenticated using (true);

drop policy if exists item_read on public.evaluation_item;
create policy item_read on public.evaluation_item
  for select to authenticated using (true);

drop policy if exists question_read on public.evaluation_question;
create policy question_read on public.evaluation_question
  for select to authenticated using (true);

-- Your own membership, and oversight's view of everyone's.
drop policy if exists participant_read_own on public.evaluation_participant;
create policy participant_read_own on public.evaluation_participant
  for select to authenticated
  using (profile_id = auth.uid() or is_head_mentor() or is_portal_admin());

-- The three participant tables. A participant reads their own rows ALWAYS,
-- including after closes_at: that is program rubric row 5, and it is the one
-- policy not scoped by the round's state. A round that locks its own author out
-- when it closes has collected data rather than helped anyone reflect.
drop policy if exists response_read_own on public.evaluation_response;
create policy response_read_own on public.evaluation_response
  for select to authenticated
  using (profile_id = auth.uid() or is_head_mentor() or is_portal_admin());

drop policy if exists rating_read_own on public.evaluation_item_rating;
create policy rating_read_own on public.evaluation_item_rating
  for select to authenticated
  using (
    exists (
      select 1 from evaluation_response r
      where r.id = evaluation_item_rating.response_id and r.profile_id = auth.uid()
    )
    or is_head_mentor() or is_portal_admin()
  );

drop policy if exists answer_read_own on public.evaluation_answer;
create policy answer_read_own on public.evaluation_answer
  for select to authenticated
  using (
    exists (
      select 1 from evaluation_response r
      where r.id = evaluation_answer.response_id and r.profile_id = auth.uid()
    )
    or is_head_mentor() or is_portal_admin()
  );

-- evaluation_reader, evaluation_salt and evaluation_import get NO policy, and
-- no grant either. Two locks rather than one, because either alone is a single
-- edit away from opening.


-- ###########################################################################
-- SECTION 5. Settings.
-- ###########################################################################

-- The smallest publishable denominator, seeded rather than left to the
-- function's coalesce default so it is visible in a table a person can read.
-- Decision 2 recommends 4 and says to re-measure the roster before fixing it;
-- set_platform_setting() moves it, gated on a head mentor at aal2.
insert into public.platform_setting (key, value)
values ('evaluation_min_n', '4'::jsonb)
on conflict (key) do nothing;


-- ###########################################################################
-- SECTION 6. Catalog assertions. The header's claims, checked against the
-- catalog at apply time, so a migration that half-applied says so here rather
-- than in a build record written from hope.
-- ###########################################################################

do $$
declare
  _tables   int;
  _funcs    int;
  _bad      text;
begin
  select count(*) into _tables from pg_tables
   where schemaname = 'public'
     and tablename in (
       'workshop_evaluation_round','evaluation_respondent_group','evaluation_item',
       'evaluation_question','evaluation_response','evaluation_item_rating',
       'evaluation_answer','evaluation_import','evaluation_reader',
       'evaluation_salt','evaluation_participant');
  if _tables <> 11 then
    raise exception 'expected 11 tables from this migration, found %', _tables;
  end if;

  select count(*) into _funcs from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in (
       'evaluation_round_is_open','evaluation_round_is_closed','is_evaluation_reader',
       'add_evaluation_reader','remove_evaluation_reader','submit_evaluation',
       'evaluation_summary','evaluation_comments','evaluation_answers_feed');
  if _funcs <> 9 then
    raise exception 'expected 9 functions from this migration, found %', _funcs;
  end if;

  -- Every one of them must be a definer with a pinned search_path. A definer
  -- function with a searchable path is a privilege-escalation route.
  select string_agg(p.proname, ', ') into _bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in (
       'evaluation_round_is_open','evaluation_round_is_closed','is_evaluation_reader',
       'add_evaluation_reader','remove_evaluation_reader','submit_evaluation',
       'evaluation_summary','evaluation_comments','evaluation_answers_feed')
     and (not p.prosecdef or p.proconfig is null
          or not ('search_path=public' = any(p.proconfig)));
  if _bad is not null then
    raise exception 'not security definer with a pinned search_path: %', _bad;
  end if;

  -- anon holds nothing. Supabase's default ACL grants it everything on a new
  -- public table, so this is the assertion that the revokes above actually ran.
  select string_agg(t.tablename, ', ') into _bad
    from pg_tables t
   where t.schemaname = 'public'
     and t.tablename in (
       'workshop_evaluation_round','evaluation_respondent_group','evaluation_item',
       'evaluation_question','evaluation_response','evaluation_item_rating',
       'evaluation_answer','evaluation_import','evaluation_reader',
       'evaluation_salt','evaluation_participant')
     and (has_table_privilege('anon', 'public.' || t.tablename, 'SELECT')
       or has_table_privilege('anon', 'public.' || t.tablename, 'INSERT')
       or has_table_privilege('anon', 'public.' || t.tablename, 'UPDATE')
       or has_table_privilege('anon', 'public.' || t.tablename, 'DELETE'));
  if _bad is not null then
    raise exception 'anon still holds a privilege on: %', _bad;
  end if;

  -- authenticated holds SELECT and nothing else on the three participant
  -- tables. This is spec finding 5 asserted rather than described: with an
  -- insert or update grant, every refusal inside submit_evaluation() becomes
  -- optional.
  select string_agg(t.tablename, ', ') into _bad
    from pg_tables t
   where t.schemaname = 'public'
     and t.tablename in ('evaluation_response','evaluation_item_rating','evaluation_answer')
     and (has_table_privilege('authenticated', 'public.' || t.tablename, 'INSERT')
       or has_table_privilege('authenticated', 'public.' || t.tablename, 'UPDATE')
       or has_table_privilege('authenticated', 'public.' || t.tablename, 'DELETE'));
  if _bad is not null then
    raise exception 'authenticated can write to: %', _bad;
  end if;

  -- The three revoked tables are revoked from authenticated too, not only anon.
  select string_agg(t.tablename, ', ') into _bad
    from pg_tables t
   where t.schemaname = 'public'
     and t.tablename in ('evaluation_reader','evaluation_salt','evaluation_import')
     and has_table_privilege('authenticated', 'public.' || t.tablename, 'SELECT');
  if _bad is not null then
    raise exception 'authenticated can read: %', _bad;
  end if;

  raise notice 'SITE-01: 11 tables, 9 functions, grants asserted.';
end;
$$;
