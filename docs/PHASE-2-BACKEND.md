> **Superseded for provisioning.** The portal was built on its own Supabase
> project with a reports-only schema in `supabase/migrations/`. See
> **[PORTAL.md](./PORTAL.md)** for the current architecture and runbook.
>
> The activation steps below are wrong and step 2 is dangerous: it says to run
> `supabase/schema.sql`, which carries a privilege escalation and redefines
> `handle_new_user` / `on_auth_user_created` — the names of Honest Eval's
> invite-only auth gate. Do not run it. The design memo that follows is kept
> because it records why the accounts backend is shaped the way it is.

# Phase 2: accounts backend

**Status (2026-07-21): BUILT, behind flags, awaiting provisioning.** The
participant area (sign-in, profile, evaluations, event sign-up, PDF
certificates) ships in the repo but activates only when a Supabase project
exists and its env vars are set. Until then the site builds fully static and
none of it appears.

## Provisioning steps (when ready to go live)

1. Create a Supabase project (free tier is fine). Auth → providers: leave
   Email enabled; magic links are the only sign-in method used.
2. SQL editor → run `supabase/schema.sql` (idempotent; creates tables, RLS,
   the profile trigger, and seeds the three workshop events).
3. Auth → URL configuration: set the site URL to
   `https://joshuafrost712.github.io/obt-cdt-site/` and add it to redirect
   URLs (plus `http://localhost:5173` for dev).
4. Repo → Settings → Secrets and variables → Actions → **Variables**: add
   `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` (both are public client
   values, not secrets). Re-run the deploy workflow.
5. The "My Account" nav entry and the `/account`, `/events`, `/certificates`
   routes appear on the next deploy. For local dev, put the same two vars in
   `.env.local`.

Evaluations and certificates are written via the Supabase dashboard or the
workshop-evaluation pipeline (service role), never by participants.

## Original design memo

The MVP is a fully static site. Phase 2 adds user accounts so participants can
sign up for events, view the evaluations they received, and print PDF
completion certificates. This memo records the intended architecture so
nothing in the MVP paints us into a corner.

## Principles

- The static site stays static. Phase 2 adds client-side Supabase calls from
  new, auth-gated routes; the marketing pages never depend on the backend.
- Auth-gated routes are **excluded from prerender** (they render client-side
  only). The prerender script walks `allRoutes()` from the content store, so
  simply not adding backend routes there is sufficient.
- Reserved routes (do not reuse for content pages): `/account`, `/events`,
  `/certificates`.

## Supabase sketch

One Supabase project. Email magic-link auth (participants are a small, known
population; no passwords to support). Roles via `profiles.role`:
`participant | mentor | admin`.

Tables:

- `profiles` — user id, name, org (free text), role.
- `events` — workshops and trainings: title, location, start/end, capacity,
  status. At runtime this supersedes the JSON `facts` as the source of truth
  for availability; the JSON keeps the marketing copy.
- `registrations` — profile × event, status (registered/waitlist/attended).
- `ksas` — stable registry of competency sub-points. **Keep ids stable in
  site-content.json** (e.g. rubric/thread ids) so they can become foreign keys.
- `evaluations` — participant_id, ksa_id, score (0–3), evaluator name,
  evidence note, occasion (event id). Mirrors the CBC evidence flow described
  on the public Method page.
- `certificates` — participant_id, event_id, issued_at, template version.

Row-level security:

- Participants read only their own `registrations`, `evaluations`,
  `certificates`.
- Mentors read their mentees' rows (mentor↔mentee mapping table).
- Writes are mentor/admin only; evaluation writes come from the existing
  workshop-evaluation pipeline, not from participants.

## Certificates

Client-side PDF generation with `pdfmake` (already proven in
genre-research-app's export and in Throughline). A `certificates` row is the
issuance record; the PDF is rendered on demand from it, so nothing large is
stored.

## Throughline integration

Throughline (the participant-evaluation PWA, repo `cairn`) uses Supabase and
the same 0–3 CBC rubric. When Phase 2 starts, decide between:

1. **Shared Supabase project/schema** — Throughline writes evaluations, this
   site reads them. Simplest data path; couples deployments.
2. **Export/import** keyed on a shared person id + the shared `ksas` registry.
   Looser coupling; needs a sync step.

Either way, the stable-ids rule above is the prerequisite.

## Build notes for whoever implements this

- Env vars follow the existing pattern: `VITE_SUPABASE_URL` and
  `VITE_SUPABASE_ANON_KEY` as repo Actions variables; the app builds with the
  backend disabled when they are unset (feature-flag pattern, as in
  Throughline).
- The devfeedback module must stay lazy/client-only (see
  `src/components/layout/DevFeedbackMount.tsx`); apply the same pattern to any
  Supabase client module so the prerender build never touches it.
- Never render personal data into prerendered HTML.
