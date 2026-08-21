-- OBT-CDT — close the over-grant on admin_unmatched_publications.
--
-- Found by CDT-02's criterion 11 (runtime privilege assertion) during the
-- 2026-08-21 build session, on the first run of that check against a real
-- database. This is a NEW migration and not an edit to 20260817120200, because
-- `db push` records applied migrations by filename and skips them, so editing an
-- applied file leaves the repo and the live database silently disagreeing.
--
-- ## The defect
--
-- 20260817120200_publication.sql:247-248 reads:
--
--     revoke all on public.admin_unmatched_publications from public, anon;
--     grant select on public.admin_unmatched_publications to authenticated;
--
-- `authenticated` is not named in the revoke. Supabase grants privileges to
-- `anon` and `authenticated` directly rather than through PUBLIC, so revoking
-- from `public` leaves those standing, and the `grant select` on the next line
-- adds nothing to a role that already held everything. Measured on the live
-- project before this migration, `authenticated` held DELETE, INSERT, REFERENCES,
-- SELECT, TRIGGER, TRUNCATE and UPDATE on the view.
--
-- This is precisely the mistake 20260817120100_portal_admin.sql:42-47 documents
-- as "already shipped once in the sibling project". It then shipped here, in the
-- migration that copied the pattern. The lesson is that the warning was written
-- as prose and never as an assertion; CDT-02's criterion 11 is the assertion, and
-- it caught this on its first run.
--
-- ## What the exposure actually was
--
-- Latent, not live, and it is worth being exact rather than alarming. Two things
-- held it shut. The view carries `security_invoker = on`, so a write through it
-- is checked against the *invoking* user's privileges on the underlying
-- `publication` table, and `authenticated` holds only SELECT there. Verified by
-- attempting `delete from public.admin_unmatched_publications` as `authenticated`
-- on the live project: refused with 42501.
--
-- So no data was reachable. But the grant was two independent changes away from
-- being live: a future migration recreating the view without `security_invoker`,
-- or any grant of INSERT/UPDATE/DELETE on `publication`. A control that depends
-- on two unrelated facts staying true is not a control.

begin;

revoke all on public.admin_unmatched_publications from public, anon, authenticated;
grant select on public.admin_unmatched_publications to authenticated;

-- Assert the outcome rather than trusting the statement above, and fail the
-- migration if the grant did not narrow. `has_table_privilege` is the same
-- mechanism criterion 11 uses.
do $$
begin
  if has_table_privilege('authenticated', 'public.admin_unmatched_publications', 'INSERT')
     or has_table_privilege('authenticated', 'public.admin_unmatched_publications', 'UPDATE')
     or has_table_privilege('authenticated', 'public.admin_unmatched_publications', 'DELETE')
     or has_table_privilege('authenticated', 'public.admin_unmatched_publications', 'TRUNCATE') then
    raise exception 'admin_unmatched_publications still grants a write to authenticated';
  end if;
  if not has_table_privilege('authenticated', 'public.admin_unmatched_publications', 'SELECT') then
    raise exception 'admin_unmatched_publications no longer grants SELECT to authenticated, which it needs';
  end if;
  raise notice 'admin_unmatched_publications: authenticated now holds SELECT only';
end $$;

commit;
