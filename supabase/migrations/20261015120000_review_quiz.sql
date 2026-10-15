-- ###########################################################################
-- SITE-19: a review quiz in the member portal.
--
-- Spec: Projects/OBT/OBT Consultant Track/Site and Feedback Specs/
--       SITE-19-review-quiz.md
-- Campaign tracker: 00-program-site.md in the same folder.
--
-- The slot is 20261015120000, not the spec's 20261016120000: the spec dated the
-- slot for the day after drafting and said to rename it to the build's own day,
-- which is 2026-10-15. Still above the ledger tip 20260916120000.
--
-- FIVE tables and TWO functions are created here. Nothing existing is altered.
--
--   1  quiz              one quiz, the review it pairs with, whether it is open
--   2  quiz_question     a question, its stem and its explanation      NO GRANT
--   3  quiz_choice       a choice, and whether it is the right one      NO GRANT
--   4  quiz_attempt      one submitted answer set, scored by the server
--   5  quiz_completion   the first attempt that reached a full score
--
--   quiz_paper(text)                   the questions and choices, no key
--   submit_quiz_attempt(text, jsonb)   score one attempt as the caller
--
-- ## The answer key is an authorization question, so it has two locks
--
-- quiz_question and quiz_choice are revoked from every client role AND have RLS
-- on with no policy. A column grant hiding only `is_correct` was the other way,
-- and Supabase's own column-security page advises against it: it breaks
-- `select *` and is easy to widen by accident. So a client reads the paper only
-- through quiz_paper(), whose result columns are a fixed allowlist with no key
-- in it, and learns whether a pick was right only by submitting it.
--
-- A member CAN learn the key by submitting A for everything, then B. That is
-- inherent to retake-until-right on a formative self-test and is accepted in
-- the spec (stage 2). The control is against shipping the key in a read.
--
-- ## Explanations are part of the key
--
-- Quiz 1's explanations name the right letter ("Answer: C. Some cultures..."),
-- so an explanation is returned only for a question the caller has already
-- answered correctly in one of their own attempts (decision 1, 2026-10-15).
--
-- ## Keyed on the caller
--
-- submit_quiz_attempt() takes no profile id. It writes auth.uid() and refuses a
-- null caller. The attempt and completion read policies are the owner only,
-- with no oversight clause, so program finding 37's superset cannot arise here.
--
-- ## Ledger
--
-- scripts/apply-migration.mjs records no ledger row. Before the next `db push`:
--   supabase migration repair --status applied 20260821120000
--   supabase migration repair --status applied 20261015120000
-- ###########################################################################


-- ###########################################################################
-- SECTION 1. Tables.
-- ###########################################################################

create table if not exists public.quiz (
  quiz_key       text primary key check (quiz_key ~ '^[a-z0-9-]+$'),
  title          text not null check (btrim(title) <> ''),
  -- The review this quiz pairs with. The route and anchor build the "read it
  -- again" link on a not-yet answer; the block key is how the member page's
  -- link and the lane find the quiz that belongs to a review.
  review_route   text not null check (review_route ~ '^/'),
  review_anchor  text,
  review_block   text,
  source_digest  text not null,
  active         boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create table if not exists public.quiz_question (
  id            uuid primary key default gen_random_uuid(),
  quiz_key      text not null references public.quiz (quiz_key) on delete cascade,
  question_key  text not null check (question_key ~ '^q[0-9]{2}$'),
  position      int  not null check (position > 0),
  stem          text not null check (btrim(stem) <> ''),
  explanation   text,
  unique (quiz_key, question_key),
  unique (quiz_key, position)
);

create table if not exists public.quiz_choice (
  id           uuid primary key default gen_random_uuid(),
  question_id  uuid not null references public.quiz_question (id) on delete cascade,
  choice_key   text not null check (choice_key ~ '^[a-f]$'),
  position     int  not null check (position > 0),
  label        text not null check (btrim(label) <> ''),
  is_correct   boolean not null default false,
  unique (question_id, choice_key),
  unique (question_id, position)
);

-- At most one right choice per question. The seed enforces exactly one; this is
-- the half the database can hold on its own.
create unique index if not exists quiz_choice_one_correct
  on public.quiz_choice (question_id) where is_correct;

create table if not exists public.quiz_attempt (
  id             uuid primary key default gen_random_uuid(),
  quiz_key       text not null references public.quiz (quiz_key) on delete cascade,
  profile_id     uuid not null references public.profiles (id) on delete cascade,
  attempt_no     int  not null check (attempt_no > 0),
  submitted_at   timestamptz not null default now(),
  score          int  not null check (score >= 0),
  total          int  not null check (total > 0 and score <= total),
  source_digest  text not null,
  -- One element per question: {question_key, choice_key, correct}. The PICKED
  -- choice only, never the key of a choice the member did not pick.
  result         jsonb not null check (jsonb_typeof(result) = 'array')
);

-- A double submit cannot race two rows onto one attempt number: the second
-- insert fails and the client reports it (spec D1, review note).
create unique index if not exists quiz_attempt_one_per_number
  on public.quiz_attempt (quiz_key, profile_id, attempt_no);

create table if not exists public.quiz_completion (
  quiz_key              text not null references public.quiz (quiz_key) on delete cascade,
  profile_id            uuid not null references public.profiles (id) on delete cascade,
  completed_at          timestamptz not null default now(),
  attempt_id            uuid not null references public.quiz_attempt (id) on delete cascade,
  attempts_to_complete  int  not null check (attempts_to_complete > 0),
  primary key (quiz_key, profile_id)
);

alter table public.quiz            enable row level security;
alter table public.quiz_question   enable row level security;
alter table public.quiz_choice     enable row level security;
alter table public.quiz_attempt    enable row level security;
alter table public.quiz_completion enable row level security;


-- ###########################################################################
-- SECTION 2. Grants. Revoke first, because Supabase's default ACL grants anon
-- and authenticated everything on a new public table.
-- ###########################################################################

revoke all on table public.quiz            from public, anon, authenticated;
revoke all on table public.quiz_question   from public, anon, authenticated;
revoke all on table public.quiz_choice     from public, anon, authenticated;
revoke all on table public.quiz_attempt    from public, anon, authenticated;
revoke all on table public.quiz_completion from public, anon, authenticated;

-- SELECT only, and only on the three tables that carry no key. No insert,
-- update or delete on any of the five to any client role: every write goes
-- through submit_quiz_attempt(), and the seed writes as postgres.
grant select on table public.quiz            to authenticated;
grant select on table public.quiz_attempt    to authenticated;
grant select on table public.quiz_completion to authenticated;

-- quiz_question and quiz_choice: NO grant to any client role, and RLS on with
-- no policy, on evaluation_salt's precedent (evaluation_spine.sql section 2).


-- ###########################################################################
-- SECTION 3. Functions. After the tables, because a body is checked against
-- them at CREATE time.
-- ###########################################################################

-- ------------------------------------------------------------- quiz_paper
--
-- The questions and choices, one row per choice. The result columns are the
-- allowlist criterion 2 asserts set-equal; adding a column here is a contract
-- change, not a tidy-up. A changed column list needs a DROP first (program
-- finding 30), which is why this is not `create or replace` alone.
drop function if exists public.quiz_paper(text);
create function public.quiz_paper(_quiz_key text)
returns table (
  question_key       text,
  question_position  int,
  stem               text,
  choice_key         text,
  choice_position    int,
  label              text,
  explanation        text
)
language plpgsql stable security definer set search_path = public
as $$
#variable_conflict use_column
declare
  _uid uuid := auth.uid();
begin
  if _uid is null then
    raise exception 'You have to be signed in to take a quiz.'
      using errcode = 'insufficient_privilege';
  end if;
  if not exists (select 1 from quiz q where q.quiz_key = _quiz_key and q.active) then
    raise exception 'There is no open quiz called %.', _quiz_key
      using errcode = 'no_data_found';
  end if;

  return query
    select qq.question_key,
           qq.position,
           qq.stem,
           qc.choice_key,
           qc.position,
           qc.label,
           -- The explanation only where THIS caller has already been right on
           -- this question in one of their own attempts (decision 1).
           case when exists (
             select 1
               from quiz_attempt a,
                    jsonb_array_elements(a.result) r
              where a.quiz_key = _quiz_key
                and a.profile_id = _uid
                and r ->> 'question_key' = qq.question_key
                and (r ->> 'correct')::boolean
           ) then qq.explanation end
      from quiz_question qq
      join quiz_choice qc on qc.question_id = qq.id
     where qq.quiz_key = _quiz_key
     order by qq.position, qc.position;
end;
$$;

revoke execute on function public.quiz_paper(text) from public, anon;
grant  execute on function public.quiz_paper(text) to authenticated;

-- ---------------------------------------------------- submit_quiz_attempt
--
-- `_answers` is an ARRAY of {question_key, choice_key}, not an object keyed by
-- question. An object cannot carry a duplicate key once parsed (jsonb keeps the
-- last), so the "duplicate question" refusal the spec asks for would be
-- unreachable. Every question of the quiz must be named exactly once
-- (decision 2: every retake answers all ten).
drop function if exists public.submit_quiz_attempt(text, jsonb);
create function public.submit_quiz_attempt(_quiz_key text, _answers jsonb)
returns table (
  attempt_no    int,
  score         int,
  total         int,
  completed     boolean,
  question_key  text,
  choice_key    text,
  correct       boolean,
  explanation   text
)
language plpgsql security definer set search_path = public
as $$
#variable_conflict use_column
declare
  _uid      uuid := auth.uid();
  _digest   text;
  _bad      text;
  _total    int;
  _score    int;
  _no       int;
  _attempt  uuid;
  _result   jsonb;
  _done     boolean;
begin
  if _uid is null then
    raise exception 'You have to be signed in to submit a quiz.'
      using errcode = 'insufficient_privilege';
  end if;

  select q.source_digest into _digest from quiz q where q.quiz_key = _quiz_key and q.active;
  if _digest is null then
    raise exception 'There is no open quiz called %.', _quiz_key
      using errcode = 'no_data_found';
  end if;

  if _answers is null or jsonb_typeof(_answers) <> 'array'
     or exists (select 1 from jsonb_array_elements(_answers) e
                 where jsonb_typeof(e) <> 'object'
                    or coalesce(e ->> 'question_key', '') = ''
                    or coalesce(e ->> 'choice_key', '') = '') then
    raise exception 'The answers must be a list of {question_key, choice_key}.'
      using errcode = 'invalid_parameter_value';
  end if;

  -- A question named twice.
  select string_agg(k, ', ' order by k) into _bad
    from (select e ->> 'question_key' k from jsonb_array_elements(_answers) e
           group by 1 having count(*) > 1) d;
  if _bad is not null then
    raise exception 'Answered more than once: %', _bad
      using errcode = 'unique_violation';
  end if;

  -- Named but not a question of this quiz.
  select string_agg(e ->> 'question_key', ', ' order by e ->> 'question_key') into _bad
    from jsonb_array_elements(_answers) e
   where not exists (select 1 from quiz_question qq
                      where qq.quiz_key = _quiz_key and qq.question_key = e ->> 'question_key');
  if _bad is not null then
    raise exception 'Not a question in this quiz: %', _bad
      using errcode = 'invalid_parameter_value';
  end if;

  -- A question of this quiz with no answer.
  select string_agg(qq.question_key, ', ' order by qq.position) into _bad
    from quiz_question qq
   where qq.quiz_key = _quiz_key
     and not exists (select 1 from jsonb_array_elements(_answers) e
                      where e ->> 'question_key' = qq.question_key);
  if _bad is not null then
    raise exception 'These questions have no answer: %', _bad
      using errcode = 'not_null_violation';
  end if;

  -- A choice that is not a choice of its question.
  select string_agg(e ->> 'question_key', ', ' order by e ->> 'question_key') into _bad
    from jsonb_array_elements(_answers) e
   where not exists (
     select 1 from quiz_question qq join quiz_choice qc on qc.question_id = qq.id
      where qq.quiz_key = _quiz_key
        and qq.question_key = e ->> 'question_key'
        and qc.choice_key = e ->> 'choice_key');
  if _bad is not null then
    raise exception 'Not a choice of its question: %', _bad
      using errcode = 'invalid_parameter_value';
  end if;

  -- Score. One element per question: the PICKED choice and whether it was right.
  select count(*)::int,
         (count(*) filter (where qc.is_correct))::int,
         jsonb_agg(jsonb_build_object(
           'question_key', qq.question_key,
           'choice_key',   qc.choice_key,
           'correct',      qc.is_correct) order by qq.position)
    into _total, _score, _result
    from jsonb_array_elements(_answers) e
    join quiz_question qq on qq.quiz_key = _quiz_key and qq.question_key = e ->> 'question_key'
    join quiz_choice qc on qc.question_id = qq.id and qc.choice_key = e ->> 'choice_key';

  select coalesce(max(a.attempt_no), 0) + 1 into _no
    from quiz_attempt a where a.quiz_key = _quiz_key and a.profile_id = _uid;

  insert into quiz_attempt (quiz_key, profile_id, attempt_no, score, total, source_digest, result)
  values (_quiz_key, _uid, _no, _score, _total, _digest, _result)
  returning id into _attempt;

  -- Completion at a FULL score only, and once: the first date is kept.
  if _score = _total then
    insert into quiz_completion (quiz_key, profile_id, attempt_id, attempts_to_complete)
    values (_quiz_key, _uid, _attempt, _no)
    on conflict on constraint quiz_completion_pkey do nothing;
  end if;

  _done := exists (select 1 from quiz_completion c where c.quiz_key = _quiz_key and c.profile_id = _uid);

  return query
    select _no, _score, _total, _done,
           r ->> 'question_key',
           r ->> 'choice_key',
           (r ->> 'correct')::boolean,
           case when (r ->> 'correct')::boolean then qq.explanation end
      from jsonb_array_elements(_result) r
      join quiz_question qq on qq.quiz_key = _quiz_key and qq.question_key = r ->> 'question_key'
     order by qq.position;
end;
$$;

revoke execute on function public.submit_quiz_attempt(text, jsonb) from public, anon;
grant  execute on function public.submit_quiz_attempt(text, jsonb) to authenticated;


-- ###########################################################################
-- SECTION 4. Policies. SELECT only; no client role holds a write grant, so a
-- write policy would be a second opinion on a grant that already refuses.
-- ###########################################################################

drop policy if exists quiz_read on public.quiz;
create policy quiz_read on public.quiz
  for select to authenticated using (active);

-- The owner only. No is_portal_admin() or is_head_mentor() clause: Joshua's
-- completion list is a postgres script (site19-completions.mjs), so no browser
-- read ever needs the superset.
drop policy if exists quiz_attempt_read_own on public.quiz_attempt;
create policy quiz_attempt_read_own on public.quiz_attempt
  for select to authenticated using (profile_id = auth.uid());

drop policy if exists quiz_completion_read_own on public.quiz_completion;
create policy quiz_completion_read_own on public.quiz_completion
  for select to authenticated using (profile_id = auth.uid());


-- ###########################################################################
-- SECTION 5. Catalog assertions, checked at apply time.
-- ###########################################################################

do $$
declare
  _tables  int;
  _funcs   int;
  _bad     text;
begin
  select count(*) into _tables from pg_tables
   where schemaname = 'public'
     and tablename in ('quiz','quiz_question','quiz_choice','quiz_attempt','quiz_completion');
  if _tables <> 5 then
    raise exception 'expected 5 tables from this migration, found %', _tables;
  end if;

  select count(*) into _funcs from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname in ('quiz_paper','submit_quiz_attempt');
  if _funcs <> 2 then
    raise exception 'expected 2 functions from this migration, found %', _funcs;
  end if;

  select string_agg(p.proname, ', ') into _bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname in ('quiz_paper','submit_quiz_attempt')
     and (not p.prosecdef or p.proconfig is null
          or not ('search_path=public' = any(p.proconfig)));
  if _bad is not null then
    raise exception 'not security definer with a pinned search_path: %', _bad;
  end if;

  select string_agg(t.tablename, ', ') into _bad
    from pg_tables t
   where t.schemaname = 'public'
     and t.tablename in ('quiz','quiz_question','quiz_choice','quiz_attempt','quiz_completion')
     and (has_table_privilege('anon', 'public.' || t.tablename, 'SELECT')
       or has_table_privilege('anon', 'public.' || t.tablename, 'INSERT')
       or has_table_privilege('anon', 'public.' || t.tablename, 'UPDATE')
       or has_table_privilege('anon', 'public.' || t.tablename, 'DELETE'));
  if _bad is not null then
    raise exception 'anon still holds a privilege on: %', _bad;
  end if;

  select string_agg(t.tablename, ', ') into _bad
    from pg_tables t
   where t.schemaname = 'public'
     and t.tablename in ('quiz_question','quiz_choice')
     and (has_table_privilege('authenticated', 'public.' || t.tablename, 'SELECT')
       or has_table_privilege('authenticated', 'public.' || t.tablename, 'INSERT')
       or has_table_privilege('authenticated', 'public.' || t.tablename, 'UPDATE')
       or has_table_privilege('authenticated', 'public.' || t.tablename, 'DELETE'));
  if _bad is not null then
    raise exception 'authenticated holds a privilege on a key table: %', _bad;
  end if;

  select string_agg(t.tablename, ', ') into _bad
    from pg_tables t
   where t.schemaname = 'public'
     and t.tablename in ('quiz','quiz_question','quiz_choice','quiz_attempt','quiz_completion')
     and (has_table_privilege('authenticated', 'public.' || t.tablename, 'INSERT')
       or has_table_privilege('authenticated', 'public.' || t.tablename, 'UPDATE')
       or has_table_privilege('authenticated', 'public.' || t.tablename, 'DELETE'));
  if _bad is not null then
    raise exception 'authenticated can write to: %', _bad;
  end if;

  if has_function_privilege('anon', 'public.quiz_paper(text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.submit_quiz_attempt(text, jsonb)', 'EXECUTE') then
    raise exception 'anon can execute a quiz function';
  end if;

  raise notice 'SITE-19: 5 tables, 2 functions, grants asserted.';
end;
$$;
