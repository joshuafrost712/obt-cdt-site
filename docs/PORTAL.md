# The member portal

Where OBT-CDT participants read the evaluation reports that were sent to them.

Phase 1 is deliberately small: sign in, see your reports, read one. The longer
arc is that the email becomes a summary and this becomes where the report is
actually read.

## Two projects, and why

Honest Eval (repo `cairn`, Supabase project `vdbirmjvjzfdgajwgowj`) is being
built as a product for SIL and other organizations broadly. It cannot also be
this website's database, so the portal has its own project. Reports cross a
signed one-way boundary; nothing reaches back.

The cost of the split is a contract to maintain and a key to rotate. What it
buys is that an organization using Honest Eval is not thereby a tenant of the
OBT-CDT website, and that the two can be handed to different administrators —
which is the actual plan.

**What crosses is deliberately small:** the frozen markdown that was already
emailed, the recipient's address, a workshop slug, and the ids needed for
idempotency and supersede. **No observations, no evidence, no designations, no
verdicts, no evaluator identities, and no Honest Eval UUIDs.** The working
assessment record stays in the system that owns it. Widening this later should
be a deliberate, versioned decision — the envelope carries a `schema` string so
it can be — not a convenient extra column.

Workshops join on a slug, not a UUID. A workshop in Honest Eval carries an
`external_key` equal to one of this project's `events.id` values
(`psalms-bali-2026`, `crash-course-bali-2026`, `epistles-chiang-mai-2025`,
`narrative-bangalore-2025`). Neither system learns the other's identifier space.

## Schema

`supabase/migrations/` is the source of truth, applied with the Supabase CLI.
**`supabase/schema.sql` is superseded and must not be run** — its own header
explains the two reasons, one of which would damage the Honest Eval project if
it were ever pasted into the wrong SQL editor.

| Table | Holds |
|---|---|
| `profiles` | one per account; `email` is mirrored from auth and is not self-writable |
| `member_allowlist` | who may create an account at all |
| `portal_admin` | who administers this site; transferable |
| `events` | the workshops, ids matching `site-content.json` node ids |
| `publication` | one report as sent to one address |
| `publication_event` | append-only audit trail |
| `member_alias` | a second address for a member |
| `publisher_connection` / `publisher_pairing` / `publish_receipt` | the Honest Eval link |

### Five decisions worth not re-deriving

**`profiles` has no `role` column.** The original design had one, with an UPDATE
policy of `using (auth.uid() = id)` and no `WITH CHECK`. Postgres reuses the
USING expression when WITH CHECK is absent, and the row still satisfies it after
`role` changes — so any signed-in participant could have made themselves an
admin. Administrator-ness lives in `portal_admin`, which its subject cannot
write.

**`profiles.email` is protected by a column grant, not a policy.** RLS cannot
restrict columns. `revoke update ... ; grant update (full_name, org)` is what
actually stops a member editing the address their reports match on — and a member
who could edit it could claim another person's unmatched reports.

**The signup trigger refuses strangers, and the form does not say so.**
`handle_new_portal_user` raises for an address absent from `member_allowlist`,
which rolls back the `auth.users` insert. GoTrue swallows the sentence and
returns `Database error saving new user`; `src/lib/backend/signinErrors.ts`
translates it and pins that string, because it is a fact about someone else's
service. The form then shows the **same** message on success and on refusal: the
site's standing content rule is that participation is not public, so a form that
answers "yes, that person is in the cohort" is a disclosure dressed as a
validation message. The uniform copy still tells a genuinely unlisted person what
to do, so nobody is stranded.

**`admin_unmatched_publications` sets `security_invoker = on`.** A Postgres view
runs as its owner by default and does *not* apply the underlying table's RLS.
Without that line the grant would have handed every signed-in member the full
list of unmatched reports, addresses included, through a view whose name says
"admin".

**Nothing is ever deleted.** A superseded report keeps its row and gains a
pointer; a withdrawn one keeps its row and changes visibility. "Was this ever
shown to them, and when?" has to stay answerable afterwards.

## Administrators, and handing this off

`portal_admin` is a table with a partial unique index making "exactly one owner"
a database fact. The last administrator cannot be removed, enforced twice: once
in `remove_portal_admin()`, which is the door a person uses, and once in a
`before delete` trigger, which is the door a service-role script uses. Only one
of those gets reviewed.

`transfer_portal_ownership()` requires the target to already be an administrator,
so a mistyped id fails closed rather than handing the site to a stranger, and it
locks the owner row first so two races cannot both clear it.

**Bootstrap is one statement, run once.** Sign up through the portal, then:

```sql
insert into portal_admin (profile_id, is_owner)
select id, true from profiles where lower(email) = lower('<address>');
```

A one-time `claim-ownership` endpoint was considered and rejected: a public
endpoint, a secret to rotate, and a mechanism to disarm, all to replace a
statement run once. Everything after the first administrator — which is the part
that has to be self-service — goes through the RPCs.

Because the whole Supabase account for this project is intended to belong to
OBT-CDT rather than to an individual, the handoff is the account plus the owner
transfer, not a developer.

## Provisioning runbook

1. Create the project in the OBT-CDT Supabase account.
2. `supabase link` and `supabase db push`.
3. Seed `member_allowlist` with `scripts/seed_allowlist.py` (see below).
4. **Configure custom SMTP before inviting anyone.** The built-in mailer allows
   about two emails an hour and password resets share the budget; ~46 people
   self-registering will meet it. Brevo is already in use for the genre app.
5. Set the auth Redirect URLs to the portal path — an exact path, not a `/**`
   wildcard on the site origin.
6. Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` as repo Actions
   **variables** (not secrets). The workflow already passes them; see
   `.env.example` for the shape.
7. Redeploy. `/portal` and the nav entry appear; with the variables unset the
   site builds exactly as before.

Do step 5 after the non-GitHub domain is live, or it gets done twice.

### Seeding the allowlist

`scripts/seed_allowlist.py` reads the sign-up workbook and upserts
`member_allowlist`. Export the sheet somewhere outside this repo first
(`rclone backend copyid gdrive: <sheet-id> /tmp/signup.xlsx`), run it with no
flags to see what it would write, then re-run with `--apply`. It masks addresses
unless you pass `--show`, and **no participant address is ever written into this
repository** — the site's standing rule is aggregates only.

**It takes the union of every roster tab, not just Master.** The allowlist
decides one thing: who may create an account at all. It is not an authorization
boundary for content, because RLS is. So including someone who never attends
costs a dormant row, while excluding someone who did attend costs a person who
cannot reach their own report. As of the 2026-08-17 export that is **41 distinct
addresses** across Master (39), the legacy eligible list (28), Chiang Mai (23),
Psalms 2026 (23), and Hebrew Training (12). Master alone would have missed two.

The script **refuses to run against a workbook whose shape has changed** rather
than seeding what it can find. A renamed tab would otherwise drop a whole cohort
and still report success.

It also flags **near-duplicate addresses** — same local part, different domain,
`+tags` and gmail dots ignored. That is the failure that actually bites: a report
published to `x@partner.br` when the profile registered `x@partner.com.br` does not
error, it lands in the unmatched queue looking like a stranger. The current
export has exactly one such pair. Each one found is a candidate `member_alias`
row.

**Pre-creating attendee accounts is not done, and probably should not be.** The
plan called for it, but an account with no password is a state a participant
cannot use: they still have to run "forgot password" to get in, which is the same
one email as self-registering, plus a confusing intermediate. The reason to
pre-create was so reports match on arrival — and
`publication_claim_for_new_profile()` already promotes waiting rows the moment
someone signs up, so unmatched-then-matched is a designed path, not a failure.
Allowlist everyone; let them register.

### Two notes on the keys

**The portal uses Supabase's new key format.** The dashboard now issues
`sb_publishable_...` and calls the old `anon` JWT legacy, so an administrator
looking for the word "anon" in 2027 will not find it. `config.ts` accepts
`VITE_SUPABASE_PUBLISHABLE_KEY` and falls back to `VITE_SUPABASE_ANON_KEY`, so
either generation works and an old variable cannot silently switch the portal
off. The matching secret key is `sb_secret_...`, which replaces `service_role`;
it never enters this repo, CI, or a browser.

**No deploy reviewer gate, deliberately.** An earlier draft of this runbook
suggested a `production` environment with a required reviewer, on the reasoning
that this repo auto-deploys every content round. That reasoning was wrong: the
build job receives only the project URL and the publishable key, both of which a
visitor's browser already holds. A reviewer would gate every content round and
protect nothing. It becomes worth revisiting only if CI is ever given a key that
outranks `anon` — which it should not be.

## The CBC seam

Honest Eval's `src/reports/cbcExport.ts` already emits a versioned interchange
envelope and says the adapter waits on CBC's import format. That stays there.
When the format is known, the portal side is one security-definer function
returning that shape for the caller's own publications, plus a button. Do not add
a `cbc_export_state` column before then — it would be a guess about a schema that
does not exist.

## Not built yet

- The pairing endpoints, the ingest function, and the outbox on the Honest Eval
  side. The tables they write are here; the functions are not.
- The admin screens: the unmatched queue, aliases, allowlist, and the historical
  import used to backfill the Epistles reports, which predate Honest Eval and so
  cannot arrive over the signed path. Those rows carry `source = 'manual'` and an
  importer, because a report an administrator typed in must never be
  indistinguishable from one Honest Eval signed.
- The email-becomes-a-summary change, which must wait until this is live or the
  link goes nowhere.
- The richer reading experience. Note that it needs structure the v1 envelope
  does not carry, so it opens with a decision about how much crosses.
