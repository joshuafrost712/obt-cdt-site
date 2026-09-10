-- SITE-08: the promise made to the Bali cohort, and the nine responses that
-- have to keep it.
--
-- The round-1 covering message told a cohort that naming themselves on the form
-- buys that "these answers can follow you into the portal later". The form
-- collected an optional name and no address, so nothing in the schema connects
-- a typed name to an account. This migration builds the route: one
-- administrator reads the name, decides, and that decision is recorded and
-- reversible.
--
-- Three things shape every choice below.
--
-- The evidence is a typed name, it is the input to exactly one decision, and it
-- is destroyed once that decision exists (D2). It lives in its own table with
-- no grant and no policy, on `evaluation_salt`'s precedent, because Supabase's
-- default ACL grants `anon` full write on every new public table and enabling
-- RLS alone does not undo that.
--
-- The bucketing key is `member_allowlist.full_name`, an attested name written
-- by an administrator, and never `profiles.full_name`, which is client-supplied
-- at sign-up (spec finding 13). With a person deciding every attach a
-- self-declared name is no longer privilege-bearing, but it is still the string
-- that decides which responses look already answered, and a roster name is the
-- honest thing to sort by.
--
-- Both writing functions are CLOSED-ROUND-ONLY, and that is the single most
-- load-bearing sentence here. `submit_evaluation()` inserts with
-- `on conflict (round_key, profile_id) where profile_id is not null do update`
-- (20260913120000:619-623), so the partial unique index is a conflict TARGET
-- and never an abort. On an open round a participant filing normally would take
-- over the imported response just attributed to them and its ratings and
-- answers would be deleted, with `evaluation_response_source_provenance`
-- staying quiet throughout. Decisions 9 and 10 close both doors onto that
-- state. Verified against the DEPLOYED function body on 2026-09-10, not only
-- against the committed file.

-- ------------------------------------------------- 1. The attested name

-- Additive, on a roster table `obt-cdt-assess` also reads, so it is `not null
-- default ''` and nothing that currently reads the table can notice it.
alter table public.member_allowlist
  add column if not exists full_name text not null default '';

comment on column public.member_allowlist.full_name is
  'The roster''s name of record, written by an administrator from the sign-up '
  'workbook and never by a client. SITE-08 D1 buckets the attribution queue on '
  'this and never on profiles.full_name, which handle_new_portal_user() fills '
  'from client-supplied raw_user_meta_data at sign-up: the allowlist gates the '
  'ADDRESS and nothing attests the NAME. Empty string means no name is on '
  'record, which buckets every response for that person as unmatched rather '
  'than matching them wrongly.';

-- ------------------------------------------------- 2. The normalisation

-- One expression, in one place, so the importer, the candidate read and the
-- allowlist side cannot drift apart. It folds case and runs of whitespace and
-- nothing else: "Josh Frost" matches "josh  frost" and does NOT match
-- "J. Frost" or "Joshua Frost". That is intentional. A rule that matched those
-- would be guessing, and the case it fails is the case D1 sends to a person.
--
-- `unaccent` is deliberately not used: the extension is not installed on this
-- project and adding one for a name-matching nicety is a larger change than the
-- nicety is worth.
--
-- IMMUTABLE is deliberate and there is no precedent for it in this repo's
-- migrations, so the reason is here rather than left to be second-guessed.
-- Postgres trusts the declaration and does not verify it, and lower() is
-- strictly collation-dependent, so this is a promise rather than a proof. It is
-- made because the function must be usable in an index or a generated column if
-- a later round's roster is large enough to want one, and because D1's "matches
-- exactly one" is only as meaningful as this expression. The promise holds as
-- long as the database's collation does not change under it, which is the same
-- assumption every text index on this project already makes.
create or replace function public.evaluation_name_norm(_name text)
returns text
language sql
immutable
set search_path = public
as $$
  select lower(regexp_replace(trim(coalesce(_name, '')), '\s+', ' ', 'g'));
$$;

comment on function public.evaluation_name_norm(text) is
  'SITE-08 D2. The one normalisation expression, folding case and whitespace '
  'runs and nothing else. Not gated and carrying no refusals: it is a pure '
  'helper, deliberately excluded from D4''s count of four gated functions and '
  'fourteen refusals so that accounting has one meaning.';

-- ------------------------------------------------- 3. The evidence

create table if not exists public.evaluation_response_identity (
  response_id  uuid primary key references public.evaluation_response (id) on delete cascade,
  round_key    text not null references public.workshop_evaluation_round (round_key),
  typed_name   text not null,
  name_norm    text not null,
  import_id    uuid not null references public.evaluation_import (id),
  created_at   timestamptz not null default now()
);

comment on table public.evaluation_response_identity is
  'SITE-08 D2. The name a respondent typed on the round-1 Google Form, held '
  'only until somebody decides what it means. No grant and no policy for any '
  'client role, on evaluation_salt''s precedent. The row is DELETED the moment '
  'the response''s attribution is settled, resolved or unattributable alike: '
  'the typed name is the input to one decision, and once the decision exists '
  'the name is the least useful and most identifying thing in the schema. It '
  'carries no rating, no answer and no comment, so nothing here widens what an '
  'oversight read returns.';

create index if not exists evaluation_response_identity_round_idx
  on public.evaluation_response_identity (round_key);

create index if not exists evaluation_response_identity_norm_idx
  on public.evaluation_response_identity (name_norm);

-- ------------------------------------------------- 4. The audit

create table if not exists public.evaluation_attribution_log (
  id           uuid primary key default gen_random_uuid(),
  response_id  uuid not null references public.evaluation_response (id) on delete cascade,
  round_key    text not null,
  action       text not null check (action in ('resolve','unattributable','detach')),
  actor_id     uuid not null references public.profiles (id),
  subject_id   uuid references public.profiles (id),
  typed_name   text,
  reason       text not null default '',
  at           timestamptz not null default now()
);

comment on table public.evaluation_attribution_log is
  'SITE-08 D6. Who decided what, on what evidence, and when. It KEEPS '
  'typed_name after the identity row is destroyed, which is a deliberate '
  'exception to D2''s destruction rule: the log is the only record that a '
  'decision was made on evidence, and a log that omits the evidence cannot '
  'answer the question it exists for. That is the narrowest possible '
  'retention, one string on the row recording the decision, unreachable by '
  'every client role and readable only by an administrator through '
  'evaluation_attribution_history().';

create index if not exists evaluation_attribution_log_response_idx
  on public.evaluation_attribution_log (response_id, at);

-- ------------------------------------------------- 5. Grant posture

-- Both tables closed to every client role. RLS enabled AND the grants revoked,
-- because enabling RLS on a table whose default ACL still grants `anon` is not
-- a boundary. Criterion 19 mutation-tests both.
alter table public.evaluation_response_identity enable row level security;
alter table public.evaluation_attribution_log   enable row level security;

revoke all on table public.evaluation_response_identity from public, anon, authenticated;
revoke all on table public.evaluation_attribution_log   from public, anon, authenticated;

-- ------------------------------------------------- 6. The queue

-- Gated on is_portal_admin(), used textually and never reimplemented, so it
-- becomes two-factor for free the day 20260821120000_admin_mfa.sql applies.
-- This migration does NOT close that hole and must not be read as doing so.
create or replace function public.evaluation_attribution_queue()
returns table (
  response_id       uuid,
  round_key         text,
  round_display_name text,
  typed_name        text,
  submitted_at      timestamptz,
  bucket            text,
  candidates        jsonb
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  -- Refusal 1 of 14. Tested first, before any other work.
  if not is_portal_admin() then
    raise exception 'Only a portal administrator can read the attribution queue.'
      using errcode = 'insufficient_privilege';
  end if;

  return query
  with unattached as (
    select r.id, r.round_key, r.submitted_at,
           i.typed_name, i.name_norm
    from evaluation_response r
    left join evaluation_response_identity i on i.response_id = r.id
    where r.profile_id is null
  ),
  -- The bucket is computed against the ATTESTED name. Repointing this join at
  -- profiles.full_name is criterion 5's mutation (a).
  scored as (
    select u.*,
           (select count(*) from member_allowlist m
             where u.name_norm is not null
               and evaluation_name_norm(m.full_name) = u.name_norm
               and m.full_name <> '') as match_count
    from unattached u
  )
  select
    s.id,
    s.round_key,
    w.display_name,
    coalesce(s.typed_name, ''),
    s.submitted_at,
    case
      when s.name_norm is null then 'unmatched'
      when s.match_count = 1   then 'matched'
      when s.match_count > 1   then 'ambiguous'
      else 'unmatched'
    end::text,
    -- The candidate array's full_name is the ALLOWLIST's attested name and
    -- never profiles.full_name. Criterion 5's mutation (b) repoints this one,
    -- and criterion 17 asserts the same string in the rendered picker: an
    -- administrator picker showing a self-declared name beside an address is
    -- the one place finding 13's string could still steer a human decision.
    --
    -- profile_id is null for the twenty allowlisted addresses with no account.
    -- Such a candidate is RETURNED rather than filtered, and cannot be attached
    -- to, because resolve_evaluation_response names a profile and there is
    -- none. An administrator looking for a name needs to know the difference
    -- between "not on the roster" and "on the roster and never registered".
    (
      select coalesce(jsonb_agg(c order by c.rank, c.full_name, c.email), '[]'::jsonb)
      from (
        select p.id as profile_id, m.email, m.full_name,
               case when s.name_norm is not null
                     and m.full_name <> ''
                     and evaluation_name_norm(m.full_name) = s.name_norm
                    then 0 else 1 end as rank
        from member_allowlist m
        left join profiles p on lower(p.email) = lower(m.email)
      ) c
    )
  from scored s
  join workshop_evaluation_round w on w.round_key = s.round_key
  order by
    case
      when s.name_norm is null then 3
      when s.match_count = 1   then 1
      when s.match_count > 1   then 2
      else 3
    end,
    s.submitted_at;
end;
$$;

comment on function public.evaluation_attribution_queue() is
  'SITE-08 D4 function 1. The unattached responses in every round, bucketed by '
  'the attested name. matched = the typed name normalises to exactly one '
  'allowlist name; ambiguous = more than one; unmatched = none, OR no identity '
  'row at all, which is the blank-name case folded in because the '
  'administrator''s action is identical for both. For a matched row the '
  'candidate array is ordered with the matching person first, and that is a '
  'SUGGESTION and never a default: nothing attaches without an explicit '
  'resolve naming a subject (criterion 5). One of only two oversight reads of '
  'the typed name anywhere in the design.';

revoke execute on function public.evaluation_attribution_queue() from public, anon;
grant  execute on function public.evaluation_attribution_queue() to authenticated;

-- ------------------------------------------------- 7. Resolve

-- Seven refusals. The administrator gate is tested FIRST, before any other
-- precondition, because CDT-10's criterion 9 measured that a function testing
-- its precondition first passes a test that only asserts "an exception was
-- raised" with the gate deleted.
create or replace function public.resolve_evaluation_response(
  _response_id uuid,
  _profile_id  uuid,
  _reason      text default ''
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  _actor       uuid := auth.uid();
  _round       text;
  _source      text;
  _typed       text;
  _existing    uuid;
begin
  -- Refusal 1. Tested first.
  if not is_portal_admin() then
    raise exception 'Only a portal administrator can attribute a response.'
      using errcode = 'insufficient_privilege';
  end if;

  -- The lock, taken AFTER the gate and BEFORE the precondition re-checks, which
  -- is D4's stated placement and what criterion 11 asserts by reading
  -- pg_get_functiondef. Two resolves naming two different people, or a resolve
  -- against a concurrent detach, pass their preconditions on the same row and
  -- the second write would win silently; finding 6's partial index cannot catch
  -- two writers naming different subjects.
  --
  -- HONEST NOTE, decision 11: this lock is NOT proven. No lane in either
  -- campaign can stage two overlapping transactions, because every SQL path
  -- posts a complete `begin; … rollback;` in one HTTP request to the management
  -- API and the repo carries no direct Postgres client. Criterion 11 asserts
  -- the lock is PRESENT and correctly positioned, and asserts the sequential
  -- second resolve refuses. The concurrent race is argued and not demonstrated.
  select r.round_key, r.source, r.profile_id
    into _round, _source, _existing
  from evaluation_response r
  where r.id = _response_id
  for update;

  if _round is null then
    raise exception 'No such response.'
      using errcode = 'check_violation';
  end if;

  -- Refusal 2. Checked explicitly so the message is about the situation rather
  -- than an index name. Re-attaching is a detach followed by a resolve, which
  -- leaves two log rows and is the point.
  if _existing is not null then
    raise exception 'That response is already attributed. Detach it first, which leaves both decisions in the log.'
      using errcode = 'unique_violation';
  end if;

  -- Refusal 4. A portal filing is already attached to its author and
  -- re-pointing one is not a repair, it is a rewrite of who said something.
  -- Nothing in the UI offers this; the refusal exists because the function is
  -- callable directly.
  if _source = 'portal' then
    raise exception 'That response was filed in the portal by its own author and cannot be re-attributed.'
      using errcode = 'check_violation';
  end if;

  -- Refusal 7, DECISION 10, and it is the refusal that makes this spec's
  -- participation-row invariant true rather than nearly true.
  --
  -- On an open round, attributing a response to somebody and inserting their
  -- participation row lets them file normally and SILENTLY DESTROY the
  -- reflection just attributed to them: submit_evaluation() upserts on the
  -- partial index as a conflict TARGET, binds _response_id to the imported
  -- response, and its replace-by-comparison deletes strip the ratings and
  -- answers. source stays 'manual' and import_id stays set, so the provenance
  -- constraint does not fire either. Every criterion would stay green.
  if evaluation_round_is_open(_round) then
    raise exception 'The % round is open. A response can only be attributed once its round has closed.', _round
      using errcode = 'check_violation';
  end if;

  if _profile_id is null then
    -- Refusal 6. Marking a response permanently unattributable without saying
    -- why is the one decision here that can never be reviewed later.
    if coalesce(btrim(_reason), '') = '' then
      raise exception 'Marking a response unattributable needs a reason.'
        using errcode = 'check_violation';
    end if;
  else
    -- Refusal 5. The subject is always an address already on the allowlist,
    -- never an arbitrary account. This is the first of D1's three mitigations
    -- for the open MFA hole.
    if not exists (
      select 1 from profiles p
      join member_allowlist m on lower(m.email) = lower(p.email)
      where p.id = _profile_id
    ) then
      raise exception 'That account is not on the member allowlist.'
        using errcode = 'check_violation';
    end if;

    -- Refusal 3. Finding 6 is why this can happen at all, and it is the
    -- refusal that stops one person owning two responses in one round.
    if exists (
      select 1 from evaluation_response r
      where r.round_key = _round and r.profile_id = _profile_id
    ) then
      raise exception 'That person already has a response in the % round.', _round
        using errcode = 'unique_violation';
    end if;
  end if;

  -- Capture the evidence before it is destroyed, so the log can keep it (D6).
  select i.typed_name into _typed
  from evaluation_response_identity i
  where i.response_id = _response_id;

  -- On success: attach, add the participation row, write the audit, destroy the
  -- evidence. One statement block, so a failure leaves none of it.
  if _profile_id is not null then
    update evaluation_response
       set profile_id = _profile_id, updated_at = now()
     where id = _response_id;

    -- D5, finding 7. Without this the person owns a response, passes every RLS
    -- check on it, and sees nothing anywhere in the portal, because
    -- evalApi.ts:178 myRounds reads evaluation_participant FIRST and returns []
    -- when it is empty.
    insert into evaluation_participant (round_key, profile_id)
    values (_round, _profile_id)
    on conflict do nothing;
  end if;

  insert into evaluation_attribution_log
    (response_id, round_key, action, actor_id, subject_id, typed_name, reason)
  values
    (_response_id, _round,
     case when _profile_id is null then 'unattributable' else 'resolve' end,
     _actor, _profile_id, _typed, coalesce(_reason, ''));

  delete from evaluation_response_identity where response_id = _response_id;
end;
$$;

comment on function public.resolve_evaluation_response(uuid, uuid, text) is
  'SITE-08 D4 function 2. Seven refusals, each with a named SQLSTATE. A null '
  '_profile_id marks the response permanently unattributable and requires a '
  'reason. CLOSED-ROUND-ONLY per decision 10: on an open round the attributed '
  'person could file normally and silently destroy the reflection just '
  'attributed to them, because submit_evaluation() uses the partial unique '
  'index as a conflict target rather than being aborted by it.';

revoke execute on function public.resolve_evaluation_response(uuid, uuid, text) from public, anon;
grant  execute on function public.resolve_evaluation_response(uuid, uuid, text) to authenticated;

-- ------------------------------------------------- 8. Detach

-- Five refusals. Detach exists because the worst state this spec can produce is
-- a participant reading somebody else's reflection under a heading that says
-- "What you wrote", and a surface that can create that state and cannot leave
-- it is not finished.
create or replace function public.detach_evaluation_response(
  _response_id uuid,
  _reason      text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  _actor   uuid := auth.uid();
  _round   text;
  _source  text;
  _subject uuid;
begin
  -- Refusal 1. Tested first.
  if not is_portal_admin() then
    raise exception 'Only a portal administrator can detach a response.'
      using errcode = 'insufficient_privilege';
  end if;

  -- Same placement as resolve: after the gate, before the precondition
  -- re-checks. Decision 11's honest note applies here too.
  select r.round_key, r.source, r.profile_id
    into _round, _source, _subject
  from evaluation_response r
  where r.id = _response_id
  for update;

  if _round is null then
    raise exception 'No such response.'
      using errcode = 'check_violation';
  end if;

  -- Refusal 2. Detaching without saying why is as unreviewable as marking a
  -- response unattributable without saying why.
  if coalesce(btrim(_reason), '') = '' then
    raise exception 'Detaching a response needs a reason.'
      using errcode = 'check_violation';
  end if;

  -- Refusal 3.
  if _subject is null then
    raise exception 'That response is not attributed to anybody.'
      using errcode = 'check_violation';
  end if;

  -- Refusal 4, DECISION 8. A portal filing is attached to its own author, and
  -- detaching it clears that author's read of their own response IRREVERSIBLY:
  -- resolve cannot put it back, because its refusal 4 refuses source='portal',
  -- and no identity row ever existed for a portal filing, so nothing surfaces
  -- it in the queue for repair. Detach is only ever usable on an imported
  -- response, which is the only kind it was ever for.
  if _source = 'portal' then
    raise exception 'That response was filed in the portal by its own author and cannot be detached.'
      using errcode = 'check_violation';
  end if;

  -- Refusal 5, DECISION 9. Detach leaves the participation row in place, and on
  -- an open round that row is the whole gate: submit_evaluation() tests
  -- evaluation_round_is_open() BEFORE the participant list (20260913120000:559-572),
  -- so a detached person passes the membership test with no attached response
  -- blocking the partial index and can file into the aggregate of a round they
  -- were never a participant of. That is the integrity failure the migration's
  -- own comment at :382-385 names.
  if evaluation_round_is_open(_round) then
    raise exception 'The % round is open. A response can only be detached once its round has closed.', _round
      using errcode = 'check_violation';
  end if;

  update evaluation_response
     set profile_id = null, updated_at = now()
   where id = _response_id;

  -- It deliberately does NOT restore the identity row or remove the
  -- participation row. The first is destroyed by design. The second may
  -- PRE-DATE this spec's write, because SITE-02 seeds evaluation_participant,
  -- and detach must not remove a membership it did not create. Refusal 5 means
  -- a detach only ever happens on a closed round, where a surviving membership
  -- grants nothing.
  insert into evaluation_attribution_log
    (response_id, round_key, action, actor_id, subject_id, typed_name, reason)
  values
    (_response_id, _round, 'detach', _actor, _subject, null, _reason);
end;
$$;

comment on function public.detach_evaluation_response(uuid, text) is
  'SITE-08 D4 function 3. Five refusals. Undoes an attach and is itself '
  'audited. Refuses a portal filing (decision 8) and an open round (decision '
  '9). Leaves the participation row in place deliberately, because SITE-02 '
  'also seeds that table and detach must not remove a membership it did not '
  'create.';

revoke execute on function public.detach_evaluation_response(uuid, text) from public, anon;
grant  execute on function public.detach_evaluation_response(uuid, text) to authenticated;

-- ------------------------------------------------- 9. History

-- One refusal. It exists because a log no role can read cannot answer the
-- question D6 says it exists for: D1 was claiming the audit as a mitigation for
-- the open MFA hole while specifying no reader for it, which is a mitigation in
-- name only.
create or replace function public.evaluation_attribution_history(_response_id uuid)
returns table (
  id          uuid,
  action      text,
  actor_email text,
  subject_email text,
  typed_name  text,
  reason      text,
  at          timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not is_portal_admin() then
    raise exception 'Only a portal administrator can read an attribution history.'
      using errcode = 'insufficient_privilege';
  end if;

  return query
  select l.id, l.action, actor.email, subject.email, l.typed_name, l.reason, l.at
  from evaluation_attribution_log l
  join profiles actor on actor.id = l.actor_id
  left join profiles subject on subject.id = l.subject_id
  where l.response_id = _response_id
  order by l.at;
end;
$$;

comment on function public.evaluation_attribution_history(uuid) is
  'SITE-08 D4 function 4. The log rows for one response, so D1''s third '
  'mitigation is something a person can actually do rather than a table nobody '
  'can read. The second of only two oversight reads of the typed name.';

revoke execute on function public.evaluation_attribution_history(uuid) from public, anon;
grant  execute on function public.evaluation_attribution_history(uuid) to authenticated;

-- The helper is not gated and carries no refusals, per D4.
revoke execute on function public.evaluation_name_norm(text) from public, anon;
grant  execute on function public.evaluation_name_norm(text) to authenticated;
