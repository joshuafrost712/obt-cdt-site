# Participant handbooks

A handbook is a per-workshop reference document for confirmed participants:
dates, venue, travel, visas, packing, prework, contacts. The first one is
**Bali 2026** at `/workshops/psalms-bali-2026/handbook`.

It is a different kind of page from the rest of the site. The marketing pages
argue a case; a handbook answers questions, in a hurry, on a phone, sometimes
on airport Wi-Fi, and often on paper. So it gets its own layout and its own
block types.

## Unlisted, not private

The handbook page is marked `"hidden": true` in `site-content.json`. That gives
it three things:

- no entry in the top nav (`navItems()` filters hidden pages)
- no entry in `sitemap.xml`
- `<meta name="robots" content="noindex, nofollow">` in the prerendered head

It is still prerendered, so anyone with the link gets the full document as HTML.

**This repo is public.** Unlisted controls search engines and site navigation,
nothing more. Every word of handbook copy, including the venue address and any
form links, is readable in `src/content/site-content.json` on github.com and in
the commit history. Do not put anything in a handbook that would be a problem
world-readable. Personal data stays out entirely, same as the rest of the site.

### Deliberately absent: the registration form link

The registration and travel form is **not** linked from the handbook, by decision
(2026-07-28). An open Google Form on a URL that anyone can reach collects junk
submissions, and the form is the one link here that writes data rather than
reads it. Sections 08 and 18 tell participants the link came by email and to
write to Josh if they lost it. Do not add it back as a convenience.

The Exegetical Guide link is fine to keep: it is read-only and already
circulated to the cohort.

## Where the copy lives

One page node in `src/content/site-content.json`, `id: "bali-2026-handbook"`,
with `"layout": "handbook"`. Its `blocks` array is:

1. one `hero` (with `mediaId` for the full-bleed photo, and `labelToken` items
   for the date chips)
2. one `sectionNav` (the contents grid; also what the desktop rail is built
   from, via the section list)
3. one `handbookSection` per section, in order

## Adding or editing a section

A section looks like this:

```jsonc
{
  "id": "bali.03",
  "type": "handbookSection",
  "number": "03",                    // chip, and the rail's numbering
  "anchor": "s03-location",          // fragment id; keep it stable, people link to it
  "kicker": "Location",
  "title": "Where we will be",
  "body": "Paragraphs separated by blank lines. **bold** works.",
  "mediaId": "bali-location",        // optional photo band
  "caption": "Caption under the band.",
  "items": [ /* child blocks */ ]
}
```

Then add a matching entry to the `sectionNav` items so it appears in the
contents grid (`number`, `anchor`, `label`). The desktop rail is generated from
the sections themselves, so it needs nothing.

## The handbook block types

All of these are valid as children of a `handbookSection`. They are written
container-free, and `BlockRenderer` adds the standard column wrapper if one is
used at the top level of an ordinary page (the handbook link card on the Psalms
workshop page is a `linkGrid` used that way).

| Type | What it is | Fields it uses |
| --- | --- | --- |
| `subsection` | A headed paragraph inside a section | `kicker`, `title`, `body` |
| `callout` | Status panel | `variant`, `label`, `title`, `body` |
| `checklist` | Ticked cards, two columns | `kicker`, `title`, `body`, `items[].label`, `items[].body` |
| `glanceGrid` | Cards, or a fact table with `variant: "rows"` | `items[].kicker`, `.value`, `.label`, `.body` |
| `linkGrid` | Resource cards | `items[].label`, `.href` or `.route`, `.body`, `.note` |

### Callout variants

- `action-required` — clay, with a slow pulse on the chip. Something the reader
  must do. Use sparingly; it stops meaning anything if every section has one.
- `coming-soon` — muted. A detail that is genuinely not settled yet.
- `note` — teal. Context worth knowing.
- `thanks` — gold. Closing note.

The default chip text comes from the variant; `label` overrides it.

## The "coming soon" discipline

About a third of the source document for Bali 2026 was blank when it arrived.
Most of those blanks got filled from material that already existed elsewhere.
The ones that remain are marked with a `coming-soon` callout that says **what**
is missing and **who** will send it, so a reader can tell a tracked gap from an
oversight.

Open gaps in the Bali 2026 handbook as of the initial build:

- **16 Laundry** — nothing known at all.
- **13 Venue** — room allocation, check-in time, linen, accessibility, quiet
  hours, on-site contacts.
- **15 Wi-Fi** — network name, password, real bandwidth.
- **19 Health** — venue contact, nearest clinic and hospital, safeguarding
  contact.
- **07 Team** — full facilitator list, mentor groups, on-site coordination.
- **09 Transfers** — driver details and pickup times.
- **18 Documents** — shared folder, WhatsApp or email group.
- **12 Packing** — the final resource and equipment list.

When one is settled, replace the `coming-soon` callout with real content and
delete the entry above.

## Print

The handbook has `@media print` rules in `src/index.css`: nav, footer, rail,
progress bar and photo bands are hidden, headings stay with their text,
callouts and list items do not split across pages, and external link targets
are printed after the link text. Check the print view after any layout change
to the handbook — participants do print this.
