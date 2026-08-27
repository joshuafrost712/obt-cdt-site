-- ###########################################################################
-- Spec SITE-03. Member-only page bodies, stored where a public repository
-- cannot reach them.
--
-- ## Why a table at all
--
-- The site's answer to "make this members-only" was `hidden: true`, which is a
-- noindex tag on a file anyone can fetch (program finding 2). The stronger
-- reason is structural: `src/lib/content/loader.ts` imports site-content.json
-- statically, so Vite inlines it, and the build prerenders every route to
-- static HTML. A members-only page whose body lives in that file is public in
-- four places at once — the repository's working tree, its HISTORY, the
-- deployed JavaScript, and dist/. Client-side gating on this site is decoration.
--
-- So a member body is not in the repo. It is here, behind RLS, and the node in
-- site-content.json carries `blocks: []` and nothing else. The route, the title
-- and the nav label stay public by decision 4 of the spec, because a router that
-- cannot build its route table until a session resolves is a flash of nothing on
-- every page load for every visitor.
--
-- ## Why the block is JSON and not markdown
--
-- Finding 6 of the spec, and it is the difference between SITE-05 being a content
-- move and a rewrite. The Psalms page uses sixteen block types (24 cta, 7
-- linkGrid, 25 glanceCard across 6 glanceGrid, 7 callout, 22 subsection, 6
-- handbookSection, 1 sectionNav, 1 imageSlot, 1 timeline), and
-- src/lib/backend/markdown.tsx renders headings, bullets, paragraphs, bold and
-- italic with ZERO link support. A handbook moved into markdown blocks would
-- lose its contents rail, its fact tables, its schedule and every clickable
-- link, including the WhatsApp group and the travel forms.
--
-- `member_block.block` therefore holds one block in the site's OWN `Block`
-- schema (src/schema/types.ts), and the page renders it through the same
-- BlockRenderer the public pages use.
--
-- ## Who may read this, stated as a decision and not as a clause
--
-- ANY SIGNED-IN MEMBER, and the residual is named out loud in the spec's
-- decision 1: every account holder reads every member page forever, including
-- future cohorts, and THE AUDIENCE GROWS WITH THE ALLOWLIST AND NEVER SHRINKS.
-- That is a real cost on a document naming a base address and a live schedule.
-- It is taken because this is workshop material rather than participant data,
-- and scoping it per person would be a second access system with nothing to
-- enforce.
--
-- The audience is not "anyone with an account they made", because there is no
-- such thing here: handle_new_portal_user() refuses a signup that is not in
-- member_allowlist, and that table is revoked from every client role. The
-- allowlist is the boundary; `to authenticated` is how this schema spells it.
--
-- Reads and writes do NOT share a predicate (sibling finding 30, recurring class
-- 9). There is no write predicate at all: no client role holds insert, update or
-- delete on either table. scripts/seed_member_pages.py writes as `postgres`
-- through the management API, from files in the private vault.
--
-- ## Grants
--
-- Supabase's default ACL grants `anon` arwdDxtm on every new public table
-- (sibling finding 28), so the per-table revoke below is mandatory and not
-- tidiness. Asserted from the catalog with has_table_privilege in criterion 1,
-- never by reading this file.
--
-- Objects this migration owns:
--   table public.member_page
--   table public.member_block
--   index member_block_route_ordinal_idx
--   policy "a member page is readable by any signed-in member" on member_page
--   policy "a member block is readable by any signed-in member" on member_block
-- It declares no function and amends no object belonging to another migration.
-- ###########################################################################

-- ---------------------------------------------------------------------------
-- member_page: one row per gated route.
-- ---------------------------------------------------------------------------
create table if not exists public.member_page (
  route         text primary key,
  -- Short overline above the title on the rendered page. The TITLE is not here:
  -- it is in site-content.json and is public, because the route table needs it.
  kicker        text,
  -- sha256 of the vault source file, so a re-seed of an unchanged document is
  -- visibly a no-op and an edit that did not land is visibly an edit that did
  -- not land. The seed's own gate compares this.
  source_digest text not null,
  -- The opaque per-document token scripts/member-content-gate.mjs greps for
  -- across dist/** and src/**. Opaque by construction: it carries no prose, so
  -- publishing the route-to-token manifest in a public repo leaks nothing, and
  -- a member reading this column learns nothing they did not already have.
  sentinel      text not null unique,
  updated_at    timestamptz not null default now(),

  constraint member_page_route_shape check (route ~ '^/[a-z0-9/-]*$'),
  -- The format is asserted rather than described so a hand-typed "sentinel"
  -- that is actually a sentence cannot be seeded. A sentence in this column
  -- would put member prose into a public manifest.
  constraint member_page_sentinel_shape check (sentinel ~ '^mbr-[0-9a-f]{32}$')
);

comment on table public.member_page is
  'Spec SITE-03. One row per members-only route. Bodies live in member_block; '
  'the route, title and nav label stay public in site-content.json.';

-- ---------------------------------------------------------------------------
-- member_block: the body, one row per block, in the site's own Block schema.
-- ---------------------------------------------------------------------------
create table if not exists public.member_block (
  route     text not null references public.member_page(route) on update cascade on delete cascade,
  -- The block's own `id`, not a second string. Enforced below, because two
  -- strings meaning one thing is two strings that will drift, and SITE-05 moves
  -- 140 `bali.*` ids that are React keys, data-dfb-node targets and the DOM-id
  -- fallback all at once.
  block_key text not null,
  ordinal   integer not null,
  -- The fragment this block answers to. Singular today because no block on the
  -- Psalms page carries two old anchors, measured; the 2026-07-28 merge folded
  -- 21 sections into 5 and the next merge could change that, which SITE-05
  -- inherits as a note.
  anchor    text,
  block     jsonb not null,

  primary key (route, block_key),
  constraint member_block_ordinal_nonneg check (ordinal >= 0),
  constraint member_block_is_a_block check (
    jsonb_typeof(block) = 'object'
    and block ? 'id'
    and block ? 'type'
    and jsonb_typeof(block -> 'id') = 'string'
    and jsonb_typeof(block -> 'type') = 'string'
  ),
  constraint member_block_key_is_the_block_id check (block ->> 'id' = block_key),
  -- An anchor column that disagrees with the block it sits on is a link that
  -- lands nowhere. The column may be set when the JSON is silent (the seed
  -- lifts it), but the two may not say different things.
  constraint member_block_anchor_matches check (
    anchor is null or block ->> 'anchor' is null or anchor = block ->> 'anchor'
  )
);

comment on table public.member_block is
  'Spec SITE-03. One block of a member page body, in the site Block schema '
  '(src/schema/types.ts), rendered through the same BlockRenderer as a public page.';

-- Read order. Not unique: the seed re-numbers on a reorder, and a unique index
-- would abort the swap mid-statement.
create index if not exists member_block_route_ordinal_idx
  on public.member_block (route, ordinal);

-- ---------------------------------------------------------------------------
-- Grants, per table, before any policy. Sibling finding 28: the default ACL
-- gives anon arwdDxtm, so RLS alone would be the only line.
-- ---------------------------------------------------------------------------
alter table public.member_page  enable row level security;
alter table public.member_block enable row level security;

revoke all on table public.member_page  from public, anon, authenticated;
revoke all on table public.member_block from public, anon, authenticated;

grant select on table public.member_page  to authenticated;
grant select on table public.member_block to authenticated;

-- ---------------------------------------------------------------------------
-- Policies. Read only, and the name states the whole rule (sibling finding 31:
-- a policy name over 63 bytes truncates with a NOTICE and not an error; these
-- are 49 and 50).
-- ---------------------------------------------------------------------------
drop policy if exists "a member page is readable by any signed-in member" on public.member_page;
create policy "a member page is readable by any signed-in member" on public.member_page
  for select to authenticated using (true);

drop policy if exists "a member block is readable by any signed-in member" on public.member_block;
create policy "a member block is readable by any signed-in member" on public.member_block
  for select to authenticated using (true);
