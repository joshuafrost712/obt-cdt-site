-- SITE-12 c1. A member gets a name the moment their profile exists, taken from
-- the roster their address was checked against rather than from what they typed.
--
-- Why the roster and not the form. NIST SP 800-63-3 separates a SELF-ASSERTED
-- attribute (the subscriber typed it) from one an authority ATTESTS, and says a
-- system must know which it holds. `member_allowlist.full_name` is this cohort's
-- attested name of record (SITE-08, program finding 51); `raw_user_meta_data` is
-- client-supplied at sign-up and validated by nothing, which Supabase's own
-- documentation says in as many words. Seeding from the authority record starts
-- the value attested and lets it degrade to self-asserted only if the member
-- edits it on the account screen, which is the right direction.
--
-- What this function did before, and the one thing the spec got wrong about it.
-- The gate is `if not exists (select 1 from member_allowlist where email = _norm)`.
-- It is an EXISTENCE test: it selects the literal 1 and never `full_name`, so no
-- attested value was ever "already in the trigger's hand" as SITE-12's stage 2
-- claims. The row is identified, not loaded. So the seed below ADDS a read; it
-- does not reuse one. Measured with pg_get_functiondef on 2026-09-17 and quoted
-- in SITE-12-build-record.md#D0.
--
-- The fallback chain is three-deep and the order is the whole point:
--   1. the attested roster name, when the roster carries one (36 of 42 rows)
--   2. the client's own metadata, which is today's behaviour
--   3. the empty string, which is today's behaviour when neither exists
-- So a registrant whose roster row has no name is never worse off than before
-- this migration, which is criterion 2, and the insert never fails.
--
-- The seed is ONE-SHOT by construction. The trigger fires on insert into
-- auth.users, so a roster correction made after someone registers does not
-- propagate, and a member's own edit never flows back to the roster. Both are
-- correct: the roster is the attested record and a member must not be able to
-- rewrite it. See SITE-12 D1.
--
-- Nothing here weakens the gate. The refusal above the insert is unchanged and
-- criterion 3 asserts it two-sided, so a mutation that empties this function
-- fails as loudly as one that removes the raise.

create or replace function public.handle_new_portal_user()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  _norm text := lower(btrim(new.email));
  _attested text;
begin
  -- The gate. Unchanged, and deliberately still an existence test: whether the
  -- roster carries a NAME must never decide whether the address may register.
  if not exists (select 1 from member_allowlist where email = _norm) then
    raise exception 'That address is not on the OBT-CDT participant list.'
      using errcode = 'insufficient_privilege';
  end if;

  -- The attested name, read from the row the gate just proved exists. Left null
  -- when the roster's value is empty, so coalesce falls through to the client's.
  select nullif(btrim(ma.full_name), '')
    into _attested
    from member_allowlist ma
   where ma.email = _norm;

  insert into public.profiles (id, email, full_name)
  values (
    new.id,
    _norm,
    coalesce(_attested, new.raw_user_meta_data ->> 'full_name', '')
  )
  on conflict (id) do nothing;
  return new;
end;
$function$;
