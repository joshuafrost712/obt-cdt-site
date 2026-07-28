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

## Consent and sourcing rules

- Use images cleared for public web use (the shared Wycliffe/SIL image
  repository, once access is granted, is the primary source).
- **No identifiable participants without documented consent**, and no images
  that identify people, projects, or partner organizations working in
  sensitive or restricted-access contexts. When in doubt, choose photos where
  individuals are not identifiable (hands, backs, wide shots) or use a
  different subject.
- Record the source/credit for every image in the manifest's `credit` field.
