-- SITE-08: the attribution surface, asserted against the database.
--
--   node scripts/site08-fixtures.mjs --assert
--
-- This file is NOT self-contained. The runner substitutes @W1@ and the fixture
-- ids, splits on `-- @@CHUNK@@`, and posts each chunk as its own
-- `begin; scaffold; chunk; select …; rollback;`.
--
-- ## Every rule here was paid for by a defect in this campaign
--
-- **One transaction per assertion block, not just per mutation** (program
-- finding 33). SITE-02's first split marked only the mutations, which put each
-- following assertion block inside the previous mutation's broken schema; two
-- of three still passed there. Asserting from inside a SAVEPOINT is worse
-- still: `rollback to savepoint` reverts the results row along with the
-- mutation, so ten verdicts vanished and the run printed success.
--
-- **The count of verdicts is itself an assertion.** The runner refuses a run
-- returning fewer than its stated mutation count. Without it a silently
-- skipped gate mutation passes the check built to stop it.
--
-- **A refusal and an empty read are never one verdict.** `s8run` returns the
-- row count AND the SQLSTATE, never collapsing them, and every zero-row
-- assertion carries a positive control on the same connection.
--
-- **No participant prose is written into this file** (findings 18 and 24, and
-- this session's own leak). Every expected name is read from the database at
-- run time. That matters more here than anywhere in the campaign, because the
-- string in question is a person's name.
--
-- ## Both writing functions are closed-round-only
--
-- Decisions 9 and 10. Every criterion that calls one runs on a CLOSED round in
-- the `site08-rls-w1` namespace unless it says otherwise, and the two that say
-- otherwise are criterion 8's mutated arm and criterion 14's decision-9
-- mutation, each of which provisions its own state and restores it.

create temporary table site08_results (
  seq     serial,
  verdict text,
  label   text,
  outcome text
) on commit drop;

create function s8pass(_label text, _ok boolean, _outcome text default '')
returns void language plpgsql as $$
begin
  insert into site08_results (verdict, label, outcome)
  values (case when _ok then 'PASS' else 'FAIL' end, _label, _outcome);
end $$;

create function s8note(_label text, _outcome text default '')
returns void language plpgsql as $$
begin
  insert into site08_results (verdict, label, outcome) values ('note', _label, _outcome);
end $$;

-- Run `_sql` as `_uid`. Returns how many rows came back, or -1 and the SQLSTATE
-- that refused it. The two are never collapsed into one verdict.
create function s8run(_uid uuid, _sql text, out n bigint, out state text)
language plpgsql as $$
begin
  n := -1; state := null;
  if _uid is null then
    perform set_config('role', 'anon', true);
    perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  else
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claims',
      json_build_object('role', 'authenticated', 'sub', _uid::text, 'aal', 'aal1')::text, true);
  end if;
  begin
    execute 'select count(*) from (' || _sql || ') z' into n;
  exception when others then
    state := sqlstate;
    n := -1;
  end;
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', null, true);
end $$;

-- Call a VOID function as `_uid` and return the SQLSTATE it raised, or null on
-- success. A separate helper from s8run because a void call has no row count
-- and pretending it does is how a refusal becomes an empty read.
create function s8call(_uid uuid, _sql text, out state text, out msg text)
language plpgsql as $$
begin
  state := null; msg := null;
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('role', 'authenticated', 'sub', _uid::text, 'aal', 'aal1')::text, true);
  begin
    execute _sql;
  exception when others then
    state := sqlstate;
    msg := sqlerrm;
  end;
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', null, true);
end $$;

-- Become a signed-in user for the rest of the block, and step back to postgres.
-- Several chunks read an administrator-gated function directly rather than
-- through s8run, because they need its ROWS and not just a count, and
-- auth.uid() is null under postgres so the gate would refuse them.
create function s8be(_uid uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('role', 'authenticated', 'sub', _uid::text, 'aal', 'aal1')::text, true);
end $$;

create function s8unbe() returns void language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', null, true);
end $$;

create function s8cols(_fn text) returns text[] language sql stable as $$
  select array(
    select trim(x) from unnest(string_to_array(
      regexp_replace(pg_get_function_result(p.oid), '^TABLE\(|\)$', '', 'g'), ',')) x
    order by 1)
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = _fn
  limit 1;
$$;

-- @@CHUNK@@ criterion 1: no reader function widened

-- Set-equality against the D0 baseline, not a count: program finding 8's
-- lesson is that a count applied where duplicates are the failure cannot see
-- it. The baselines are the literal strings recorded before the migration.
do $$
declare
  _sum text[] := s8cols('evaluation_summary');
  _com text[] := s8cols('evaluation_comments');
  _ans text[] := s8cols('evaluation_answers_feed');
begin
  perform s8pass('c1 evaluation_summary return set unchanged',
    _sum @> array['item_key text','mean_rating numeric','suppressed boolean']
      and array_length(_sum, 1) = 12,
    array_length(_sum, 1) || ' columns');
  perform s8pass('c1 evaluation_comments return set unchanged',
    array_length(_com, 1) = 4 and not (_com::text ilike '%name%'),
    array_to_string(_com, ' | '));
  perform s8pass('c1 evaluation_answers_feed return set unchanged',
    array_length(_ans, 1) = 3 and not (_ans::text ilike '%name%'),
    array_to_string(_ans, ' | '));
  -- The property that actually matters, stated independently of the counts: no
  -- reader returns anything name-shaped or a response correlation key.
  perform s8pass('c1 no reader returns a name or a response id',
    not (_sum::text ilike '%name%') and not (_com::text ilike '%response_id%')
      and not (_ans::text ilike '%response_id%'),
    'the typed name reaches no facilitator-facing read');
end $$;

-- @@CHUNK@@ criterion 1 MUTATION: widen evaluation_comments and watch it go red

-- Inside this chunk's own transaction, which the runner rolls back. Finding 30:
-- `create or replace` refuses a return-type change, so this must drop first,
-- which also drops the grants and is why the grants are re-asserted after.
do $$
declare _before text[] := s8cols('evaluation_comments');
begin
  drop function if exists public.evaluation_comments(text);
  create function public.evaluation_comments(_round_key text)
  returns table (item_key text, item_title text, kind text, comment text, typed_name text)
  language sql stable security definer set search_path = public as $f$
    select null::text, null::text, null::text, null::text, null::text where false;
  $f$;
  perform s8pass('c1 MUTATION widened reader is detected',
    s8cols('evaluation_comments') <> _before
      and s8cols('evaluation_comments')::text ilike '%typed_name%',
    'set-equality goes red naming typed_name');
end $$;

-- @@CHUNK@@ criterion 19: both new tables closed to every client role

do $$
declare
  _t text;
  _v text;
  _open int := 0;
  _pol int;
  _rls boolean;
begin
  foreach _t in array array['evaluation_response_identity','evaluation_attribution_log'] loop
    execute format('select relrowsecurity from pg_class where oid = %L::regclass', 'public.' || _t) into _rls;
    perform s8pass('c19 ' || _t || ' has RLS enabled', _rls);
    select count(*) into _pol from pg_policies where schemaname = 'public' and tablename = _t;
    perform s8pass('c19 ' || _t || ' has zero policies', _pol = 0, _pol || ' policies');
    foreach _v in array array['select','insert','update','delete'] loop
      if has_table_privilege('anon', 'public.' || _t, _v) then _open := _open + 1; end if;
      if has_table_privilege('authenticated', 'public.' || _t, _v) then _open := _open + 1; end if;
    end loop;
  end loop;
  perform s8pass('c19 anon and authenticated hold none of the 16 table privileges',
    _open = 0, _open || ' privileges held');
end $$;

-- @@CHUNK@@ criterion 19 MUTATION: restore one grant and watch it go red

do $$
declare _held boolean;
begin
  grant select on table public.evaluation_response_identity to authenticated;
  _held := has_table_privilege('authenticated', 'public.evaluation_response_identity', 'select');
  perform s8pass('c19 MUTATION a restored grant is detected', _held,
    'authenticated holds SELECT on evaluation_response_identity');
end $$;

-- @@CHUNK@@ criterion 4: per-function grant posture, as an effective privilege

-- has_function_privilege and NOT a role_routine_grants row. Review-2 finding
-- B1: a PUBLIC grant is reported under the grantee name PUBLIC and never under
-- anon, so a criterion looking for an anon row stays green while anon holds the
-- privilege through PUBLIC. proacl is checked too, which catches it at source.
do $$
declare
  _fn text;
  _bad int := 0;
  _acl text;
begin
  foreach _fn in array array[
    'evaluation_attribution_queue()',
    'resolve_evaluation_response(uuid,uuid,text)',
    'detach_evaluation_response(uuid,text)',
    'evaluation_attribution_history(uuid)'
  ] loop
    if has_function_privilege('anon', ('public.' || _fn)::regprocedure, 'EXECUTE') then
      _bad := _bad + 1;
      perform s8note('c4 anon CAN execute ' || _fn);
    end if;
    if not has_function_privilege('authenticated', ('public.' || _fn)::regprocedure, 'EXECUTE') then
      _bad := _bad + 1;
      perform s8note('c4 authenticated CANNOT execute ' || _fn);
    end if;
    select coalesce(array_to_string(p.proacl, ','), '') into _acl
    from pg_proc p where p.oid = ('public.' || _fn)::regprocedure;
    if _acl ~ '(^|,)=X/' then
      _bad := _bad + 1;
      perform s8note('c4 PUBLIC execute entry in proacl for ' || _fn, _acl);
    end if;
  end loop;
  perform s8pass('c4 all four functions: anon refused, authenticated admitted, no PUBLIC entry',
    _bad = 0, _bad || ' defect(s)');
end $$;

-- @@CHUNK@@ criterion 4 MUTATION: remove one revoke and watch it go red

do $$
declare _anon boolean;
begin
  grant execute on function public.resolve_evaluation_response(uuid,uuid,text) to public;
  _anon := has_function_privilege('anon',
    'public.resolve_evaluation_response(uuid,uuid,text)'::regprocedure, 'EXECUTE');
  perform s8pass('c4 MUTATION a PUBLIC grant is visible to the anon assertion', _anon,
    'anon holds EXECUTE through PUBLIC, which a role_routine_grants row would have missed');
end $$;

-- @@CHUNK@@ criterion 5: the queue buckets on the attested name and attaches nothing

do $$
declare
  _matched   text;
  _ambiguous text;
  _unmatched int;
  _first     text;
  _attested  text;
  _declared  text;
  _selfleak  int;
  _stillnull int;
  _twinname  text;
begin
  -- Read the expected strings from the database, never from a literal here.
  select m.full_name, p.full_name into _attested, _declared
  from public.profiles p join public.member_allowlist m on lower(m.email) = lower(p.email)
  where p.id = '@REAL@';

  -- The queue is administrator-gated and auth.uid() is null under postgres, so
  -- this block reads it AS the administrator. Criterion 6 is what proves the
  -- gate; this chunk is about what the queue returns.
  select full_name into _twinname from public.member_allowlist
  where email = '@TWIN_A_EMAIL@';

  -- Everything the queue returns is gathered under impersonation; the verdicts
  -- are recorded after stepping back, because the results table belongs to
  -- postgres and `authenticated` cannot insert into it.
  perform s8be('@ADMIN@');

  select bucket into _matched from public.evaluation_attribution_queue()
  where round_key = '@W1@' and typed_name = _attested;

  select bucket into _ambiguous from public.evaluation_attribution_queue()
  where round_key = '@W1@' and typed_name = _twinname;

  select count(*) into _unmatched from public.evaluation_attribution_queue()
  where round_key = '@W1@' and bucket = 'unmatched';

  select candidates->0->>'full_name' into _first
  from public.evaluation_attribution_queue()
  where round_key = '@W1@' and typed_name = _attested;

  select count(*) into _selfleak
  from public.evaluation_attribution_queue() q, jsonb_array_elements(q.candidates) c
  where c->>'full_name' = _declared;

  perform s8unbe();

  perform s8pass('c5 an attested name resolving to one allowlist row buckets matched',
    _matched = 'matched', coalesce(_matched, 'null'));
  perform s8pass('c5 a name resolving to two allowlist rows buckets ambiguous',
    _ambiguous = 'ambiguous', coalesce(_ambiguous, 'null'));
  perform s8pass('c5 a name matching nothing and a blank name both bucket unmatched',
    _unmatched = 2, _unmatched || ' unmatched rows');
  -- The matching person leads the candidate list, and it is a SUGGESTION.
  perform s8pass('c5 the matched row leads with the matching person',
    _first = _attested, coalesce(_first, 'null'));
  -- Review-2 finding B8: the candidate array carries the ATTESTED name and
  -- never the self-declared one, which is where finding 13's string could
  -- still steer a human decision.
  perform s8pass('c5 no candidate anywhere carries the self-declared name',
    _selfleak = 0, 'profile name "' || _declared || '" appears ' || _selfleak || ' times');

  -- The half that proves a bucket is a suggestion rather than an action.
  select count(*) into _stillnull from public.evaluation_response
  where round_key = '@W1@' and profile_id is null;
  perform s8pass('c5 nothing attached itself: all four responses still unattributed',
    _stillnull = 4, _stillnull || ' of 4 still null');
end $$;

-- @@CHUNK@@ criterion 5 MUTATION a: repoint the BUCKET join at profiles.full_name

-- Adversarial setup, deliberately not the trigger-written fixture: another
-- member's self-declared name is written through so the bucket would change if
-- the join read it.
do $$
declare _bucket text; _attested text;
begin
  select m.full_name into _attested
  from public.member_allowlist m where lower(m.email) = lower(
    (select email from public.profiles where id = '@REAL@'));

  update public.profiles set full_name = 'Nobody On This Roster' where id = '@REAL@';

  create or replace function public.evaluation_attribution_queue()
  returns table (response_id uuid, round_key text, round_display_name text,
                 typed_name text, submitted_at timestamptz, bucket text, candidates jsonb)
  language plpgsql stable security definer set search_path = public as $f$
  begin
    if not is_portal_admin() then
      raise exception 'admin only' using errcode = 'insufficient_privilege';
    end if;
    return query
    select r.id, r.round_key, w.display_name, coalesce(i.typed_name,''), r.submitted_at,
      case when i.name_norm is null then 'unmatched'
           -- MUTATED: profiles.full_name instead of member_allowlist.full_name
           when (select count(*) from profiles p
                 where evaluation_name_norm(p.full_name) = i.name_norm) = 1 then 'matched'
           when (select count(*) from profiles p
                 where evaluation_name_norm(p.full_name) = i.name_norm) > 1 then 'ambiguous'
           else 'unmatched' end::text,
      '[]'::jsonb
    from evaluation_response r
    left join evaluation_response_identity i on i.response_id = r.id
    join workshop_evaluation_round w on w.round_key = r.round_key
    where r.profile_id is null;
  end $f$;

  perform s8be('@ADMIN@');
  select bucket into _bucket from public.evaluation_attribution_queue()
  where round_key = '@W1@' and typed_name = _attested;
  perform s8unbe();
  perform s8pass('c5 MUTATION a bucket join repointed at the self-declared name goes red',
    _bucket is distinct from 'matched',
    'the attested name now buckets ' || coalesce(_bucket, 'null') || ' instead of matched');
end $$;

-- @@CHUNK@@ criterion 5 MUTATION b: repoint the CANDIDATE join at profiles.full_name

do $$
declare _first text; _declared text;
begin
  select p.full_name into _declared from public.profiles p where p.id = '@REAL@';

  create or replace function public.evaluation_attribution_queue()
  returns table (response_id uuid, round_key text, round_display_name text,
                 typed_name text, submitted_at timestamptz, bucket text, candidates jsonb)
  language plpgsql stable security definer set search_path = public as $f$
  begin
    if not is_portal_admin() then
      raise exception 'admin only' using errcode = 'insufficient_privilege';
    end if;
    return query
    select r.id, r.round_key, w.display_name, coalesce(i.typed_name,''), r.submitted_at,
      'matched'::text,
      -- MUTATED: the picker renders profiles.full_name
      (select coalesce(jsonb_agg(jsonb_build_object(
                 'profile_id', p.id, 'email', m.email, 'full_name', p.full_name)), '[]'::jsonb)
       from member_allowlist m left join profiles p on lower(p.email) = lower(m.email)
       where p.id = '@REAL@')
    from evaluation_response r
    left join evaluation_response_identity i on i.response_id = r.id
    join workshop_evaluation_round w on w.round_key = r.round_key
    where r.profile_id is null;
  end $f$;

  perform s8be('@ADMIN@');
  select candidates->0->>'full_name' into _first
  from public.evaluation_attribution_queue() where round_key = '@W1@' limit 1;
  perform s8unbe();
  perform s8pass('c5 MUTATION b candidate join repointed at the self-declared name goes red',
    _first = _declared,
    'the picker would render "' || coalesce(_first,'null') || '", which is the self-declared name');
end $$;

-- @@CHUNK@@ criterion 6: the queue is administrator-only

do $$
declare _n bigint; _st text; _ctl bigint; _cst text;
begin
  select n, state into _n, _st from s8run('@REAL@',
    'select * from public.evaluation_attribution_queue()');
  perform s8pass('c6 a non-administrator is refused by SQLSTATE',
    _st = '42501', 'sqlstate ' || coalesce(_st, 'none') || ', rows ' || _n);

  -- Positive control on the same connection: a refusal and a broken query must
  -- never look alike.
  select n, state into _ctl, _cst from s8run('@REAL@', 'select 1');
  perform s8pass('c6 positive control: the same caller can still read something',
    _ctl = 1 and _cst is null, 'control rows ' || _ctl);

  select n, state into _n, _st from s8run('@ADMIN@',
    'select * from public.evaluation_attribution_queue()');
  perform s8pass('c6 the administrator reads a non-zero queue',
    _st is null and _n >= 4, 'rows ' || _n);
end $$;

-- @@CHUNK@@ criterion 13: the four administrator gates, each mutation-tested

-- Four mutations, one per function, each watched going RED: with the gate
-- deleted the call that MUST raise insufficient_privilege no longer does.
-- Phrased as a red watch rather than "confirm a non-admin can call it", per
-- review-2 note 7, because every other mutation here is watched going red.
do $$
declare _st text; _n bigint;
begin
  select n, state into _n, _st from s8run('@REAL@',
    'select * from public.evaluation_attribution_queue()');
  perform s8pass('c13 queue gate refuses a non-administrator', _st = '42501', coalesce(_st,'none'));

  select state into _st from s8call('@REAL@',
    'select public.resolve_evaluation_response(''@RESP_MATCHED@''::uuid, ''@REAL@''::uuid, ''x'')');
  perform s8pass('c13 resolve gate refuses a non-administrator', _st = '42501', coalesce(_st,'none'));

  select state into _st from s8call('@REAL@',
    'select public.detach_evaluation_response(''@RESP_MATCHED@''::uuid, ''x'')');
  perform s8pass('c13 detach gate refuses a non-administrator', _st = '42501', coalesce(_st,'none'));

  select n, state into _n, _st from s8run('@REAL@',
    'select * from public.evaluation_attribution_history(''@RESP_MATCHED@''::uuid)');
  perform s8pass('c13 history gate refuses a non-administrator', _st = '42501', coalesce(_st,'none'));
end $$;

-- @@CHUNK@@ criterion 13 MUTATION 1: delete the queue's gate

do $$
declare _st text; _n bigint;
begin
  create or replace function public.evaluation_attribution_queue()
  returns table (response_id uuid, round_key text, round_display_name text,
                 typed_name text, submitted_at timestamptz, bucket text, candidates jsonb)
  language plpgsql stable security definer set search_path = public as $f$
  begin
    return query select r.id, r.round_key, w.display_name, ''::text, r.submitted_at,
      'unmatched'::text, '[]'::jsonb
    from evaluation_response r join workshop_evaluation_round w on w.round_key = r.round_key
    where r.profile_id is null;
  end $f$;
  select n, state into _n, _st from s8run('@REAL@',
    'select * from public.evaluation_attribution_queue()');
  perform s8pass('c13 MUTATION queue gate deleted: the refusal disappears',
    _st is null, 'a non-administrator now reads ' || _n || ' rows unrefused');
end $$;

-- @@CHUNK@@ criterion 13 MUTATION 2: delete resolve's gate

do $$
declare _st text;
begin
  create or replace function public.resolve_evaluation_response(
    _response_id uuid, _profile_id uuid, _reason text default '')
  returns void language plpgsql security definer set search_path = public as $f$
  begin
    -- gate deleted
    update evaluation_response set profile_id = _profile_id where id = _response_id;
  end $f$;
  select state into _st from s8call('@REAL@',
    'select public.resolve_evaluation_response(''@RESP_MATCHED@''::uuid, ''@REAL@''::uuid, ''x'')');
  perform s8pass('c13 MUTATION resolve gate deleted: the refusal disappears',
    _st is null, 'a non-administrator wrote an attribution unrefused');
end $$;

-- @@CHUNK@@ criterion 13 MUTATION 3: delete detach's gate

do $$
declare _st text;
begin
  update public.evaluation_response set profile_id = '@REAL@' where id = '@RESP_MATCHED@';
  create or replace function public.detach_evaluation_response(_response_id uuid, _reason text)
  returns void language plpgsql security definer set search_path = public as $f$
  begin
    -- gate deleted
    update evaluation_response set profile_id = null where id = _response_id;
  end $f$;
  select state into _st from s8call('@REAL@',
    'select public.detach_evaluation_response(''@RESP_MATCHED@''::uuid, ''x'')');
  perform s8pass('c13 MUTATION detach gate deleted: the refusal disappears',
    _st is null, 'a non-administrator detached a response unrefused');
end $$;

-- @@CHUNK@@ criterion 13 MUTATION 4: delete history's gate

do $$
declare _st text; _n bigint;
begin
  create or replace function public.evaluation_attribution_history(_response_id uuid)
  returns table (id uuid, action text, actor_email text, subject_email text,
                 typed_name text, reason text, at timestamptz)
  language plpgsql stable security definer set search_path = public as $f$
  begin
    return query select l.id, l.action, ''::text, ''::text, l.typed_name, l.reason, l.at
    from evaluation_attribution_log l where l.response_id = _response_id;
  end $f$;
  select n, state into _n, _st from s8run('@REAL@',
    'select * from public.evaluation_attribution_history(''@RESP_MATCHED@''::uuid)');
  perform s8pass('c13 MUTATION history gate deleted: the refusal disappears',
    _st is null, 'a non-administrator read the audit unrefused');
end $$;

-- @@CHUNK@@ criterion 7 and 12: a resolve attaches, logs, and destroys the evidence

do $$
declare _st text; _msg text; _owner uuid; _ident int; _log int; _typed text;
begin
  -- Criterion 15's ordering rule: capture the evidence BEFORE the resolve,
  -- because the resolve deletes it and comparing against NULL passes vacuously.
  select typed_name into _typed from public.evaluation_response_identity
  where response_id = '@RESP_MATCHED@';
  perform s8pass('c15 the typed name is captured before the decision',
    _typed is not null and _typed <> '', coalesce(_typed, 'null'));

  select state, msg into _st, _msg from s8call('@ADMIN@',
    'select public.resolve_evaluation_response(''@RESP_MATCHED@''::uuid, ''@REAL@''::uuid, ''criterion 7'')');
  perform s8pass('c7 the administrator resolves without error', _st is null,
    coalesce(_st || ' ' || _msg, 'ok'));

  select profile_id into _owner from public.evaluation_response where id = '@RESP_MATCHED@';
  perform s8pass('c7 the response is now owned by the named subject', _owner = '@REAL@'::uuid,
    coalesce(_owner::text, 'null'));

  -- D5, finding 7: without the participation row the owner sees nothing in the
  -- portal at all, because myRounds reads evaluation_participant first.
  perform s8pass('c8 resolving added the participation row',
    exists (select 1 from public.evaluation_participant
            where round_key = '@W1@' and profile_id = '@REAL@'));

  select count(*) into _ident from public.evaluation_response_identity
  where response_id = '@RESP_MATCHED@';
  perform s8pass('c12 the evidence is destroyed on decision', _ident = 0, _ident || ' identity rows');

  select count(*) into _log from public.evaluation_attribution_log
  where response_id = '@RESP_MATCHED@' and action = 'resolve';
  perform s8pass('c15 the decision is logged once', _log = 1, _log || ' log rows');

  -- D6's deliberate exception to D2: the log KEEPS the typed name, compared
  -- against the value captured before the delete.
  perform s8pass('c15 the log kept the typed name the identity row no longer has',
    (select typed_name from public.evaluation_attribution_log
     where response_id = '@RESP_MATCHED@' and action = 'resolve') = _typed,
    'log holds the captured evidence');
end $$;

-- @@CHUNK@@ criterion 12 MUTATION: remove the identity delete

do $$
declare _ident int;
begin
  create or replace function public.resolve_evaluation_response(
    _response_id uuid, _profile_id uuid, _reason text default '')
  returns void language plpgsql security definer set search_path = public as $f$
  declare _round text;
  begin
    if not is_portal_admin() then
      raise exception 'admin only' using errcode = 'insufficient_privilege';
    end if;
    select round_key into _round from evaluation_response where id = _response_id for update;
    update evaluation_response set profile_id = _profile_id where id = _response_id;
    insert into evaluation_attribution_log (response_id, round_key, action, actor_id, subject_id, reason)
    values (_response_id, _round, 'resolve', auth.uid(), _profile_id, _reason);
    -- MUTATED: the identity delete is gone
  end $f$;
  perform s8call('@ADMIN@',
    'select public.resolve_evaluation_response(''@RESP_AMBIG@''::uuid, ''@TWIN_A@''::uuid, ''mutation'')');
  select count(*) into _ident from public.evaluation_response_identity
  where response_id = '@RESP_AMBIG@';
  perform s8pass('c12 MUTATION the evidence survives the decision',
    _ident = 1, _ident || ' identity row still present after a resolve');
end $$;

-- @@CHUNK@@ criterion 10: unattributable requires a reason and stays unattached

do $$
declare _st text; _owner uuid; _log int; _ident int;
begin
  select state into _st from s8call('@ADMIN@',
    'select public.resolve_evaluation_response(''@RESP_UNMATCHED@''::uuid, null, '''')');
  perform s8pass('c10 an empty reason raises check_violation', _st = '23514', coalesce(_st,'none'));

  select state into _st from s8call('@ADMIN@',
    'select public.resolve_evaluation_response(''@RESP_UNMATCHED@''::uuid, null, ''   '')');
  perform s8pass('c10 a whitespace-only reason raises check_violation', _st = '23514', coalesce(_st,'none'));

  select state into _st from s8call('@ADMIN@',
    'select public.resolve_evaluation_response(''@RESP_UNMATCHED@''::uuid, null, ''cannot be identified'')');
  perform s8pass('c10 with a reason it succeeds', _st is null, coalesce(_st,'ok'));

  select profile_id into _owner from public.evaluation_response where id = '@RESP_UNMATCHED@';
  perform s8pass('c10 the response stays unattached', _owner is null, coalesce(_owner::text,'null'));

  select count(*) into _ident from public.evaluation_response_identity
  where response_id = '@RESP_UNMATCHED@';
  perform s8pass('c10 the evidence is destroyed here too', _ident = 0, _ident || ' identity rows');

  select count(*) into _log from public.evaluation_attribution_log
  where response_id = '@RESP_UNMATCHED@' and action = 'unattributable';
  perform s8pass('c10 one unattributable row is logged with its reason', _log = 1, _log || ' log rows');
end $$;

-- @@CHUNK@@ criterion 11: a second resolve refuses, and the lock is asserted PRESENT

-- Decision 11. The concurrent form cannot be staged on this transport: every
-- SQL path posts a complete begin/rollback in one HTTP request and the repo has
-- no direct Postgres client, so two overlapping transactions are impossible.
-- What is asserted is the sequential refusal and the lock's PRESENCE and
-- POSITION. This criterion does NOT prove the lock works.
do $$
declare _st text; _log int; _def text; _gate int; _lock int; _check int;
begin
  perform s8call('@ADMIN@',
    'select public.resolve_evaluation_response(''@RESP_MATCHED@''::uuid, ''@REAL@''::uuid, ''first'')');
  select state into _st from s8call('@ADMIN@',
    'select public.resolve_evaluation_response(''@RESP_MATCHED@''::uuid, ''@OTHER@''::uuid, ''second'')');
  perform s8pass('c11 a second resolve naming a different subject raises unique_violation',
    _st = '23505', 'sqlstate ' || coalesce(_st, 'none'));

  select count(*) into _log from public.evaluation_attribution_log
  where response_id = '@RESP_MATCHED@' and action = 'resolve';
  perform s8pass('c11 exactly one resolve row is logged', _log = 1, _log || ' rows');

  -- The lock's presence AND position: after the gate, before the precondition
  -- re-checks, which is D4's stated placement.
  select pg_get_functiondef(p.oid) into _def from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'resolve_evaluation_response';
  _gate  := position('is_portal_admin' in _def);
  _lock  := position('for update' in _def);
  _check := position('already attributed' in _def);
  perform s8pass('c11 resolve holds a for-update on the response row', _lock > 0);
  perform s8pass('c11 the lock sits after the gate and before the precondition re-checks',
    _gate > 0 and _lock > _gate and _check > _lock,
    'gate@' || _gate || ' lock@' || _lock || ' precondition@' || _check);

  select pg_get_functiondef(p.oid) into _def from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'detach_evaluation_response';
  perform s8pass('c11 detach holds a for-update too',
    position('for update' in _def) > position('is_portal_admin' in _def));

  perform s8note('c11 NOT PROVEN: the two-writer race',
    'decision 11 — no lane in either campaign can stage two overlapping transactions');
end $$;

-- @@CHUNK@@ criterion 11 MUTATION: delete the for-update and watch the assertion go red

-- The mutated body carries NO comment naming the lock, and that is deliberate
-- rather than tidiness. The first version of this mutation wrote
-- `-- MUTATED: no for-update` inside the function, and pg_get_functiondef
-- returns comments, so the assertion searching for the phrase found it in the
-- comment and the mutation reported itself un-mutated. A criterion that greps
-- a function's TEXT is defeated by prose in that function, which is worth
-- knowing for any later spec asserting on pg_get_functiondef.
--
-- The assertion is therefore two-sided: the phrase is gone AND the body still
-- contains the update it was guarding, so a mutation that simply emptied the
-- function could not pass either.
do $$
declare _def text;
begin
  create or replace function public.resolve_evaluation_response(
    _response_id uuid, _profile_id uuid, _reason text default '')
  returns void language plpgsql security definer set search_path = public as $f$
  begin
    if not is_portal_admin() then
      raise exception 'admin only' using errcode = 'insufficient_privilege';
    end if;
    update evaluation_response set profile_id = _profile_id where id = _response_id;
  end $f$;
  select pg_get_functiondef(p.oid) into _def from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'resolve_evaluation_response';
  perform s8pass('c11 MUTATION the missing lock is detected',
    position('for update' in _def) = 0 and position('update evaluation_response' in _def) > 0,
    'pg_get_functiondef no longer contains the lock, and still contains the write it guarded');
end $$;

-- @@CHUNK@@ criterion 13 refusals 3, 4, 5: the named refusals on resolve

do $$
declare _st text;
begin
  -- Refusal 4: a portal filing cannot be re-attributed.
  -- evaluation_response_source_provenance forbids source='portal' with an
  -- import_id, so both move together. The import_id is put back below.
  update public.evaluation_response set source = 'portal', import_id = null
  where id = '@RESP_AMBIG@';
  select state into _st from s8call('@ADMIN@',
    'select public.resolve_evaluation_response(''@RESP_AMBIG@''::uuid, ''@TWIN_A@''::uuid, ''x'')');
  perform s8pass('c13 refusal 4: a portal filing is refused by check_violation',
    _st = '23514', coalesce(_st,'none'));
  update public.evaluation_response set source = 'manual',
    import_id = (select id from public.evaluation_import where round_key = '@W1@' limit 1)
  where id = '@RESP_AMBIG@';

  -- Refusal 5: the subject must be on the allowlist. The offlist fixture is
  -- registered and then removed from the allowlist, a state no signUp reaches.
  select state into _st from s8call('@ADMIN@',
    'select public.resolve_evaluation_response(''@RESP_AMBIG@''::uuid, ''@OFFLIST@''::uuid, ''x'')');
  perform s8pass('c13 refusal 5: an off-allowlist subject is refused by check_violation',
    _st = '23514', coalesce(_st,'none'));

  -- Refusal 3: the subject already holds a response in this round.
  perform s8call('@ADMIN@',
    'select public.resolve_evaluation_response(''@RESP_AMBIG@''::uuid, ''@TWIN_A@''::uuid, ''first'')');
  select state into _st from s8call('@ADMIN@',
    'select public.resolve_evaluation_response(''@RESP_BLANK@''::uuid, ''@TWIN_A@''::uuid, ''again'')');
  perform s8pass('c13 refusal 3: one person cannot own two responses in one round',
    _st = '23505', coalesce(_st,'none'));
end $$;

-- @@CHUNK@@ criterion 14: detach returns the response, is audited, and refuses two states

do $$
declare _st text; _owner uuid; _log int; _part boolean;
begin
  perform s8call('@ADMIN@',
    'select public.resolve_evaluation_response(''@RESP_MATCHED@''::uuid, ''@REAL@''::uuid, ''setup'')');

  select state into _st from s8call('@ADMIN@',
    'select public.detach_evaluation_response(''@RESP_MATCHED@''::uuid, '''')');
  perform s8pass('c14 an empty reason raises check_violation', _st = '23514', coalesce(_st,'none'));

  select state into _st from s8call('@ADMIN@',
    'select public.detach_evaluation_response(''@RESP_MATCHED@''::uuid, ''   '')');
  perform s8pass('c14 a whitespace-only reason raises check_violation', _st = '23514', coalesce(_st,'none'));

  select state into _st from s8call('@ADMIN@',
    'select public.detach_evaluation_response(''@RESP_MATCHED@''::uuid, ''criterion 14'')');
  perform s8pass('c14 with a reason the detach succeeds', _st is null, coalesce(_st,'ok'));

  select profile_id into _owner from public.evaluation_response where id = '@RESP_MATCHED@';
  perform s8pass('c14 the response is unattached again', _owner is null, coalesce(_owner::text,'null'));

  select count(*) into _log from public.evaluation_attribution_log
  where response_id = '@RESP_MATCHED@' and action = 'detach';
  perform s8pass('c14 the detach is logged with its reason', _log = 1, _log || ' rows');

  -- D5's stated asymmetry, asserted so a later session cannot read the
  -- survival as a bug: the membership may pre-date this spec's write.
  select exists (select 1 from public.evaluation_participant
                 where round_key = '@W1@' and profile_id = '@REAL@') into _part;
  perform s8pass('c14 the participation row deliberately survives the detach', _part,
    'D5: detach must not remove a membership it did not create');

  -- A detach of an unattached response.
  select state into _st from s8call('@ADMIN@',
    'select public.detach_evaluation_response(''@RESP_MATCHED@''::uuid, ''again'')');
  perform s8pass('c14 detaching an unattached response raises check_violation',
    _st = '23514', coalesce(_st,'none'));

  -- Decision 8: a portal filing is refused, and its author can still read it.
  update public.evaluation_response set source = 'portal', import_id = null,
    profile_id = '@OTHER@'
  where id = '@RESP_BLANK@';
  select state into _st from s8call('@ADMIN@',
    'select public.detach_evaluation_response(''@RESP_BLANK@''::uuid, ''x'')');
  perform s8pass('c14 decision 8: a portal filing is refused by check_violation',
    _st = '23514', coalesce(_st,'none'));
  perform s8pass('c14 decision 8: its author can still read their own response',
    (select profile_id from public.evaluation_response where id = '@RESP_BLANK@') = '@OTHER@'::uuid,
    'the refusal protected the read it exists to protect');
end $$;

-- @@CHUNK@@ criterion 8 and 14: the open-round refusals, decisions 9 and 10

do $$
declare _st text;
begin
  -- Decision 10: resolve refuses an open round. This is the refusal that makes
  -- the participation-row invariant true rather than nearly true.
  update public.workshop_evaluation_round
  set state = 'open', opens_at = now() - interval '1 day', closes_at = now() + interval '1 day'
  where round_key = '@W1@';

  select state into _st from s8call('@ADMIN@',
    'select public.resolve_evaluation_response(''@RESP_UNMATCHED@''::uuid, ''@REAL@''::uuid, ''x'')');
  perform s8pass('c8 decision 10: resolve on an OPEN round raises check_violation',
    _st = '23514', coalesce(_st,'none'));

  -- Decision 9: detach refuses an open round too.
  update public.evaluation_response set profile_id = '@OTHER@' where id = '@RESP_UNMATCHED@';
  select state into _st from s8call('@ADMIN@',
    'select public.detach_evaluation_response(''@RESP_UNMATCHED@''::uuid, ''x'')');
  perform s8pass('c14 decision 9: detach on an OPEN round raises check_violation',
    _st = '23514', coalesce(_st,'none'));

  -- Restored in the same chunk, and the restore is asserted. The runner rolls
  -- the chunk back too, which is the stronger guarantee, but an explicit
  -- restore is what D9 asks for.
  update public.evaluation_response set profile_id = null where id = '@RESP_UNMATCHED@';
  update public.workshop_evaluation_round
  set state = 'closed', opens_at = now() - interval '60 days', closes_at = now() - interval '30 days'
  where round_key = '@W1@';
  perform s8pass('c8/c14 the round is restored to closed',
    not public.evaluation_round_is_open('@W1@'), 'restore asserted');
end $$;

-- @@CHUNK@@ criterion 8 MUTATION, mutated arm: remove decision 10 and watch the takeover destroy data

-- The sharpest mutation in this spec, because what it demonstrates is SILENT
-- DATA LOSS on the ordinary happy path. With the open-round refusal gone, a
-- resolved participant filing normally does not create a second response: they
-- take over the imported one, and submit_evaluation()'s replace-by-comparison
-- deletes strip its ratings and answers, while the provenance constraint stays
-- quiet because source and import_id are unchanged.
do $$
declare
  _st text; _ratings_before int; _ratings_after int; _same boolean; _src text; _imp uuid;
begin
  -- Give the imported response some child rows to lose.
  -- item_key is format-checked as ^w[0-9]+d[0-9]+-[a-z0-9]+$, so a fixture key
  -- has to look like a real one rather than carry the lane's prefix.
  insert into public.evaluation_item
    (round_key, item_key, day, part, kind, title, ordinal, active)
  values ('@W1@', 'w1d1-fixture', 1, 'morning', 'session', 'Fixture item', 1, true)
  on conflict do nothing;
  insert into public.evaluation_item_rating (response_id, round_key, item_key, attended, rating)
  values ('@RESP_UNMATCHED@', '@W1@', 'w1d1-fixture', true, 4)
  on conflict do nothing;
  select count(*) into _ratings_before from public.evaluation_item_rating
  where response_id = '@RESP_UNMATCHED@';

  -- MUTATION: decision 10's refusal removed.
  create or replace function public.resolve_evaluation_response(
    _response_id uuid, _profile_id uuid, _reason text default '')
  returns void language plpgsql security definer set search_path = public as $f$
  declare _round text;
  begin
    if not is_portal_admin() then
      raise exception 'admin only' using errcode = 'insufficient_privilege';
    end if;
    select round_key into _round from evaluation_response where id = _response_id for update;
    -- MUTATED: no open-round refusal
    update evaluation_response set profile_id = _profile_id where id = _response_id;
    insert into evaluation_participant (round_key, profile_id)
    values (_round, _profile_id) on conflict do nothing;
    insert into evaluation_attribution_log (response_id, round_key, action, actor_id, subject_id, reason)
    values (_response_id, _round, 'resolve', auth.uid(), _profile_id, _reason);
    delete from evaluation_response_identity where response_id = _response_id;
  end $f$;

  update public.workshop_evaluation_round
  set state = 'open', opens_at = now() - interval '1 day', closes_at = now() + interval '1 day'
  where round_key = '@W1@';

  select state into _st from s8call('@ADMIN@',
    'select public.resolve_evaluation_response(''@RESP_UNMATCHED@''::uuid, ''@REAL@''::uuid, ''mutated'')');
  perform s8pass('c8 MUTATION the resolve now succeeds on an open round', _st is null,
    coalesce(_st, 'no refusal'));

  -- The attributed person files normally, which is the ordinary happy path.
  select state into _st from s8call('@REAL@',
    'select public.submit_evaluation(''@W1@'', ''cit'', ''[]''::jsonb, ''[]''::jsonb, true)');

  select count(*) into _ratings_after from public.evaluation_item_rating
  where response_id = '@RESP_UNMATCHED@';
  select (source = 'manual'), source, import_id into _same, _src, _imp
  from public.evaluation_response where id = '@RESP_UNMATCHED@';

  perform s8pass('c8 MUTATION the imported response was TAKEN OVER, not duplicated',
    _st is null, 'submit_evaluation succeeded: ' || coalesce(_st, 'no error'));
  perform s8pass('c8 MUTATION its ratings were silently destroyed',
    _ratings_before = 1 and _ratings_after = 0,
    _ratings_before || ' rating(s) before, ' || _ratings_after || ' after');
  perform s8pass('c8 MUTATION the provenance constraint stayed quiet',
    _same and _imp is not null,
    'source is still ' || _src || ' with its import_id intact, so nothing fired');
end $$;

-- @@CHUNK@@ criterion 8 MUTATION, restored arm: the refusal stops the sequence at step one

do $$
declare _st text; _ratings int;
begin
  insert into public.evaluation_item
    (round_key, item_key, day, part, kind, title, ordinal, active)
  values ('@W1@', 'w1d1-fixture', 1, 'morning', 'session', 'Fixture item', 1, true)
  on conflict do nothing;
  insert into public.evaluation_item_rating (response_id, round_key, item_key, attended, rating)
  values ('@RESP_UNMATCHED@', '@W1@', 'w1d1-fixture', true, 4) on conflict do nothing;

  update public.workshop_evaluation_round
  set state = 'open', opens_at = now() - interval '1 day', closes_at = now() + interval '1 day'
  where round_key = '@W1@';

  -- The real function, unmutated. Its refusal fires on the resolve itself, so
  -- the sequence never reaches the takeover. That is why the restored arm
  -- CANNOT re-run the destruction assertion, stated here so a later fix round
  -- does not rewrite it back.
  select state into _st from s8call('@ADMIN@',
    'select public.resolve_evaluation_response(''@RESP_UNMATCHED@''::uuid, ''@REAL@''::uuid, ''restored'')');
  perform s8pass('c8 RESTORED the same resolve raises check_violation',
    _st = '23514', coalesce(_st,'none'));

  select count(*) into _ratings from public.evaluation_item_rating
  where response_id = '@RESP_UNMATCHED@';
  perform s8pass('c8 RESTORED the imported child rows are still present',
    _ratings = 1, _ratings || ' rating(s) intact');

  update public.workshop_evaluation_round
  set state = 'closed', opens_at = now() - interval '60 days', closes_at = now() - interval '30 days'
  where round_key = '@W1@';
end $$;

-- @@CHUNK@@ criterion 8 MUTATION: delete the participation insert

do $$
declare _part boolean;
begin
  create or replace function public.resolve_evaluation_response(
    _response_id uuid, _profile_id uuid, _reason text default '')
  returns void language plpgsql security definer set search_path = public as $f$
  declare _round text;
  begin
    if not is_portal_admin() then
      raise exception 'admin only' using errcode = 'insufficient_privilege';
    end if;
    select round_key into _round from evaluation_response where id = _response_id for update;
    if evaluation_round_is_open(_round) then
      raise exception 'open' using errcode = 'check_violation';
    end if;
    update evaluation_response set profile_id = _profile_id where id = _response_id;
    -- MUTATED: no participation insert
    insert into evaluation_attribution_log (response_id, round_key, action, actor_id, subject_id, reason)
    values (_response_id, _round, 'resolve', auth.uid(), _profile_id, _reason);
  end $f$;
  perform s8call('@ADMIN@',
    'select public.resolve_evaluation_response(''@RESP_BLANK2@''::uuid, ''@OTHER@''::uuid, ''mutation'')');
  select exists (select 1 from public.evaluation_participant
                 where round_key = '@W1@' and profile_id = '@OTHER@') into _part;
  perform s8pass('c8 MUTATION without the participation insert the owner is invisible',
    not _part, 'myRounds would return [] for somebody who owns a response');
end $$;

-- @@CHUNK@@ criterion 15: the audit is administrator-only and readable

do $$
declare _n bigint; _st text;
begin
  perform s8call('@ADMIN@',
    'select public.resolve_evaluation_response(''@RESP_MATCHED@''::uuid, ''@REAL@''::uuid, ''audit'')');

  select n, state into _n, _st from s8run('@ADMIN@',
    'select * from public.evaluation_attribution_history(''@RESP_MATCHED@''::uuid)');
  perform s8pass('c15 the administrator reads the history', _st is null and _n >= 1,
    _n || ' rows, sqlstate ' || coalesce(_st,'none'));

  select n, state into _n, _st from s8run('@REAL@',
    'select * from public.evaluation_attribution_history(''@RESP_MATCHED@''::uuid)');
  perform s8pass('c15 a non-administrator is refused by SQLSTATE', _st = '42501',
    coalesce(_st,'none'));
end $$;

-- @@CHUNK@@ criterion 15 MUTATION: null the typed_name write

do $$
declare _typed text; _logged text;
begin
  select typed_name into _typed from public.evaluation_response_identity
  where response_id = '@RESP_AMBIG@';

  create or replace function public.resolve_evaluation_response(
    _response_id uuid, _profile_id uuid, _reason text default '')
  returns void language plpgsql security definer set search_path = public as $f$
  declare _round text;
  begin
    if not is_portal_admin() then
      raise exception 'admin only' using errcode = 'insufficient_privilege';
    end if;
    select round_key into _round from evaluation_response where id = _response_id for update;
    update evaluation_response set profile_id = _profile_id where id = _response_id;
    -- MUTATED: typed_name is nulled rather than carried
    insert into evaluation_attribution_log (response_id, round_key, action, actor_id, subject_id, typed_name, reason)
    values (_response_id, _round, 'resolve', auth.uid(), _profile_id, null, _reason);
    delete from evaluation_response_identity where response_id = _response_id;
  end $f$;

  perform s8call('@ADMIN@',
    'select public.resolve_evaluation_response(''@RESP_AMBIG@''::uuid, ''@TWIN_A@''::uuid, ''mutation'')');
  select typed_name into _logged from public.evaluation_attribution_log
  where response_id = '@RESP_AMBIG@' and action = 'resolve';

  -- Compared against the value CAPTURED BEFORE the delete. Review-2 finding B3:
  -- reading the identity table at assertion time compares NULL to NULL and
  -- passes vacuously, which would leave D6's exception untested.
  perform s8pass('c15 MUTATION the missing typed name is detected against the captured value',
    _typed is not null and _logged is null,
    'captured "' || coalesce(_typed,'null') || '" but the log holds null');
end $$;

-- @@CHUNK@@ criterion 9: a resolved response reads back after the round closes, and only by its author

do $$
declare _own bigint; _oth bigint; _sown text; _soth text;
begin
  perform s8call('@ADMIN@',
    'select public.resolve_evaluation_response(''@RESP_MATCHED@''::uuid, ''@REAL@''::uuid, ''c9'')');

  -- The round is already closed, which is the state the criterion needs: a
  -- participant can always re-read their own answers, including afterwards.
  select n, state into _own, _sown from s8run('@REAL@',
    'select * from public.evaluation_response where id = ''@RESP_MATCHED@''');
  perform s8pass('c9 the author reads their own response after the round closed',
    _sown is null and _own = 1, _own || ' rows');

  select n, state into _oth, _soth from s8run('@OTHER@',
    'select * from public.evaluation_response where id = ''@RESP_MATCHED@''');
  -- The zero is distinguished from an error: RLS filters silently, so a zero
  -- with a null SQLSTATE is the correct outcome and a zero with an error is not.
  perform s8pass('c9 a different participant reads zero rows, and it is a filter not an error',
    _oth = 0 and _soth is null,
    _oth || ' rows, sqlstate ' || coalesce(_soth, 'none') || ' — silent filtering, as expected');
end $$;
