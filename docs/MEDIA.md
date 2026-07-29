# Media: how image slots work and how to swap in real photos

Every image on the site is a **slot** referenced by id in
`src/content/media-manifest.json`. While no photo is assigned, a slot renders
as a designed gradient panel carrying its label, so reviewers can see what
photo belongs where.

## Image selection discipline

Source of truth: **`_Meta/Visual-Media-Protocol.md`** in Joshua's vault. Read it
before choosing any image. The short version:

- An image earns its place by helping a reader process the text it sits beside.
  It is a visual lead-in to the next point, not decoration keyed to the general
  subject. "Beautiful but distracting" is the failure mode (feedback, 2026-07-28).
- Choose images **after** the prose is final, never alongside it. Write, find the
  main points, decide which points a visual actually helps, then search.
- Budget from length before searching: roughly **one visual per 800–1,000 words**,
  and never more than one per section. A hero counts.
- Derive the search query from the specific point, not from the document's
  subject. That is also what makes the search succeed.
- Some points want no picture. A schedule does not want a picture.

The Psalms page carries 5 visuals across ~3,700 words, down from 8, and each one
leads into the section it opens.

### A hero uses up the page's budget

Since 2026-07-29 every page opens on a handbook hero, and the marketing pages are
280 to 560 words. At roughly one visual per 800 to 1,000 words that is one image
per page, and the hero is it. So the mid-page `imageSlot` blocks on Philosophy and
The Five Threads were removed rather than filled, and the same slots on the
Narrative and Epistles workshop pages (about 240 words each) went with them. If
you are tempted to add a second photo to one of these pages, the page needs to be
twice as long first.

### A hero without a photo is a finished hero

`HandbookHero` renders the navy-to-brand wash whether or not the manifest entry
has a `src`, and it ignores placeholder labels. So a page with no suitable
photograph gets the same shape, just quieter, and there is never a reason to ship
a near-miss to avoid an empty-looking hero. **Philosophy, Method and General
travel advice ship photo-free** for exactly that reason: nothing found on Commons
or Openverse led into their argument rather than decorating it. `get-involved-hero`
is a placeholder awaiting a picture of a mentor working alongside a translator.

Two rejections from that round, recorded so they are not re-proposed: a shelf of
Kinyarwanda Bibles in Kigali (a burned-in camera date stamp, and printed Bibles
argue against a page about oral Scripture), and a Bangalore skyline that turned
out to be a near-black night exposure.

## Swapping in a real image

1. Drop the file into `public/media/` (e.g. `public/media/bangalore-circle.jpg`).
   Prefer web-sized JPEG/WebP, roughly 1600px wide, under ~400 KB.
2. Edit the slot's entry in `src/content/media-manifest.json`:

```jsonc
"workshop-narrative": {
  "kind": "image",                          // was "placeholder"
  "alt": "…keep or improve the alt text…",
  "aspect": "16/9",
  "src": "media/bangalore-circle.jpg",      // path under public/
  "credit": "Photo: Wycliffe/SIL"           // shown under the image
}
```

3. Done. No component changes; commit and the deploy workflow ships it.

To add a NEW slot: add a manifest entry, then reference it from a content block
(`"type": "imageSlot", "mediaId": "<id>"` in `src/content/site-content.json`).

## Interim sourcing: openly-licensed photography

Until the Wycliffe/SIL image repository is available, place-and-context photos
come from **Wikimedia Commons**, with **Openverse** as a fallback when Commons
is thin on a subject. Both return license and creator as data, so the `credit`
field is verified rather than remembered:

```bash
# Commons: license + creator + a resized URL, per file
curl -s "https://commons.wikimedia.org/w/api.php?action=query&generator=search\
&gsrsearch=filetype:bitmap%20<query>&gsrlimit=8&gsrnamespace=6&prop=imageinfo\
&iiprop=url|size|extmetadata&iiurlwidth=1600&format=json"

# Openverse: commercial use + modification allowed only
curl -s "https://api.openverse.org/v1/images/?q=<query>&license_type=commercial,modification"
```

Unsplash is not usable this way: its search pages are JS-rendered and it needs
an API key.

Credit format, so the manifest stays consistent:

```
Photo: <creator> (<license>, via Wikimedia Commons)
```

Append `, cropped` (or the relevant alteration) when the file has been changed.
CC BY-SA requires that the change be flagged, and the crop is often the point:
`choir-singing-suwon.jpg` is a tight crop of a wide balcony shot, taken to bring
the singers' faces up to a size that carries the section.

Captions describe the photograph, not the workshop. A stock photo of Balinese
musicians must not be captioned so that it reads as a picture of OBT work. A
caption may name the connection to the point after describing the photo:
"A tingklik player in Bali. The workshop's work is psalms carried in genres a
community already plays."

When both sources come up empty, say so and offer the real options rather than
settling for a pretty near-miss. About 25 queries across Commons and Openverse
for "joyful Asian congregation singing" produced one usable candidate.

**Commons search is literal.** It matches words that actually appear in filenames,
descriptions and categories, so a descriptive phrase like "workshop participants
seated in a circle internalizing a passage" returns nothing at all while
"translation workshop" returns a whole shoot. Query with two or three nouns, then
mine the set you find: one good event category is worth twenty adjectives. Expect
HTTP 429 if you fire queries back to back; space them a few seconds apart.

### Veins already found

- **Hablon-Usipon Children's Book Translation Workshop 2025** (`Filipinayzd`,
  CC BY-SA 4.0, 5184×3456, 20+ frames). A real mother-tongue translation
  workshop in the Philippines. Supplies `home-workshop` and `workshops-hero`.
  Prefer the working shots over the posed certificate presentations, and caption
  them as what they are: a translation workshop in the Philippines, never as OBT
  work.
- **Wikimedia training workshops** (Kushtia 2025, Bangladesh). Usable, but most
  frames are posed group line-ups that read as class photos.

### Two frames from one shoot is the limit

`home-workshop` and `workshops-hero` are both Hablon-Usipon frames. That is
acceptable because they are on different pages and captioned distinctly; a third
would start to look like the site only has one photograph.

## Looking at the roundabout diagram without scrolling

`RoundaboutDiagram` on the home page is a pure function of `{stage, progress}`, so
its seven scenes are only reachable by scrolling a live browser, and a screenshot
of the prerendered page only ever shows scene 0. `scripts/diagram-preview.tsx`
renders the real component at every scene into one page:

```bash
npx vite build --ssr scripts/diagram-preview.tsx --outDir .diagram-preview
node .diagram-preview/diagram-preview.js > .diagram-preview/diagram.html
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless \
  --disable-gpu --hide-scrollbars --screenshot=/tmp/roundabout.png \
  --window-size=1500,1400 "file://$PWD/.diagram-preview/diagram.html"
```

Output is gitignored. Use it after any change to the figure: two collisions on
2026-07-29 (the scene-2 caption sitting on the ring, and the faded rubric ticks
showing through the "OBT consulting" centre label on scenes 5 and 6) were invisible
in the code and obvious in the render. It also shows the compact mobile instance,
which must carry no text at all.

## Consent and sourcing rules

- Use images cleared for public web use (the shared Wycliffe/SIL image
  repository, once access is granted, is the primary source).
- **No identifiable participants without documented consent**, and no images
  that identify people, projects, or partner organizations working in
  sensitive or restricted-access contexts. When in doubt, choose photos where
  individuals are not identifiable (hands, backs, wide shots) or use a
  different subject.
- Record the source/credit for every image in the manifest's `credit` field.
