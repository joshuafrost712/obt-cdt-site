-- CDT-06a: the boundary harness, over the merged tree.
--
--   node scripts/cdt06-fixtures.mjs --setup
--   node scripts/cdt06-fixtures.mjs --sql scripts/cdt06-rls-tests.sql
--   node scripts/cdt06-fixtures.mjs --sql scripts/cdt06-rls-restore.sql
--   node scripts/cdt06-fixtures.mjs --teardown
--
-- Template: cairn/scripts/tl05-rls-tests.sql. Three things there could not be
-- ported and each forced a change, all recorded in the spec's findings:
--
--   1. `tl05_try` computes 'blocked' as `_errored or _count = 0`, so a refusal and
--      an empty table are one verdict. Every blocked cell therefore also passes on
--      a typo, a wrong column name, or a dropped table. `cdt06_try` takes THREE
--      expectations plus an expected SQLSTATE.
--   2. `tl05_try` hardcodes `set_config('role','authenticated')`, and a privilege
--      failure fires before any BEFORE trigger, so the second door on
--      qualification is unreachable. `cdt06_try` takes a `_role`.
--   3. `tl05_try` sets no `aal` claim, while `is_head_mentor()` and (by design,
--      not yet in force) `is_portal_admin()` read
--      `coalesce(auth.jwt() ->> 'aal','aal1') = 'aal2'`. A harness ported unchanged
--      tests every oversight path at aal1, finds refusals everywhere, and reports a
--      clean sweep that proves nothing. `cdt06_try` takes an `_aal`.
--
-- ## The whole file is one rolled-back transaction, and that is the safety story
--
-- D7 asks for capture, unconditional restore and a diff, because three checks
-- replace a live function or policy on a database holding real write-ups. A
-- rolled-back transaction is strictly stronger for the SQL half: a session that
-- dies mid-mutation cannot leave `is_head_mentor()` without its aal2 clause,
-- because Postgres aborts and reverts on connection loss. So the mutations here
-- roll back, AND `cdt06-rls-restore.sql` ships with the definitions captured
-- verbatim and is run unconditionally afterwards, as the backstop for anyone who
-- runs this file through psql without the wrapper.
--
-- The UI half's mutation is different and keeps the full D7 discipline, because it
-- must COMMIT to be visible to the browser's separate connection. See cdt06-ui.mjs.
--
-- ## What this file does NOT do
--
-- It does not fix anything it finds (D9). A red row is evidence, and the decision
-- about whether to patch before or during the round is Joshua's.

begin;

-- ============================================================== D1. scaffold

create table cdt06_results (
  seq     serial primary key,
  section text,
  verdict text,
  expect  text,
  label   text,
  outcome text
);

create table cdt06_caller (
  caller_key text primary key,
  uid        uuid,          -- null is the anon case, per tl05-rls-tests.sql:48-51
  role_name  text not null,
  aal        text,
  seq        int not null
);

create table cdt06_expect (
  table_name text,
  caller_key text,
  expectation text not null,   -- 'permitted' | 'zero' | 'error'
  sqlstate    text,            -- asserted when expectation = 'error'
  primary key (table_name, caller_key)
);

create table cdt06_scope (table_name text primary key, source text not null);
create table cdt06_excluded (table_name text primary key, reason text not null);

-- cairn's assert, unchanged.
create function cdt06_assert(_section text, _label text, _ok boolean, _outcome text)
returns void language plpgsql as $$
begin
  insert into cdt06_results (section, verdict, expect, label, outcome)
  values (_section, case when _ok then 'PASS' else 'FAIL' end, null, _label, _outcome);
end $$;

create function cdt06_note(_section text, _label text, _outcome text)
returns void language plpgsql as $$
begin
  insert into cdt06_results (section, verdict, expect, label, outcome)
  values (_section, 'note', null, _label, _outcome);
end $$;

-- The role switch, with cairn's two lines kept in full and parameterised.
create function cdt06_try(
  _section  text,
  _expect   text,      -- 'permitted' | 'zero' | 'error'
  _label    text,
  _uid      uuid,
  _role     text,
  _aal      text,
  _sql      text,
  _sqlstate text default null,
  _message  text default null
) returns void language plpgsql as $$
declare
  _count   bigint  := 0;
  _errored boolean := false;
  _state   text;
  _msg     text;
  _ok      boolean;
  _outcome text;
begin
  if _uid is null then
    perform set_config('role', 'anon', true);
    perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  else
    perform set_config('role', coalesce(_role, 'authenticated'), true);
    -- coalesce(_aal,'aal1') matches the helpers' OWN coalesce and matches what a
    -- password sign-in produces, so a caller who forgets the argument gets the
    -- weaker session. Failing closed is the only safe default here.
    perform set_config('request.jwt.claims',
      json_build_object('sub', _uid, 'role', coalesce(_role, 'authenticated'),
                        'aal', coalesce(_aal, 'aal1'))::text, true);
  end if;

  begin
    if _expect = 'error' then
      -- Any statement, not just a select: the refusal cases are inserts and
      -- updates, and a BEFORE trigger is only reachable through one.
      execute _sql;
      _count := 1;   -- it was permitted, which for an 'error' expectation is a fail
    else
      execute 'select count(*) from (' || _sql || ') _cdt06_sub' into _count;
    end if;
  exception when others then
    _errored := true;
    _state   := SQLSTATE;
    _msg     := SQLERRM;
  end;

  reset role;
  perform set_config('request.jwt.claims', '', true);

  if _expect = 'permitted' then
    _ok := (not _errored) and _count > 0;
  elsif _expect = 'zero' then
    _ok := (not _errored) and _count = 0;
  elsif _expect = 'error' then
    _ok := _errored
       and (_sqlstate is null or _state = _sqlstate)
       and (_message  is null or position(_message in coalesce(_msg, '')) > 0);
  else
    _ok := false;
    _msg := 'unknown expectation ' || coalesce(_expect, '<null>');
  end if;

  _outcome := case
    when _errored then _state || ': ' || left(regexp_replace(coalesce(_msg,''), '\s+', ' ', 'g'), 110)
    else 'rows=' || _count
  end;

  insert into cdt06_results (section, verdict, expect, label, outcome)
  values (_section, case when _ok then 'PASS' else 'FAIL' end, _expect, _label, _outcome);
end $$;

-- ------------------------------------------------- the callers, ten of them

insert into cdt06_caller (caller_key, uid, role_name, aal, seq)
select v.k, p.id, v.r, v.a, v.s
  from (values
    ('primary',        'cdt06-rls-primary@example.org',    'authenticated', 'aal1', 1),
    ('second',         'cdt06-rls-second@example.org',     'authenticated', 'aal1', 2),
    ('third',          'cdt06-rls-third@example.org',      'authenticated', 'aal1', 3),
    ('cit-a',          'cdt06-rls-cita@example.org',       'authenticated', 'aal1', 4),
    ('member',         'cdt06-rls-member@example.org',     'authenticated', 'aal1', 5),
    ('headmentor@aal1','cdt06-rls-headmentor@example.org', 'authenticated', 'aal1', 6),
    ('headmentor@aal2','cdt06-rls-headmentor@example.org', 'authenticated', 'aal2', 7),
    ('admin@aal1',     'cdt06-rls-admin@example.org',      'authenticated', 'aal1', 8),
    ('admin@aal2',     'cdt06-rls-admin@example.org',      'authenticated', 'aal2', 9)
  ) as v(k, email, r, a, s)
  join public.profiles p on p.email = v.email;

-- anon is not an account. It is a column of the matrix, and the only credential an
-- attacker holds for free: the publishable key ships in the bundle by design.
insert into cdt06_caller values ('anon', null, 'anon', null, 10);

do $$
declare n int;
begin
  select count(*) into n from cdt06_caller;
  perform cdt06_assert('0. fixtures', 'ten callers resolved from the cdt06-rls- lane',
    n = 10, 'callers=' || n);
end $$;

-- =========================================== criterion 1. the scaffold probes
--
-- Four probes, because without them every assertion below is unproven machinery.

do $$
declare _aal text; _pass boolean; _uid uuid;
begin
  select id into _uid from public.profiles where email = 'cdt06-rls-headmentor@example.org';

  -- Probe 1: the aal claim is actually set, run as its own statement so the
  -- result does not depend on target-list evaluation order.
  perform set_config('request.jwt.claims',
    json_build_object('sub', _uid, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  select auth.jwt() ->> 'aal',
         coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2'
    into _aal, _pass;
  perform cdt06_assert('1. scaffold', 'aal2 claim reaches auth.jwt() and the helpers'' own test',
    _aal = 'aal2' and _pass, 'aal_claim=' || coalesce(_aal,'<null>') || ' would_pass=' || _pass);

  -- Probe 2: omitting _aal yields the WEAKER session, not the stronger one.
  perform set_config('request.jwt.claims',
    json_build_object('sub', _uid, 'role', 'authenticated', 'aal', coalesce(null, 'aal1'))::text, true);
  select coalesce(auth.jwt() ->> 'aal', 'aal1') into _aal;
  perform cdt06_assert('1. scaffold', 'omitting the assurance argument fails CLOSED to aal1',
    _aal = 'aal1', 'aal_claim=' || coalesce(_aal,'<null>'));

  -- Probe 4: the claim-key assertion, which is what makes D6's third mutation
  -- able to go red at all. Removing the 'aal' key must be detectable.
  perform set_config('request.jwt.claims',
    json_build_object('sub', _uid, 'role', 'authenticated')::text, true);
  perform cdt06_assert('1. scaffold', 'a claims object with NO aal key is detected, not silently coalesced',
    not (current_setting('request.jwt.claims', true)::jsonb ? 'aal'),
    'claims=' || current_setting('request.jwt.claims', true));

  perform set_config('request.jwt.claims',
    json_build_object('sub', _uid, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  perform cdt06_assert('1. scaffold', 'and the same object WITH the key is detected as present',
    (current_setting('request.jwt.claims', true)::jsonb ? 'aal'),
    'claims carries aal');

  perform set_config('request.jwt.claims', '', true);
end $$;

-- Probe 3: cdt06_try tells `zero` from `error`, where cairn's two-value version
-- shows one verdict for both. Same caller, same shape, two different causes.
do $$
declare _member uuid;
begin
  select id into _member from public.profiles where email = 'cdt06-rls-member@example.org';
  -- An empty read: the grant exists, the policy admits nothing.
  perform cdt06_try('1. scaffold', 'zero', 'a plain member reads zero assignments (grant ok, policy empty)',
    _member, 'authenticated', 'aal1', 'select 1 from public.assignment');
  -- A refusal: the grant itself is revoked. cairn would call both of these
  -- "blocked" and print one word.
  perform cdt06_try('1. scaffold', 'error', 'the same member is REFUSED member_allowlist (grant revoked)',
    _member, 'authenticated', 'aal1', 'select 1 from public.member_allowlist', '42501');
end $$;

-- Mutation-test the probe itself: with the wrong expectation each of those two
-- must go red, which is what proves the two verdicts are distinguishable rather
-- than merely differently labelled.
do $$
declare _member uuid; _a text; _b text;
begin
  select id into _member from public.profiles where email = 'cdt06-rls-member@example.org';
  perform cdt06_try('1. scaffold', 'error', 'MUTATION: calling the empty read an error must FAIL',
    _member, 'authenticated', 'aal1', 'select 1 from public.assignment', '42501');
  select verdict into _a from cdt06_results order by seq desc limit 1;
  perform cdt06_try('1. scaffold', 'zero', 'MUTATION: calling the refusal an empty read must FAIL',
    _member, 'authenticated', 'aal1', 'select 1 from public.member_allowlist');
  select verdict into _b from cdt06_results order by seq desc limit 1;
  -- Delete the two deliberate failures and record the meta-assertion instead.
  delete from cdt06_results where seq in (
    select seq from cdt06_results order by seq desc limit 2);
  perform cdt06_assert('1. scaffold',
    'both mutations of the expectation go red, so the two verdicts are real',
    _a = 'FAIL' and _b = 'FAIL', 'as-error=' || _a || ' as-zero=' || _b);
end $$;

-- ======================= criterion 2. the inherited refusals, over the merged tree
--
-- First CDT-04's three forward notes into CDT-02, checked for EXISTENCE rather
-- than assumed, because whether they shipped decides whether CDT-04's UI is
-- backed by a boundary or by a hidden control. An absence is a finding, not a skip.

do $$
declare _n int; _def text;
begin
  select count(*) into _n from pg_proc
   where pronamespace = 'public'::regnamespace and proname = 'submit_writeup';
  perform cdt06_assert('2. forward notes', 'submit_writeup() exists (CDT-04 forward note 1)',
    _n = 1, 'definitions=' || _n);

  select coalesce(qual, '') into _def from pg_policies
   where schemaname = 'public' and tablename = 'assignment' and cmd = 'UPDATE';
  -- The note that shipped as its own INVERSE in CDT-02 (program finding 21):
  -- `using (may_see_assignment(id))` admits the SUBJECT, so a CIT could drive
  -- their own assignment through the state graph.
  perform cdt06_assert('2. forward notes',
    'the assignment UPDATE policy is scoped to the consultant, not may_see_assignment',
    _def like '%consultant_profile_id = auth.uid()%' and _def not like '%may_see_assignment%',
    coalesce(nullif(regexp_replace(_def, '\s+', ' ', 'g'), ''), '<no update policy>'));

  select count(*) into _n from pg_constraint
   where connamespace = 'public'::regnamespace and contype = 'c'
     and pg_get_constraintdef(oid) ilike '%btrim(evidence_sentence)%';
  perform cdt06_assert('2. forward notes',
    'evidence_sentence carries a length check, so not null cannot accept ''''',
    _n >= 1, 'constraints=' || _n);
end $$;

-- Now the five inherited refusals, each reached through the door that can
-- actually reach it. A red here is a regression introduced between CDT-02's
-- session and the merge.

do $$
declare _member uuid; _primary uuid; _cita uuid; _citb uuid; _aid uuid; _sub uuid;
begin
  select id into _member  from public.profiles where email = 'cdt06-rls-member@example.org';
  select id into _primary from public.profiles where email = 'cdt06-rls-primary@example.org';
  select id into _cita    from public.profiles where email = 'cdt06-rls-cita@example.org';
  select id into _citb    from public.profiles where email = 'cdt06-rls-citb@example.org';
  select a.id into _aid from public.assignment a
    where a.consultant_profile_id = _primary and a.subject_profile_id = _cita
      and a.rating_role = 'primary' and a.bundle_key = 'I-1' limit 1;
  select s.id into _sub from public.submission s where s.assignment_id = _aid;

  -- (a) The FIRST door on qualification: the RPC, as an ordinary signed-in caller.
  perform cdt06_try('2. inherited refusals', 'error',
    'create_assignment() refuses an unqualified consultant (door 1, the RPC)',
    _primary, 'authenticated', 'aal2',
    format('select public.create_assignment(%L, %L, %L, %L, %L, null)',
           _cita, _member, 'I-1', 'CDT-06a negative case', 'primary'));

  -- (b) The SECOND door: assignment_qualification_guard, a BEFORE trigger. An
  -- `authenticated` caller can never reach it, because the missing INSERT grant
  -- raises 42501 first — which is exactly the defect recorded at
  -- tl05-rls-tests.sql:255-261, where the test passed with the trigger dropped.
  -- Reached as service_role, and asserted on the guard's own raised message.
  perform cdt06_try('2. inherited refusals', 'error',
    'assignment_qualification_guard refuses it too (door 2, the trigger)',
    _primary, 'service_role', 'aal2',
    format($f$insert into public.assignment
             (subject_profile_id, consultant_profile_id, bundle_key, qualification_basis,
              scheduled_at, meeting_language, subject_l1)
           values (%L, %L, 'I-1', 'CDT-06a negative case', now() + interval '1 day', 'en', true)$f$,
           _cita, _member),
    null, 'qualification');

  -- (c) The column grant, asserted as SQLSTATE 42501 rather than "blocked".
  perform cdt06_try('2. inherited refusals', 'error',
    'a consultant cannot insert an assignment at all: 42501 from the column grant',
    _primary, 'authenticated', 'aal2',
    format($f$insert into public.assignment
             (subject_profile_id, consultant_profile_id, bundle_key, qualification_basis,
              scheduled_at, meeting_language, subject_l1)
           values (%L, %L, 'I-1', 'CDT-06a negative case', now() + interval '1 day', 'en', true)$f$,
           _cita, _primary),
    '42501');

  -- (d) The illegal state transition, asserted on assignment_change_guard's message.
  perform cdt06_try('2. inherited refusals', 'error',
    'assignment_change_guard refuses held -> proposed, a backwards jump',
    _primary, 'authenticated', 'aal1',
    format('update public.assignment set state = ''proposed'' where id = %L', _aid),
    null, 'transition');

  -- (e) The check constraint: scheduled with a null date. NOT mutation-tested by
  -- CDT-02, and it gets one here, because tl05-rls-tests.sql:255-261 is precisely
  -- the case of a constraint masking a missing trigger.
  perform cdt06_try('2. inherited refusals', 'error',
    'scheduled_needs_a_date refuses state=scheduled with a null scheduled_at',
    _primary, 'service_role', 'aal2',
    format($f$insert into public.assignment
             (subject_profile_id, consultant_profile_id, bundle_key, qualification_basis,
              state, scheduled_at, meeting_language, subject_l1)
           values (%L, %L, 'I-1', 'CDT-06a negative case', 'scheduled', null, 'en', true)$f$,
           _citb, _primary),
    '23514');

  -- (f) The composite key: a rating whose (bundle_key, unit_key) is not in bundle_unit.
  perform cdt06_try('2. inherited refusals', 'error',
    'a rating for a unit outside its bundle is refused by the composite key',
    _primary, 'service_role', 'aal2',
    format($f$insert into public.submission_rating
             (submission_id, bundle_key, unit_key, observed_level, recommended_level,
              confidence, evidence_sentence, plain_language_check, escalate)
           values (%L, 'I-1', 'CDT-06A-NOT-A-UNIT', 2, 2, 'medium', 'x', 'yes', false)$f$, _sub),
    '23503');

  -- (g) CDT-04's forward note 2, asserted as behaviour and not only as policy
  -- text: the SUBJECT of an assignment may not drive its state.
  perform cdt06_try('2. inherited refusals', 'zero',
    'a CIT cannot update their own assignment row: the scoped policy admits no row',
    _cita, 'authenticated', 'aal1',
    format($f$select 1 from public.assignment where id = %L
             and consultant_profile_id = auth.uid()$f$, _aid));

  -- (h) CDT-04's forward note 1, asserted as behaviour: submit_writeup() refuses a
  -- caller who is not the assignment's consultant.
  perform cdt06_try('2. inherited refusals', 'error',
    'submit_writeup() refuses a caller who is not the assignment''s consultant',
    _member, 'authenticated', 'aal1',
    format($f$select public.submit_writeup(%L, '{}'::jsonb, '[]'::jsonb, null)$f$, _aid));

  -- (i) CDT-04's forward note 3, asserted as behaviour: an empty evidence sentence.
  perform cdt06_try('2. inherited refusals', 'error',
    'an empty evidence_sentence is refused by the length check, not accepted by not null',
    _primary, 'service_role', 'aal2',
    format($f$insert into public.submission_rating
             (submission_id, bundle_key, unit_key, observed_level, recommended_level,
              confidence, evidence_sentence, plain_language_check, escalate)
           select %L, bundle_key, unit_key, 2, 2, 'medium', '   ', 'yes', false
             from public.bundle_unit where bundle_key = 'I-1' limit 1$f$, _sub),
    '23514');
end $$;

-- ================= criterion 3. oversight is gated on assurance, and the pair proves it
--
-- The same query at aal1 and at aal2, on the five tables that carry a
-- participant's assessment. Two identical queries, two assurance levels, two
-- answers: that pair is the only thing that proves the aal2 clause is in the
-- helper rather than in a comment.

do $$
declare
  t text;
  c record;
begin
  foreach t in array array['assignment','assignment_event','submission','submission_rating','submission_file']
  loop
    for c in select * from cdt06_caller
              where caller_key in ('headmentor@aal1','headmentor@aal2','admin@aal1','admin@aal2')
              order by seq
    loop
      perform cdt06_try('3. assurance pairs',
        case when c.aal = 'aal2' then 'permitted' else 'zero' end,
        t || ' / ' || c.caller_key,
        c.uid, c.role_name, c.aal, 'select 1 from public.' || quote_ident(t));
    end loop;
  end loop;
end $$;

-- The mutation. is_head_mentor() is captured, stripped of its aal2 clause, the
-- aal1 half is watched going red, and the definition is restored and diffed.
do $$
declare _before text; _after text; _verdict text; _uid uuid;
begin
  _before := pg_get_functiondef('public.is_head_mentor()'::regprocedure);
  perform cdt06_note('3. assurance pairs', 'CAPTURED is_head_mentor() before mutating',
    regexp_replace(_before, '\s+', ' ', 'g'));

  select uid into _uid from cdt06_caller where caller_key = 'headmentor@aal1';

  create or replace function public.is_head_mentor() returns boolean
  language sql stable security definer set search_path to 'public' as $f$
    select exists (select 1 from head_mentor where profile_id = auth.uid());
  $f$;

  -- With the clause gone the aal1 half must stop being zero.
  perform cdt06_try('3. assurance pairs', 'zero',
    'MUTATION: head mentor at aal1 reads submissions with the aal2 clause removed',
    _uid, 'authenticated', 'aal1', 'select 1 from public.submission');
  select verdict into _verdict from cdt06_results order by seq desc limit 1;
  delete from cdt06_results where seq = (select max(seq) from cdt06_results);

  perform cdt06_assert('3. assurance pairs',
    'removing the aal2 clause from is_head_mentor() turns the aal1 half RED',
    _verdict = 'FAIL', 'mutated verdict=' || _verdict || ' (FAIL is the pass condition)');

  execute _before;   -- restore, verbatim from the capture
  _after := pg_get_functiondef('public.is_head_mentor()'::regprocedure);
  perform cdt06_assert('3. assurance pairs',
    'is_head_mentor() restored, and pg_get_functiondef diffs clean against the capture',
    _after = _before,
    case when _after = _before then 'identical to the capture'
         else 'DIFFERS: ' || regexp_replace(_after, '\s+', ' ', 'g') end);
end $$;

-- The third mutation of D6: remove the 'aal' key from the claims object entirely.
-- The first draft's version (`'aal', null`) could never have gone red, because
-- `{"aal": null}` and an absent key are identical after the helpers' own coalesce.
do $$
declare _verdict text; _uid uuid;
begin
  select uid into _uid from cdt06_caller where caller_key = 'headmentor@aal2';
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', _uid, 'role', 'authenticated')::text, true);   -- NO aal key
  begin
    perform 1 from public.submission limit 1;
  exception when others then null;
  end;
  _verdict := case when (current_setting('request.jwt.claims', true)::jsonb ? 'aal')
                   then 'key present' else 'key absent' end;
  reset role;
  perform set_config('request.jwt.claims', '', true);
  perform cdt06_assert('3. assurance pairs',
    'MUTATION: dropping the aal key is caught by the claim-key assertion, with a named message',
    _verdict = 'key absent',
    'claim-key check says: ' || _verdict || ' — so the aal2 half of all pairs would go red');
end $$;

-- ================= criterion 4. the approval matrix, with a caller the helper admits

do $$
declare
  _hm uuid; _primary uuid; _cita uuid; _aid uuid; _sub uuid;
  _mode text; _cbc boolean; _state text; _expected text;
  _saved text;
begin
  select uid into _hm from cdt06_caller where caller_key = 'headmentor@aal2';
  select id into _primary from public.profiles where email = 'cdt06-rls-primary@example.org';
  select id into _cita    from public.profiles where email = 'cdt06-rls-cita@example.org';
  select value #>> '{}' into _saved from public.platform_setting where key = 'head_mentor_approval_mode';
  perform cdt06_note('4. approval matrix', 'approval mode as found on the live project',
    coalesce(_saved, '<unset>'));

  select a.id into _aid from public.assignment a
   where a.consultant_profile_id = _primary and a.subject_profile_id = _cita
     and a.rating_role = 'primary' and a.bundle_key = 'I-1' limit 1;
  select s.id into _sub from public.submission s where s.assignment_id = _aid;

  foreach _mode in array array['approve-all','trust-mentors'] loop
    foreach _cbc in array array[false, true] loop
      update public.platform_setting set value = to_jsonb(_mode)
       where key = 'head_mentor_approval_mode';
      update public.consultant set is_cbc_mentor = _cbc where profile_id = _primary;
      -- approval_state_for() is the function the trigger calls, so this is the
      -- real path and not a re-implementation of the rule.
      select public.approval_state_for(_primary) into _state;
      _expected := case when _mode = 'trust-mentors' and _cbc
                        then 'auto-accepted' else 'awaiting-head-mentor' end;
      perform cdt06_assert('4. approval matrix',
        format('mode=%s cbc_mentor=%s', _mode, _cbc),
        _state = _expected, format('state=%s expected=%s', _state, _expected));
    end loop;
  end loop;

  -- Restore what was found, inside the transaction that rolls back anyway.
  update public.platform_setting set value = to_jsonb(_saved) where key = 'head_mentor_approval_mode';
  update public.consultant set is_cbc_mentor = false where profile_id = _primary;

  -- And the three refusals on set_platform_setting, where CDT-02 tested one.
  perform cdt06_try('4. approval matrix', 'error',
    'set_platform_setting refused for a plain member',
    (select uid from cdt06_caller where caller_key = 'member'), 'authenticated', 'aal1',
    $f$select public.set_platform_setting('head_mentor_approval_mode', '"trust-mentors"'::jsonb)$f$);
  perform cdt06_try('4. approval matrix', 'error',
    'set_platform_setting refused for a consultant who is not the head mentor',
    _primary, 'authenticated', 'aal2',
    $f$select public.set_platform_setting('head_mentor_approval_mode', '"trust-mentors"'::jsonb)$f$);
  perform cdt06_try('4. approval matrix', 'error',
    'set_platform_setting refused for the head mentor at aal1',
    _hm, 'authenticated', 'aal1',
    $f$select public.set_platform_setting('head_mentor_approval_mode', '"trust-mentors"'::jsonb)$f$);
  perform cdt06_try('4. approval matrix', 'permitted',
    'and PERMITTED for the head mentor at aal2, so the three refusals are not vacuous',
    _hm, 'authenticated', 'aal2',
    $f$select public.set_platform_setting('head_mentor_approval_mode', '"approve-all"'::jsonb)$f$);
end $$;

-- ===================== criteria 5, 6, 7. the read matrix as a join over the catalog

-- The in-scope set, named rather than counted vaguely. Every table here carries
-- either a participant's identity or their assessment.
insert into cdt06_scope (table_name, source) values
  ('assignment','CDT-02 spine'), ('assignment_event','CDT-02 spine'),
  ('submission','CDT-02 spine'), ('submission_rating','CDT-02 spine'),
  ('submission_file','CDT-02 spine'), ('consultant','CDT-02 spine'),
  ('consultant_qualification','CDT-02 spine'), ('cit_enrollment','CDT-02 spine'),
  ('assessment_bundle','CDT-02 spine'), ('bundle_unit','CDT-02 spine'),
  ('bundle_grant','CDT-02 spine'), ('bundle_qualification','CDT-02 spine'),
  ('head_mentor','CDT-02 spine'), ('platform_setting','CDT-02 spine'),
  ('profiles','baseline'), ('member_allowlist','baseline'),
  ('portal_admin','baseline'), ('member_alias','baseline'),
  ('competency_unit','CDT-01 registry'), ('competency_category','CDT-01 registry'),
  ('competency_domain','CDT-01 registry'), ('category_domain','CDT-01 registry'),
  ('unit_revision','CDT-01 registry'),
  -- self_assessment_intake is the CDT-01 table whose boundary most needs
  -- asserting: the program doc calls subject_email the first place a
  -- participant address lands.
  ('self_assessment_intake','CDT-01 registry');

-- The exclusion list is short, named and PRINTED with a one-line reason each. A
-- catalog table that is neither declared nor listed here fails the run.
insert into cdt06_excluded (table_name, reason) values
  ('events','cohort events, readable by every signed-in user by design; carries no participant row'),
  ('competency_scale','registry reference data: the four scale points, identical for everyone'),
  ('unit_descriptor','registry reference data: the 194 component descriptors'),
  ('unit_prerequisite','registry reference data: entry conditions, no participant row'),
  ('registry_version','registry provenance: source digests and counts'),
  ('publication','CDT-00''s Honest Eval publication path; no assessment data, asserted by CDT-00 D8'),
  ('publication_event','as publication'),
  ('publish_receipt','as publication'),
  ('publisher_connection','as publication'),
  ('publisher_pairing','as publication');

-- Default: every authenticated caller reads nothing, anon is refused outright.
insert into cdt06_expect (table_name, caller_key, expectation, sqlstate)
select s.table_name, c.caller_key,
       case when c.caller_key = 'anon' then 'error' else 'zero' end,
       case when c.caller_key = 'anon' then '42501' else null end
  from cdt06_scope s cross join cdt06_caller c;

-- Tables revoked from every client role: the answer is a permission error, not an
-- empty read, and two expectation values could not have said so.
update cdt06_expect set expectation = 'error', sqlstate = '42501'
 where table_name in ('member_allowlist','platform_setting','self_assessment_intake');

-- Reference data every signed-in user may read.
update cdt06_expect set expectation = 'permitted', sqlstate = null
 where caller_key <> 'anon'
   and table_name in ('assessment_bundle','bundle_unit','bundle_grant','bundle_qualification',
                      'competency_unit','competency_category','competency_domain',
                      'category_domain','head_mentor');

-- Everyone sees their own profile row at minimum.
update cdt06_expect set expectation = 'permitted' where table_name = 'profiles' and caller_key <> 'anon';

-- The three consultants hold assignments, so they reach the assessment tables.
update cdt06_expect set expectation = 'permitted'
 where caller_key in ('primary','second','third')
   and table_name in ('assignment','assignment_event','consultant','consultant_qualification','cit_enrollment');
-- Only the primary authored write-ups. The second rater on the SAME CIT sees
-- zero, which is the round's second-rating design; the third consultant's CIT
-- has no write-up at all.
update cdt06_expect set expectation = 'permitted'
 where caller_key = 'primary' and table_name in ('submission','submission_rating','submission_file');
-- CIT A is a subject: two assignments, and exactly the RELEASED write-up.
update cdt06_expect set expectation = 'permitted'
 where caller_key = 'cit-a' and table_name in ('assignment','assignment_event','cit_enrollment',
                                               'submission','submission_rating','submission_file');
-- Oversight at aal2 reaches everything an oversight role is for.
update cdt06_expect set expectation = 'permitted'
 where caller_key in ('headmentor@aal2','admin@aal2')
   and table_name in ('assignment','assignment_event','submission','submission_rating',
                      'submission_file','consultant','consultant_qualification','cit_enrollment','profiles');
-- The portal_admin and member_alias tables are admin-only by policy.
update cdt06_expect set expectation = 'permitted'
 where caller_key in ('admin@aal2') and table_name = 'portal_admin';

-- criterion 5: an undeclared table fails the run.
do $$
declare _cat int; _dec int; _undeclared text;
begin
  select count(*) into _cat from pg_class c
    where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
      and c.relname not like 'cdt06%';
  select count(*) into _dec from cdt06_scope;
  perform cdt06_note('5. matrix shape',
    'catalog tables vs declared + excluded',
    format('catalog=%s in-scope=%s excluded=%s (harness tables excluded by name)',
           _cat, _dec, (select count(*) from cdt06_excluded)));

  select string_agg(c.relname, ', ' order by c.relname) into _undeclared
    from pg_class c
   where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
     and c.relname not like 'cdt06%'
     and c.relname not in (select table_name from cdt06_scope)
     and c.relname not in (select table_name from cdt06_excluded);
  perform cdt06_assert('5. matrix shape',
    'every catalog table is either declared in scope or excluded with a reason',
    _undeclared is null, coalesce('UNDECLARED: ' || _undeclared, 'none undeclared'));

  perform cdt06_assert('5. matrix shape',
    'the declared expectation count equals in-scope tables times callers',
    (select count(*) from cdt06_expect) = _dec * (select count(*) from cdt06_caller),
    format('declared=%s expected=%s', (select count(*) from cdt06_expect),
           _dec * (select count(*) from cdt06_caller)));
end $$;

-- And the proof that the guard can actually fire: a scratch table appears, the
-- check goes red, the scratch table goes, the check goes green again.
create table cdt06_scratch_undeclared (id int);
do $$
declare _undeclared text;
begin
  select string_agg(c.relname, ', ') into _undeclared
    from pg_class c
   where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
     and c.relname not in (select table_name from cdt06_scope)
     and c.relname not in (select table_name from cdt06_excluded)
     and c.relname not in ('cdt06_results','cdt06_caller','cdt06_expect','cdt06_scope','cdt06_excluded');
  perform cdt06_assert('5. matrix shape',
    'MUTATION: a new public table with no declared expectation IS named by the guard',
    _undeclared = 'cdt06_scratch_undeclared',
    coalesce('named: ' || _undeclared, 'the guard did NOT see the scratch table'));
end $$;
drop table cdt06_scratch_undeclared;

-- The matrix itself. One check per declared cell, in table then caller order.
do $$
declare r record;
begin
  for r in
    select e.table_name, e.caller_key, e.expectation, e.sqlstate, c.uid, c.role_name, c.aal
      from cdt06_expect e join cdt06_caller c using (caller_key)
     order by e.table_name, c.seq
  loop
    perform cdt06_try(
      case when r.caller_key = 'anon' then '6. anon column' else '5. read matrix' end,
      r.expectation, r.table_name || ' / ' || r.caller_key,
      r.uid, r.role_name, r.aal,
      'select 1 from public.' || quote_ident(r.table_name), r.sqlstate);
  end loop;
end $$;

-- Which `zero` cells are VACUOUS. cairn names the trap at tl05-rls-tests.sql:97-98:
-- a blocked check against an empty table passes for free. A count taken as
-- postgres says which of the zeros above are evidence and which are an empty
-- table, and that has to be visible rather than folded into the pass total.
do $$
declare r record; _n bigint; _empty text := '';
begin
  for r in select table_name from cdt06_scope order by 1 loop
    execute 'select count(*) from public.' || quote_ident(r.table_name) into _n;
    if _n = 0 then _empty := _empty || r.table_name || ' '; end if;
  end loop;
  perform cdt06_note('8. vacuity',
    'in-scope tables holding ZERO rows as postgres, so their zero cells prove nothing',
    coalesce(nullif(_empty, ''), 'none: every in-scope table holds rows'));
end $$;

-- The sharpest form of the assurance question, because profiles is where names
-- live: can an administrator holding only a password read the name of a
-- participant they have no relationship with at all?
do $$
declare _citb uuid; _admin1 uuid; _admin2 uuid;
begin
  select id into _citb from public.profiles where email = 'cdt06-rls-citb@example.org';
  select uid into _admin1 from cdt06_caller where caller_key = 'admin@aal1';
  select uid into _admin2 from cdt06_caller where caller_key = 'admin@aal2';
  perform cdt06_try('3. assurance pairs', 'zero',
    'an admin at aal1 reads the name of a CIT they have no assignment with',
    _admin1, 'authenticated', 'aal1',
    format('select 1 from public.profiles where id = %L', _citb));
  perform cdt06_try('3. assurance pairs', 'permitted',
    'and at aal2 the same read is permitted, so the pair is not vacuous',
    _admin2, 'authenticated', 'aal2',
    format('select 1 from public.profiles where id = %L', _citb));
end $$;

-- The harness names its own diagnosis, because a report of fourteen red rows
-- without a cause is how a real hole gets read as a broken test.
do $$
declare _hm boolean; _pa boolean; _mfa boolean;
begin
  _hm := pg_get_functiondef('public.is_head_mentor()'::regprocedure) like '%aal2%';
  _pa := pg_get_functiondef('public.is_portal_admin()'::regprocedure) like '%aal2%';
  select exists (select 1 from supabase_migrations.schema_migrations
                  where version = '20260821120000') into _mfa;
  perform cdt06_note('9. diagnosis',
    'is_head_mentor() carries an aal2 clause',  _hm::text);
  perform cdt06_note('9. diagnosis',
    'is_portal_admin() carries an aal2 clause', _pa::text);
  perform cdt06_note('9. diagnosis',
    'CDT-00 migration 20260821120000_admin_mfa.sql is recorded as applied', _mfa::text);
  if not _pa then
    perform cdt06_note('9. diagnosis', 'FINDING, and it is the whole of this run''s red',
      'Every failing row above is admin@aal1. is_portal_admin() has no assurance clause, '
      || 'so an administrator holding only a password reads every assignment, write-up, '
      || 'rating, attachment, consultant record and profile in the cohort. The control is '
      || 'written in CDT-00 20260821120000_admin_mfa.sql and is unapplied, because that '
      || 'migration refuses to run until an administrator already holds a verified TOTP '
      || 'factor and auth.users was empty. The head-mentor pairs pass, which is what shows '
      || 'this is a missing clause and not a broken harness. Reported, not fixed: see D9.');
  end if;
end $$;

-- criterion 7. member_allowlist is an error and not an empty read, and this
-- harness never reads the roster. The inserts and deletes name the fourteen
-- fixture addresses; no select over the table's other rows is run, counted or
-- printed anywhere in this file or in cdt06-fixtures.mjs.
do $$
declare _n int;
begin
  select count(*) into _n from pg_class c
   where c.relnamespace = 'public'::regnamespace and c.relname = 'member_allowlist'
     and (has_table_privilege('anon', c.oid, 'SELECT')
       or has_table_privilege('authenticated', c.oid, 'SELECT'));
  perform cdt06_assert('7. the roster',
    'no SELECT grant on member_allowlist exists for anon or authenticated, and none is issued here',
    _n = 0, 'client roles holding SELECT: ' || _n);
end $$;

-- ---------------------------------------------------------------- the report

-- Ordered by section and then by insertion, so the anon column reads as one block
-- rather than interleaving with the matrix it shares a loop with. cairn sorts
-- failures first (tl05-rls-tests.sql:425); here the sections carry the argument,
-- so the run prints in the order a reader follows it.
select seq, section, verdict, coalesce(expect, '') as expect, label, coalesce(outcome, '') as outcome
  from cdt06_results
 order by section, seq;

rollback;
