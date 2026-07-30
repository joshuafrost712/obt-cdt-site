# OBT-CDT public website

Public site for the **OBT Consultant Development Track** (OBT-CDT), an
initiative of SIL Global's Consulting Pool.

Live: https://joshuafrost712.github.io/obt-cdt-site/

## Stack

React 19 + TypeScript + Vite + Tailwind CSS v4. Static site, prerendered at
build time (`scripts/prerender.mjs`) so every route is crawlable HTML on
GitHub Pages. Deploys automatically from `main` via GitHub Actions.

Visual identity follows SIL Global's, read off `global.sil.org`: Playfair
Display headings, Lora body, Source Sans 3 interface, SIL's eight-step palette.
All of it lives in the `@theme` block in `src/index.css`. See `docs/STYLE.md`.

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

## Page kinds

Nearly every page is now `"layout": "handbook"`: a photo hero, numbered sections,
and the handbook block vocabulary. Joshua asked for the whole site to look like
the Bali handbook page on 2026-07-29. See `docs/HANDBOOK.md`, including the rule
that the contents rail and progress bar only appear from four sections up, so a
300-word page does not get scaffolding it has no use for.

- `"layout": "handbook"` renders the page with the participant-handbook shell.
  The generic `ContentPage` (header band plus an undifferentiated block stream) is
  still there as the fallback for a page that does not opt in, but nothing uses
  it today.
- `"hidden": true` makes a page **unlisted**: still prerendered and reachable by
  link, but absent from the top nav and `sitemap.xml`, and served with
  `noindex, nofollow`.

The home page and `/workshops` are the two exceptions, because each has a job the
handbook layout cannot do. Home is the scroll-driven roundabout essay; the
workshops index generates its cards from the workshops list rather than from
content blocks. Both wear the handbook photo hero and nothing else of it.

The roundabout essay is responsive in kind, not just in size (2026-07-30). On
`lg+` the full diagram sits sticky beside the scenes and advances with scroll
(growing to 500px at `xl`); without JS it stays at its faint stage-0 state.
Below `lg` there is no scroll-linked diagram at all: each scene carries a static
`SceneFigure` under (phone) or beside (tablet) its text, cropped to the part of
the figure that scene is about, with the five thread names as an HTML legend on
the circulating scene. Those instances prerender at the correct stage, so
no-JS readers and print get the right picture per scene.

Unlisted is not private. **This repo is public**, so hidden-page copy is
readable in `site-content.json` on github.com and in the history regardless.
Treat `hidden` as "don't index, don't advertise", never as access control.

One page is unlisted: `/general-travel-advice`, the generic pre-flight and
departure checks that came out of the Bali handbook on 2026-07-28. It is linked
from the workshop travel section and from nowhere else, deliberately: it is a
reference for the few who want it, not a claim the track has anything original
to say about airport queues.

The Bali 2026 handbook used to be unlisted too; on 2026-07-28 it was merged into
the Psalms workshop page at Joshua's request, so `/workshops/psalms-bali-2026` is
now both the public workshop page and the participant handbook, and it is
indexed.

Retired routes are declared in `redirects()` in `src/lib/content/loader.ts`. The
prerender writes a real meta-refresh page for each (`scripts/prerender.mjs`) and
`App.tsx` maps the same URLs for client-side navigation, so
`/workshops/psalms-bali-2026/handbook` still works for anyone who has the link
from an email. Add to that map rather than deleting a URL outright.

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
- **Named exception: facilitator credits.** The Psalms page lists the four people
  running the workshop by name, with role and professional qualification, at
  Joshua's explicit direction (2026-07-28) and on an indexed page. Participants
  are still aggregate-only. Do not "fix" the facilitator block back out; if it
  needs to change, that is Joshua's call.
- No identification of partner organizations or projects in sensitive
  contexts.
- Images follow `docs/MEDIA.md` and, behind it,
  `_Meta/Visual-Media-Protocol.md` in Joshua's vault.
- The accounts backend (sign-in, event sign-up, evaluations, certificates) is
  built behind feature flags and appears only once Supabase is provisioned:
  see `docs/PHASE-2-BACKEND.md` for the 5-step activation.

## Voice & anti-AI

All body/marketing copy on the site must read as human-written. When editing
`site-content.json` (directly or by applying a feedback batch), run this
checklist. It does not apply to UI micro-copy (nav labels, buttons, form
labels), only to sentences and paragraphs a reader reads.

**Structure is part of this, not just sentences.** A reader identified the
handbook as AI-generated from its shape before its prose: 21 top-level sections
and a highlighted callout in every one. So:

- **No more than about five to seven top-level sections.** Past that, nest.
  People do not naturally divide a document into twenty parts, because they
  cannot hold twenty in working memory. The 21-section handbook became five
  sections with subsections on 2026-07-28.
- **A highlighting device only works while it is rare.** Ticked checklists,
  callout panels, badges, bold runs, pull quotes. Twenty-one callouts taught the
  reader to skip all of them. Ticks now belong only to lists a participant works
  through; everything else is a plain `list`. Consolidate "still to be confirmed"
  notes to one per section.
- **Say a thing once.** Three descriptions of the same two weeks in three
  different formats is the same failure as three paragraphs of filler.

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
