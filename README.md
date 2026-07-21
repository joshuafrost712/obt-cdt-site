# OBT-CDT public website

Public site for the **OBT Consultant Development Track** (OBT-CDT), an
initiative of SIL Global's Consulting Pool.

Live: https://joshuafrost712.github.io/obt-cdt-site/

## Stack

React 19 + TypeScript + Vite + Tailwind CSS v4. Static site, prerendered at
build time (`scripts/prerender.mjs`) so every route is crawlable HTML on
GitHub Pages. Deploys automatically from `main` via GitHub Actions.

## Editing content

All user-visible copy lives in **`src/content/site-content.json`** as nodes
with stable ids. Components never hardcode text, so editing a node updates
every place it appears (page heading, nav label, browser title).

Two ways to edit:

1. **Edit the JSON directly** (or ask Claude to).
2. **Edit in place**: run `npm run dev`, highlight any text on the page, click
   "✎ Edit text". The dev server patches the JSON on disk and the page
   hot-reloads. On the deployed site, open it once with `?dev=1` to enable the
   same tools; edits made there are recorded as suggestions in the feedback
   batch (the deployed site can't write to the repo).

Feedback: highlight text → "💬 Comment" → rank → "Send batch to Claude". In dev
the batch lands in `feedback/incoming/`; deployed, it posts to the Apps Script
sink (`VITE_FEEDBACK_URL` repo variable) or downloads as a file. See
`feedback/README.md` for how batches are handled.

Images: every image is a manifest-keyed slot; see `docs/MEDIA.md`.

## Development

```bash
npm install
npm run dev       # dev server with edit-in-place + feedback inbox
npm run build     # client build + SSR build + prerender (dist/)
npm run preview   # serve the built site
```

## Content rules

- No participant names, emails, or other personal data anywhere on the site.
  Aggregate figures only.
- No identification of partner organizations or projects in sensitive
  contexts.
- Phase 2 (accounts, event sign-up, evaluations, certificates) is designed but
  not built: see `docs/PHASE-2-BACKEND.md`.
