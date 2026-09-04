-- SITE-02: the ten assertions the disclosure panel names.
--
--   node scripts/site02-fixtures.mjs --assert
--
-- This file is NOT self-contained. The runner substitutes @W1@, @W2@ and the six
-- fixture profile ids, wraps the whole thing in `begin; … rollback;`, and reads
-- the report `select` at the end. Every mutation reverts even if the session dies
-- mid-run, which is a stronger guarantee than capture-and-restore: Postgres
-- reverts on connection loss.
--
-- Every ASSERTION block gets a chunk of its own too, not just every mutation.
-- The first split marked only the mutations, which put each following assertion
-- block inside the previous mutation's transaction: the correlation assertions
-- ran against a stubbed `evaluation_comments` and reported an empty population,
-- and the base-table assertions ran under a `using (true)` policy and reported a
-- facilitator reading eight responses. Two of the three still PASSED there, which
-- is the worse half.
--
-- ## Why it is split into chunks, and it is a defect this harness found in itself
--
-- The first version put each mutation inside a SAVEPOINT and asserted from inside
-- it. `rollback to savepoint` reverts the `insert into site02_results` along with
-- the mutation, so every mutation verdict vanished and the run printed 26 passes
-- and 0 failures — a harness reporting success over ten tests that left no trace
-- of having run. That is this campaign's signature class arriving against the
-- test rather than the system, for the fourth time.
--
-- So the file is split on `-- @@CHUNK@@` and the runner posts each chunk as its
-- own `begin; scaffold; chunk; select …; rollback;`. The report select runs
-- BEFORE the rollback, so its rows come back; the mutation still never commits;
-- and a mutation that somehow escaped its chunk cannot reach the next one.
--
-- ## The panel is the index, not this file
--
-- `src/pages/backend/evalDisclosure.ts` names an assertion per sentence, and
-- `site02-ui.mjs` reads that table and checks that every name here ran and
-- passed. An assertion renamed on one side and not the other fails loudly rather
-- than quietly not being run. That is what makes program rubric row 2 — "a claim
-- with no assertion is a defect, not an omission" — mechanical instead of a
-- promise.
--
-- ## Three rules, all learned the expensive way in this campaign
--
-- **A refusal and an empty read are never one verdict.** `tl05_try` in cairn
-- computed 'blocked' as `_errored or _count = 0`, so every blocked cell also
-- passed on a typo or a dropped table. `s2run` below returns the row count AND
-- the SQLSTATE, and every zero-row assertion carries a POSITIVE CONTROL: the same
-- caller, same connection, reading something they ARE allowed to read.
--
-- **A mutation that fails for the wrong reason proves nothing.** SITE-01's build
-- found two of its own mutations refused by a primary key after the constraint
-- they targeted had been dropped, and read that as the control working. Each
-- mutation here sits in its own savepoint and is asserted to flip exactly the
-- assertion it targets, in a transaction of its own.
--
-- **No participant prose is written into this file.** Names and addresses are
-- read from `profiles` at run time. SITE-03 finding 18 and program finding 24: a
-- harness that hardcodes its expected strings both leaks them into a public
-- repository and jams the seed that would have caught the leak.

-- ============================================================ scaffold

create table site02_results (
  seq     serial primary key,
  verdict text,
  label   text,
  outcome text
);

create function s2(_label text, _ok boolean, _outcome text default null)
returns void language plpgsql as $$
begin
  insert into site02_results (verdict, label, outcome)
  values (case when _ok then 'PASS' else 'FAIL' end, _label, _outcome);
end $$;

create function s2note(_label text, _outcome text default null)
returns void language plpgsql as $$
begin
  insert into site02_results (verdict, label, outcome) values ('note', _label, _outcome);
end $$;

-- Run `_sql` as `_uid` at `_aal`. Returns how many rows came back, or -1 and the
-- SQLSTATE that refused it. The two are never collapsed.
create function s2run(_uid uuid, _aal text, _sql text, out n bigint, out state text)
language plpgsql as $$
begin
  n := -1; state := null;
  if _uid is null then
    perform set_config('role', 'anon', true);
    perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  else
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claims',
      json_build_object('role', 'authenticated', 'sub', _uid::text, 'aal', coalesce(_aal, 'aal1'))::text, true);
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

-- A function's return column list, as a sorted set. `pg_get_function_result` and
-- NOT `information_schema.columns`, which describes tables and views: a criterion
-- reading it here would return zero rows and pass vacuously (SITE-01's review).
create function s2cols(_fn text) returns text[] language sql stable as $$
  select array(
    select split_part(trim(x), ' ', 1)
      from unnest(string_to_array(
             regexp_replace(pg_get_function_result(p.oid), '^TABLE\(|\)$', '', 'g'), ',')) as x
     order by 1)
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = _fn
   limit 1
$$;

-- The two shaped items, resolved at run time in the same order the fixture used.
create view s2_items as
  select (select item_key from public.evaluation_item
           where round_key = '@W1@' and active order by day, ordinal limit 1) as first_key,
         (select item_key from public.evaluation_item
           where round_key = '@W1@' and active order by day desc, ordinal desc limit 1) as scarce_key;

-- @@CHUNK@@ the assertions
do $$
declare _n int;
begin
  select count(*) into _n from public.evaluation_response where round_key = '@W1@';
  perform s2('population-is-not-empty', _n >= 8, _n::text || ' week-one response(s)');
  select count(*) into _n from public.evaluation_item where round_key = '@W1@' and active;
  perform s2('population-has-items', _n >= 3, _n::text || ' active item(s)');
end $$;

-- @@CHUNK@@ assertions 1: 1. the feed carries no identity
-- ============================================== 1. the feed carries no identity

do $$
declare _cols text[]; _hits bigint; _names text[];
begin
  _cols := s2cols('evaluation_comments');
  perform s2('facilitator-read-has-no-name',
             _cols = array['comment','item_key','item_title','kind'],
             'columns ' || array_to_string(_cols, ','));

  select array_agg(x) into _names from (
    select full_name as x from public.profiles where email like 'site02-ui-%'
    union all select email from public.profiles where email like 'site02-ui-%'
  ) y;
  perform s2('facilitator-read-has-no-name/population',
             coalesce(array_length(_names, 1), 0) >= 12,
             coalesce(array_length(_names, 1), 0)::text || ' name(s) and address(es) searched for');

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('role','authenticated','sub','@READER@','aal','aal1')::text, true);
  select count(*) into _hits
    from public.evaluation_comments('@W1@') c, unnest(_names) as nm
   where nm <> '' and (c.comment ilike '%' || nm || '%' or c.item_title ilike '%' || nm || '%');
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', null, true);
  perform s2('facilitator-read-has-no-name/live-rows', _hits = 0, _hits::text || ' hit(s) in the live feed');
end $$;

-- @@CHUNK@@ m1
drop function public.evaluation_comments(text);
create function public.evaluation_comments(_round_key text)
returns table(item_key text, item_title text, kind text, comment text, response_id uuid)
language sql security definer set search_path = public
as $f$ select null::text, null::text, null::text, null::text, null::uuid where false $f$;
do $$
declare _cols text[];
begin
  _cols := s2cols('evaluation_comments');
  perform s2('MUTATION 1 facilitator-read-has-no-name goes red',
             _cols <> array['comment','item_key','item_title','kind'],
             'columns ' || array_to_string(_cols, ','));
end $$;

-- @@CHUNK@@ assertions 2: 2. the feed does not correlate
-- ============================================ 2. the feed does not correlate

do $$
declare _perms text[]; _def text; _keys text[];
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('role','authenticated','sub','@READER@','aal','aal1')::text, true);
  -- Every item that actually carries comments, and the ORDER its comments come
  -- back in. A subquery preserves the function's own row order.
  select array_agg(distinct item_key) into _keys from public.evaluation_comments('@W1@');
  select array_agg(p) into _perms from (
    select (select string_agg(c.comment, '|') from (
              select comment from public.evaluation_comments('@W1@') where item_key = k
            ) c) as p
      from unnest(_keys) as k
  ) z;
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', null, true);

  perform s2('comments-do-not-correlate/population',
             coalesce(array_length(_keys, 1), 0) >= 3,
             coalesce(array_length(_keys, 1), 0)::text || ' commented item(s)');
  perform s2('comments-do-not-correlate',
             (select count(distinct x) from unnest(_perms) as x) = array_length(_perms, 1),
             (select count(distinct x) from unnest(_perms) as x)::text || ' distinct ordering(s) over '
               || coalesce(array_length(_perms, 1), 0)::text || ' item(s)');

  _def := pg_get_functiondef('public.evaluation_comments(text)'::regprocedure);
  perform s2('comments-do-not-correlate/salted',
             _def like '%evaluation_salt%' and _def like '%response_id%' and _def like '%item_key%',
             'the ordering names the salt, the response and the item');
end $$;

-- @@CHUNK@@ m2
drop function public.evaluation_comments(text);
create function public.evaluation_comments(_round_key text)
returns table(item_key text, item_title text, kind text, comment text)
language sql security definer set search_path = public as $f$
  select r.item_key, i.title, i.kind, r.comment
    from public.evaluation_item_rating r
    join public.evaluation_item i on i.round_key = r.round_key and i.item_key = r.item_key
   where r.round_key = _round_key and r.comment is not null
   order by r.response_id, r.item_key
$f$;
do $$
declare _perms text[]; _keys text[];
begin
  perform set_config('role', 'postgres', true);
  select array_agg(distinct item_key) into _keys from public.evaluation_comments('@W1@');
  select array_agg(p) into _perms from (
    select (select string_agg(c.comment, '|') from (
              select comment from public.evaluation_comments('@W1@') where item_key = k
            ) c) as p
      from unnest(_keys) as k
  ) z;
  perform s2('MUTATION 2 comments-do-not-correlate goes red',
             (select count(distinct x) from unnest(_perms) as x) < array_length(_perms, 1),
             (select count(distinct x) from unnest(_perms) as x)::text || ' distinct ordering(s) over '
               || coalesce(array_length(_perms, 1), 0)::text || ' item(s) under order-by-response_id');
end $$;

-- @@CHUNK@@ assertions 3: 3. the reads refuse while the round is open
-- =================================== 3. the reads refuse while the round is open

-- @@CHUNK@@ m3open
update public.workshop_evaluation_round
   set state = 'open', closes_at = now() + interval '1 day' where round_key = '@W1@';
do $$
declare r record;
begin
  r := s2run('@READER@', 'aal1', 'select * from public.evaluation_summary(''@W1@'')');
  perform s2('facilitator-reads-refuse-while-open/summary', r.state is not null,
             coalesce('refused ' || r.state, 'returned ' || r.n::text || ' row(s)'));
  r := s2run('@READER@', 'aal1', 'select * from public.evaluation_comments(''@W1@'')');
  perform s2('facilitator-reads-refuse-while-open/comments', r.state is not null,
             coalesce('refused ' || r.state, 'returned ' || r.n::text || ' row(s)'));
  r := s2run('@READER@', 'aal1', 'select * from public.evaluation_answers_feed(''@W1@'')');
  perform s2('facilitator-reads-refuse-while-open/answers', r.state is not null,
             coalesce('refused ' || r.state, 'returned ' || r.n::text || ' row(s)'));
end $$;

-- @@CHUNK@@ assertions 3b: the same reads on a CLOSED round
do $$
declare r record;
begin
  -- Closed, which is the fixture's own state: the same read must work, or the
  -- refusal above proved only that something was broken.
  r := s2run('@READER@', 'aal1', 'select * from public.evaluation_summary(''@W1@'')');
  perform s2('facilitator-reads-refuse-while-open', r.state is null and r.n > 0,
             'closed: ' || coalesce('refused ' || r.state, r.n::text || ' row(s)'));
end $$;

-- @@CHUNK@@ m3
create or replace function public.evaluation_round_is_closed(_round_key text)
returns boolean language sql stable security definer set search_path = public as $f$ select true $f$;
update public.workshop_evaluation_round
   set state = 'open', closes_at = now() + interval '1 day' where round_key = '@W1@';
do $$
declare r record;
begin
  r := s2run('@READER@', 'aal1', 'select * from public.evaluation_summary(''@W1@'')');
  perform s2('MUTATION 3 facilitator-reads-refuse-while-open goes red', r.state is null and r.n > 0,
             'mid-round read ' || coalesce('refused ' || r.state, 'returned ' || r.n::text || ' row(s)'));
end $$;

-- @@CHUNK@@ assertions 4: 4 and 5. whose answers a participant can read
-- ================================= 4 and 5. whose answers a participant can read

do $$
declare r record;
begin
  r := s2run('@PARTICIPANT@', 'aal1',
             'select * from public.evaluation_answer a join public.evaluation_response p on p.id = a.response_id where p.round_key = ''@W1@''');
  perform s2('author-reads-own-after-close', r.state is null and r.n > 0,
             coalesce('refused ' || r.state, r.n::text || ' answer(s) after closes_at'));

  r := s2run('@SECOND@', 'aal1',
             'select * from public.evaluation_response where profile_id = ''@PARTICIPANT@''::uuid');
  perform s2('second-participant-reads-zero', r.state is null and r.n = 0,
             coalesce('refused ' || r.state, r.n::text || ' row(s) of another participant'));
  -- The positive control, same caller, same connection: without it "zero rows"
  -- is indistinguishable from "the query was broken".
  r := s2run('@SECOND@', 'aal1', 'select * from public.evaluation_response where round_key = ''@W1@''');
  perform s2('second-participant-reads-zero/positive-control', r.state is null and r.n = 1,
             coalesce('refused ' || r.state, r.n::text || ' own row(s)'));
end $$;

-- @@CHUNK@@ m4
drop policy response_read_own on public.evaluation_response;
create policy response_read_own on public.evaluation_response for select to authenticated
  using ((profile_id = auth.uid() and (select closes_at from public.workshop_evaluation_round w
                                        where w.round_key = evaluation_response.round_key) > now())
         or is_head_mentor() or is_portal_admin());
do $$
declare r record;
begin
  r := s2run('@PARTICIPANT@', 'aal1',
             'select * from public.evaluation_answer a join public.evaluation_response p on p.id = a.response_id where p.round_key = ''@W1@''');
  perform s2('MUTATION 4 author-reads-own-after-close goes red', r.state is null and r.n = 0,
             coalesce('refused ' || r.state, r.n::text || ' answer(s) once the policy is scoped by round state'));
end $$;

-- @@CHUNK@@ m5
drop policy response_read_own on public.evaluation_response;
create policy response_read_own on public.evaluation_response for select to authenticated using (true);
do $$
declare r record;
begin
  r := s2run('@SECOND@', 'aal1',
             'select * from public.evaluation_response where profile_id = ''@PARTICIPANT@''::uuid');
  perform s2('MUTATION 5 second-participant-reads-zero goes red', r.state is null and r.n > 0,
             coalesce('refused ' || r.state, r.n::text || ' row(s) of another participant'));
end $$;

-- @@CHUNK@@ assertions 5: 6. a facilitator cannot reach the tables underneath the feed
-- ================== 6. a facilitator cannot reach the tables underneath the feed

do $$
declare r record;
begin
  r := s2run('@READER@', 'aal1', 'select * from public.evaluation_response where round_key = ''@W1@''');
  perform s2('facilitator-cannot-read-base-tables/response', r.state is null and r.n = 0,
             coalesce('refused ' || r.state, r.n::text || ' row(s)'));
  r := s2run('@READER@', 'aal1', 'select * from public.evaluation_item_rating where round_key = ''@W1@''');
  perform s2('facilitator-cannot-read-base-tables/ratings', r.state is null and r.n = 0,
             coalesce('refused ' || r.state, r.n::text || ' row(s)'));
  r := s2run('@READER@', 'aal1', 'select * from public.evaluation_answer where round_key = ''@W1@''');
  perform s2('facilitator-cannot-read-base-tables', r.state is null and r.n = 0,
             coalesce('refused ' || r.state, r.n::text || ' answer row(s)'));
  r := s2run('@READER@', 'aal1', 'select * from public.evaluation_item where round_key = ''@W1@''');
  perform s2('facilitator-cannot-read-base-tables/positive-control', r.state is null and r.n > 0,
             coalesce('refused ' || r.state, r.n::text || ' instrument row(s) the reader MAY see'));
end $$;

-- @@CHUNK@@ m6
drop policy answer_read_own on public.evaluation_answer;
create policy answer_read_own on public.evaluation_answer for select to authenticated
  using (is_evaluation_reader() or is_head_mentor() or is_portal_admin());
do $$
declare r record;
begin
  r := s2run('@READER@', 'aal1', 'select * from public.evaluation_answer where round_key = ''@W1@''');
  perform s2('MUTATION 6 facilitator-cannot-read-base-tables goes red', r.state is null and r.n > 0,
             coalesce('refused ' || r.state, r.n::text || ' answer row(s)'));
end $$;

-- @@CHUNK@@ assertions 6: 7. oversight, and only at aal2
-- ============================================ 7. oversight, and only at aal2

do $$
declare r record;
begin
  r := s2run('@HEADMENTOR@', 'aal2', 'select * from public.evaluation_response where round_key = ''@W1@'' and profile_id is not null');
  perform s2('head-mentor-read-is-attributed', r.state is null and r.n > 0,
             coalesce('refused ' || r.state, r.n::text || ' attributed row(s) at aal2'));
  r := s2run('@HEADMENTOR@', 'aal1', 'select * from public.evaluation_response where round_key = ''@W1@'' and profile_id is not null');
  perform s2('head-mentor-read-is-attributed/aal1-sees-nothing', r.state is null and r.n = 0,
             coalesce('refused ' || r.state, r.n::text || ' row(s) at aal1'));
  r := s2run('@HEADMENTOR@', 'aal1', 'select * from public.evaluation_item where round_key = ''@W1@''');
  perform s2('head-mentor-read-is-attributed/positive-control', r.state is null and r.n > 0,
             coalesce('refused ' || r.state, r.n::text || ' instrument row(s) at aal1'));
end $$;

-- @@CHUNK@@ m7
drop policy response_read_own on public.evaluation_response;
create policy response_read_own on public.evaluation_response for select to authenticated
  using (profile_id = auth.uid() or is_portal_admin());
do $$
declare r record;
begin
  r := s2run('@HEADMENTOR@', 'aal2', 'select * from public.evaluation_response where round_key = ''@W1@'' and profile_id is not null');
  perform s2('MUTATION 7 head-mentor-read-is-attributed goes red', r.state is null and r.n = 0,
             coalesce('refused ' || r.state, r.n::text || ' attributed row(s) with is_head_mentor() removed'));
end $$;

-- @@CHUNK@@ assertions 7: 8 and 9. suppression, and the absence count
-- ================================== 8 and 9. suppression, and the absence count

do $$
declare _scarce text; _first text; _sup boolean; _mean numeric; _nr bigint; _na bigint; _cols text[];
begin
  select scarce_key, first_key into _scarce, _first from s2_items;
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('role','authenticated','sub','@READER@','aal','aal1')::text, true);

  select suppressed, mean_rating into _sup, _mean
    from public.evaluation_summary('@W1@') where item_key = _scarce;
  select n_rated, n_absent, suppressed into _nr, _na, _sup
    from public.evaluation_summary('@W1@') where item_key = _scarce;
  perform s2('suppression-fires-below-min-n', _sup and _mean is null,
             'the one-rating item: suppressed=' || coalesce(_sup::text,'null') || ' mean=' || coalesce(_mean::text,'null'));

  select n_rated, n_absent, suppressed, mean_rating into _nr, _na, _sup, _mean
    from public.evaluation_summary('@W1@') where item_key = _first;
  perform s2('suppression-fires-below-min-n/published-item', not _sup and _mean is not null,
             'the well-rated item: n_rated=' || _nr::text || ' mean=' || coalesce(_mean::text,'null'));
  perform s2('n-absent-in-facilitator-read', _na > 0,
             'n_absent=' || coalesce(_na::text,'null') || ' on a published item');
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', null, true);

  _cols := s2cols('evaluation_summary');
  perform s2('n-absent-in-facilitator-read/column',
             'n_absent' = any(_cols), 'columns ' || array_to_string(_cols, ','));
end $$;

-- @@CHUNK@@ m8
update public.platform_setting set value = to_jsonb(1) where key = 'evaluation_min_n';
do $$
declare _scarce text; _sup boolean; _mean numeric;
begin
  select scarce_key into _scarce from s2_items;
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('role','authenticated','sub','@READER@','aal','aal1')::text, true);
  select suppressed, mean_rating into _sup, _mean
    from public.evaluation_summary('@W1@') where item_key = _scarce;
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', null, true);
  perform s2('MUTATION 8 suppression-fires-below-min-n goes red', not _sup and _mean is not null,
             'at min_n 1 the one-rating item publishes: suppressed=' || coalesce(_sup::text,'null')
               || ' mean=' || coalesce(_mean::text,'null'));
end $$;

-- @@CHUNK@@ m9
drop function public.evaluation_summary(text, text);
create function public.evaluation_summary(_round_key text, _group_key text default null)
returns table(item_key text, item_title text, kind text, n_rated bigint,
              suppressed boolean, mean_rating numeric)
language sql security definer set search_path = public
as $f$ select null::text, null::text, null::text, null::bigint, null::boolean, null::numeric where false $f$;
do $$
declare _cols text[];
begin
  _cols := s2cols('evaluation_summary');
  perform s2('MUTATION 9 n-absent-in-facilitator-read goes red', not ('n_absent' = any(_cols)),
             'columns ' || array_to_string(_cols, ','));
end $$;

-- @@CHUNK@@ assertions 8: 10. an imported round is distinguishable, and stays so
-- ============================ 10. an imported round is distinguishable, and stays so

do $$
declare _manual int; _portal_can_update boolean; r record;
begin
  select count(*) into _manual from public.evaluation_response
   where round_key = '@W1@' and source = 'manual' and profile_id = '@PARTICIPANT@'::uuid;
  perform s2('imported-round-is-distinguishable/row', _manual = 1,
             _manual::text || ' imported response(s) readable by their author');

  -- The sentence is only worth making if the provenance cannot be rewritten from
  -- the client. SITE-01's build measured that this needs BOTH a grant and a
  -- policy; the grant is the one asserted here, and it is the one a future widen
  -- would reach for first.
  _portal_can_update := has_table_privilege('authenticated', 'public.evaluation_response', 'UPDATE');
  perform s2('imported-round-is-distinguishable', not _portal_can_update,
             'authenticated UPDATE on evaluation_response = ' || _portal_can_update::text);

  r := s2run('@PARTICIPANT@', 'aal1',
             'select * from public.evaluation_response where round_key = ''@W1@'' and source = ''manual''');
  perform s2('imported-round-is-distinguishable/author-can-see-it', r.state is null and r.n = 1,
             coalesce('refused ' || r.state, r.n::text || ' row(s)'));
end $$;

-- @@CHUNK@@ m10
grant update on public.evaluation_response to authenticated;
do $$
declare _can boolean;
begin
  _can := has_table_privilege('authenticated', 'public.evaluation_response', 'UPDATE');
  perform s2('MUTATION 10 imported-round-is-distinguishable goes red', _can,
             'authenticated UPDATE on evaluation_response = ' || _can::text);
end $$;

