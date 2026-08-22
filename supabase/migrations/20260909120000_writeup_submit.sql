-- ###########################################################################
-- Spec CDT-04, the migration this spec did not want to own.
--
-- ## Why this file exists
--
-- CDT-04's dependency notes carried three forward notes into CDT-02, each cheap
-- inside a migration already being written and expensive afterwards. CDT-02 was
-- built on 2026-08-21 and shipped ONE of the three. Measured in this session
-- against the live project rather than read off the spec:
--
--   * `check (length(btrim(evidence_sentence)) > 0)` — SHIPPED,
--     `20260908120000_assessment_spine.sql:426`. Nothing owed.
--   * `submit_writeup()` — NOT shipped. `pg_proc` holds no such function and no
--     migration mentions the name.
--   * an `assignment` update policy scoped to the consultant — NOT shipped, and
--     what shipped instead is the hole in a different shape. The policy reads
--     `for update using (may_see_assignment(id)) with check (may_see_assignment(id))`
--     and `may_see_assignment()` admits `a.subject_profile_id = auth.uid()`. So
--     the column grant at :350 and the policy agree that a CIT may write their
--     own assignment's state, date, meeting URL and language.
--
-- So CDT-04's concurrency note fires: this spec owns a migration, holds the
-- schema baton for its session, and is safe beside nothing.
--
-- ## Objects this migration owns (tl-13 discipline: name them, so a later spec
-- ## re-declaring one knows it is reopening a write path)
--
-- Creates: submit_writeup(uuid, jsonb, jsonb, jsonb).
-- Replaces: the policy "an assignment is updatable by its two parties and
--   oversight" on public.assignment, with "an assignment is updatable by its
--   consultant and oversight". The old NAME is dropped, not reused, because a
--   name that says "its two parties" would then describe a rule that admits one.
-- Declares no table, no bucket, and no trigger.
--
-- ## The two rules that make submit_writeup worth a function
--
-- **PostgREST gives the client no transaction.** A write-up is otherwise three
-- calls: insert `submission`, insert `submission_rating` (whose composite key
-- needs the submission to exist first), insert `submission_file`. A failure
-- between call one and call two leaves a `submission` with zero ratings — a
-- write-up that exists and says nothing, permanently reachable in the table the
-- head mentor's queue reads.
--
-- **A write-up that covers 12 of 16 units is not a write-up.** The coverage gate
-- lives here rather than in the form, because a form check is a courtesy and a
-- database check is a rule. This is the one thing in the September round that a
-- rushed consultant at 10pm can silently get wrong, and CBC receives the result.
-- ###########################################################################

-- --------------------------------------------------------------- the RPC

create or replace function public.submit_writeup(
  _assignment uuid,
  _submission jsonb,
  _ratings    jsonb,
  _file       jsonb default null
) returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  _caller     uuid := auth.uid();
  _a          public.assignment;
  _sub_id     uuid;
  _expected   int;
  _got        int;
begin
  if _caller is null then
    raise exception 'submit_writeup needs a signed-in caller'
      using errcode = '42501';
  end if;

  select * into _a from assignment where id = _assignment;

  -- One message for "no such assignment" and for "not yours", deliberately.
  -- Two messages would let a caller who guessed a uuid learn that it exists,
  -- which is the same disclosure `signinErrors.ts` refuses on the sign-in form.
  if not found or _a.consultant_profile_id <> _caller then
    raise exception 'that assignment is not yours to write up'
      using errcode = '42501';
  end if;

  -- The state graph allows held -> submitted and returned -> submitted. Filing
  -- from `submitted` is refused here rather than by assignment_change_guard,
  -- because the guard's message ('illegal state transition: submitted ->
  -- submitted') reads as a bug in the page rather than as "the head mentor has
  -- this and has not sent it back".
  if _a.state not in ('held', 'returned') then
    raise exception
      'a write-up is filed from a held or returned assignment; this one is %',
      _a.state
      using errcode = 'check_violation';
  end if;

  if _ratings is null or jsonb_typeof(_ratings) <> 'array' then
    raise exception 'submit_writeup needs a ratings array'
      using errcode = 'invalid_parameter_value';
  end if;

  select id into _sub_id from submission where assignment_id = _assignment;

  if _sub_id is null then
    insert into submission (
      assignment_id, bundle_key, consultant_profile_id,
      body_md, strength_note, growth_note_1, growth_note_2, context_note,
      connection_quality, consent_recorded, transcript_source, submitted_at
    ) values (
      _assignment, _a.bundle_key, _caller,
      coalesce(_submission ->> 'body_md', ''),
      _submission ->> 'strength_note',
      _submission ->> 'growth_note_1',
      _submission ->> 'growth_note_2',
      _submission ->> 'context_note',
      _submission ->> 'connection_quality',
      -- No coalesce to false. `consent_recorded` has no default precisely so
      -- that absence cannot mean yes; a missing key raises 23502 here.
      (_submission ->> 'consent_recorded')::boolean,
      coalesce(_submission ->> 'transcript_source', 'none'),
      now()
    ) returning id into _sub_id;
  else
    -- The returned -> submitted revision path. One submission row per
    -- assignment: a second row would put two write-ups for one viva in the
    -- approval queue with no way to tell which is current.
    --
    -- approval_state is set explicitly because submission_set_approval_state is
    -- BEFORE INSERT only, so a revision would otherwise keep the 'returned'
    -- state it is being revised out of. refuse_change_after_approval blocks this
    -- update outright once approved_at is set, which is the intended refusal.
    update submission set
      body_md            = coalesce(_submission ->> 'body_md', ''),
      strength_note      = _submission ->> 'strength_note',
      growth_note_1      = _submission ->> 'growth_note_1',
      growth_note_2      = _submission ->> 'growth_note_2',
      context_note       = _submission ->> 'context_note',
      connection_quality = _submission ->> 'connection_quality',
      consent_recorded   = (_submission ->> 'consent_recorded')::boolean,
      transcript_source  = coalesce(_submission ->> 'transcript_source', 'none'),
      submitted_at       = now(),
      approval_state     = approval_state_for(_caller),
      approved_by        = null,
      approved_at        = null,
      return_reason      = null
    where id = _sub_id;

    delete from submission_rating where submission_id = _sub_id;
  end if;

  insert into submission_rating (
    submission_id, bundle_key, unit_key,
    observed_level, recommended_level, confidence,
    evidence_sentence, plain_language_check, plain_language_note, escalate
  )
  select
    _sub_id,
    _a.bundle_key,
    r ->> 'unit_key',
    (r ->> 'observed_level')::smallint,
    (r ->> 'recommended_level')::smallint,
    r ->> 'confidence',
    r ->> 'evidence_sentence',
    r ->> 'plain_language_check',
    r ->> 'plain_language_note',
    coalesce((r ->> 'escalate')::boolean, false)
  from jsonb_array_elements(_ratings) r;

  -- The coverage gate. The two composite foreign keys already refuse a unit
  -- outside the bundle and the primary key refuses a duplicate, so what is left
  -- to check is the one they cannot: that nothing was left out.
  select count(*) into _expected from bundle_unit where bundle_key = _a.bundle_key;
  select count(*) into _got from submission_rating where submission_id = _sub_id;

  if _got <> _expected then
    raise exception
      'a write-up rates every unit in its bundle: % of % rated for %',
      _got, _expected, _a.bundle_key
      using errcode = 'check_violation';
  end if;

  if _file is not null and coalesce(_file ->> 'filename', '') <> '' then
    insert into submission_file (submission_id, kind, source_url, storage_path, filename, mime)
    values (
      _sub_id,
      coalesce(_file ->> 'kind', 'writeup'),
      _file ->> 'source_url',
      _file ->> 'storage_path',
      _file ->> 'filename',
      _file ->> 'mime'
    );
  end if;

  -- Last, so a refusal anywhere above leaves the assignment where the consultant
  -- can try again. assignment_change_guard checks the transition and
  -- assignment_audit records it.
  update assignment set state = 'submitted' where id = _assignment;

  return _sub_id;
end;
$$;

-- Postgres grants EXECUTE to PUBLIC by default, so a function missing these two
-- lines is anon-callable.
revoke execute on function public.submit_writeup(uuid, jsonb, jsonb, jsonb) from public, anon;
grant execute on function public.submit_writeup(uuid, jsonb, jsonb, jsonb) to authenticated;

-- ------------------------------------------- the update policy, rescoped

-- What was there admitted the subject. The four granted columns are state,
-- scheduled_at, meeting_url and meeting_language, so a CIT holding their own
-- assignment link could confirm their own date and drive their own assignment
-- through the state graph.
--
-- `with check` as well as `using`, and the same expression: Postgres reuses
-- `using` for the new row only when `with check` is absent, and CDT-00 D7's
-- question 2 asks every `for update` policy to say it out loud rather than rely
-- on that. `assignment_change_guard` forbids changing consultant_profile_id, so
-- NEW's consultant is always OLD's and the two expressions cannot disagree.
drop policy if exists "an assignment is updatable by its two parties and oversight" on public.assignment;
drop policy if exists "an assignment is updatable by its consultant and oversight" on public.assignment;
create policy "an assignment is updatable by its consultant and oversight" on public.assignment
  for update to authenticated
  using (consultant_profile_id = auth.uid() or is_head_mentor() or is_portal_admin())
  with check (consultant_profile_id = auth.uid() or is_head_mentor() or is_portal_admin());

-- ------------------------------------------------- assert, do not trust

-- `20260908120100_fix_view_overgrant.sql`'s lesson, applied to its own author's
-- work: a revoke that is not asserted is a comment. Each block below fails the
-- migration rather than reporting.
do $$
declare _n int;
begin
  -- 1. The function exists, is definer, and has a pinned search_path.
  select count(*) into _n
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'submit_writeup'
     and p.prosecdef
     and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c
                  where c like 'search_path=%');
  if _n <> 1 then
    raise exception 'submit_writeup is missing, invoker-rights, or has no pinned search_path (found %)', _n;
  end if;

  -- 2. anon cannot call it.
  if has_function_privilege('anon', 'public.submit_writeup(uuid,jsonb,jsonb,jsonb)', 'execute') then
    raise exception 'anon holds EXECUTE on submit_writeup';
  end if;
  if not has_function_privilege('authenticated', 'public.submit_writeup(uuid,jsonb,jsonb,jsonb)', 'execute') then
    raise exception 'authenticated lacks EXECUTE on submit_writeup';
  end if;

  -- 3. Exactly one update policy on `assignment`, and its expression does not
  --    mention the subject. Asserted on the catalog rather than on the file,
  --    because the file is what we believe and the catalog is what is true.
  select count(*) into _n
    from pg_policies
   where schemaname = 'public' and tablename = 'assignment' and cmd = 'UPDATE';
  if _n <> 1 then
    raise exception 'expected exactly 1 update policy on assignment, found %', _n;
  end if;

  select count(*) into _n
    from pg_policies
   where schemaname = 'public' and tablename = 'assignment' and cmd = 'UPDATE'
     and (qual like '%subject_profile_id%' or with_check like '%subject_profile_id%');
  if _n <> 0 then
    raise exception 'the assignment update policy still admits the subject';
  end if;

  select count(*) into _n
    from pg_policies
   where schemaname = 'public' and tablename = 'assignment' and cmd = 'UPDATE'
     and with_check is not null;
  if _n <> 1 then
    raise exception 'the assignment update policy has no with_check of its own';
  end if;
end $$;
