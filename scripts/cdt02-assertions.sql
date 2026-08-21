-- CDT-02 acceptance criteria 3 to 10, asserted at runtime with the UI bypassed.
--
-- Ported in shape from cairn/scripts/tl05-rls-tests.sql, including the lesson at
-- its lines 254-261: a check there "passed for the wrong reason … the error came
-- from that constraint and the check would have passed with the guard trigger
-- dropped entirely." So six of these are mutation-tested: the control is removed,
-- the check is watched going red, and the control is restored.
--
-- ## How to run it
--
--   node scripts/cdt02-assertions.mjs
--
-- That wrapper prepends the real registry and bundle rows (from each seed's
-- --emit-sql) and wraps everything in a transaction it ROLLS BACK. Nothing here
-- persists, which is what lets the criteria run against the REAL I-1 to I-4 rows
-- while both source maps are still unsigned.
--
-- ## Why the identities are forged rather than signed in
--
-- Every check sets `request.jwt.claims` directly and then `set role authenticated`.
-- That tests the PREDICATE a policy evaluates, which is the thing this migration
-- owns. It does NOT test Supabase Auth's issuing of an aal2 token; that needs a
-- real TOTP enrolment and is CDT-00 D6's check, still outstanding. Stated because
-- a harness that quietly conflates the two would report MFA as proven when only
-- the SQL half is.

-- ---------------------------------------------------------------- reporting

create temp table _r (
  id serial primary key,
  criterion text,
  name text,
  expected text,
  actual text
);

create or replace function pg_temp.rec(_c text, _n text, _e text, _a text)
returns void language plpgsql as $$
begin
  insert into _r (criterion, name, expected, actual) values (_c, _n, _e, _a);
end $$;

-- Run one statement as `authenticated` with forged claims, and report the
-- sqlstate rather than the message. A sqlstate is the stable thing: 42501 is a
-- privilege failure and 23503 a foreign key, and the criteria distinguish them.
create or replace function pg_temp.attempt(_sql text, _uid uuid, _aal text default 'aal1')
returns text language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', _uid::text, 'role', 'authenticated', 'aal', _aal)::text, true);
  set local role authenticated;
  execute _sql;
  reset role;
  return 'OK';
exception when others then
  reset role;
  return sqlstate;
end $$;

-- Count rows visible to one identity. Returns text so it can sit in the same
-- report column as a sqlstate.
create or replace function pg_temp.visible(_sql text, _uid uuid, _aal text default 'aal1')
returns text language plpgsql as $$
declare _n bigint;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', _uid::text, 'role', 'authenticated', 'aal', _aal)::text, true);
  set local role authenticated;
  execute _sql into _n;
  reset role;
  return _n::text;
exception when others then
  reset role;
  return 'ERR ' || sqlstate;
end $$;

-- --------------------------------------------------------------- fixtures
--
-- Fixture identities only, per criterion 14. No real participant appears here.
-- The grants mirror the real ones: A is a facilitator (I-4 only), B an exegete
-- (I-2), C an adult-education specialist, who is the spec's worked case and the
-- reason scope matching is a hierarchy.

-- The allowlist comes first, because the baseline's `handle_new_portal_user`
-- trigger on auth.users refuses an address that is not on it with
-- "That address is not on the OBT-CDT participant list." Discovered by this
-- harness's first run, which is the trigger working: the portal really does
-- refuse a stranger, including a fixture one.
insert into public.member_allowlist (email, note) values
  ('cdt02-cit-x@example.invalid',        'CDT-02 fixture'),
  ('cdt02-cit-y@example.invalid',        'CDT-02 fixture'),
  ('cdt02-cons-a@example.invalid',       'CDT-02 fixture'),
  ('cdt02-cons-b@example.invalid',       'CDT-02 fixture'),
  ('cdt02-cons-c@example.invalid',       'CDT-02 fixture'),
  ('cdt02-head-mentor@example.invalid',  'CDT-02 fixture'),
  ('cdt02-plain-member@example.invalid', 'CDT-02 fixture');

insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at)
select v.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
       v.email, 'x', now(), now(), now()
from (values
  ('11111111-1111-4111-8111-111111111111'::uuid, 'cdt02-cit-x@example.invalid'),
  ('22222222-2222-4222-8222-222222222222'::uuid, 'cdt02-cit-y@example.invalid'),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid, 'cdt02-cons-a@example.invalid'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid, 'cdt02-cons-b@example.invalid'),
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc'::uuid, 'cdt02-cons-c@example.invalid'),
  ('dddddddd-dddd-4ddd-8ddd-dddddddddddd'::uuid, 'cdt02-head-mentor@example.invalid'),
  ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'::uuid, 'cdt02-plain-member@example.invalid')
) as v(id, email);

-- `handle_new_portal_user` has ALREADY created these profiles rows, as a side
-- effect of the auth.users insert above. So this labels them rather than creating
-- them; inserting them again raises 23505 on profiles_pkey, which is how the
-- trigger's reach became visible on this harness's second run.
update public.profiles
   set full_name = 'Fixture ' || left(id::text, 4), org = 'fixture'
 where email like 'cdt02-%';

select pg_temp.rec('setup', 'signup trigger created a profile per fixture user', '7',
  (select count(*)::text from public.profiles where email like 'cdt02-%'));

insert into public.consultant (profile_id, is_cbc_mentor, languages, status) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', false, array['en'], 'active'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', true,  array['en'], 'active'),
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', false, array['en','id'], 'active');

insert into public.head_mentor (profile_id) values
  ('dddddddd-dddd-4ddd-8ddd-dddddddddddd');

insert into public.consultant_qualification (profile_id, scope_kind, scope_key, basis) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bundle',   'obt-cdt-facilitator', 'OBT-CDT facilitator status'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'category', 'bt-exegesis',         'MA in biblical exegesis'),
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'category', 'gc-adult-education',  'adult education qualification');

insert into public.cit_enrollment (profile_id, participant_kind, track_membership, assessment_language) values
  ('11111111-1111-4111-8111-111111111111', 'cit', 'sil-obt-cdt', 'en'),
  ('22222222-2222-4222-8222-222222222222', 'cit', 'sil-obt-cdt', 'id');

-- =========================================================== CRITERION 3
-- Qualification enforced at both doors, against the four real bundles.

-- The RPC door. Expectations are declared here, before any call.
do $$
declare
  _hm uuid := 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  _x  uuid := '11111111-1111-4111-8111-111111111111';
  r record;
begin
  for r in select * from (values
    -- consultant,                                    bundle, expected
    ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid, 'I-4', 'OK'),
    ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid, 'I-1', '42501'),
    ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid, 'I-2', '42501'),
    ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid, 'I-3', '42501'),
    ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid, 'I-2', 'OK'),
    ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid, 'I-4', '42501'),
    -- The worked case: a category grant against I-1's six domain rows.
    ('cccccccc-cccc-4ccc-8ccc-cccccccccccc'::uuid, 'I-1', 'OK'),
    ('cccccccc-cccc-4ccc-8ccc-cccccccccccc'::uuid, 'I-4', '42501')
  ) as t(cons, bundle, expected)
  loop
    perform pg_temp.rec('3',
      'create_assignment ' || left(r.cons::text, 4) || ' -> ' || r.bundle,
      r.expected,
      pg_temp.attempt(
        format('select create_assignment(%L, %L, %L, %L)', _x, r.cons, r.bundle, 'fixture basis'),
        _hm, 'aal2'));
  end loop;
end $$;

-- I-1's permissiveness printed rather than implied, per finding 2. Asserted as a
-- count so it is a real check, with the rows themselves in the label so a reader
-- sees exactly how permissive it is.
insert into _r (criterion, name, expected, actual)
select '3',
       'I-1 is permissive: ' || string_agg(scope_kind || ':' || scope_key, ' ' order by scope_key),
       '6', count(*)::text
from bundle_qualification where bundle_key = 'I-1';

-- The direct-statement door, which is the half an RPC-only rule leaves open.
select pg_temp.rec('3', 'direct insert as authenticated (no insert grant)', '42501',
  pg_temp.attempt(
    'insert into assignment (subject_profile_id, consultant_profile_id, bundle_key) '
    || 'values (''11111111-1111-4111-8111-111111111111'', '
    || '''aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'', ''I-1'')',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'));

-- As service role, where only the trigger stands between it and a bad row.
do $$
begin
  insert into assignment (subject_profile_id, consultant_profile_id, bundle_key)
  values ('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'I-1');
  perform pg_temp.rec('3', 'direct insert as service role (trigger door)', '42501', 'OK - NOT REFUSED');
exception when others then
  perform pg_temp.rec('3', 'direct insert as service role (trigger door)', '42501', sqlstate);
end $$;

-- MUTATION TEST: drop the trigger, watch the service-role refusal go red.
drop trigger assignment_qualification on public.assignment;
do $$
begin
  insert into assignment (id, subject_profile_id, consultant_profile_id, bundle_key)
  values ('f0000000-0000-4000-8000-000000000001',
          '11111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'I-1');
  perform pg_temp.rec('3', 'MUTATION guard dropped: unqualified insert now succeeds',
    'OK', 'OK');
  delete from assignment where id = 'f0000000-0000-4000-8000-000000000001';
exception when others then
  perform pg_temp.rec('3', 'MUTATION guard dropped: unqualified insert now succeeds',
    'OK', 'still refused ' || sqlstate);
end $$;
create trigger assignment_qualification
  before insert or update on public.assignment
  for each row execute function public.assignment_qualification_guard();

-- Restoration is itself asserted, because a harness that leaves a guard off is
-- worse than one that never dropped it.
select pg_temp.rec('3', 'guard restored', '1',
  (select count(*)::text from pg_trigger
    where tgrelid = 'public.assignment'::regclass and tgname = 'assignment_qualification'));

-- =========================================================== CRITERION 4
-- The approval matrix, all four combinations.

do $$
declare
  _mentor uuid := 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';  -- is_cbc_mentor = true
  _plain  uuid := 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';  -- is_cbc_mentor = false
begin
  update platform_setting set value = '"approve-all"' where key = 'head_mentor_approval_mode';
  perform pg_temp.rec('4', 'approve-all  + cbc mentor',     'awaiting-head-mentor', approval_state_for(_mentor));
  perform pg_temp.rec('4', 'approve-all  + non-mentor',     'awaiting-head-mentor', approval_state_for(_plain));
  update platform_setting set value = '"trust-mentors"' where key = 'head_mentor_approval_mode';
  perform pg_temp.rec('4', 'trust-mentors + cbc mentor',    'auto-accepted',        approval_state_for(_mentor));
  perform pg_temp.rec('4', 'trust-mentors + non-mentor',    'awaiting-head-mentor', approval_state_for(_plain));
  update platform_setting set value = '"approve-all"' where key = 'head_mentor_approval_mode';
end $$;

-- A consultant cannot flip the mode, and cannot write approval_state directly.
select pg_temp.rec('4', 'consultant calls set_platform_setting', '42501',
  pg_temp.attempt('select set_platform_setting(''head_mentor_approval_mode'', ''"trust-mentors"''::jsonb)',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'));

-- Louder than the expected empty read, and worth recording as such: platform_setting
-- has NO grant at all, not merely no policy, so the read fails with 42501 before
-- RLS is consulted. A denied read that returns zero rows is indistinguishable from
-- an empty table; this one is distinguishable.
select pg_temp.rec('4', 'consultant reads platform_setting (no grant, not just no policy)', 'ERR 42501',
  pg_temp.visible('select count(*) from platform_setting',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'));

-- ============================================ set-up for criteria 5, 7, 9, 10
-- Two real assignments on CIT X: B primary on I-2, and a second rater on the
-- same bundle so criterion 7 has something to be blind to.

do $$
declare _a1 uuid; _a2 uuid; _s1 uuid; _s2 uuid; _unit text;
begin
  insert into assignment (subject_profile_id, consultant_profile_id, bundle_key,
                          qualification_basis, state)
  values ('11111111-1111-4111-8111-111111111111', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          'I-2', 'MA in biblical exegesis', 'proposed')
  returning id into _a1;

  -- C also holds a category grant; give them the second rating on I-2. C's grant
  -- is gc-adult-education, which does NOT cover I-2, so qualify them properly
  -- first: this is a fixture, not a way around the guard.
  insert into consultant_qualification (profile_id, scope_kind, scope_key, basis)
  values ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'category', 'bt-discourse', 'fixture: discourse');

  insert into assignment (subject_profile_id, consultant_profile_id, bundle_key,
                          qualification_basis, rating_role, second_of, state)
  values ('11111111-1111-4111-8111-111111111111', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          'I-2', 'fixture: discourse', 'second', _a1, 'proposed')
  returning id into _a2;

  perform set_config('cdt.a1', _a1::text, true);
  perform set_config('cdt.a2', _a2::text, true);

  select unit_key into _unit from bundle_unit where bundle_key = 'I-2' and is_primary limit 1;
  perform set_config('cdt.unit', _unit, true);

  insert into submission (assignment_id, bundle_key, consultant_profile_id, consent_recorded, body_md)
  values (_a1, 'I-2', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', true, 'B write-up')
  returning id into _s1;
  insert into submission (assignment_id, bundle_key, consultant_profile_id, consent_recorded, body_md)
  values (_a2, 'I-2', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', true, 'C write-up')
  returning id into _s2;

  perform set_config('cdt.s1', _s1::text, true);
  perform set_config('cdt.s2', _s2::text, true);

  insert into submission_rating (submission_id, bundle_key, unit_key, observed_level,
    recommended_level, confidence, evidence_sentence, plain_language_check)
  values (_s1, 'I-2', _unit, 2, 2, 'high', 'B saw the candidate restate the clause structure.', 'yes'),
         (_s2, 'I-2', _unit, 1, 1, 'medium', 'C saw the candidate hesitate on the same clause.', 'partly');

  perform pg_temp.rec('setup', 'two assignments, two write-ups, two ratings', 'built', 'built');
end $$;

-- =========================================================== CRITERION 5
-- The three assignment guards, each by its own error, then mutation-tested.

select pg_temp.rec('5', 'consultant updates consultant_profile_id (column grant)', '42501',
  pg_temp.attempt(
    format('update assignment set consultant_profile_id = %L where id = %L',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', current_setting('cdt.a1')),
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'));

-- As service role, which is the only way to reach the trigger: a privilege
-- failure fires before any BEFORE trigger, so the column grant would mask it.
do $$
begin
  update assignment set consultant_profile_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
   where id = current_setting('cdt.a1')::uuid;
  perform pg_temp.rec('5', 'service role reassigns (change guard)', '23514', 'OK - NOT REFUSED');
exception when others then
  perform pg_temp.rec('5', 'service role reassigns (change guard)', '23514', sqlstate);
end $$;

do $$
begin
  update assignment set state = 'closed' where id = current_setting('cdt.a1')::uuid;
  perform pg_temp.rec('5', 'illegal transition proposed -> closed', '23514', 'OK - NOT REFUSED');
exception when others then
  perform pg_temp.rec('5', 'illegal transition proposed -> closed', '23514', sqlstate);
end $$;

do $$
begin
  insert into assignment (subject_profile_id, consultant_profile_id, bundle_key, state, scheduled_at)
  values ('22222222-2222-4222-8222-222222222222', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          'I-2', 'scheduled', null);
  perform pg_temp.rec('5', 'scheduled with null scheduled_at (check constraint)', '23514', 'OK - NOT REFUSED');
exception when others then
  perform pg_temp.rec('5', 'scheduled with null scheduled_at (check constraint)', '23514', sqlstate);
end $$;

-- The legal path still works, and the audit trail records it.
do $$
begin
  update assignment set state = 'scheduled', scheduled_at = '2026-09-18T09:00:00Z'
   where id = current_setting('cdt.a1')::uuid;
  perform pg_temp.rec('5', 'legal transition proposed -> scheduled', 'OK', 'OK');
exception when others then
  perform pg_temp.rec('5', 'legal transition proposed -> scheduled', 'OK', sqlstate);
end $$;

select pg_temp.rec('5', 'audit trail rows for that assignment (created + 2 changes)', '3',
  (select count(*)::text from assignment_event where assignment_id = current_setting('cdt.a1')::uuid));

-- MUTATION TEST: drop the change guard, watch the second and third go red.
drop trigger assignment_change on public.assignment;
do $$
begin
  update assignment set state = 'closed' where id = current_setting('cdt.a1')::uuid;
  perform pg_temp.rec('5', 'MUTATION change guard dropped: illegal transition succeeds',
    'OK', 'OK');
  update assignment set state = 'scheduled' where id = current_setting('cdt.a1')::uuid;
exception when others then
  perform pg_temp.rec('5', 'MUTATION change guard dropped: illegal transition succeeds',
    'OK', 'still refused ' || sqlstate);
end $$;
create trigger assignment_change
  before update on public.assignment
  for each row execute function public.assignment_change_guard();
select pg_temp.rec('5', 'change guard restored', '1',
  (select count(*)::text from pg_trigger
    where tgrelid = 'public.assignment'::regclass and tgname = 'assignment_change'));

-- =========================================================== CRITERION 6
-- Runtime half. The catalog half runs in cdt02-assertions.mjs's report.

select pg_temp.rec('6', 'plain member reads assignment', '0',
  pg_temp.visible('select count(*) from assignment', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'));
select pg_temp.rec('6', 'plain member reads submission', '0',
  pg_temp.visible('select count(*) from submission', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'));
select pg_temp.rec('6', 'plain member reads assignment_event', '0',
  pg_temp.visible('select count(*) from assignment_event', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'));
select pg_temp.rec('6', 'plain member reads submission_rating', '0',
  pg_temp.visible('select count(*) from submission_rating', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'));

-- These three expectations are DERIVED from the base tables as postgres, not
-- typed. Criterion 3's successful create_assignment calls legitimately leave rows
-- behind, so a hard-coded count here fails for a reason that has nothing to do
-- with the rule being tested. The assertion that matters is "the role sees
-- exactly the rows the rule says it should", which is what comparing against the
-- unfiltered count gives.
select pg_temp.rec('6', 'consultant B reads exactly their own assignments',
  (select count(*)::text from assignment
    where consultant_profile_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
       or subject_profile_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
  pg_temp.visible('select count(*) from assignment', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'));

select pg_temp.rec('6', 'the CIT reads exactly the assignments about them',
  (select count(*)::text from assignment
    where subject_profile_id = '11111111-1111-4111-8111-111111111111'
       or consultant_profile_id = '11111111-1111-4111-8111-111111111111'),
  pg_temp.visible('select count(*) from assignment', '11111111-1111-4111-8111-111111111111'));

select pg_temp.rec('6', 'head mentor at aal2 reads all assignments',
  (select count(*)::text from assignment),
  pg_temp.visible('select count(*) from assignment',
    'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'aal2'));
select pg_temp.rec('6', 'head mentor at aal1 reads none', '0',
  pg_temp.visible('select count(*) from assignment',
    'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'aal1'));
select pg_temp.rec('6', 'head mentor at aal2 reads all write-ups',
  (select count(*)::text from submission),
  pg_temp.visible('select count(*) from submission',
    'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'aal2'));
select pg_temp.rec('6', 'head mentor at aal1 reads no write-ups', '0',
  pg_temp.visible('select count(*) from submission',
    'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'aal1'));

-- =========================================================== CRITERION 7
-- A second rater is blind to the first. This is the one that would have failed
-- the spec's first draft.

select pg_temp.rec('7', 'B reads own write-up', '1',
  pg_temp.visible(format('select count(*) from submission where id = %L', current_setting('cdt.s1')),
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'));
select pg_temp.rec('7', 'B reads C''s write-up', '0',
  pg_temp.visible(format('select count(*) from submission where id = %L', current_setting('cdt.s2')),
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'));
select pg_temp.rec('7', 'C (second rater) reads B''s write-up', '0',
  pg_temp.visible(format('select count(*) from submission where id = %L', current_setting('cdt.s1')),
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc'));
select pg_temp.rec('7', 'C reads B''s ratings (the recommended_level leak)', '0',
  pg_temp.visible(format('select count(*) from submission_rating where submission_id = %L',
    current_setting('cdt.s1')), 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'));
select pg_temp.rec('7', 'C reads own ratings', '1',
  pg_temp.visible(format('select count(*) from submission_rating where submission_id = %L',
    current_setting('cdt.s2')), 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'));

-- MUTATION TEST: widen helper 3 to the subject scope and watch the blindness go.
create or replace function public.may_see_submission(_submission_id uuid)
returns boolean language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from submission s join assignment a on a.id = s.assignment_id
     where s.id = _submission_id
       and exists (select 1 from assignment m
                    where m.subject_profile_id = a.subject_profile_id
                      and m.consultant_profile_id = auth.uid())
  ) or is_head_mentor() or is_portal_admin();
$$;
select pg_temp.rec('7', 'MUTATION helper 3 widened to subject scope: C now sees B',
  '1',
  pg_temp.visible(format('select count(*) from submission where id = %L', current_setting('cdt.s1')),
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc'));
-- restore
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
select pg_temp.rec('7', 'helper 3 restored: C blind again', '0',
  pg_temp.visible(format('select count(*) from submission where id = %L', current_setting('cdt.s1')),
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc'));

-- =========================================================== CRITERION 9
-- Nothing before release, nothing changes after approval.

select pg_temp.rec('9', 'CIT reads unreleased write-up', '0',
  pg_temp.visible(format('select count(*) from submission where id = %L', current_setting('cdt.s1')),
    '11111111-1111-4111-8111-111111111111'));

do $$ begin
  update submission set released_at = now() where id = current_setting('cdt.s1')::uuid;
end $$;

select pg_temp.rec('9', 'CIT reads it after release', '1',
  pg_temp.visible(format('select count(*) from submission where id = %L', current_setting('cdt.s1')),
    '11111111-1111-4111-8111-111111111111'));

-- Approval requires release, and a consultant cannot approve.
select pg_temp.rec('9', 'consultant calls approve_submission', '42501',
  pg_temp.attempt(format('select approve_submission(%L)', current_setting('cdt.s1')),
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'));
select pg_temp.rec('9', 'head mentor at aal1 calls approve_submission', '42501',
  pg_temp.attempt(format('select approve_submission(%L)', current_setting('cdt.s1')),
    'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'aal1'));
select pg_temp.rec('9', 'head mentor at aal2 approves', 'OK',
  pg_temp.attempt(format('select approve_submission(%L)', current_setting('cdt.s1')),
    'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'aal2'));
select pg_temp.rec('9', 'approval_state after approve', 'approved',
  (select approval_state from submission where id = current_setting('cdt.s1')::uuid));

select pg_temp.rec('9', 'author edits an approved write-up', '23514',
  pg_temp.attempt(format('update submission set body_md = ''tampered'' where id = %L',
    current_setting('cdt.s1')), 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'));
select pg_temp.rec('9', 'author edits an approved write-up''s rating', '23514',
  pg_temp.attempt(format('update submission_rating set recommended_level = 3 where submission_id = %L',
    current_setting('cdt.s1')), 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'));

-- MUTATION TEST: drop the lock, watch the edit succeed.
drop trigger submission_locked_after_approval on public.submission;
select pg_temp.rec('9', 'MUTATION lock dropped: approved write-up now editable',
  'OK',
  pg_temp.attempt(format('update submission set body_md = ''tampered'' where id = %L',
    current_setting('cdt.s1')), 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'));
create trigger submission_locked_after_approval
  before update or delete on public.submission
  for each row execute function public.refuse_change_after_approval();
select pg_temp.rec('9', 'lock restored', '1',
  (select count(*)::text from pg_trigger
    where tgrelid = 'public.submission'::regclass and tgname = 'submission_locked_after_approval'));

-- ========================================================== CRITERION 10
-- A rating cannot escape its bundle, and the required fields are required.

do $$
declare _foreign text;
begin
  -- A unit that is primary in another bundle, so (I-2, that unit) is not in
  -- bundle_unit. Chosen from data rather than typed.
  select unit_key into _foreign from bundle_unit
   where bundle_key = 'I-4' and is_primary
     and unit_key not in (select unit_key from bundle_unit where bundle_key = 'I-2')
   limit 1;
  perform pg_temp.rec('10', 'rating for a unit outside the bundle (' || _foreign || ')', '23503',
    pg_temp.attempt(format(
      'insert into submission_rating (submission_id, bundle_key, unit_key, observed_level, '
      || 'recommended_level, confidence, evidence_sentence, plain_language_check) '
      || 'values (%L, ''I-2'', %L, 2, 2, ''high'', ''x'', ''yes'')',
      current_setting('cdt.s2'), _foreign),
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc'));
end $$;

do $$
begin
  insert into submission_rating (submission_id, bundle_key, unit_key, observed_level,
    recommended_level, confidence, evidence_sentence, plain_language_check)
  values (current_setting('cdt.s2')::uuid, 'I-2',
    (select unit_key from bundle_unit where bundle_key='I-2' and is_primary
      and unit_key <> current_setting('cdt.unit') limit 1),
    2, 2, 'high', null, 'yes');
  perform pg_temp.rec('10', 'rating with a null evidence_sentence', '23502', 'OK - NOT REFUSED');
exception when others then
  perform pg_temp.rec('10', 'rating with a null evidence_sentence', '23502', sqlstate);
end $$;

do $$
begin
  insert into submission (assignment_id, bundle_key, consultant_profile_id, body_md)
  values (current_setting('cdt.a2')::uuid, 'I-2', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'no consent');
  perform pg_temp.rec('10', 'submission with consent_recorded omitted (no default)', '23502', 'OK - NOT REFUSED');
exception when others then
  perform pg_temp.rec('10', 'submission with consent_recorded omitted (no default)', '23502', sqlstate);
end $$;

-- The scope guard, which is what caught the Bundle-Map's I-4 row.
do $$
begin
  insert into consultant_qualification (profile_id, scope_kind, scope_key, basis)
  values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bundle', 'not-a-real-grant', 'x');
  perform pg_temp.rec('10', 'bundle-scoped grant not in the vocabulary', '23503', 'OK - NOT REFUSED');
exception when others then
  perform pg_temp.rec('10', 'bundle-scoped grant not in the vocabulary', '23503', sqlstate);
end $$;

do $$
begin
  insert into consultant_qualification (profile_id, scope_kind, scope_key, basis)
  values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'category', 'not-a-category', 'x');
  perform pg_temp.rec('10', 'category grant not in the registry', '23503', 'OK - NOT REFUSED');
exception when others then
  perform pg_temp.rec('10', 'category grant not in the registry', '23503', sqlstate);
end $$;

-- ------------------------------------------------------------- the report

select criterion,
       name,
       expected,
       actual,
       case when expected = actual then 'PASS' else 'FAIL' end as verdict
from _r order by id;
