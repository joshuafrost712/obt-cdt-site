-- ###########################################################################
-- Spec CDT-04, third migration. One write-up per assignment, enforced.
--
-- ## How this was found
--
-- By the walkthrough breaking. `submission` has no unique constraint on
-- `assignment_id` — verified against the live catalog: the only unique indexes
-- are `submission_pkey` on (id) and `submission_id_bundle_key_key` on
-- (id, bundle_key), the latter existing only so `submission_rating`'s composite
-- foreign key has something to point at.
--
-- The harness inserted a second `submission` for one assignment, and the
-- assignment page went blank behind an error, because `getSubmissionForAssignment`
-- uses `.maybeSingle()` and PostgREST refuses two rows where one was asked for.
-- Two duplicates existed on the live project at the time; both were fixture rows
-- and both are removed below.
--
-- ## Why the constraint is the fix rather than the client
--
-- `submit_writeup()` already assumes this: it does `select id into _sub_id from
-- submission where assignment_id = _assignment` and then either inserts or
-- revises. Under two rows that SELECT is non-deterministic, so the revision path
-- would silently update whichever row Postgres happened to return, and the other
-- would stay in the head mentor's queue forever as a write-up nobody can reach.
--
-- Making the client tolerate duplicates would be the wrong repair. "One write-up
-- per assignment" is not a display preference; it is what makes an approval trail
-- mean anything, and CDT-02's decision 1 put the approval state ON the submission
-- precisely so that one row is one decision. A second rating is a second
-- ASSIGNMENT with `rating_role = 'second'`, carrying its own submission, so the
-- second-rating design is unaffected by this.
--
-- Objects owned: the unique index submission_one_per_assignment. No table, no
-- function, no policy.
-- ###########################################################################

-- Any duplicate must go before the index can exist. Keep the earliest by
-- submitted_at, then created order, since that is the one a head mentor may
-- already have seen. This deletes nothing on a clean database.
with ranked as (
  select id,
         row_number() over (
           partition by assignment_id
           order by submitted_at nulls last, id
         ) as rn
    from public.submission
)
delete from public.submission_rating
 where submission_id in (select id from ranked where rn > 1);

with ranked as (
  select id,
         row_number() over (
           partition by assignment_id
           order by submitted_at nulls last, id
         ) as rn
    from public.submission
)
delete from public.submission_file
 where submission_id in (select id from ranked where rn > 1);

with ranked as (
  select id,
         row_number() over (
           partition by assignment_id
           order by submitted_at nulls last, id
         ) as rn
    from public.submission
)
delete from public.submission
 where id in (select id from ranked where rn > 1);

create unique index if not exists submission_one_per_assignment
  on public.submission (assignment_id);

do $$
declare _n int;
begin
  select count(*) into _n
    from pg_indexes
   where schemaname = 'public' and indexname = 'submission_one_per_assignment';
  if _n <> 1 then
    raise exception 'submission_one_per_assignment was not created';
  end if;

  -- And assert the property, not only the index: no assignment holds two.
  select count(*) into _n from (
    select assignment_id from public.submission group by assignment_id having count(*) > 1
  ) d;
  if _n <> 0 then
    raise exception '% assignment(s) still hold more than one submission', _n;
  end if;
end $$;
