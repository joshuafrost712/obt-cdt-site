# Style guide: SIL's, adopted

The site follows SIL Global's own visual identity. Joshua asked for this on
2026-07-28: "The style guide for this website should copy the styling that you
can derive from the SIL website — https://global.sil.org. Please copy the font
and the color palette."

The values below were **read off the live site**, not eyeballed. `global.sil.org`
runs the Blocksy theme, which publishes its type and palette as CSS custom
properties in the page head, so they can be extracted exactly:

```bash
curl -sL -A 'Mozilla/5.0' https://global.sil.org -o page.html
grep -oE -- '--theme-palette-color-[0-9]+: *[^;]+' page.html | sort -u
grep -oE -- '--theme-font-family:[^;}]+' page.html | sort -u
```

Everything lives in the `@theme` block at the top of `src/index.css`. Change it
there; components only ever use token names.

## Type

| Role | SIL | Where |
| --- | --- | --- |
| Body copy | Lora 400, 21px, line-height 1.65 | `--font-body`, applied in `Body` (`src/components/text.tsx`) |
| Headings | Playfair Display 600/700 | `--font-display`, via `font-display` |
| Interface | Source Sans 3 500, uppercase, 0.15em tracking on labels | `--font-sans`, the `body` default |
| Pull quotes | Caveat 500 | `--font-script`, only in the `quote` block |

**Two deliberate departures from SIL.**

SIL sets **H2 in Caveat**, a handwriting face. Copying that would have put all 21
handbook section headings, and every marketing H2, in handwriting. Joshua chose
the restrained option: headings stay in Playfair Display, and Caveat is kept for
pull quotes, where it does what a handwriting face is good at.

Body copy keeps this site's existing per-block sizes rather than SIL's flat 21px,
which would have broken the layouts. SIL's line-height and face are adopted.

Because every paragraph of reading copy on the site funnels through the `Body`
component, `font-body` is applied there once. Interface text does not pass
through it and so stays on Source Sans 3. Do not scatter `font-body` into
component classNames.

## Colour

SIL's eight-step palette, verbatim:

| Token | Value | SIL slot | Use |
| --- | --- | --- | --- |
| `brand` | `#005cb9` | palette 1 | primary buttons, note callouts, roles |
| `brand-light` | `#00a7e1` | palette 2 | figures and accents on dark |
| `accent` | `#ff6b00` | palette 3 | rules, hovers, graphic marks |
| `ink-faint` | `#727272` | palette 4 | secondary text |
| `navy` | `#003049` | palette 5 | dark surfaces, footer, hero |
| `paper-deep` | `#f9fafb` | palette 6 | tinted panels |
| `paper` | `#ffffff` | palette 8 | page |
| `ink` | `#000000` | text colour | body text |

Borders come from `ink` at 10% alpha, which lands within a shade of SIL's own
`#e4e4e4` border grey, so there is no separate border token.

**Three values are not SIL's, for contrast reasons.** SIL's orange is 2.9:1 on
white, which fails WCAG AA for text:

- `accent-deep` `#c24e00` (4.8:1) carries every small orange text element:
  kickers, labels, list markers, section numbers. Plain `accent` is for graphics
  and hovers only.
- Filled primary buttons are `bg-brand` (6.4:1 with white) hovering to `accent`.
  That mirrors SIL's own link behaviour, navy resting and orange on hover, and
  avoids white-on-orange.
- `ink-soft` `#3f4a52` sits between SIL's black body text and its `#727272` grey,
  for secondary paragraphs that would be too light at `#727272`.

## Adding a colour

Don't, unless SIL has one. The eight above plus the three contrast variants cover
the whole site. If a new state genuinely needs a colour, derive it from an
existing token with `color-mix` or an alpha, and note the contrast ratio here.
