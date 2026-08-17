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
3. Seed `member_allowlist` from the sign-up sheet (Master tab, keyed on lowercased
   Primary Email) and pre-create the Psalms and Crash Course attendee accounts.
4. **Configure custom SMTP before inviting anyone.** The built-in mailer allows
   about two emails an hour and password resets share the budget; ~46 people
   self-registering will meet it. Brevo is already in use for the genre app.
5. Set the auth Redirect URLs to the portal path — an exact path, not a `/**`
   wildcard on the site origin.
6. Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` as Actions variables
   **and add them to `.github/workflows/deploy.yml`'s `env:` block**; they are not
   passed today, so this is a workflow edit, not just a variable. Consider a
   `production` environment with a required reviewer: this repo auto-deploys
   every content round, and that pipeline would then sit in front of the portal
   database.
7. Redeploy. `/portal` and the nav entry appear; with the variables unset the
   site builds exactly as before.

Do step 5 after the non-GitHub domain is live, or it gets done twice.

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
