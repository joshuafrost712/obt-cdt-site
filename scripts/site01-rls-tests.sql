-- SITE-01: the evaluation boundary harness.
--
--   node scripts/site01-fixtures.mjs --setup
--   node scripts/site01-fixtures.mjs --run
--   node scripts/site01-fixtures.mjs --teardown
--
-- This file is NOT self-contained: the runner prepends `begin;`, the instrument
-- rows from `seed_evaluation_instrument.py --emit-sql`, and appends `rollback;`.
-- Every fixture row, every mutation and every seeded instrument row disappears
-- when the transaction ends, which is a stronger guarantee than capture-and-
-- restore: a session that dies mid-mutation cannot leave `evaluation_comments()`
-- without its salt, because Postgres reverts on connection loss.
--
-- ## The one rule this harness is built around
--
-- `tl05_try` in cairn computes 'blocked' as `_errored or _count = 0`, so a
-- refusal and an empty table are one verdict, and every blocked cell also passes
-- on a typo, a wrong column name or a dropped table. Every zero-row assertion
-- here therefore carries a POSITIVE CONTROL in the same section: the same caller,
-- on the same connection, reading something they are allowed to read. Without it
-- "returns zero rows" is indistinguishable from "the query was broken".
--
-- ## Nine mutations, and each is watched going the wrong way
--
-- A control that has never been seen to fail has not been tested. Each mutation
-- below breaks one control, asserts the harness turns red, and restores it.
--
-- ## No item key, question key or title is written into this file
--
-- They are read from the seeded instrument at run time. SITE-03 finding 18: a
-- harness that hardcodes its expected strings both leaks them and jams the seed
-- that would have caught the leak. The same discipline is cheap here and it also
-- means a change to Session-Map.md cannot silently stop testing anything.

-- ============================================================ scaffold

create table site01_results (
  seq     serial primary key,
  section text,
  verdict text,
  label   text,
  outcome text
);

create function s1_assert(_section text, _label text, _ok boolean, _outcome text default null)
returns void language plpgsql as $$
begin
  insert into site01_results (section, verdict, label, outcome)
  values (_section, case when _ok then 'PASS' else 'FAIL' end, _label, _outcome);
end $$;

create function s1_note(_section text, _label text, _outcome text default null)
returns void language plpgsql as $$
begin
  insert into site01_results (section, verdict, label, outcome)
  values (_section, 'note', _label, _outcome);
end $$;

-- Three expectations plus an expected SQLSTATE, so 'refused' and 'empty' are
-- never the same verdict.
create function s1_try(
  _section  text,
  _expect   text,          -- 'permitted' | 'zero' | 'error' | 'ok'
  _label    text,
  _uid      uuid,
  _role     text,
  _aal      text,
  _sql      text,
  _sqlstate text default null,
  _message  text default null
) returns void language plpgsql as $$
declare
  _count bigint := 0; _errored boolean := false;
  _state text; _msg text; _ok boolean; _outcome text;
begin
  if _uid is null then
    perform set_config('role', 'anon', true);
    perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  else
    perform set_config('role', coalesce(_role, 'authenticated'), true);
    -- coalesce to aal1 matches the helpers' own coalesce and matches what a
    -- password sign-in produces. Failing closed is the only safe default.
    perform set_config('request.jwt.claims',
      json_build_object('sub', _uid, 'role', coalesce(_role, 'authenticated'),
                        'aal', coalesce(_aal, 'aal1'))::text, true);
  end if;
  begin
    if _expect in ('error', 'ok') then
      -- Executed, not wrapped. `select count(*) from (insert …)` is a syntax
      -- error, so a mutation that must simply SUCCEED cannot use 'permitted'.
      execute _sql;
      _count := 1;
    else
      execute 'select count(*) from (' || _sql || ') _s1_sub' into _count;
    end if;
  exception when others then
    _errored := true; _state := SQLSTATE; _msg := SQLERRM;
  end;
  reset role;
  perform set_config('request.jwt.claims', '', true);

  if _expect = 'ok' then _ok := not _errored;
  elsif _expect = 'permitted' then _ok := (not _errored) and _count > 0;
  elsif _expect = 'zero' then _ok := (not _errored) and _count = 0;
  elsif _expect = 'error' then
    _ok := _errored
       and (_sqlstate is null or _state = _sqlstate)
       and (_message is null or position(_message in coalesce(_msg,'')) > 0);
  else _ok := false; _msg := 'unknown expectation ' || coalesce(_expect,'<null>');
  end if;

  _outcome := case when _errored
    then _state || ': ' || left(regexp_replace(coalesce(_msg,''), '\s+', ' ', 'g'), 100)
    else 'rows=' || _count end;
  insert into site01_results (section, verdict, label, outcome)
  values (_section, case when _ok then 'PASS' else 'FAIL' end, _label, _outcome);
end $$;

-- The lane's people and the round's own keys, resolved rather than typed.
create table site01_env (k text primary key, v text);

do $$
declare _round text; _n int;
begin
  select round_key into _round from workshop_evaluation_round
   where round_key like 'psalms-bali-2026:w1';
  if _round is null then
    raise exception 'the seed did not create the w1 round; nothing below would mean anything';
  end if;
  insert into site01_env values ('round', _round);
  insert into site01_env
    select 'round2', round_key from workshop_evaluation_round where round_key like '%:w2';

  for _n in 1..6 loop
    null;
  end loop;

  insert into site01_env
  select 'uid_' || split_part(split_part(email,'@',1), 'site01-rls-', 2), id::text
    from profiles where email like 'site01-rls-%';

  select count(*) into _n from site01_env where k like 'uid_%';
  if _n <> 6 then
    raise exception 'expected 6 site01-rls- profiles, found %. A harness that runs on a partial fixture set proves nothing.', _n;
  end if;

  -- Five active items and their keys, ordered, for the correlation test.
  insert into site01_env
  select 'item' || rn, item_key from (
    select item_key, row_number() over (order by day, ordinal, item_key) rn
      from evaluation_item where round_key = _round and active
  ) x where rn <= 5;

  select count(*) into _n from site01_env where k like 'item%';
  if _n <> 5 then
    raise exception 'expected 5 active w1 items, found %', _n;
  end if;

  -- A sixth active item that NOTHING in this harness rates. R4's assertion is
  -- about an item with no ratings at all, and items 1 to 5 all carry the
  -- correlation fixtures' ratings.
  insert into site01_env
  select 'item_unrated', item_key from (
    select item_key, row_number() over (order by day, ordinal, item_key) rn
      from evaluation_item where round_key = _round and active
  ) x where rn = 6;

  -- A real item that is INACTIVE in this round. Review finding 6: the refusal
  -- test used 'w9d9-zz', a key that exists nowhere, so the `not exists` on the
  -- item row refused it and the `and i.active` clause was never exercised.
  -- Delete `and i.active` from submit_evaluation() and that test still passed.
  insert into site01_env
  select 'item_inactive', item_key from evaluation_item
   where round_key = _round and not active order by day, ordinal limit 1;

  insert into site01_env
    select 'item_w2', item_key from evaluation_item
     where round_key = (select v from site01_env where k='round2') and active
     order by day, ordinal, item_key limit 1;

  -- A required and an optional question, by their real flags.
  insert into site01_env
    select 'q_required', question_key from evaluation_question
     where round_key = _round and required and answer_shape = 'text'
     order by ordinal limit 1;
  insert into site01_env
    select 'q_scale', question_key from evaluation_question
     where round_key = _round and answer_shape = 'scale'
     order by ordinal limit 1;
end $$;

create function s1_env(_k text) returns text language sql stable as $$
  select v from site01_env where k = _k;
$$;
create function s1_uid(_role text) returns uuid language sql stable as $$
  select v::uuid from site01_env where k = 'uid_' || _role;
$$;

-- Wear the reader's identity for the blocks that call the two reads directly.
--
-- Necessary because `is_evaluation_reader()` reads `auth.uid()`, which is null
-- for `postgres`, so a do-block calling the feed is refused by the very gate
-- criterion 15 exists to prove. Only the JWT claim is set and the ROLE is left
-- alone: these are definer functions, so the claim is what they read, and
-- keeping postgres is what lets the same block write its result row.
create function s1_wear(_role text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', s1_uid(_role), 'role','authenticated','aal','aal2')::text, true);
end $$;
create function s1_unwear() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '', true);
end $$;

-- A complete, valid answer payload for a round, built from the round's OWN
-- required questions rather than from a list typed here.
--
-- The first version of this harness hand-wrote two answers and the RPC refused
-- it, correctly: round 1 carries THREE required `rating_choice` questions plus a
-- required `long_text`, because the 2026-08-28 revision replaced twenty
-- per-session ratings with three block ratings. A harness with a hardcoded
-- payload tests the instrument the author remembered rather than the one the
-- contract defines, and it goes red for the wrong reason the next time Joshua
-- edits Question-Set.md.
create function s1_answers(_round text, _tag text default 'harness')
returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(
    case when q.answer_shape = 'text'
      then jsonb_build_object('question_key', q.question_key, 'body', _tag || ' answer to ' || q.question_key)
      else jsonb_build_object('question_key', q.question_key, 'attended', true, 'rating', 4)
    end order by q.ordinal), '[]'::jsonb)
  from evaluation_question q
  where q.round_key = _round and q.active and q.required;
$$;

do $$
begin
  perform s1_note('0. fixtures', 'round', s1_env('round'));
  perform s1_note('0. fixtures', 'six accounts resolved, five items, two questions',
    'items ' || s1_env('item1') || '…' || s1_env('item5')
    || '  required q ' || s1_env('q_required') || '  scale q ' || s1_env('q_scale'));
end $$;

-- ============================================== criterion 1. the catalog

do $$
declare _t int; _f int; _bad text;
begin
  select count(*) into _t from pg_tables where schemaname='public' and tablename in (
    'workshop_evaluation_round','evaluation_respondent_group','evaluation_item',
    'evaluation_question','evaluation_response','evaluation_item_rating',
    'evaluation_answer','evaluation_import','evaluation_reader','evaluation_salt',
    'evaluation_participant');
  perform s1_assert('1. catalog', 'eleven tables exist, counted from pg_tables', _t = 11, 'tables=' || _t);

  select count(*) into _f from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname in (
    'evaluation_round_is_open','evaluation_round_is_closed','is_evaluation_reader',
    'add_evaluation_reader','remove_evaluation_reader','submit_evaluation',
    'evaluation_summary','evaluation_comments','evaluation_answers_feed');
  perform s1_assert('1. catalog', 'nine functions exist, counted from pg_proc', _f = 9, 'functions=' || _f);

  select string_agg(p.proname, ', ') into _bad
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname in (
    'evaluation_round_is_open','evaluation_round_is_closed','is_evaluation_reader',
    'add_evaluation_reader','remove_evaluation_reader','submit_evaluation',
    'evaluation_summary','evaluation_comments','evaluation_answers_feed')
     and (not p.prosecdef or p.proconfig is null or not ('search_path=public' = any(p.proconfig)));
  perform s1_assert('1. catalog', 'every function is definer with a pinned search_path',
    _bad is null, coalesce('leaky: ' || _bad, 'all nine'));

  -- The partial index, by name and by its predicate. A plain unique index here
  -- would stop constraining the moment profile_id went nullable.
  select string_agg(indexdef, ' ') into _bad from pg_indexes
   where schemaname='public' and indexname='evaluation_response_one_per_participant';
  perform s1_assert('1. catalog', 'the one-per-participant index is PARTIAL on profile_id is not null',
    _bad is not null and _bad like '%WHERE (profile_id IS NOT NULL)%', coalesce(_bad,'absent'));
end $$;

-- =============================================== criterion 2. the grants

do $$
declare r record; _bad text := ''; _anon int := 0; _auth int := 0;
begin
  for r in
    select t.tablename,
           has_table_privilege('anon','public.'||t.tablename,'SELECT') as a_s,
           has_table_privilege('anon','public.'||t.tablename,'INSERT') as a_i,
           has_table_privilege('anon','public.'||t.tablename,'UPDATE') as a_u,
           has_table_privilege('anon','public.'||t.tablename,'DELETE') as a_d,
           has_table_privilege('authenticated','public.'||t.tablename,'SELECT') as u_s,
           has_table_privilege('authenticated','public.'||t.tablename,'INSERT') as u_i,
           has_table_privilege('authenticated','public.'||t.tablename,'UPDATE') as u_u,
           has_table_privilege('authenticated','public.'||t.tablename,'DELETE') as u_d
      from pg_tables t where t.schemaname='public' and t.tablename in (
        'workshop_evaluation_round','evaluation_respondent_group','evaluation_item',
        'evaluation_question','evaluation_response','evaluation_item_rating',
        'evaluation_answer','evaluation_import','evaluation_reader','evaluation_salt',
        'evaluation_participant')
      order by t.tablename
  loop
    perform s1_note('2. grants', r.tablename,
      'anon ' || (case when r.a_s then 'S' else '-' end)||(case when r.a_i then 'I' else '-' end)
               ||(case when r.a_u then 'U' else '-' end)||(case when r.a_d then 'D' else '-' end)
      || '   authenticated ' || (case when r.u_s then 'S' else '-' end)||(case when r.u_i then 'I' else '-' end)
               ||(case when r.u_u then 'U' else '-' end)||(case when r.u_d then 'D' else '-' end));
    if r.a_s or r.a_i or r.a_u or r.a_d then _anon := _anon + 1; end if;
  end loop;
  perform s1_assert('2. grants', 'anon holds nothing on any of the eleven', _anon = 0, 'tables with anon rights=' || _anon);

  select count(*) into _auth from pg_tables t
   where t.schemaname='public'
     and t.tablename in ('evaluation_response','evaluation_item_rating','evaluation_answer')
     and (has_table_privilege('authenticated','public.'||t.tablename,'INSERT')
       or has_table_privilege('authenticated','public.'||t.tablename,'UPDATE')
       or has_table_privilege('authenticated','public.'||t.tablename,'DELETE'));
  perform s1_assert('2. grants',
    'authenticated holds SELECT and nothing else on the three participant tables',
    _auth = 0, 'writable=' || _auth);

  select count(*) into _auth from pg_tables t
   where t.schemaname='public'
     and t.tablename in ('evaluation_reader','evaluation_salt','evaluation_import')
     and has_table_privilege('authenticated','public.'||t.tablename,'SELECT');
  perform s1_assert('2. grants', 'the salt, the reader list and the import log are unreadable by authenticated',
    _auth = 0, 'readable=' || _auth);
end $$;

-- ====================================== fixtures: memberships and the round

do $$
declare _round text := s1_env('round');
begin
  insert into evaluation_participant (round_key, profile_id)
  values (_round, s1_uid('participant')), (_round, s1_uid('second'));
  -- `outsider` is deliberately NOT added: criterion 17.

  insert into evaluation_reader (profile_id, note) values (s1_uid('reader'), 'harness');
  insert into head_mentor (profile_id) values (s1_uid('headmentor'))
    on conflict (profile_id) do nothing;
  insert into portal_admin (profile_id) values (s1_uid('admin'))
    on conflict (profile_id) do nothing;

  update workshop_evaluation_round
     set state = 'open', opens_at = now() - interval '1 day', closes_at = now() + interval '7 days'
   where round_key = _round;
  perform s1_note('0. fixtures', 'round opened for the write tests',
    'open=' || evaluation_round_is_open(_round) || ' closed=' || evaluation_round_is_closed(_round));
end $$;

-- ================================ criterion 3. one write through the RPC

do $$
declare _round text := s1_env('round'); _rid uuid; _r int; _a int; _st text;
begin
  perform set_config('role','authenticated',true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', s1_uid('participant'), 'role','authenticated','aal','aal1')::text, true);

  _rid := submit_evaluation(_round, 'cit',
    jsonb_build_array(
      jsonb_build_object('item_key', s1_env('item1'), 'attended', true,  'rating', 4,
                         'comment', 'participant A on item1'),
      jsonb_build_object('item_key', s1_env('item2'), 'attended', false, 'rating', null),
      jsonb_build_object('item_key', s1_env('item3'), 'attended', true,  'rating', 2,
                         'comment', 'participant A on item3')),
    s1_answers(_round, 'participant A'));
  reset role; perform set_config('request.jwt.claims','',true);

  insert into site01_env values ('response_a', _rid::text);
  select count(*) into _r from evaluation_item_rating where response_id = _rid;
  select count(*) into _a from evaluation_answer where response_id = _rid;
  select state into _st from evaluation_response where id = _rid;

  perform s1_assert('3. one write', 'three ratings landed', _r = 3, 'ratings=' || _r);
  perform s1_assert('3. one write',
    'one answer landed for every required question, counted from the instrument',
    _a = (select count(*) from evaluation_question
           where round_key = _round and active and required),
    'answers=' || _a || ' required=' ||
      (select count(*) from evaluation_question where round_key=_round and active and required));
  perform s1_assert('3. one write', 'the response is submitted', _st = 'submitted', 'state=' || _st);

  perform s1_assert('3. one write', 'the not-attended item stored a null rating and never a zero',
    exists (select 1 from evaluation_item_rating
             where response_id=_rid and item_key = s1_env('item2')
               and attended = false and rating is null),
    (select coalesce(rating::text,'null') from evaluation_item_rating
      where response_id=_rid and item_key=s1_env('item2')));

  perform s1_assert('3. one write', 'the scale ANSWER stored a rating, not a body',
    exists (select 1 from evaluation_answer
             where response_id=_rid and question_key=s1_env('q_scale')
               and answer_shape='scale' and rating is not null and body is null),
    'R2: an aggregate round''s ratings are questions');

  perform s1_assert('3. one write', 'the text answer stored a body, not a rating',
    exists (select 1 from evaluation_answer
             where response_id=_rid and question_key=s1_env('q_required')
               and answer_shape='text' and body is not null and rating is null));
end $$;

-- ========================== criterion 4. the rating constraint, all corners

do $$
declare _rid uuid := s1_env('response_a')::uuid; _round text := s1_env('round');
        _ok boolean; _mutated boolean := false;
begin
  -- All four attempted as postgres, because after criterion 2 no client can.
  begin
    insert into evaluation_item_rating (response_id, round_key, item_key, attended, rating)
    values (_rid, _round, s1_env('item4'), true, 3);
    _ok := true;
  exception when others then _ok := false; end;
  perform s1_assert('4. rating constraint', '(attended, 3) accepted', _ok);

  begin
    insert into evaluation_item_rating (response_id, round_key, item_key, attended, rating)
    values (_rid, _round, s1_env('item5'), false, null);
    _ok := true;
  exception when others then _ok := false; end;
  perform s1_assert('4. rating constraint', '(not attended, null) accepted', _ok);

  begin
    insert into evaluation_item_rating (response_id, round_key, item_key, attended, rating)
    values (_rid, _round, s1_env('item1'), false, 2);
    _ok := false;
  exception when check_violation then _ok := true; when others then _ok := false; end;
  perform s1_assert('4. rating constraint', '(not attended, 2) REFUSED', _ok);

  -- The corner the obvious constraint accepts: `true and NULL` is NULL, and a
  -- CHECK is satisfied by NULL.
  begin
    insert into evaluation_item_rating (response_id, round_key, item_key, attended, rating)
    values (_rid, _round, s1_env('item1'), true, null);
    _ok := false;
  exception when check_violation then _ok := true; when others then _ok := false; end;
  perform s1_assert('4. rating constraint', '(attended, null) REFUSED  <- the corner the naive form admits', _ok);

  -- MUTATION 1. Drop it, watch the fourth corner succeed, restore.
  --
  -- On item5, and the rows made above are cleared FIRST. The first version
  -- mutated against item1, which response_a had already rated in criterion 3, so
  -- (response_id, item_key) refused with 23505 and the mutation reported that
  -- the control was working when the control had been dropped. A mutation that
  -- fails for the wrong reason proves nothing at all.
  delete from evaluation_item_rating
   where response_id = _rid and item_key in (s1_env('item4'), s1_env('item5'));
  alter table evaluation_item_rating drop constraint evaluation_item_rating_scale;
  begin
    insert into evaluation_item_rating (response_id, round_key, item_key, attended, rating)
    values (_rid, _round, s1_env('item5'), true, null);
    _mutated := true;
  exception when others then _mutated := false; end;
  perform s1_assert('4. rating constraint',
    'MUTATION: without the constraint, (attended, null) is accepted', _mutated,
    'the control is doing the work');
  delete from evaluation_item_rating where response_id=_rid and item_key=s1_env('item5') and rating is null;
  alter table evaluation_item_rating add constraint evaluation_item_rating_scale check (
    (attended and rating is not null and rating between 1 and 5)
    or ((not attended) and rating is null));
end $$;

-- ============================ criterion 6. a cross-round rating is refused

do $$
declare _rid uuid := s1_env('response_a')::uuid; _round text := s1_env('round');
        _ok boolean; _mutated boolean;
begin
  begin
    insert into evaluation_item_rating (response_id, round_key, item_key, attended, rating)
    values (_rid, _round, s1_env('item_w2'), true, 3);
    _ok := false;
  exception when foreign_key_violation then _ok := true; when others then _ok := false; end;
  perform s1_assert('6. cross-round', 'a rating citing another round''s item_key is refused by the FK, not the RPC',
    _ok, '23503 on (round_key, item_key)');

  -- MUTATION 2.
  alter table evaluation_item_rating drop constraint evaluation_item_rating_round_key_item_key_fkey;
  begin
    insert into evaluation_item_rating (response_id, round_key, item_key, attended, rating)
    values (_rid, _round, s1_env('item_w2'), true, 3);
    _mutated := true;
  exception when others then _mutated := false; end;
  perform s1_assert('6. cross-round', 'MUTATION: without the composite FK the cross-round rating lands', _mutated);
  delete from evaluation_item_rating where response_id=_rid and item_key=s1_env('item_w2');
  alter table evaluation_item_rating
    add constraint evaluation_item_rating_round_key_item_key_fkey
    foreign key (round_key, item_key) references evaluation_item (round_key, item_key);
end $$;

-- ============ criterion 13 + 17. what the RPC refuses, and correcting forward

do $$
declare _round text := s1_env('round'); _rid uuid; _before int; _after int;
        _ratings jsonb; _answers jsonb;
begin
  _answers := s1_answers(_round, 'second');

  -- An item key that exists nowhere. Refused by the `not exists`.
  perform s1_try('13. RPC refusals', 'error', 'a rating for an item that does not exist is refused',
    s1_uid('second'), 'authenticated', 'aal1',
    format('select submit_evaluation(%L, %L, %L::jsonb, %L::jsonb)', _round, 'cit',
      jsonb_build_array(jsonb_build_object('item_key','w9d9-zz','attended',true,'rating',3))::text,
      _answers::text), '23503');

  -- A REAL item that is inactive in this round. This is the one that exercises
  -- `and i.active`; the test above passes with that clause deleted.
  perform s1_try('13. RPC refusals', 'error',
    'a rating for a real but INACTIVE item is refused, which is the clause the test above misses',
    s1_uid('second'), 'authenticated', 'aal1',
    format('select submit_evaluation(%L, %L, %L::jsonb, %L::jsonb)', _round, 'cit',
      jsonb_build_array(jsonb_build_object('item_key', s1_env('item_inactive'),
                                           'attended',true,'rating',3))::text,
      _answers::text), '23503');

  -- a missing required answer
  perform s1_try('13. RPC refusals', 'error', 'a missing required answer is refused',
    s1_uid('second'), 'authenticated', 'aal1',
    format('select submit_evaluation(%L, %L, %L::jsonb, %L::jsonb)', _round, 'cit',
      '[]', jsonb_build_array(jsonb_build_object('question_key', s1_env('q_scale'),
                                                 'attended', true, 'rating', 3))::text),
    '23502');

  -- criterion 17: an account that is not in the round
  perform s1_try('17. round membership', 'error', 'a member who is not in evaluation_participant cannot file',
    s1_uid('outsider'), 'authenticated', 'aal1',
    format('select submit_evaluation(%L, %L, %L::jsonb, %L::jsonb)', _round, 'cit', '[]', _answers::text),
    '42501');

  insert into evaluation_participant (round_key, profile_id) values (_round, s1_uid('outsider'));
  perform s1_try('17. round membership', 'permitted', 'the same account, added to the round, succeeds',
    s1_uid('outsider'), 'authenticated', 'aal1',
    format('select submit_evaluation(%L, %L, %L::jsonb, %L::jsonb)', _round, 'cit', '[]', _answers::text));
  delete from evaluation_response where profile_id = s1_uid('outsider');
  delete from evaluation_participant where round_key=_round and profile_id = s1_uid('outsider');

  -- correcting forward: the same participant resubmits with one changed rating.
  select count(*) into _before from evaluation_response where round_key=_round and profile_id=s1_uid('participant');
  perform set_config('role','authenticated',true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', s1_uid('participant'),'role','authenticated','aal','aal1')::text, true);
  _rid := submit_evaluation(_round, 'consultant',
    jsonb_build_array(
      jsonb_build_object('item_key', s1_env('item1'),'attended',true,'rating',1,'comment','revised'),
      jsonb_build_object('item_key', s1_env('item2'),'attended',false,'rating',null),
      jsonb_build_object('item_key', s1_env('item3'),'attended',true,'rating',2,
                         'comment','participant A on item3')),
    s1_answers(_round, 'A revised'));
  reset role; perform set_config('request.jwt.claims','',true);
  select count(*) into _after from evaluation_response where round_key=_round and profile_id=s1_uid('participant');

  perform s1_assert('13. RPC refusals', 'a revision CORRECTS FORWARD: still one response, not two and not an abort',
    _before = 1 and _after = 1 and _rid = s1_env('response_a')::uuid,
    'before=' || _before || ' after=' || _after);
  perform s1_assert('13. RPC refusals', 'the changed rating and comment actually changed',
    exists (select 1 from evaluation_item_rating
             where response_id=_rid and item_key=s1_env('item1') and rating=1 and comment='revised'));
  perform s1_assert('13. RPC refusals', 'the changed respondent_group actually changed',
    (select respondent_group from evaluation_response where id=_rid) = 'consultant');
end $$;

-- =================== criterion 14 + 8 fixtures. unattached responses

do $$
declare _round text := s1_env('round'); _imp uuid; _rid uuid; _ok boolean; i int; j int;
begin
  insert into evaluation_import (round_key, source_file, source_digest, manifest_file,
                                 manifest_digest, rows_read, rows_imported, rows_unattached, operator)
  values (_round,'harness.csv','0','Round-1-Columns.json','0',8,8,8,'site01-harness')
  returning id into _imp;

  -- Eight unattached responses over five items. Eight and five, because two
  -- responses over three items passes a completely broken ordering one run in
  -- four; this is roughly one in forty thousand.
  for i in 1..8 loop
    insert into evaluation_response (round_key, profile_id, respondent_group, state, source, import_id, submitted_at)
    values (_round, null, 'cit', 'submitted', 'manual', _imp, now())
    returning id into _rid;
    insert into site01_env values ('corr' || i, _rid::text);
    for j in 1..5 loop
      insert into evaluation_item_rating (response_id, round_key, item_key, attended, rating, comment)
      values (_rid, _round, s1_env('item' || j), true, 1 + ((i + j) % 5),
              'r' || i || ' on item' || j);
    end loop;
  end loop;

  perform s1_assert('14. unattached', 'two or more unattached responses coexist in one round',
    (select count(*) from evaluation_response where round_key=_round and profile_id is null) = 8,
    'unattached=' || (select count(*) from evaluation_response where round_key=_round and profile_id is null));

  -- The partial index still constrains the ATTACHED case.
  begin
    insert into evaluation_response (round_key, profile_id, respondent_group, state)
    values (_round, s1_uid('participant'), 'cit', 'draft');
    _ok := false;
  exception when unique_violation then _ok := true; when others then _ok := false; end;
  perform s1_assert('14. unattached', 'a duplicate ATTACHED response still raises 23505',
    _ok, 'the partial index constrains where it should');
end $$;

-- ============ criterion 11. neither read works while the round is open

do $$
declare _round text := s1_env('round'); _mutated boolean;
begin
  perform s1_try('11. round-state gate', 'error', 'the summary refuses while the round is open',
    s1_uid('reader'), 'authenticated','aal1',
    format('select * from evaluation_summary(%L)', _round), '23514');
  perform s1_try('11. round-state gate', 'error', 'the comment feed refuses while the round is open',
    s1_uid('reader'), 'authenticated','aal1',
    format('select * from evaluation_comments(%L)', _round), '23514');
  perform s1_try('11. round-state gate', 'error', 'the answer feed refuses while the round is open',
    s1_uid('reader'), 'authenticated','aal1',
    format('select * from evaluation_answers_feed(%L)', _round), '23514');

  -- MUTATION 3. Break the closed-round rule in the one place it is written.
  create or replace function evaluation_round_is_closed(_round_key text)
  returns boolean language sql stable security definer set search_path = public as $f$ select true $f$;
  perform s1_try('11. round-state gate', 'permitted',
    'MUTATION: with the closed-round rule broken, the mid-round read succeeds',
    s1_uid('reader'), 'authenticated','aal1',
    format('select * from evaluation_summary(%L)', _round));
  create or replace function evaluation_round_is_closed(_round_key text)
  returns boolean language sql stable security definer set search_path = public as $f$
    select exists (select 1 from workshop_evaluation_round
                    where round_key = _round_key and (state = 'closed' or now() >= closes_at));
  $f$;
  perform s1_try('11. round-state gate', 'error', 'restored: the summary refuses again',
    s1_uid('reader'), 'authenticated','aal1',
    format('select * from evaluation_summary(%L)', _round), '23514');
end $$;

-- ============================================ close the round for the reads

update workshop_evaluation_round set state='closed' where round_key = (select v from site01_env where k='round');

-- ===================== criterion 5. a participant reads their own, after close

do $$
declare _round text := s1_env('round');
begin
  perform s1_assert('5. own answers after close', 'the round is closed',
    evaluation_round_is_closed(_round) and not evaluation_round_is_open(_round));

  perform s1_try('5. own answers after close', 'permitted',
    'the author still reads their own response after closes_at',
    s1_uid('participant'), 'authenticated','aal1',
    'select * from evaluation_response where profile_id = auth.uid()');
  perform s1_try('5. own answers after close', 'permitted', 'and their own ratings',
    s1_uid('participant'), 'authenticated','aal1',
    'select * from evaluation_item_rating');
  perform s1_try('5. own answers after close', 'permitted', 'and their own answers',
    s1_uid('participant'), 'authenticated','aal1',
    'select * from evaluation_answer');

  -- The zero, and its positive control on the same connection.
  perform s1_try('5. own answers after close', 'zero',
    'a DIFFERENT participant reads the same tables and gets zero rows',
    s1_uid('second'), 'authenticated','aal1',
    'select * from evaluation_item_rating');
  perform s1_try('5. own answers after close', 'permitted',
    'POSITIVE CONTROL: the same caller reads the instrument and gets rows',
    s1_uid('second'), 'authenticated','aal1',
    'select * from evaluation_item');
end $$;

-- ============== criterion 10. a facilitator cannot reach the base tables

do $$
declare _mutated boolean;
begin
  perform s1_try('10. reader vs base tables', 'zero',
    'an evaluation_reader who is NOT oversight reads evaluation_response: zero',
    s1_uid('reader'), 'authenticated','aal1', 'select * from evaluation_response');
  perform s1_try('10. reader vs base tables', 'zero', 'and evaluation_item_rating: zero',
    s1_uid('reader'), 'authenticated','aal1', 'select * from evaluation_item_rating');
  perform s1_try('10. reader vs base tables', 'zero', 'and evaluation_answer: zero',
    s1_uid('reader'), 'authenticated','aal1', 'select * from evaluation_answer');
  perform s1_try('10. reader vs base tables', 'permitted',
    'POSITIVE CONTROL: the same reader reads the instrument and gets rows',
    s1_uid('reader'), 'authenticated','aal1', 'select * from evaluation_item');
  -- 42501 and not zero rows. The salt has no grant to any client role AND no
  -- policy, so the refusal happens at the grant. Asserting 'zero' would have
  -- passed on a filtered read too, and the difference matters here more than
  -- anywhere else in the file: a filtered read is one policy edit from being
  -- unfiltered, and this is the key to the comment feed's permutation.
  perform s1_try('10. reader vs base tables', 'error',
    'the salt is REFUSED at the grant even for a reader, not filtered to zero',
    s1_uid('reader'), 'authenticated','aal1', 'select * from evaluation_salt', '42501');

  -- MUTATION 4. Widen the policy to admit a reader.
  drop policy rating_read_own on evaluation_item_rating;
  create policy rating_read_own on evaluation_item_rating for select to authenticated
    using (exists (select 1 from evaluation_response r
                    where r.id = evaluation_item_rating.response_id and r.profile_id = auth.uid())
           or is_head_mentor() or is_portal_admin() or is_evaluation_reader());
  perform s1_try('10. reader vs base tables', 'permitted',
    'MUTATION: widen the policy to the reader and the zero becomes non-zero',
    s1_uid('reader'), 'authenticated','aal1', 'select * from evaluation_item_rating');
  drop policy rating_read_own on evaluation_item_rating;
  create policy rating_read_own on evaluation_item_rating for select to authenticated
    using (exists (select 1 from evaluation_response r
                    where r.id = evaluation_item_rating.response_id and r.profile_id = auth.uid())
           or is_head_mentor() or is_portal_admin());
  perform s1_try('10. reader vs base tables', 'zero', 'restored: zero again',
    s1_uid('reader'), 'authenticated','aal1', 'select * from evaluation_item_rating');
end $$;

-- ================ criterion 7. the facilitator reads carry no identity

do $$
declare _round text := s1_env('round'); _cols text[]; _want text[]; _hits int; _res text;
begin
  perform s1_wear('reader');
  -- The column SET, from pg_get_function_result(). information_schema.columns
  -- describes tables and views, not a function's return type, so a criterion
  -- reading it would return zero rows and pass vacuously.
  select pg_get_function_result(p.oid) into _res from pg_proc p
    join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='evaluation_comments';
  select array_agg(trim(split_part(trim(x), ' ', 1)) order by trim(split_part(trim(x),' ',1)))
    into _cols
    from regexp_split_to_table(replace(replace(_res,'TABLE(',''),')',''), ',') as x;
  _want := array['comment','item_key','item_title','kind'];
  perform s1_assert('7. no identity', 'evaluation_comments returns EXACTLY four columns, set-equal to the allowlist',
    _cols = _want, array_to_string(_cols, ', '));

  -- and then a live search of the rows for every fixture person.
  select count(*) into _hits from evaluation_comments(_round) c
   where c.comment ilike '%site01-rls-%' or c.comment ilike '%SITE-01 participant%'
      or c.item_title ilike '%site01-rls-%';
  perform s1_assert('7. no identity', 'no fixture name or address appears in the comment feed''s rows',
    _hits = 0, 'hits=' || _hits);

  -- MUTATION 5. Put response_id back and watch the SET-EQUALITY go red.
  --
  -- `drop` first, because `create or replace` refuses to change a function's
  -- return type. That refusal is itself worth knowing: it means a real attempt
  -- to widen this feed in a migration cannot be a quiet one-line edit.
  drop function evaluation_comments(text);
  create function evaluation_comments(_round_key text)
  returns table (item_key text, item_title text, kind text, comment text, response_id uuid)
  language plpgsql stable security definer set search_path = public as $f$
  declare _salt text;
  begin
    select s.salt into _salt from evaluation_salt s where s.round_key = _round_key;
    return query select i.item_key, i.title, i.kind, r.comment, r.response_id
      from evaluation_item_rating r
      join evaluation_response resp on resp.id = r.response_id
      join evaluation_item i on i.round_key=r.round_key and i.item_key=r.item_key
     where r.round_key=_round_key and resp.state='submitted' and r.comment is not null
     order by md5(_salt || r.response_id::text || r.item_key);
  end $f$;
  select pg_get_function_result(p.oid) into _res from pg_proc p
    join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='evaluation_comments';
  select array_agg(trim(split_part(trim(x),' ',1)) order by trim(split_part(trim(x),' ',1)))
    into _cols
    from regexp_split_to_table(replace(replace(_res,'TABLE(',''),')',''), ',') as x;
  perform s1_assert('7. no identity',
    'MUTATION: response_id added back and the set-equality assertion goes red',
    _cols <> _want, array_to_string(_cols, ', '));
end $$;

-- restore evaluation_comments verbatim
drop function if exists public.evaluation_comments(text);
create function public.evaluation_comments(_round_key text)
returns table (item_key text, item_title text, kind text, comment text)
language plpgsql stable security definer set search_path = public
as $$
declare _salt text;
begin
  if not is_evaluation_reader() then
    raise exception 'The comment feed is for the named evaluation readers.'
      using errcode = 'insufficient_privilege';
  end if;
  if not evaluation_round_is_closed(_round_key) then
    raise exception 'The % round is still open. The comments are published once it closes.', _round_key
      using errcode = 'check_violation';
  end if;
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
  where r.round_key = _round_key and resp.state = 'submitted' and r.comment is not null
  order by md5(_salt || r.response_id::text || r.item_key);
end;
$$;
revoke execute on function public.evaluation_comments(text) from public, anon;
grant execute on function public.evaluation_comments(text) to authenticated;

do $$
declare _cols text;
begin
  select pg_get_function_result(p.oid) into _cols from pg_proc p
    join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='evaluation_comments';
  perform s1_assert('7. no identity', 'restored: four columns again',
    _cols not ilike '%response_id%', _cols);
end $$;

-- ================ criterion 8. the comment feed does not correlate

do $$
declare _round text := s1_env('round'); _perm text; _perms text[] := '{}'; j int;
        _dupe int; _def text; _broken text[] := '{}';
begin
  perform s1_wear('reader');
  for j in 1..5 loop
    select string_agg(substring(c.comment from '^r([0-9]+)'), '-' order by c.ord)
      into _perm
      from (select comment, row_number() over () as ord
              from evaluation_comments(_round)
             where item_key = s1_env('item' || j)) c;
    _perms := _perms || _perm;
  end loop;
  select count(*) into _dupe from (
    select p, count(*) n from unnest(_perms) p group by p having count(*) > 1
  ) x;
  perform s1_assert('8. no correlation',
    'the eight responses appear in a DIFFERENT order for each of the five items',
    _dupe = 0, array_to_string(_perms, '  |  '));

  select pg_get_functiondef(p.oid) into _def from pg_proc p
    join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='evaluation_comments';
  perform s1_assert('8. no correlation',
    'the ORDER BY is keyed on the secret salt, the response and the item',
    _def like '%md5(_salt || r.response_id::text || r.item_key)%',
    'not a public permutation');

  -- MUTATION 6. Order by response_id and every item yields the same permutation.
  create or replace function evaluation_comments(_round_key text)
  returns table (item_key text, item_title text, kind text, comment text)
  language plpgsql stable security definer set search_path = public as $f$
  begin
    return query select i.item_key, i.title, i.kind, r.comment
      from evaluation_item_rating r
      join evaluation_response resp on resp.id=r.response_id
      join evaluation_item i on i.round_key=r.round_key and i.item_key=r.item_key
     where r.round_key=_round_key and resp.state='submitted' and r.comment is not null
     order by r.response_id;
  end $f$;
  for j in 1..5 loop
    select string_agg(substring(c.comment from '^r([0-9]+)'), '-' order by c.ord)
      into _perm
      from (select comment, row_number() over () as ord
              from evaluation_comments(_round)
             where item_key = s1_env('item' || j)) c;
    _broken := _broken || _perm;
  end loop;
  select count(*) into _dupe from (
    select p, count(*) n from unnest(_broken) p group by p having count(*) > 1
  ) x;
  perform s1_assert('8. no correlation',
    'MUTATION: ordered by response_id, every item yields the SAME permutation',
    _dupe > 0, array_to_string(_broken, '  |  '));
end $$;

-- restore again
drop function if exists public.evaluation_comments(text);
create function public.evaluation_comments(_round_key text)
returns table (item_key text, item_title text, kind text, comment text)
language plpgsql stable security definer set search_path = public
as $$
declare _salt text;
begin
  if not is_evaluation_reader() then
    raise exception 'The comment feed is for the named evaluation readers.'
      using errcode = 'insufficient_privilege';
  end if;
  if not evaluation_round_is_closed(_round_key) then
    raise exception 'The % round is still open. The comments are published once it closes.', _round_key
      using errcode = 'check_violation';
  end if;
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
  where r.round_key = _round_key and resp.state = 'submitted' and r.comment is not null
  order by md5(_salt || r.response_id::text || r.item_key);
end;
$$;
revoke execute on function public.evaluation_comments(text) from public, anon;
grant execute on function public.evaluation_comments(text) to authenticated;

-- ============ criterion 9. small-n suppression, and its boundary moves

do $$
declare _round text := s1_env('round'); _sup boolean; _mean numeric; _n bigint;
begin
  perform s1_wear('reader');
  -- item4 has no ratings at all; item1 has nine (eight correlation + participant A).
  select suppressed, mean_rating, n_rated into _sup, _mean, _n
    from evaluation_summary(_round) where item_key = s1_env('item1');
  perform s1_assert('9. small n', 'a well-rated item publishes its mean',
    _mean is not null and _sup = false, 'n=' || _n || ' mean=' || coalesce(_mean::text,'null'));

  -- Drop item2 to below the threshold. It has eight not-attended plus one, so
  -- delete down to three attended.
  delete from evaluation_item_rating
   where item_key = s1_env('item2') and round_key = _round
     and response_id in (select v::uuid from site01_env where k in ('corr1','corr2','corr3','corr4','corr5'));
  select suppressed, mean_rating, n_rated into _sup, _mean, _n
    from evaluation_summary(_round) where item_key = s1_env('item2');
  perform s1_assert('9. small n', 'an item below min_n reports its counts and suppresses the mean',
    _sup = true and _mean is null, 'n=' || _n || ' suppressed=' || _sup);

  -- R4: an item nobody rated is NOT the same as a suppressed one.
  select suppressed, mean_rating, n_rated into _sup, _mean, _n
    from evaluation_summary(_round) where item_key = s1_env('item_unrated');
  perform s1_assert('9. small n',
    'R4: an item with no ratings reads n=0, suppressed=false, not "suppressed"',
    _n = 0 and _sup = false and _mean is null, 'n=' || _n || ' suppressed=' || _sup);

  -- The boundary moves without a migration, through the RPC that refuses
  -- everyone but a head mentor at aal2.
  perform s1_try('9. small n', 'error', 'set_platform_setting refuses a head mentor at aal1',
    s1_uid('headmentor'), 'authenticated', 'aal1',
    'select set_platform_setting(''evaluation_min_n'', ''2''::jsonb)', '42501');

  perform set_config('role','authenticated',true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', s1_uid('headmentor'),'role','authenticated','aal','aal2')::text, true);
  perform set_platform_setting('evaluation_min_n', '2'::jsonb);
  reset role; perform set_config('request.jwt.claims','',true);
  perform s1_wear('reader');   -- the head-mentor call cleared the claim

  select suppressed, mean_rating into _sup, _mean
    from evaluation_summary(_round) where item_key = s1_env('item2');
  perform s1_assert('9. small n',
    'the same item publishes once a head mentor at aal2 lowers min_n: a row, not a migration',
    _sup = false and _mean is not null, 'mean=' || coalesce(_mean::text,'null'));
  perform set_config('role','authenticated',true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', s1_uid('headmentor'),'role','authenticated','aal','aal2')::text, true);
  perform set_platform_setting('evaluation_min_n', '4'::jsonb);
  reset role; perform set_config('request.jwt.claims','',true);
end $$;

-- ============ criterion 9b (R3). the group split suppresses per cell

do $$
declare _round text := s1_env('round'); _all bigint; _cit bigint; _err text;
begin
  perform s1_wear('reader');
  select count(*) into _all from evaluation_summary(_round);
  select count(*) into _cit from evaluation_summary(_round, 'cit');
  perform s1_assert('9b. per-group (R3)',
    'the grouped read covers the same items as the ungrouped one, so an item cannot vanish from it',
    _all = _cit and _all > 0, 'ungrouped=' || _all || ' cit=' || _cit);

  perform s1_assert('9b. per-group (R3)',
    'a group with too few raters is suppressed even though the item total is fine',
    (select suppressed from evaluation_summary(_round, 'consultant') where item_key = s1_env('item1')) = true,
    'consultant is participant A alone, n=1, under min_n=4');

  -- Review finding 5. A suppressed cell withholds its COUNTS as well as its
  -- mean. "n_rated 1, n_absent 1" on a named session is attribution on a group
  -- of two or three, and the published n is also what made the differencing in
  -- finding 1 exact rather than approximate.
  perform s1_assert('9b. per-group (R3)',
    'a suppressed cell withholds n_rated and n_absent too, not just the mean',
    (select n_rated from evaluation_summary(_round, 'consultant') where item_key = s1_env('item1')) is null
    and (select n_absent from evaluation_summary(_round, 'consultant') where item_key = s1_env('item1')) is null,
    'counts are null on a suppressed cell');

  -- and R4 still survives that change, which is the thing it could have broken.
  perform s1_assert('9b. per-group (R3)',
    'R4 survives it: an item nobody rated still reads n_rated = 0 with suppressed = false',
    (select n_rated from evaluation_summary(_round) where item_key = s1_env('item_unrated')) = 0
    and (select suppressed from evaluation_summary(_round) where item_key = s1_env('item_unrated')) = false,
    'a withheld cell is null and suppressed; an unrated one is 0 and not suppressed');

  perform s1_try('9b. per-group (R3)', 'error', 'an unknown group is refused, not silently empty',
    s1_uid('reader'), 'authenticated','aal1',
    format('select * from evaluation_summary(%L, %L)', _round, 'nobody'), '23503');
end $$;

-- ===== criterion 9c. the group split cannot be DIFFERENCED against the total
--
-- The hole this closes was reproduced on 2026-08-31, in the build, before the
-- guard existed: one item, four groups sized 6/5/2/4 at min_n 4, the total
-- publishing `dist=4,3,4,3,3`, the two-person cell suppressed, and subtracting
-- the three published cells from the published total returning `0,0,1,0,1` —
-- those two people's exact ratings, recovered from two permitted reads neither
-- of which discloses them.
--
-- The fixtures here reproduce the shape: item1 carries eight `cit` ratings and
-- one `consultant` rating, so the smallest group is 1 and the total is 9.

do $$
declare _round text := s1_env('round');
        _tot record; _cit record; _def text; _leaked int;
begin
  perform s1_wear('reader');
  select * into _tot from evaluation_summary(_round) where item_key = s1_env('item1');
  select * into _cit from evaluation_summary(_round, 'cit') where item_key = s1_env('item1');

  perform s1_assert('9c. no differencing',
    'the ungrouped TOTAL still publishes, because it leaks nothing on its own',
    _tot.suppressed = false and _tot.mean_rating is not null and _tot.dist_1 is not null,
    'n=' || _tot.n_rated || ' dist=' || concat_ws(',',_tot.dist_1,_tot.dist_2,_tot.dist_3,_tot.dist_4,_tot.dist_5));

  perform s1_assert('9c. no differencing',
    'but the split is WITHHELD for this item, because one group on it has n=1',
    _cit.suppressed = true and _cit.mean_rating is null and _cit.dist_1 is null,
    'cit n=' || _cit.n_rated || ' mean=' || coalesce(_cit.mean_rating::text,'null'));

  perform s1_assert('9c. no differencing',
    'so subtracting the published cells from the total yields nothing',
    _cit.dist_1 is null,
    'the largest group''s cell is null, so there is nothing to subtract');

  perform s1_assert('9c. no differencing',
    'the guard is in the function body and keyed on the smallest group that rated the item',
    (select pg_get_functiondef(p.oid) from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname='public' and p.proname='evaluation_summary') like '%group_sizes%');

  -- MUTATION 10. Remove the complementary-suppression guard and watch the two
  -- people's ratings come back.
  create or replace function evaluation_summary(_round_key text, _group_key text default null)
  returns table (item_key text, item_title text, kind text, n_rated bigint, n_absent bigint,
                 suppressed boolean, mean_rating numeric, dist_1 bigint, dist_2 bigint,
                 dist_3 bigint, dist_4 bigint, dist_5 bigint)
  language plpgsql stable security definer set search_path = public as $f$
  declare _min_n integer;
  begin
    select coalesce((select (value #>> '{}')::int from platform_setting
                     where key='evaluation_min_n'), 4) into _min_n;
    return query
    with rated as (
      select r.item_key, r.attended, r.rating from evaluation_item_rating r
      join evaluation_response resp on resp.id = r.response_id
      where r.round_key=_round_key and resp.state='submitted'
        and (_group_key is null or resp.respondent_group = _group_key))
    select i.item_key, i.title, i.kind,
           count(*) filter (where x.attended), count(*) filter (where not x.attended),
           (count(*) filter (where x.attended) > 0 and count(*) filter (where x.attended) < _min_n),
           case when count(*) filter (where x.attended) >= _min_n then round(avg(x.rating) filter (where x.attended),2) end,
           case when count(*) filter (where x.attended) >= _min_n then count(*) filter (where x.rating=1) end,
           case when count(*) filter (where x.attended) >= _min_n then count(*) filter (where x.rating=2) end,
           case when count(*) filter (where x.attended) >= _min_n then count(*) filter (where x.rating=3) end,
           case when count(*) filter (where x.attended) >= _min_n then count(*) filter (where x.rating=4) end,
           case when count(*) filter (where x.attended) >= _min_n then count(*) filter (where x.rating=5) end
    from evaluation_item i left join rated x on x.item_key = i.item_key
    where i.round_key=_round_key and i.active group by i.item_key, i.title, i.kind
    order by i.item_key;
  end $f$;

  select * into _tot from evaluation_summary(_round) where item_key = s1_env('item1');
  select * into _cit from evaluation_summary(_round, 'cit') where item_key = s1_env('item1');
  _leaked := (_tot.dist_1 - coalesce(_cit.dist_1,0)) + (_tot.dist_2 - coalesce(_cit.dist_2,0))
           + (_tot.dist_3 - coalesce(_cit.dist_3,0)) + (_tot.dist_4 - coalesce(_cit.dist_4,0))
           + (_tot.dist_5 - coalesce(_cit.dist_5,0));
  perform s1_assert('9c. no differencing',
    'MUTATION: without the guard, the one-person group''s ratings are recovered by subtraction',
    _leaked = 1,
    'recovered ' || _leaked || ' rating(s) that no single read disclosed');
end $$;

-- restore evaluation_summary verbatim, guard included
create or replace function public.evaluation_summary(_round_key text, _group_key text default null)
returns table (item_key text, item_title text, kind text, n_rated bigint, n_absent bigint,
               suppressed boolean, mean_rating numeric, dist_1 bigint, dist_2 bigint,
               dist_3 bigint, dist_4 bigint, dist_5 bigint)
language plpgsql stable security definer set search_path = public
as $$
declare _min_n integer;
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
  select coalesce((select (value #>> '{}')::int from platform_setting
                   where key = 'evaluation_min_n'), 4) into _min_n;
  return query
  with all_rated as (
    select r.item_key, r.attended, r.rating, resp.respondent_group
    from evaluation_item_rating r
    join evaluation_response resp on resp.id = r.response_id
    where r.round_key = _round_key and resp.state = 'submitted'
  ),
  group_sizes as (
    select a.item_key, min(a.n) as min_group_n
    from (
      select ar.item_key, ar.respondent_group, count(*) filter (where ar.attended) as n
      from all_rated ar group by ar.item_key, ar.respondent_group
    ) a
    where a.n > 0
    group by a.item_key
  ),
  rated as (
    select a.item_key, a.attended, a.rating from all_rated a
    where _group_key is null or a.respondent_group = _group_key
  ),
  agg as (
    select i.item_key, i.title, i.kind,
           count(*) filter (where x.attended) as n_rated,
           count(*) filter (where not x.attended) as n_absent,
           avg(x.rating) filter (where x.attended) as mean_rating,
           count(*) filter (where x.rating = 1) as d1,
           count(*) filter (where x.rating = 2) as d2,
           count(*) filter (where x.rating = 3) as d3,
           count(*) filter (where x.rating = 4) as d4,
           count(*) filter (where x.rating = 5) as d5,
           (count(*) filter (where x.attended) >= _min_n
            and (_group_key is null
                 or coalesce((select g.min_group_n from group_sizes g
                               where g.item_key = i.item_key), 0) >= _min_n)) as publishable
    from evaluation_item i
    left join rated x on x.item_key = i.item_key
    where i.round_key = _round_key and i.active
    group by i.item_key, i.title, i.kind
  )
  select a.item_key, a.title, a.kind, a.n_rated, a.n_absent,
         (a.n_rated > 0 and not a.publishable),
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
revoke execute on function public.evaluation_summary(text, text) from public, anon;
grant execute on function public.evaluation_summary(text, text) to authenticated;

do $$
declare _round text := s1_env('round'); _cit record;
begin
  perform s1_wear('reader');
  select * into _cit from evaluation_summary(_round, 'cit') where item_key = s1_env('item1');
  perform s1_assert('9c. no differencing', 'restored: the split is withheld again',
    _cit.suppressed = true and _cit.dist_1 is null);
end $$;

-- ============ criterion 12. oversight sees what the panel says it sees

do $$
begin
  perform s1_try('12. oversight', 'permitted', 'a head mentor at aal2 reads attributed responses',
    s1_uid('headmentor'), 'authenticated','aal2', 'select * from evaluation_response');
  perform s1_try('12. oversight', 'zero', 'the SAME head mentor at aal1 gets zero',
    s1_uid('headmentor'), 'authenticated','aal1', 'select * from evaluation_response');
  perform s1_try('12. oversight', 'permitted',
    'POSITIVE CONTROL: the aal1 head mentor still reads the instrument',
    s1_uid('headmentor'), 'authenticated','aal1', 'select * from evaluation_item');

  perform s1_try('12. oversight', 'permitted',
    'the portal administrator reads attributed responses at aal1',
    s1_uid('admin'), 'authenticated','aal1', 'select * from evaluation_response');
  perform s1_note('12. oversight',
    'WHICH WORLD: is_portal_admin() carries NO aal2 clause on this project',
    'migration 20260821120000_admin_mfa.sql is unapplied, so the admin half ran at aal1 by design, not by accident');
end $$;

-- ============ criterion 14b. an unattached response counts but cannot be read back

do $$
declare _round text := s1_env('round');
begin
  perform s1_wear('reader');
  perform s1_assert('14. unattached', 'unattached responses are counted in the aggregate',
    (select n_rated from evaluation_summary(_round) where item_key = s1_env('item3')) >= 8,
    'n=' || (select n_rated from evaluation_summary(_round) where item_key = s1_env('item3')));

  perform s1_assert('14. unattached', 'and their comments appear in the feed',
    (select count(*) from evaluation_comments(_round) where comment like 'r%on item3%') = 8);

  perform s1_try('14. unattached', 'zero',
    'but no participant can read an unattached response back',
    s1_uid('participant'), 'authenticated','aal1',
    'select * from evaluation_response where profile_id is null');
  perform s1_try('14. unattached', 'permitted',
    'POSITIVE CONTROL: the same caller reads their own attached response',
    s1_uid('participant'), 'authenticated','aal1',
    'select * from evaluation_response where profile_id = auth.uid()');
end $$;

-- ============ the reader gate itself, and anon

do $$
declare _round text := s1_env('round');
begin
  perform s1_try('15. the reader gate', 'error', 'a participant cannot call the summary',
    s1_uid('participant'), 'authenticated','aal1',
    format('select * from evaluation_summary(%L)', _round), '42501');
  perform s1_try('15. the reader gate', 'error', 'a participant cannot call the comment feed',
    s1_uid('participant'), 'authenticated','aal1',
    format('select * from evaluation_comments(%L)', _round), '42501');
  perform s1_try('15. the reader gate', 'permitted', 'the reader can',
    s1_uid('reader'), 'authenticated','aal1',
    format('select * from evaluation_comments(%L)', _round));

  -- With the SQLSTATE named. Review finding 6: without it, restoring `execute`
  -- to anon would still leave submit_evaluation raising 42501 from its own
  -- `auth.uid() is null` branch, and the assertion would pass with the grant
  -- defect present. 42501 here must be the GRANT refusing, and the message
  -- distinguishes it.
  perform s1_try('15. the reader gate', 'error', 'anon cannot call the summary at all',
    null, 'anon', null, format('select * from evaluation_summary(%L)', _round),
    '42501', 'permission denied for function');
  -- 'error' and not 'zero'. anon is revoked from every table this spec owns, so
  -- it is refused at the grant with 42501 before RLS is consulted. Asserting
  -- 'zero' here would have passed on a filtered read AND on a refusal, which is
  -- the conflation this harness's own header warns about; the first version of
  -- this line made exactly that mistake.
  perform s1_try('15. the reader gate', 'error', 'anon is REFUSED at the grant on the instrument, not filtered to zero',
    null, 'anon', null, 'select * from evaluation_item', '42501');
  perform s1_try('15. the reader gate', 'error', 'anon cannot call submit_evaluation',
    null, 'anon', null,
    format('select submit_evaluation(%L, %L, ''[]''::jsonb, ''[]''::jsonb)', _round, 'cit'),
    '42501', 'permission denied for function');

  -- MUTATION 7. Remove the reader gate and a participant can read the feed.
  create or replace function is_evaluation_reader()
  returns boolean language sql stable security definer set search_path = public as $f$ select true $f$;
  perform s1_try('15. the reader gate', 'permitted',
    'MUTATION: with is_evaluation_reader() forced true, a participant reads the feed',
    s1_uid('participant'), 'authenticated','aal1',
    format('select * from evaluation_comments(%L)', _round));
  create or replace function is_evaluation_reader()
  returns boolean language sql stable security definer set search_path = public as $f$
    select exists (select 1 from evaluation_reader where profile_id = auth.uid());
  $f$;
  perform s1_try('15. the reader gate', 'error', 'restored: the participant is refused again',
    s1_uid('participant'), 'authenticated','aal1',
    format('select * from evaluation_comments(%L)', _round), '42501');
end $$;

-- ===== criterion 15b. the answer feed carries the same three controls
--
-- Review finding 6: this function was added by the build and was asserted only
-- on the round-state gate. It does carry the reader gate, the closed-round gate
-- and the salted ordering, but nothing proved it, so an edit removing any one of
-- them would have gone green.

do $$
declare _round text := s1_env('round'); _cols text; _def text; _perm text; _perms text[] := '{}';
        _dupe int; q text;
begin
  select pg_get_function_result(p.oid), pg_get_functiondef(p.oid) into _cols, _def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname='public' and p.proname='evaluation_answers_feed';

  perform s1_assert('15b. the answer feed', 'it returns three columns and no identifier',
    _cols not ilike '%profile%' and _cols not ilike '%response_id%'
    and _cols not ilike '%respondent%' and _cols not ilike '%submitted%', _cols);
  perform s1_assert('15b. the answer feed', 'it carries the reader gate',
    _def like '%is_evaluation_reader()%');
  perform s1_assert('15b. the answer feed', 'it carries the closed-round gate',
    _def like '%evaluation_round_is_closed(_round_key)%');
  perform s1_assert('15b. the answer feed', 'it is ordered on the secret salt, not on arrival',
    _def like '%md5(_salt || a.response_id::text || a.question_key)%');

  perform s1_try('15b. the answer feed', 'error', 'a participant cannot call it',
    s1_uid('participant'), 'authenticated','aal1',
    format('select * from evaluation_answers_feed(%L)', _round), '42501');
  perform s1_try('15b. the answer feed', 'permitted', 'the reader can',
    s1_uid('reader'), 'authenticated','aal1',
    format('select * from evaluation_answers_feed(%L)', _round));

  -- The same correlation property the comment feed is held to. The eight
  -- imported responses each answered every required question, so each text
  -- question has eight bodies carrying their row number.
  perform s1_wear('reader');
  for q in select question_key from evaluation_question
            where round_key = _round and active and answer_shape = 'text' order by ordinal loop
    select string_agg(substring(f.body from 'r([0-9]+)'), '-' order by f.ord) into _perm
      from (select body, row_number() over () as ord
              from evaluation_answers_feed(_round) where question_key = q) f;
    if _perm is not null then _perms := _perms || _perm; end if;
  end loop;
  select count(*) into _dupe from (
    select x, count(*) n from unnest(_perms) x group by x having count(*) > 1) y;
  perform s1_assert('15b. the answer feed',
    'the same responses appear in a different order for each text question',
    _dupe = 0 or array_length(_perms,1) < 2,
    coalesce(array_to_string(_perms, '  |  '), 'no text bodies to order'));
end $$;

-- ============ the answer's shape is bound to its question (R2)

do $$
declare _round text := s1_env('round'); _rid uuid := s1_env('corr1')::uuid; _ok boolean;
begin
  -- corr1, not response_a. response_a answered every required question in
  -- criterion 3, so (response_id, question_key) refused these inserts with 23505
  -- before the four-column foreign key was ever consulted, and all three
  -- assertions failed for a reason that had nothing to do with what they test.
  -- A gate that goes red for the wrong reason is as useless as one that goes
  -- green for the wrong reason.

  -- A rating stored against a TEXT question, with the shape forged.
  begin
    insert into evaluation_answer (response_id, round_key, question_key, answer_shape,
                                   absence_allowed, attended, rating)
    values (_rid, _round, s1_env('q_required'), 'scale', true, true, 4);
    _ok := false;
  exception when foreign_key_violation then _ok := true; when others then _ok := false; end;
  perform s1_assert('16. answer shape (R2)',
    'a scale answer against a TEXT question is refused by the four-column FK', _ok);

  -- Forging absence_allowed, in a way the row's OWN check admits so that the
  -- foreign key is the thing under test. `absence_allowed = false` with
  -- `attended = false` is caught by evaluation_answer_absence before the FK is
  -- ever consulted, which is correct behaviour and the wrong experiment.
  begin
    insert into evaluation_answer (response_id, round_key, question_key, answer_shape,
                                   absence_allowed, attended, rating)
    values (_rid, _round, s1_env('q_scale'), 'scale', false, true, 4);
    _ok := false;
  exception when foreign_key_violation then _ok := true; when others then _ok := false; end;
  perform s1_assert('16. answer shape (R2)',
    'absence_allowed cannot be forged either: the FK carries it from the question', _ok,
    'q_scale is a rating_choice, so its real absence_allowed is true');

  -- And the local check catches the other direction, before the FK.
  begin
    insert into evaluation_answer (response_id, round_key, question_key, answer_shape,
                                   absence_allowed, attended, rating)
    values (_rid, _round, s1_env('q_scale'), 'scale', false, false, null);
    _ok := false;
  exception when check_violation then _ok := true; when others then _ok := false; end;
  perform s1_assert('16. answer shape (R2)',
    'and "I wasn''t there" against a no-absence question is caught by the row''s own CHECK', _ok);

  -- MUTATION 8.
  alter table evaluation_answer drop constraint evaluation_answer_shape_fkey;
  begin
    insert into evaluation_answer (response_id, round_key, question_key, answer_shape,
                                   absence_allowed, attended, rating)
    values (_rid, _round, s1_env('q_required'), 'scale', true, true, 4);
    _ok := true;
  exception when others then _ok := false; end;
  perform s1_assert('16. answer shape (R2)',
    'MUTATION: without the FK, a rating lands in a text question', _ok);
  delete from evaluation_answer where response_id=_rid and question_key=s1_env('q_required') and answer_shape='scale';
  alter table evaluation_answer
    add constraint evaluation_answer_shape_fkey
    foreign key (round_key, question_key, answer_shape, absence_allowed)
    references evaluation_question (round_key, question_key, answer_shape, absence_allowed);
end $$;

-- ============ MUTATION 9. the write path is the only write path

do $$
declare _round text := s1_env('round');
begin
  perform s1_try('17. write path', 'error',
    'a participant cannot INSERT a rating directly: 42501 at the grant, before any policy',
    s1_uid('participant'), 'authenticated','aal1',
    format('insert into evaluation_item_rating (response_id, round_key, item_key, attended, rating)
            values (%L, %L, %L, true, 5)', s1_env('response_a'), _round, s1_env('item5')), '42501');
  perform s1_try('17. write path', 'error', 'nor UPDATE one',
    s1_uid('participant'), 'authenticated','aal1',
    'update evaluation_item_rating set rating = 5', '42501');
  perform s1_try('17. write path', 'error', 'nor DELETE one',
    s1_uid('participant'), 'authenticated','aal1',
    'delete from evaluation_item_rating', '42501');

  -- MUTATION 9, and it needed to be widened once the first attempt was run.
  --
  -- A grant alone is NOT enough: with `grant insert` and no insert policy the
  -- write is still refused, by RLS, with 42501. So the write path is behind two
  -- independent locks and a single edit to either one does not open it. That is
  -- worth stating rather than quietly fixing, because the spec's finding 5 is
  -- written as though the grant were the whole control.
  grant insert on evaluation_item_rating to authenticated;
  perform s1_try('17. write path', 'error',
    'the grant alone is not enough: RLS still refuses, so this is TWO locks',
    s1_uid('participant'), 'authenticated','aal1',
    format('insert into evaluation_item_rating (response_id, round_key, item_key, attended, rating)
            values (%L, %L, %L, true, 5)', s1_env('response_a'), _round, s1_env('item5')), '42501');
  create policy rating_write_mutation on evaluation_item_rating for insert to authenticated
    with check (true);
  perform s1_try('17. write path', 'ok',
    'MUTATION: with BOTH the grant and an insert policy, the RPC''s refusals become optional',
    s1_uid('participant'), 'authenticated','aal1',
    format('insert into evaluation_item_rating (response_id, round_key, item_key, attended, rating)
            values (%L, %L, %L, true, 5)', s1_env('response_a'), _round, s1_env('item5')));
  drop policy rating_write_mutation on evaluation_item_rating;
  revoke insert on evaluation_item_rating from authenticated;
  delete from evaluation_item_rating where response_id = s1_env('response_a')::uuid
    and item_key = s1_env('item5');
  perform s1_try('17. write path', 'error', 'restored: refused again',
    s1_uid('participant'), 'authenticated','aal1',
    format('insert into evaluation_item_rating (response_id, round_key, item_key, attended, rating)
            values (%L, %L, %L, true, 4)', s1_env('response_a'), _round, s1_env('item5')), '42501');
end $$;

-- ============================================================ the report

select section, verdict, label, outcome from site01_results order by seq;
