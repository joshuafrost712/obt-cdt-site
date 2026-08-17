-- OBT-CDT Member Portal — publications: the reports a member can read.
--
-- A publication is one report, as it was sent to one address. It arrives either
-- over the signed push from Honest Eval or, for workshops that predate Honest
-- Eval, by an administrator importing it. Nothing in here is generated locally.
--
-- ## What is deliberately absent
--
-- No observations, no evidence, no designations, no verdicts, no evaluator
-- names, and no Honest Eval UUIDs. The portal stores the frozen prose that was
-- already emailed and the identity needed to route it. The working assessment
-- record stays in the system that owns it. That boundary is the reason the two
-- projects are separate at all, and widening it later should be a deliberate
-- versioned decision, not a convenient column.

-- ------------------------------------------------------- publisher connections
-- A paired Honest Eval deployment. The portal administrator creates a pairing,
-- hands the link to that deployment's platform owner, and it redeems it once.
-- Entering the link IS the approval; there is no second confirmation step here,
-- by explicit request.
create table if not exists public.publisher_connection (
  id             uuid primary key default gen_random_uuid(),
  label          text not null,
  -- vault.secrets id. The key itself never appears in this table, never reaches
  -- a browser, and is read only by the publish-ingest function.
  signing_key_id uuid not null,
  next_key_id    uuid,
  overlap_until  timestamptz,
  key_fingerprint text not null,
  status         text not null default 'active'
    check (status in ('active', 'revoked')),
  created_by     uuid references public.profiles(id) on delete set null,
  created_at     timestamptz not null default now(),
  last_seen_at   timestamptz
);

alter table public.publisher_connection enable row level security;
revoke all on table public.publisher_connection from public, anon, authenticated;

-- A pairing offer: single use, short lived, and stored only as a hash.
create table if not exists public.publisher_pairing (
  id            uuid primary key default gen_random_uuid(),
  label         text not null,
  -- sha256 of the NORMALIZED token. Storing the plaintext would make a database
  -- read (a screenshot of the SQL editor, a logical backup) into a pairing.
  token_hash    text not null unique,
  signing_key_id uuid not null,
  status        text not null default 'open'
    check (status in ('open', 'redeemed', 'expired')),
  attempts_left int not null default 5,
  expires_at    timestamptz not null,
  created_by    uuid references public.profiles(id) on delete set null,
  created_at    timestamptz not null default now(),
  redeemed_at   timestamptz,
  connection_id uuid references public.publisher_connection(id) on delete set null
);

alter table public.publisher_pairing enable row level security;
revoke all on table public.publisher_pairing from public, anon, authenticated;

-- ------------------------------------------------------------------ replay
-- One row per accepted envelope. The UNIQUE VIOLATION is the replay refusal —
-- doing it as an insert rather than select-then-insert is what makes it correct
-- when two copies of the same request arrive at once.
create table if not exists public.publish_receipt (
  connection_id uuid not null references public.publisher_connection(id) on delete cascade,
  nonce         text not null,
  seen_at       timestamptz not null default now(),
  primary key (connection_id, nonce)
);

alter table public.publish_receipt enable row level security;
revoke all on table public.publish_receipt from public, anon, authenticated;

-- ------------------------------------------------------------- publications
create table if not exists public.publication (
  id              uuid primary key default gen_random_uuid(),

  -- sha256(connection_id ‖ document_id ‖ normalized recipient email), computed by
  -- the sender. Deterministic, so a retry after an ambiguous timeout cannot
  -- double-publish and the manual path cannot duplicate what the push delivered.
  -- One key, two transports, no double.
  publication_key text not null unique,

  connection_id   uuid references public.publisher_connection(id) on delete set null,
  -- 'signed'   = arrived over the verified push or bundle from Honest Eval.
  -- 'manual'   = typed or uploaded by an administrator (the Epistles backfill).
  -- These must never be indistinguishable: one carries a cryptographic claim
  -- about its origin and the other carries a human's word for it.
  source          text not null default 'signed'
    check (source in ('signed', 'manual')),
  imported_by     uuid references public.profiles(id) on delete set null,

  event_id        text references public.events(id) on delete set null,
  -- Carried from the sender so a report still names its workshop even when the
  -- slug does not match any local event row (a workshop the portal has not been
  -- told about yet). Better a labelled orphan than a blank.
  workshop_name   text not null default '',

  document_id     text not null,
  kind            text not null,
  revision        integer not null default 1,
  supersedes      text,
  superseded_by   uuid references public.publication(id) on delete set null,

  title           text not null default '',
  subject         text not null default '',
  date_label      text not null default '',
  body_md         text not null,

  recipient_email text not null,
  -- 'subject' = the person the report is about. 'copied' = someone else who was
  -- on the email, e.g. a supervisor. Members are only ever shown 'subject'; a
  -- 'copied' row is a decision for a human, not an automatic disclosure.
  recipient_role  text not null default 'subject'
    check (recipient_role in ('subject', 'copied')),

  profile_id      uuid references public.profiles(id) on delete set null,
  match_state     text not null default 'unmatched'
    check (match_state in ('matched', 'unmatched')),

  visibility      text not null default 'visible'
    check (visibility in ('visible', 'withdrawn')),
  withdrawn_reason text,

  sent_at         timestamptz,
  received_at     timestamptz not null default now()
);

create index if not exists publication_profile_idx
  on public.publication (profile_id, sent_at desc);
create index if not exists publication_recipient_idx
  on public.publication (lower(recipient_email));
create index if not exists publication_unmatched_idx
  on public.publication (match_state) where match_state = 'unmatched';

alter table public.publication enable row level security;

-- SELECT only, and never for anon. No insert/update/delete policies and no write
-- grants: every write is service-role, from the ingest function or an admin
-- import. A write that fails at the grant with 42501 fails before any policy is
-- consulted, which is the louder and more debuggable failure.
revoke all on table public.publication from public, anon, authenticated;
grant select on table public.publication to authenticated;

drop policy if exists "read my own reports" on public.publication;
create policy "read my own reports" on public.publication
  for select to authenticated
  using (
    (
      profile_id = auth.uid()
      and match_state = 'matched'
      and visibility = 'visible'
      and recipient_role = 'subject'
    )
    or is_portal_admin()
  );

-- --------------------------------------------------------------- audit trail
-- Append only. "Was this ever shown to them, and when?" has to stay answerable
-- after a withdrawal, which is also why nothing above is ever deleted.
create table if not exists public.publication_event (
  id             bigserial primary key,
  publication_id uuid not null references public.publication(id) on delete cascade,
  kind           text not null
    check (kind in ('published','superseded','withdrawn','matched','rematched','imported')),
  detail         text not null default '',
  actor          uuid references public.profiles(id) on delete set null,
  at             timestamptz not null default now()
);

alter table public.publication_event enable row level security;
revoke all on table public.publication_event from public, anon, authenticated;
grant select on table public.publication_event to authenticated;

drop policy if exists "admins read the audit trail" on public.publication_event;
create policy "admins read the audit trail" on public.publication_event
  for select to authenticated using (is_portal_admin());

-- ------------------------------------------------------------------ aliases
-- A second address for a member. People register with one address and are
-- emailed at another often enough that without this the admin queue fills with
-- the same handful of people every round.
create table if not exists public.member_alias (
  email      text primary key,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  added_by   uuid references public.profiles(id) on delete set null,
  added_at   timestamptz not null default now()
);

alter table public.member_alias enable row level security;
revoke all on table public.member_alias from public, anon, authenticated;
grant select on table public.member_alias to authenticated;

drop policy if exists "admins read aliases" on public.member_alias;
create policy "admins read aliases" on public.member_alias
  for select to authenticated using (is_portal_admin());

-- ------------------------------------------------------------- late signup
-- Somebody who has not signed up yet cannot be matched, and with ~46 allowlisted
-- against ~30 who have reports, that is the ordinary case rather than an edge
-- case. Without this trigger every one of them sits in the administrator's queue
-- forever and the queue stops being read.
create or replace function public.publication_claim_for_new_profile()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare _n int;
begin
  with claimed as (
    update publication
       set profile_id = new.id, match_state = 'matched'
     where match_state = 'unmatched'
       and lower(recipient_email) = lower(new.email)
    returning id
  )
  insert into publication_event (publication_id, kind, detail)
  select id, 'matched', 'claimed when the member signed up' from claimed;

  get diagnostics _n = row_count;
  return new;
end;
$$;

drop trigger if exists publication_claim_trigger on public.profiles;
create trigger publication_claim_trigger
  after insert on public.profiles
  for each row execute function public.publication_claim_for_new_profile();

-- --------------------------------------------------------------- admin view
-- A VIEW, not a table. A queue table can drift from the rows it describes, and
-- then the administrator is working from a list that is quietly wrong.
create or replace view public.admin_unmatched_publications as
  select id, recipient_email, recipient_role, workshop_name, title,
         date_label, sent_at, received_at, source
    from public.publication
   where match_state = 'unmatched';

-- `security_invoker` is load-bearing, not tidiness. A Postgres view runs as its
-- OWNER by default, which means it does NOT apply the underlying table's RLS —
-- so without this line the grant below would hand every signed-in member the
-- full list of unmatched reports, addresses included, straight through a view
-- whose name says "admin". With it on, `publication`'s policy is evaluated as
-- the caller: an administrator sees the queue and a member sees nothing.
alter view public.admin_unmatched_publications set (security_invoker = on);

revoke all on public.admin_unmatched_publications from public, anon;
grant select on public.admin_unmatched_publications to authenticated;
