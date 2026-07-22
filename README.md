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

**Developer version (for reviewers):** open
https://joshuafrost712.github.io/obt-cdt-site/dev/ once on any device. It
switches the review tools on for that device (highlight → comment / edit
text) and drops you on the home page. `?dev=0` turns them off again. Text
edits made on the deployed site can't write to the repo, so they are captured
old→new in the feedback batch for Claude to apply.

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
- The accounts backend (sign-in, event sign-up, evaluations, certificates) is
  built behind feature flags and appears only once Supabase is provisioned:
  see `docs/PHASE-2-BACKEND.md` for the 5-step activation.

## Voice & anti-AI

All body/marketing copy on the site must read as human-written. When editing
`site-content.json` (directly or by applying a feedback batch), run this
checklist. It does not apply to UI micro-copy (nav labels, buttons, form
labels), only to sentences and paragraphs a reader reads.

- **No AI vocabulary.** Drive these to zero: leverage, delve, foster,
  underscore, harness, streamline, robust, seamless, pivotal, crucial,
  tapestry, landscape (figurative), realm, journey (figurative),
  transformative, unwavering, myriad, "in conclusion," "in summary," "at its
  core," "it's important to note," "not only… but also," "paving the way for,"
  "valuable insights," "dive into," "unpack." Use the plain word instead (use,
  look at, build, show, smooth, solid, key).
- **No AI constructions.** No negative parallelism ("it's not X, it's Y" — say
  Y). No rule-of-three lists ("faithful, scalable, and sustainable" — keep the
  strongest). No copula dodges ("serves as" / "stands as" → "is"). No hedge
  stacks. No signposted conclusions or recap endings. No bold-first bullets
  (`**Thing:** …`) or Title Case colon headings.
- **Ground it.** Open sections on something concrete a reader can picture (a
  place, a number, a named practice), not "In a world where…".
- **Vary the rhythm.** Uneven sentence and paragraph lengths; not a uniform wall
  of 18-word sentences.
- **Never invent facts** (figures, names, quotes) to sound specific. Aggregate
  figures only, per the content rules above.

This mirrors the vault's `_Meta/About Me/anti-ai-conventions.md`; that file is
the source of truth if the two ever drift.
