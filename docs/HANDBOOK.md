# Participant handbooks, and the layout the whole site now uses

A handbook is a per-workshop reference document for confirmed participants:
dates, venue, travel, visas, packing, prework, contacts. The first one is
**Bali 2026**, and it is part of the Psalms workshop page at
`/workshops/psalms-bali-2026`.

This layout used to be the exception. On 2026-07-29 Joshua asked for the whole
site to look like it, so it is now the default: `HandbookLayout` renders
Philosophy, Method, The Five Threads, Get Involved and General travel advice as
well as the Bali handbook, and the two completed workshops plus the workshops
index borrow its hero. `ContentPage` survives as the fallback for a page that
does not opt in, and nothing currently uses it.

What carries the look is the photo hero, the numbered section chips and the
block vocabulary below. What does **not** travel to every page is the
wayfinding.

## Wayfinding appears from four sections up

The rail, the reading-progress bar and the `sectionNav` contents grid are
navigation aids for a document too long to hold in your head. Bali 2026 is 3,700
words over six sections and needs all three. The marketing pages are 280 to 560
words over two to four sections, and a sticky contents rail beside three headings
is scaffolding around nothing. That is the same over-signposting this document was
cut back for the day before (see "Five sections, not twenty-one" below).

So `HandbookLayout` gates all three on `sections.length >= 4`. Below that the
sections read straight down a full-width column. Today only Bali (6) and Method
(4) clear the bar. If you add a fifth section to a page, give it a `sectionNav`
block too, or the mobile jump grid will be missing.

## Marketing blocks inside a handbook section

`prose`, `quote`, `statRow`, `cardGrid`, `rubricScale` and `imageSlot` used to
own their own column wrapper and render titles as `h2`, which double-wrapped and
clashed with the section heading when nested. They now take the same `nested`
flag the handbook leaf blocks do; `Frame`, `Heading` and `Kicker` in
`BlockRenderer` are where that decision lives.

Two traps that cost a round of fixes:

- **A nested block drops its kicker.** One heading line per leaf block, for the
  reason given in `HandbookBlocks`.
- **Card heading level depends on the grid above it.** A page conversion often
  promotes a grid's title onto its section and leaves the grid title-less, so the
  cards sit directly under the section's `h2` and must be `h3`. `cardLevel()`
  decides this; hardcoding `h4` for anything nested skipped a heading level on
  /threads and /get-involved.

It is a different kind of page from the marketing copy it now also carries. The
marketing pages argue a case; a handbook answers questions, in a hurry, on a
phone, sometimes on airport Wi-Fi, and often on paper. That is what the layout
and the block types below are shaped for.

## One page, not two

The handbook used to be a separate unlisted page at
`/workshops/psalms-bali-2026/handbook`. On 2026-07-28 Joshua asked for the two to
be merged: "just merge the handbook page with this page. It should tell people
that it is fully booked and then give the rest of the information down beneath."

So a **workshop** can now carry `"layout": "handbook"`, exactly as a page can.
`WorkshopPage` sees that and delegates to `HandbookLayout`, which sorts the
block list into three zones:

| Zone | What it is | On the Psalms page |
| --- | --- | --- |
| intro | blocks before the first `handbookSection` | the fully-booked notice, the vision prose, one photo |
| sections | the `handbookSection` blocks, with the rail and progress bar | the six handbook sections |
| outro | blocks after the last `handbookSection` | the "Missed this one?" call to action |

The workshop's own header (kicker, title, facts panel) is not rendered in this
mode; the handbook hero replaces it and shows the `StatusBadge` from
`facts.status` instead, so the page still says "Fully booked" at the top.

The old URL keeps working. `redirects()` in `src/lib/content/loader.ts` maps it to
the merged page; the prerender writes a meta-refresh page and `App.tsx` handles
client-side navigation to it.

## Unlisted, not private

The merged page is **indexed**, because it is also the public page for the
workshop. That was a deliberate call: it publishes the facilitators' names,
roles and qualifications, the venue address, and the read-only Exegetical Guide
link. See the named exception in `README.md` under Content rules.

`"hidden": true` still exists for pages and now also for workshops, and still
means no nav entry, no `sitemap.xml` entry, and `noindex, nofollow` in the head.

**This repo is public.** Unlisted controls search engines and site navigation,
nothing more. Every word of handbook copy is readable in `site-content.json` on
github.com and in the commit history. Do not put anything in a handbook that
would be a problem world-readable.

### Deliberately absent: the registration form link

The registration and travel form is **not** linked from the handbook, by decision
(2026-07-28). An open Google Form on a URL that anyone can reach collects junk
submissions, and the form is the one link here that writes data rather than
reads it. The travel section tells participants the link came by email and to
write to Josh if they lost it. Do not add it back as a convenience.

The Exegetical Guide link is fine to keep: it is read-only and already
circulated to the cohort.

## Six sections, not twenty-one

The handbook shipped with 21 top-level sections. A reviewer read that as a sign
the document had been machine-generated, and he was right about the cause:
nobody divides a document into 21 parts on purpose. On 2026-07-28 it became five,
each holding the old sections as subsections. A sixth arrived on 2026-07-31.

| Section | Absorbs |
| --- | --- |
| 01 Welcome to Workshop 3 | old 01 welcome, 06 learning outcomes, 07 facilitators |
| 02 Dates and programme | 02 dates, 04 how the weeks build, 05 programme |
| 03 Your preparation | 17 prework, 18 documents |
| 04 Travel, visas and packing | 08 travel, 09 transfers, 10 before you fly, 11 entry, 12 packing, 20 departure |
| 05 Life on the base | 03 location, 13 venue, 14 meals, 15 Wi-Fi, 16 laundry, 21 free time, 19 health |
| 06 Cost and financial support | new on 2026-07-31; nothing folded in |

Section 06 is a real addition rather than a regression toward twenty-one. Until
2026-07-31 the site said nothing about what a workshop costs, while the two
public description docs said there was no registration fee and Josh was quoting
$150 and $250 privately to whoever asked. Cost is a top-level question a
participant arrives with, so it gets a top-level section and a contents entry
rather than a paragraph buried in "Life on the base".

On 2026-08-03 the section changed position rather than shape: Bali is not being
charged after all, so the figures are a **recommended contribution** and the
section also carries the change coming to later workshops. Do not quietly
promote those figures back into a fee. The distinction is the whole point of the
section, and the participants most likely to over-read a number as a bill are
the ones whose organisations have nothing.

It sits last, not after 02 where a reader might look for it first, because
inserting it there would renumber sections 03 through 05 and break the anchors
participants already hold in email. Given the choice between the tidier position
and links that keep resolving, the links win.

`bali.20.thanks`, the closing cyan note, moved from the end of 05 to the end of
06 so that it is still the last thing on the page and the document does not end
on money. It carries no anchor, so nothing needed rehoming.

**Every one of the 21 old anchors still resolves.** Section anchors are
`s01-welcome` through `s06-cost`; the other 20 (`s08-travel`, `s16-laundry`, and
so on) live on the subsection, checklist, glanceGrid or linkGrid they were folded
into. Participants have those fragment links in email. Keep them working: the
`anchor` field renders as an `id` on all of those block types.

Two of them moved on 2026-07-28 when their content left the page.
`s10-before-you-fly` now sits on the card linking to General travel advice, and
`s20-departure` on "Closing well". When you delete a block, check whether it was
carrying an anchor and rehome it on whatever now stands in that place.

The facilitator credits moved out of section 03 into 01 later the same day, on
the reading that who you will be working with is orientation rather than prework
(feedback, 2026-07-28). `s07-team` travelled with the block, so the link still
resolves; that is the pattern to follow when a block changes section.

`TitleSync` in `App.tsx` scrolls to the top on navigation and **must** keep its
hash guard. Without it, the browser's own jump to the fragment is undone the
moment React hydrates, and every one of those emailed links lands the reader at
the top of a twenty-page document.

## Where the copy lives

One workshop node in `src/content/site-content.json`, `id: "psalms-bali-2026"`,
with `"layout": "handbook"`. Its `blocks` array is:

1. one `hero` (with `mediaId` for the full-bleed photo, and `labelToken` items
   for the date chips)
2. the intro blocks, ordinary page blocks like `prose` and `imageSlot`
3. one `sectionNav` (the contents grid, six entries)
4. six `handbookSection` blocks
5. the outro `ctaGroup`

## The revision line, and the mirror rule

The hero takes an optional `note`, and on a handbook that is the revision line:

```jsonc
"note": "Last updated 17 August 2026 · weekend meals, laundry, blankets, and visa guidance. Where an older email disagrees with this page, the page is right."
```

Participants were told on 2026-08-03 that this page supersedes the logistics
emails. That promise only works if a reader can date the page. Without the line, a
participant who got the 14 August blanket notice has no way to tell whether what
they are reading was written before or after it, so the safe move is to distrust
the page and re-read the inbox, which is the failure the page existed to end.

**Any content change to a handbook bumps the line in the same commit.** The date
is the day the change ships, and the clause after the dot names what moved, in a
handful of words, so the line answers "is the thing I heard about in here yet?"
Do not list every edit; name the ones a participant would go looking for.

The rule behind it is not a site rule. Logistics facts reach participants by email
and WhatsApp first, and the page goes stale unless mirroring is a standing
obligation rather than a good intention. That obligation, the question set a new
venue has to answer, and the discretion screen for what may go on a public page
live in the vault at `_Meta/Workshop-Logistics-Protocol.md`, with the `/logistics-update`
skill as the mechanism. Read it before a logistics round; this file only governs
how the copy is shaped once it arrives.

## Adding or editing a section

```jsonc
{
  "id": "bali.s5",
  "type": "handbookSection",
  "number": "05",                    // chip, and the rail's numbering
  "anchor": "s05-base",              // fragment id; keep it stable, people link to it
  "kicker": "While you are there",
  "title": "Life on the base",
  "body": "Paragraphs separated by blank lines. **bold** works.",
  "mediaId": "bali-location",        // optional photo band
  "caption": "Caption under the band.",
  "variant": "plain",                // optional: skip the duotone wash
  "items": [ /* child blocks */ ]
}
```

Then update the matching `sectionNav` item (`number`, `anchor`, `label`). The
desktop rail is generated from the sections themselves, so it needs nothing.

## The handbook block types

All of these are valid as children of a `handbookSection`. They are written
container-free, and `BlockRenderer` adds the standard column wrapper if one is
used at the top level of an ordinary page. All of them accept `anchor`.

| Type | What it is | Fields it uses |
| --- | --- | --- |
| `subsection` | A headed paragraph inside a section | `title`, `body` |
| `callout` | Status panel | `variant`, `label`, `title`, `body` |
| `checklist` | Ticked cards, two columns | `title`, `body`, `items[].label`, `items[].body` |
| `list` | A quiet bulleted list, or numbered with `variant: "numbered"` | as `checklist`, with `listItem` children |
| `glanceGrid` | Cards, a fact table with `variant: "rows"`, or a credits table with `variant: "people"` | `items[].kicker`, `.value`, `.label`, `.body` |
| `timeline` | A dated spine: one line through a sequence of days | same item fields as `glanceGrid` |
| `scheduleTable` | A real timetable: days as row groups, times down the left | `title`, `body`, `note`, `items[]` of `scheduleDay` (`label`, `value`) each holding `scheduleRow` items (`label`, `value`, `body`, `variant`) |
| `linkGrid` | Resource cards | `items[].label`, `.href` or `.route`, `.body`, `.note` |

**No leaf block takes a `kicker`.** Only `handbookSection` and `sectionNav` do,
because there the small-caps eyebrow introduces an h2 and reads as furniture over
a title. Over a leaf block's xl h3 it reads as a heading level that is somehow
smaller than the headings beneath it, which is exactly how a reviewer read it on
2026-07-28. Every leaf block gets one heading line. If you find yourself wanting
a kicker to say what the title doesn't, write a better title: `bali.15.list` went
from "Staying online" over "Plan for less bandwidth than you have at home" to
that title with the old one as its body.

`timeline` reads exactly the item fields a `glanceGrid` does, so a dated card
grid becomes a spine by changing one `type` and renaming nothing. Inside a
handbook section `BlockRenderer` picks the handbook version; at the top level of
a marketing page the original essay timeline still renders. The trip dates have
been a spine since 2026-07-28; a comment asking for a timeline that arrived after
that was written against a cached render.

`scheduleTable` and `timeline` answer two different questions about the same
week and a section can carry both. The spine says what a day is for; the table
says when to be in the room. Section 03 of the Crash Course handbook does both,
added 2026-08-18 because a participant standing in the corridor at 11:20 needs
the clock, not the theme. A row with `variant: "break"` is a devotion, a snack,
a meal or the end-of-day line: still listed, because somebody is planning a
phone call around it, but set back so the teaching and the team work are what
the eye finds first. Times live only in the content file, so a schedule change
is one edit and no code.

A `linkGrid` item with `route` (rather than `href`) goes through react-router.
The site is served from a base path on Pages, so a raw `<a href="/x">` would drop
it and 404.

A hero `labelToken` with a `route` renders as a link pill rather than a static
one: brighter border, an arrow, and react-router for the same base-path reason.
Added 2026-08-18 so the Psalms date band can send a Crash Course participant to
the Crash Course handbook from the top of the page, which is where a reader
already looks to work out which week they are here for. Use it sparingly. A date
band of four facts and three links is a nav bar, not a date band.

`variant: "people"` on a `glanceGrid` renders the rows table with the left column
as a person's name in the display face rather than a small-caps field label, so
the row reads name, then role, then qualification.

### Callout variants

- `action-required` — orange, with a slow pulse on the chip. Something the reader
  must do, with a deadline behind it. There are four: dates, flights, visa,
  dietary needs. Do not add a fifth without removing one.
- `coming-soon` — muted. A detail that is genuinely not settled yet. **At most
  one per section, consolidated, and only where something really is outstanding.**
  Eleven of these across the document was the single biggest source of panel
  fatigue; two remain.
- `note` — SIL blue. Context worth knowing. Two, and both are load-bearing.
- `thanks` — cyan. The closing note. One, at the very end. It lives at the end of
  the last section, so it travels when a new last section is added.

The default chip text comes from the variant; `label` overrides it.

## Highlighting discipline

Counts as of 2026-07-31, after the restructure, the review round that followed
it, and the cost section, and worth re-checking after any substantial edit:

| | Original | Restructure | After review | With cost |
| --- | --- | --- | --- | --- |
| Top-level sections | 21 | 5 | 5 | 6 |
| Callout panels | 21 | 11 | 9 | 9 |
| Ticked checklists | 13 | 5 | 1 | 1 |
| Photographs | 8 | 5 | 5 | 5 |
| Words | 3,775 | ~3,700 | ~3,500 | ~3,755 |

The cost section added a `glanceGrid` and three `subsection` blocks and no
callout, which is why the panel count did not move. `action-required` is still at
its four and `note` at its two. A settled fee is a fact for the rows table, not a
stop-and-read panel.

The 2026-08-17 round held to the same rule. It added a `glanceGrid` and a
`linkGrid` for laundry and extended four existing bodies, so sections stayed at
six and panels at nine. The blanket is the case worth remembering: it arrived as
an urgent all-cohort notice with a deadline and a cost, which is exactly the shape
that argues for a fifth `action-required`. It went into Rooming as bold prose
instead, because the four that exist are the four that survive being read.

The second round the same day added the revision line and the weekend food
arrangements, again with no new panel: the Saturday and Sunday community meals and
the noodles-and-eggs supplement extended the existing Weekends subsection.

A third round added the weekend meal sign-up sheet, and it is the harder case,
because a recurring Friday deadline with real consequences is a better candidate
for `action-required` than anything else on the page that lacks one. It still did
not get a panel. The deadline is bold inside the paragraph that explains why it
exists, and it repeats in the `note` on the link card, so a reader meets it twice
without a fifth orange box competing with dates, flights, visas and dietary needs.
A `linkGrid` card with a deadline in its note is the pattern to reuse when
something is both a task and a link.

A tick means "you do this, then confirm you did". A callout means "stop and read
this". Both stop meaning anything when every section has one.

The review round cut four of the five checklists. Joshua's note on it is the
governing principle for this document: **the people coming are seasoned
travellers.** Advice they have not needed since their first international trip
reads as padding and makes the whole handbook less credible, so generic
pre-flight, packing and departure advice was cut. What survived is either
Bali-specific (entry requirements, the weather they are packing for) or
workshop-specific (what to bring for the sessions). The generic material lives on
the unlisted `/general-travel-advice` page, linked once from the travel section
for whoever wants it.

## The "coming soon" discipline

About a third of the source document for Bali 2026 was blank when it arrived.
Most of those blanks got filled from material that already existed elsewhere.
The ones that remain are gathered into one panel per section that says **what** is
missing and **who** will send it, so a reader can tell a tracked gap from an
oversight.

Open gaps as of 2026-08-17:

- **04** driver details and pickup times, and the final resource and equipment
  list.
- **05** venue arrival details and reception number, room allocation, check-in,
  accessibility, quiet hours, Wi-Fi network and password, nearest clinic and
  hospital, safeguarding contact.

Two closed on 2026-08-17. **Laundry** now carries the service the base
recommends, with its own price list as a rows table and its map and WhatsApp
links; the source was a message from the base on 2026-08-16. **Linen** is
answered inside Rooming: the base sheets every bed and provides a pillow with a
case but no blankets, from the notice sent to participants on 2026-08-14. Both
came out of the section-05 panel in the same commit, which is the pattern.

When one is settled, move it into real content and delete it from the panel and
from this list.

Sections 02 and 03 no longer carry a panel, and neither should get one back
without a reason.

- **02** asked participants to wait for meal times and daily hours. They do not
  need the clock; they need the shape of a day, and that now lives in "The daily
  rhythm" as prose. The one genuinely undecided session is already named on the
  day it falls.
- **03** listed the facilitators, mentors, translators and local partners still
  to be confirmed. Naming local partners on an indexed public page can expose
  them, so the panel went and the confirmed four stand on their own.

## Print

The handbook has `@media print` rules in `src/index.css`: nav, footer, rail,
progress bar and photographs are hidden, headings stay with their text, callouts
and list items do not split across pages, and external link targets are printed
after the link text. `imageSlot` figures carry `hb-band` so they drop out of
print along with the section photo bands. Check the print view after any layout
change to the handbook: participants do print this, and it currently runs to
about 20 pages.
