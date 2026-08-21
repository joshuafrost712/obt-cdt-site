# Security posture of the OBT-CDT site

Written 2026-08-21 by spec CDT-00, the security pass that runs before real
participant names enter the database. Every measurement here was taken on that
date with the command kept, and where a number is asserted the command that
produced it is named. If you are changing something this document describes,
change this document in the same commit.

Read `docs/PORTAL.md` for what the member portal is and `docs/STYLE.md` for the
type stack. This file is about who can see what, and about which of the controls
below are real.

## The threat this is written against

Several people in the OBT-CDT cohort work in places where being identified as a
Bible translation consultant carries real cost. For them the disclosure that
matters is not an assessment rating. It is the bare fact of participation.

That reorders the usual security priorities. A third-party origin learning which
IP address read the participant handbook is a **larger** problem for this cohort
than script injection is, because the third party learns something true about a
real person and the injection is hypothetical. So the first thing this pass did
was remove every third-party request from the site, and the CSP came second.

Two attackers are worth naming separately, because the controls differ.

A **passive observer** wants to know who is involved. They read public pages,
watch who requests what, and follow links. Against this one the controls are:
no third-party origins, a no-referrer policy, aggregates-only content, and a
sign-up form that answers identically whether or not an address is on the list.

An **authenticated member** who wants to read somebody else's report is the
other. Against this one the only real control is row-level security in Postgres,
and the audit below is how it is checked. Note the shape of an RLS failure: a
denied read returns **zero rows, not an error**, so a broken policy looks like an
empty page rather than a fault. That is why the assertions in this document check
state rather than checking that a call did not throw.

## What this pass changed

**The four type families are now self-hosted.** `index.html` used to carry a
preconnect to `fonts.googleapis.com`, a second to `fonts.gstatic.com`, and a
stylesheet request pulling Playfair Display, Lora, Source Sans 3 and Caveat from
Google. Every visit to the Bali handbook therefore handed Google an IP address, a
timestamp and a referring URL. All three are gone. The files live in
`public/fonts/`, are declared as `@font-face` in `src/index.css`, and are
downloaded by `scripts/fetch-fonts.mjs`.

**One Content-Security-Policy now reaches every generated HTML file**, written by
`scripts/csp-hashes.mjs` after the prerender. **A referrer policy of
`no-referrer`** rides along with it.

**The portal refuses to render inside a frame**, which is the interim stand-in
for a `frame-ancestors` directive that GitHub Pages cannot deliver.

**A migration requiring two-factor authentication for administration is written
and reviewed**, and is deliberately not yet applied. See the honest gaps below.

## Two admissions

A memo that records only the exposure it closed is the overstatement this pass
exists to avoid. So, plainly:

**The feedback sink is a third-party origin, and it stays.** `src/devfeedback/send.ts`
POSTs review comments to a Google Apps Script web app on `script.google.com`.
`connect-src` admits `https://script.google.com` and
`https://script.googleusercontent.com`. This means **any page load that triggers a
feedback send tells Google that this device is reviewing this site.** It is
admitted because the review loop is how copy rounds actually happen, and because
the people using it are Joshua and a handful of reviewers rather than
participants reading the handbook. It is not the same exposure the font removal
closed, but it is the same kind, and it should be read as a trade rather than as
an absence. Retiring the remote sink and keeping the markdown-download fallback
is the alternative, at the cost of a worse review loop.

Note that this is currently inert either way: `VITE_FEEDBACK_URL` is unset on the
deployment, so the widget already falls through to downloading a file. That will
change the moment the variable is set.

**There is no CAPTCHA, by decision.** Supabase's CAPTCHA setting means hCaptcha
or Cloudflare Turnstile, both of which load a provider script and call home.
Because there is exactly one CSP for this whole site (see below), admitting that
origin would admit it on the participant handbook as well as on the sign-in page.
The exposure this campaign was written to close is precisely "a third party sees
who reads this," so re-admitting one to close a different risk is a poor trade
for a cohort of roughly 46 known addresses whose sign-up is already gated by
`member_allowlist`. Revisit behind Cloudflare, where Turnstile is same-origin
from the browser's point of view and the trade disappears.

## Why there is exactly one policy for the whole site

This constraint is what makes the two admissions above genuine trades rather
than preferences, so it is worth stating precisely.

`scripts/prerender.mjs` writes three classes of HTML. The prerendered routes
derive from `index.html`; `404.html` is a copy of it; and the retired-route
redirect stubs plus the developer entry at `dist/dev/index.html` are complete
documents built from template literals that never see the template at all.

The portal is served from `404.html`. `routes()` does not include it, `dist/`
contains no `portal/` directory, and GitHub Pages serves `404.html` for any
unmatched path, which the SPA then client-renders. So a per-route policy cannot
reach the portal, and **any origin the portal needs is an origin the public
handbook also carries.**

`csp-hashes.mjs` therefore patches all three classes with one policy.

**The inline-script gate is an allowlist, and the reason matters.** The first
version of this script collected every inline script it found and put all of
their hashes in the policy. That gate could never fail: adding a new inline
script simply got it admitted, and the build printed a reassuring line either
way. It was tested by planting an unhashed inline script, and it passed.

So the admitted scripts live in `scripts/csp-allowed-inline.json`, and a script
that is not on it **fails the build**. That failure is the point: it is what stops
the site white-screening six months from now, and it makes adding an inline
script a reviewable commit rather than a side effect.

The allowlist keys on a **normalized** hash, not the raw one, because the `/dev/`
entry interpolates the base path and its bytes differ between a local build (`/`)
and CI (`/obt-cdt-site/`). Normalization templates quoted absolute paths and Vite
asset digests out, and it derives the base from the text rather than from
`process.env.VITE_BASE`, because an env-dependent key gives different answers
depending on which shell ran the script. The policy still carries the real sha256
of the real bytes, which is what the browser checks. Verified 2026-08-21: the
same two keys from a `/obt-cdt-site/` build, a `/` build, and a bare run with no
base set; and a planted inline script fails the build with exit code 1.

## The policy, and the six deliberate things in it

```
default-src 'self';
script-src 'self' '<sha256 of the js-class script>' '<sha256 of the /dev/ script>';
style-src 'self' 'unsafe-inline';
img-src 'self' data:;
font-src 'self';
connect-src 'self' https://script.google.com https://script.googleusercontent.com
            https://<ref>.supabase.co wss://<ref>.supabase.co;
form-action 'self';
base-uri 'self';
object-src 'none';
frame-src 'none';
frame-ancestors 'none';
```

The hashes are computed at build time and not baked into source, because the
`/dev/` entry interpolates the base path and its SHA-256 therefore differs
between a local build (`/`) and CI (`/obt-cdt-site/`). A hash written into
source would be wrong in exactly one of the two.

**`frame-ancestors 'none'` is ignored.** Browsers honour that directive only from
a response header, and GitHub Pages cannot send one. Chrome logs a console
message saying so on every page load. It stays in the policy because it costs
nothing and becomes live the day a header-delivered CSP exists, but **do not read
this line as clickjacking being closed.** It is not. The interim control is the
next section.

**`style-src 'unsafe-inline'` is a departure with a stated cost.** There are 16
`style={{...}}` usages across `HandbookBlocks.tsx`, `ImageSlot.tsx`,
`SelectionLayer.tsx`, `RoundaboutDiagram.tsx` and `HandbookPage.tsx`. React writes
those as `style` attributes. Removing them is a refactor of unrelated components,
so the honest posture is to permit them and say what it costs: an attacker who has
**already** achieved execution can restyle the page. That is a defacement risk,
not a disclosure one.

**`connect-src` names the Supabase origin explicitly** rather than allowing
`https:`, so a compromised dependency cannot exfiltrate to an attacker's host.
`wss:` is listed separately because CSP scheme matching does not let an `https://`
source match a `wss://` URL. Supabase Realtime is unused today, and the
"a new origin is a decision" rule below would not have fired for it, because
Realtime is not a new origin. Listing it now costs nothing and closes that gap.

**`img-src data:` is required** by the SVG favicon and Vite's inlined assets.

**`blob:` is deliberately absent.** `send.ts` uses `URL.createObjectURL` for the
markdown download fallback, and that is not governed by any directive here. Do
not add `blob:` on a guess.

**The dev server is unaffected.** `@vitejs/plugin-react` injects an inline module
preamble and HMR opens a WebSocket, neither of which the policy would allow. It
does not matter, because the policy is injected into `dist/` rather than living in
the served template, so `npm run dev` never sees it.

## The frame guard, and what it is not

`src/lib/frameBuster.ts` runs on portal routes only. If the page is framed, the
app does not mount: the document is replaced with a plain notice and a link that
opens the portal at top level.

**It refuses rather than escapes, and that is a correction to the spec.** CDT-00
D3 called for a script that checks `window.top !== window.self` and replaces the
top location. Measured in Chrome 151 on 2026-08-21, that cannot work: a
cross-origin frame may navigate its top-level browsing context only with
transient user activation, so `window.top.location.replace()` from a framed page
with no click behind it is refused. A frame-buster written that way reviews as
correct and does nothing in production. Refusal needs no activation, and an
attacker gains nothing from framing a page that renders no portal UI. The escape
is still attempted first, because it succeeds when the framing page is
same-origin and costs nothing when it is not.

Public pages are deliberately **not** guarded. The handbook is meant to be
shareable and embeddable.

**Retirement path.** This control goes away when a header-delivered CSP exists,
which is the Cloudflare half of CDT-DOMAIN. At that point `frame-ancestors`
becomes real and `frameBuster.ts` is deleted rather than kept, because a
defeatable control left in place reads as protection. A JS guard is defeatable:
an attacker controlling the framing page can influence the child through the
iframe's `sandbox` attribute.

## Outbound links are not governed by the CSP

A CSP governs what the page fetches, not where a link navigates. The site links
to `youtube.com`, `docs.google.com`, `forms.gle`, `wa.me`, `maps.app.goo.gl`,
`www.google.com`, `lovebali.baliprov.go.id`, `evisa.imigrasi.go.id` and
`www.mechon-mamre.org`. None is an embed; all are `href` values, verified by
`grep -rn "<iframe\|youtube.com/embed" src public index.html` returning nothing.

The control that actually applies is `<meta name="referrer" content="no-referrer">`,
which stops each of those destinations learning which page the visitor came from.
Without it, a click from the handbook tells the destination the exact section
that was open.

`scripts/cdt00-origin-scan.mjs` enumerates both sets and reports them separately,
so the exclusion is visible rather than implied.

## The policy audit

Every table, view, function and trigger in `supabase/migrations/`, against the
seven questions below. Objects that pass get a row, because a checklist whose
output is only its failures cannot be reread later to see what was covered.

Counted mechanically on 2026-08-21: **10 tables, 1 view, 8 functions, 3 triggers,
7 policies**, which is 22 distinct objects. The count is of distinct object
names, not of `create` statements, because `is_portal_admin()` acquires a second
`create or replace` once the MFA migration lands.

The seven questions:

1. Is RLS enabled, and is there a `revoke all` from **`public, anon, authenticated`**
   (all three named) before any grant?
2. Does every `for update` policy have a `with check`, given that Postgres reuses
   the `using` expression when it is absent?
3. Where a rule is about columns rather than rows, is it a column grant rather
   than a policy, since RLS cannot restrict columns?
4. Does every view carry `security_invoker = on`?
5. Is every `security definer` function `set search_path`, and is EXECUTE revoked
   from `public, anon` and granted explicitly, since Postgres grants EXECUTE to
   PUBLIC by default?
6. Does any table let its own subject write the field that decides their privilege?
7. Can any client role read a table whose contents disclose cohort membership?

### Tables

| Object | RLS | Revoke shape | Verdict | Line |
|---|---|---|---|---|
| `profiles` | on | **partial**: `revoke update … from authenticated` only | see finding A | baseline 47, 62 |
| `member_allowlist` | on | all three roles, no grant | pass | baseline 84-85 |
| `events` | on | **none**: relies on RLS alone | see finding A | baseline 147 |
| `portal_admin` | on | all three, then `grant select` | pass | admin 47-48 |
| `publisher_connection` | on | all three, no grant | pass | publication 37-38 |
| `publisher_pairing` | on | all three, no grant | pass | publication 58-59 |
| `publish_receipt` | on | all three, no grant | pass | publication 72-73 |
| `publication` | on | all three, then `grant select` | pass | publication 137-144 |
| `publication_event` | on | all three, then `grant select` | pass | publication 172-174 |
| `member_alias` | on | all three, then `grant select` | pass | publication 191-193 |

### The view

| Object | `security_invoker` | Verdict | Line |
|---|---|---|---|
| `admin_unmatched_publications` | on | pass, and load-bearing | publication 245 |

Without that line the `grant select … to authenticated` on the next line would
hand every signed-in member the full list of unmatched reports, addresses
included, through a view whose name says "admin". A Postgres view runs as its
owner and does not apply the underlying table's RLS by default.

### Functions

| Object | definer | `search_path` | EXECUTE revoked | Verdict | Line |
|---|---|---|---|---|---|
| `handle_new_portal_user` | yes | set | **no** | see finding B | baseline 101-104 |
| `is_portal_admin` | yes | set | public, anon | pass | admin 56-58, 74, 76 |
| `is_portal_owner` | yes | set | public, anon | pass | admin 65-67, 75, 77 |
| `add_portal_admin` | yes | set | public, anon | pass | admin 85-87, 182, 185 |
| `remove_portal_admin` | yes | set | public, anon | pass | admin 104-106, 183, 186 |
| `portal_admin_guard_last` | yes | set | **no** | see finding B | admin 132-134 |
| `transfer_portal_ownership` | yes | set | public, anon | pass | admin 150-152, 184, 187 |
| `publication_claim_for_new_profile` | yes | set | **no** | see finding B | publication 204-206 |

### Triggers

| Object | On | Verdict | Line |
|---|---|---|---|
| `on_auth_user_created` | `auth.users` | pass: gates signup on the allowlist | baseline 124-127 |
| `portal_admin_guard_last_trigger` | `portal_admin` | pass: second door on the last-admin rule | admin 145-148 |
| `publication_claim_trigger` | `profiles` | pass: claims waiting reports at signup | publication 225-228 |

### Policies

| Policy | Table | Action | `with check` | Verdict |
|---|---|---|---|---|
| read own profile | `profiles` | select | n/a | pass: `auth.uid() = id`, so no member can enumerate another |
| update own profile | `profiles` | update | **yes** | pass: question 2 satisfied |
| events readable by signed-in users | `events` | select | n/a | pass: workshop rows are public marketing facts |
| admins read the admin list | `portal_admin` | select | n/a | pass: `is_portal_admin()` |
| read my own reports | `publication` | select | n/a | pass: own matched visible subject rows, or admin |
| admins read the audit trail | `publication_event` | select | n/a | pass |
| admins read aliases | `member_alias` | select | n/a | pass |

Question 6 passes across the schema. `profiles.role` does not exist; it was
removed in the baseline precisely because administrator-ness must not live in a
row its own subject can update. Privilege lives in `portal_admin`, which has no
write policy and no write grant, and every mutation goes through a
security-definer RPC.

Question 7 passes. `member_allowlist` is the table whose contents disclose cohort
membership and it is revoked from all three client roles. `member_alias` and
`publication_event` are admin-gated. `profiles` shows a member only their own
row.

### Finding A: two tables never revoke the default grants

`profiles` revokes `update` from `authenticated` only, and `events` revokes
nothing. Supabase grants `select, insert, update, delete` to `anon` and
`authenticated` on new tables in `public`, so on those two tables **RLS is the
only line**, where the other eight have a grant boundary underneath it.

This is not currently exploitable. `profiles` has no insert or delete policy, so
those are denied by RLS; its update policy is `auth.uid() = id`, which is false
for `anon`; and `events` has no write policy at all. But it is a departure from
the pattern the rest of the schema follows, and defence in depth is the whole
point of that pattern. A one-line follow-up per table would close it. Left for
CDT-01, which owns the next migration, rather than widened into this one.

### Finding B: three functions never revoke EXECUTE from PUBLIC

`handle_new_portal_user`, `portal_admin_guard_last` and
`publication_claim_for_new_profile` are all `security definer` with
`set search_path`, and none of them revokes EXECUTE. Postgres grants EXECUTE to
PUBLIC on every new function, so `anon` and `authenticated` hold it.

None of the three is exploitable today, because Postgres refuses a direct call to
a trigger function with "trigger functions can only be called as triggers"
(SQLSTATE 0A000) before the body ever runs. So this closes a pattern rather than
a hole. It is worth closing anyway: CDT-01 and CDT-02 will copy whatever shape
they find here, and the exemption rests on a Postgres implementation detail
rather than on anything this schema controls.

**Fixed in `supabase/migrations/20260821120000_admin_mfa.sql`**, which is written
and not yet applied.

### A note the next migration author needs

`revoke ... from public` **alone is not enough.** Supabase grants `anon` and
`authenticated` directly, so all three roles have to be named. That mistake has
already shipped once in the sibling project, and `20260817120100_portal_admin.sql`
lines 42-47 record it.

## Two-factor authentication for administration

`supabase/migrations/20260821120000_admin_mfa.sql` puts an `aal2` requirement
inside `is_portal_admin()` and `is_portal_owner()` rather than in each policy,
because there are **six** call sites in shipped SQL: four policies
(`portal_admin.sql:81`, `publication.sql:156`, `:178`, `:197`) and two RPCs
(`portal_admin.sql:90`, `:110`). A rule applied at five of six is worse than no
rule.

The same migration closes the gap that made the helper-level approach incomplete.
`is_portal_owner()` had **no call site anywhere in the schema**, and
`transfer_portal_ownership` checked the owner inline at `portal_admin.sql:160-165`.
So the one RPC that hands the entire site to another account was the single admin
path that did not route through a helper, and adding the clause to the helpers
alone would have left it reachable at `aal1`.

**Ordering is enforced, not just documented.** Applying the requirement before an
administrator can reach `aal2` locks the only administrator out of every admin
read and every admin RPC, including the ones that would add a second
administrator. The migration therefore opens with a `DO` block that refuses to run
unless some `portal_admin` already has a verified MFA factor in
`auth.mfa_factors`. An empty `portal_admin` table also refuses, which is correct.

`scripts/mfa-enrol.mjs` is the enrolment mechanism, kept in the repo rather than
done once by hand, because a second administrator will need it and because there
has to be a way to produce an `aal2` session on demand. **A password sign-in
returns `aal1` even when a verified factor exists**; `aal2` is reached only
through `mfa.challenge()` and `mfa.verify()`, which mint a new session.

What an administrator sitting at `aal1` sees is **nothing**: an empty admin view
and RPCs that refuse. RLS cannot tell them why, because a denial is a silent
filter. A message saying "complete two-factor authentication" is CDT-05's, and
until it exists that empty page is the experience.

## Repo history

The repo is **public** (`gh repo view --json isPrivate`). Scanned in full on
2026-08-21 with `scripts/cdt00-history-scan.mjs`: 31 commits, 224 unique text
blob versions.

**No secret of any tracked shape appears anywhere in the history.** Zero hits for
`sb_secret_`, `sb_publishable_`, a service-role key value, a JWT, a Postgres
connection string, an SMTP or Anthropic or Google key, or a private key block.
Forty *mentions* of `service_role` and `VITE_SUPABASE_*` were found and are
reported separately: they are prose and source code naming the variables, not
values.

Two address-shaped tokens appear, both with the placeholder local part `x@` and
both in the same worked example about near-duplicate domains. The local parts are
not real, but the domain was a partner organisation's, so the example was
generalised to `partner.br` in `docs/PORTAL.md` and `scripts/seed_allowlist.py`.
The history retains the original by design, per the rule below; there is nothing
to rotate, because no credential and no person's address was disclosed.

**A finding is a rotation, never a deletion.** A public repo's history is already
cloned, forked and mirrored. Rewriting it removes the evidence and not the
exposure, and it breaks every clone. If a real key is ever found here, rotate it
and record the rotation in this file.

The scanner is proved rather than trusted: `--self-test` plants a synthetic
address and a fake key on a **local-only** branch in a throwaway git worktree,
confirms both are detected, then deletes the branch and the worktree and reports
how many canary blobs remain reachable. The branch is never pushed, for the same
reason as the rule above: a pushed-then-deleted branch stays retrievable by SHA.
Run on 2026-08-21: both shapes detected, zero canary blobs left.

Addresses are compared to the roster **by hash**, not by grep, because you cannot
grep a history for the hash of a value. The direction is reversed: address-shaped
tokens are pulled out of history and hashed, then compared against a hashed
roster held outside the repo. Pass `--roster <path outside this repo>` to run
that comparison; it was not run on 2026-08-21 because no roster export was
available in the session.

## Honest gaps, as of 2026-08-21

These are not oversights. They are the parts of CDT-00 that could not be done in
the session that wrote the rest, and each one names what unblocks it.

**The portal's Supabase project is not configured on the deployment, and this is
the gap the others hang off.** `gh api repos/joshuafrost712/obt-cdt-site/actions/variables`
returns `total_count: 0`, the `github-pages` environment has none either, and the
deployed bundle contains zero occurrences of `supabase.co`. So `backendEnabled` is
false, `src/App.tsx` does not register `/portal` at all, and the project
reference and publishable key were not available to the session. Consequences:
`connect-src` currently names no Supabase origin, and `csp-hashes.mjs` prints a
loud note saying so on every build. It refuses outright if exactly one of the two
variables is set, because a half-set pair ships a policy that does not match the
bundle. Unblocked by: the project reference and publishable key, then
`docs/PORTAL.md` step 6.

**The Supabase Auth project settings have not been applied.** All of them need
the project: TOTP enrolment enabled, leaked-password protection on, minimum
password length 12, JWT expiry one hour, refresh-token rotation with reuse
detection, email confirmations required, and the redirect allowlist narrowed to
exact paths rather than a wildcard. That last one is done knowingly twice, once
now and again when CDT-DOMAIN moves the host, because an unbounded allowlist in
the meantime is a live open redirect into the auth flow. Auth rate limits are to
be read from the dashboard and recorded here as found, not asserted from this
document. **When these are applied, add a dated table here with the value found
and the value set for each**, because a project setting has no migration and is
therefore the control most likely to be silently reverted.

**The MFA migration is written, reviewed and not applied.** Its safety gate will
refuse until an administrator has enrolled, which is the correct behaviour and
also means it cannot be applied yet. `portal_admin` is empty in any case: the
bootstrap insert in `docs/PORTAL.md` has not been run.

**The four runtime assertions have not been run.** They need the live project.
They are: `member_allowlist` returns a permission error rather than an empty
result to an authenticated client; `profiles` refuses an email update and accepts
a `full_name` update in the same session; a non-admin selecting
`admin_unmatched_publications` gets zero rows; and an admin at `aal1` is refused
where the same account at `aal2` is admitted. Each must declare its expectation
before it runs and assert on state, because a denied read and an empty table are
indistinguishable on the wire.

When the proof-of-failure for the first of those is run, it goes against a
**scratch table** with the identical grant shape, never against
`member_allowlist` itself. Temporarily lifting that table's revocation would
expose the real cohort roster to every authenticated account for as long as the
session held, and permanently if the session died between the grant and the
revoke. On a campaign whose stated value is that participant safety is not
tradeable against convenience, that is not an acceptable test. **No `grant` has
ever been issued on `member_allowlist`.**

**The `/portal` CSP check is vacuous today and is reported as such.** With the
portal unrouted, loading `/portal` renders the NotFound page, so finding zero
violations there proves nothing. `scripts/cdt00-browser-check.mjs --expect-portal`
turns that into a failure, and CDT-04 is the first spec whose check on that route
is real.

## Things that are not this document's job

**The repo is public and this pass did not change that.** It changes source and
history exposure only; the deployed bundle is public either way. Making it
private needs GitHub Pro for Pages.

**No domain and no Cloudflare.** CDT-DOMAIN owns both. The CSP is written so
neither changes it: `connect-src` names the Supabase origin, which does not move
with the host.

**No rate limiting beyond Supabase's project settings.** Without a server there
is nothing else to add, and saying so is more useful than implying a control that
is not there.

**No MFA enrolment UI.** `scripts/mfa-enrol.mjs` is a script for administrators;
the UI is CDT-05's.

## Rules that later specs inherit

**Any spec adding an inline script adds its hash.** `csp-hashes.mjs` fails the
build rather than shipping a broken page, and its failure message names the spec.

**Any spec adding an outbound request is making a decision, not a change.** A new
origin needs a line in this file saying who learns what about whom. A new
*scheme* on an existing host needs one too, which is why `wss:` is listed now.

**No participant name in a URL.** `/portal/a/:assignmentId` uses an opaque id,
never a slug built from a person's name. The same governs email subject lines.

**Storage buckets are private, always.** Short-TTL signed URLs, first path
segment as the boundary, and one honest limit to carry forward rather than
overstate: a MIME allowlist validates the `Content-Type` the uploader declares,
so it stops an accident and not an attacker.

**`supabase/schema.sql` is superseded and must never be run.** It redefines
`handle_new_user` and `on_auth_user_created`, which are the names of Honest Eval's
invite-only gate, and it carried a privilege escalation: its "update own profile"
policy had no `with check`, and Postgres reuses the `using` expression when
`with check` is absent, so any participant could have set `role='admin'`.

**The sign-up form answers the same on success and on refusal.** A form that
answered differently would confirm cohort membership to a stranger.
`src/lib/backend/signinErrors.ts` pins GoTrue's `Database error saving new user`
string, which is what a trigger refusal looks like on the wire. That is a content
rule, not a bug to fix.
