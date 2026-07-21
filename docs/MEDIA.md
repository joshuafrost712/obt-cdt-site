# Media: how image slots work and how to swap in real photos

Every image on the site is a **slot** referenced by id in
`src/content/media-manifest.json`. While no photo is assigned, a slot renders
as a designed gradient panel carrying its label, so reviewers can see what
photo belongs where.

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

## Consent and sourcing rules

- Use images cleared for public web use (the shared Wycliffe/SIL image
  repository, once access is granted, is the primary source).
- **No identifiable participants without documented consent**, and no images
  that identify people, projects, or partner organizations working in
  sensitive or restricted-access contexts. When in doubt, choose photos where
  individuals are not identifiable (hands, backs, wide shots) or use a
  different subject.
- Record the source/credit for every image in the manifest's `credit` field.
