-- OBT-CDT Member Portal — the admin manual report import. Spec SITE-14.
--
-- `publication` has been able to hold a report since 20260817120200 and has had
-- no way to receive one: measured on this project, INSERT belongs to `postgres`
-- and `service_role` only, there are no insert policies, and a client write
-- fails at the grant with 42501 before any policy is consulted. So the only
-- route is a security-definer function, and this is it.
--
-- Two functions, and the second one exists because of a measurement rather than
-- a preference. `member_allowlist` grants nothing to `authenticated` and carries
-- no policy, so the screen that shows an administrator who an address belongs to
-- before they commit the write cannot read the roster from the client at all.
--
-- ## The order of refusals is fixed, and it is asserted behaviourally
--
-- CDT-10's criterion 9 found that a function testing its precondition before its
-- admin gate passes a test that only asserts "an exception was raised" with the
-- gate deleted. So in both functions the administrator gate is refusal 1, and
-- the argument checks follow it.
--
-- And within the argument checks the order is fixed too, which is the cost of
-- inserting a refusal between two that were already ordered. An empty address is
-- ALSO absent from `member_allowlist`, so if the allowlist check ran first an
-- empty argument could raise either error and the lane proving gate-ordering
-- would go red for the wrong reason or green by luck. Empty-and-malformed first,
-- allowlist second. SITE-14 criterion 2 and criterion 16 assert both positions.

-- ---------------------------------------------------- resolve the recipient
-- Shows the administrator who an address belongs to, before anything is written.
-- This is a correctness gate, not an authorization gate: the hazard it exists
-- for is a well-formed address typed for the wrong person, which every standard
-- consulted in the spec's brief leaves to the application.
--
-- Its own admin gate is refusal 1 on the same reasoning as the write function,
-- and it is not decorative. A definer function bypasses RLS by construction, so
-- `member_allowlist`'s revocation from client roles does NOT protect it: without
-- this gate any of the 22 authenticated accounts could call it with any address
-- and learn the attested roster name plus whether that person has an account.
-- That is cohort disclosure. SITE-14 criterion 17 and mutation 6.
--
-- It returns ONE row for an address the caller already typed, never a list, so
-- it cannot be walked to enumerate the cohort.
create or replace function public.resolve_import_recipient(_email text)
returns table (
  normalized_email text,
  attested_name    text,
  on_allowlist     boolean,
  has_account      boolean
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare _norm text;
begin
  -- Refusal 1, before the lookup, so an empty argument still returns this.
  if not is_portal_admin() then
    raise exception 'Only a portal administrator can look up a report recipient.'
      using errcode = 'insufficient_privilege';
  end if;

  _norm := lower(btrim(coalesce(_email, '')));
  if _norm = '' then
    raise exception 'An address is needed to look up a recipient.'
      using errcode = 'check_violation';
  end if;

  return query
    select
      _norm,
      (select a.full_name from member_allowlist a where lower(a.email) = _norm),
      exists (select 1 from member_allowlist a where lower(a.email) = _norm),
      exists (select 1 from profiles p where lower(p.email) = _norm);
end;
$$;

revoke all on function public.resolve_import_recipient(text) from public, anon;
grant execute on function public.resolve_import_recipient(text) to authenticated;

comment on function public.resolve_import_recipient(text) is
  'SITE-14: names who an address belongs to for the import confirm step. Admin-gated as refusal 1 because it discloses an attested roster name; returns one row for a typed address and never a list.';

-- ------------------------------------------------------------- the import
-- The only write path into `publication`, and the first one of any kind.
--
-- `source` and `imported_by` are written HERE and are not arguments. A caller
-- that could supply them could file a manual row claiming to be signed, which is
-- the one distinction the source column's comment says must never blur.
-- `recipient_role` is likewise not an argument: decision 3 was answered "no, not
-- for now" on 2026-09-15, so the function hardcodes 'subject' rather than
-- accepting a value and refusing it. Criterion 3 asserts all three absences
-- against pg_get_function_identity_arguments().
--
-- `match_state` is resolved rather than supplied for the same class of reason:
-- an argument would let a caller mark a row matched with no profile behind it,
-- which RLS would then filter to nobody while the admin queue reported it done.
create or replace function public.import_publication_manual(
  _recipient_email text,
  _document_id     text,
  _title           text,
  _workshop_name   text,
  _date_label      text,
  _body_md         text,
  _event_id        text default null,
  _kind            text default 'evaluation',
  _sent_at         timestamptz default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  _norm    text;
  _key     text;
  _profile uuid;
  _state   text;
  _id      uuid;
  _actor   uuid := auth.uid();
begin
  -- Refusal 1. Tested before anything else, including argument validity, so a
  -- non-administrator calling with a deliberately invalid argument still gets
  -- THIS error and the lane can prove the gate ran first.
  if not is_portal_admin() then
    raise exception 'Only a portal administrator can import a report.'
      using errcode = 'insufficient_privilege';
  end if;

  -- Argument checks: empty-and-malformed first (see the header), each with its
  -- own errcode and a message about the situation rather than an index name.
  _norm := lower(btrim(coalesce(_recipient_email, '')));
  if _norm = '' then
    raise exception 'A recipient address is needed to import a report.'
      using errcode = 'check_violation';
  end if;
  if _norm !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'That does not look like an email address: %', _norm
      using errcode = 'check_violation';
  end if;
  if btrim(coalesce(_document_id, '')) = '' then
    raise exception 'A document id is needed, so a repeated paste can be recognised.'
      using errcode = 'check_violation';
  end if;
  if btrim(coalesce(_body_md, '')) = '' then
    raise exception 'A report with no body cannot be imported.'
      using errcode = 'check_violation';
  end if;

  -- The allowlist check, second. Decision 2, answered "refuse" 2026-09-15:
  -- handle_new_portal_user() refuses any address absent from the allowlist, so
  -- an import for an off-roster address is a report nobody could ever register
  -- to read. It raises its OWN errcode, not insufficient_privilege, so criterion
  -- 16 can tell this refusal from the admin one.
  if not exists (select 1 from member_allowlist a where lower(a.email) = _norm) then
    raise exception 'The address % is not on the member allowlist. Add it there first, or that person can never register to read this report.', _norm
      using errcode = 'foreign_key_violation';
  end if;

  -- The key. concat_ws rather than ||, because a null in a || expression makes
  -- the WHOLE expression null and publication_key is NOT NULL: the naive form
  -- fails at 23502 on the first import. The literal 'manual' occupies the
  -- connection slot (decision 1), which makes the manual keyspace visibly
  -- disjoint from the connection keyspace rather than disjoint by accident of a
  -- skipped null.
  --
  -- lower(btrim()) is the part that does the dedupe work, and it is mutation 2:
  -- without it ' A@B.org ' and 'a@b.org' hash differently, both insert, and the
  -- member sees the same report twice.
  _key := encode(
    sha256(convert_to(concat_ws('|', 'manual', btrim(_document_id), _norm), 'utf8')),
    'hex'
  );

  -- Resolved, never supplied.
  select p.id into _profile from profiles p where lower(p.email) = _norm;
  _state := case when _profile is null then 'unmatched' else 'matched' end;

  begin
    insert into publication (
      publication_key, connection_id, source, imported_by,
      event_id, workshop_name, document_id, kind,
      title, subject, date_label, body_md,
      recipient_email, recipient_role, profile_id, match_state, sent_at
    ) values (
      _key, null, 'manual', _actor,
      _event_id, coalesce(btrim(_workshop_name), ''), btrim(_document_id), coalesce(nullif(btrim(_kind), ''), 'evaluation'),
      coalesce(btrim(_title), ''), coalesce(btrim(_title), ''), coalesce(btrim(_date_label), ''), _body_md,
      _norm, 'subject', _profile, _state, _sent_at
    )
    returning id into _id;
  exception when unique_violation then
    -- Caught rather than pre-checked, on the same reasoning publish_receipt's
    -- comment already records: an insert is correct when two copies of the same
    -- request arrive at once and select-then-insert is not.
    raise exception 'The report % for % is already in the portal.', btrim(_document_id), _norm
      using errcode = 'unique_violation';
  end;

  -- What makes the import non-repudiable. Actor, time and kind; never the body.
  insert into publication_event (publication_id, kind, detail, actor)
  values (_id, 'imported', 'imported by an administrator from a pasted report', _actor);

  return _id;
end;
$$;

revoke all on function public.import_publication_manual(text, text, text, text, text, text, text, text, timestamptz) from public, anon;
grant execute on function public.import_publication_manual(text, text, text, text, text, text, text, text, timestamptz) to authenticated;

comment on function public.import_publication_manual(text, text, text, text, text, text, text, text, timestamptz) is
  'SITE-14: the only write path into publication. Admin-gated as refusal 1, then argument checks, then the allowlist check, then the insert. source, imported_by and recipient_role are written here and are not arguments.';
