/**
 * Temporary verification harness: renders the real RoundaboutDiagram at every
 * scene so the figure can be looked at without scrolling a browser. Not part of
 * the site build. Run:
 *
 *   npx vite build --ssr scripts/diagram-preview.tsx --outDir /tmp/dp
 *   node /tmp/dp/diagram-preview.js > /tmp/diagram.html
 */
import { renderToStaticMarkup } from 'react-dom/server'
import { RoundaboutDiagram } from '../src/components/scrolly/RoundaboutDiagram'
import content from '../src/content/site-content.json'
import type { Block } from '../src/schema/types'

const home = (content.pages as unknown as { id: string; blocks: Block[] }[]).find((p) => p.id === 'home')!
const scenes = home.blocks.filter((b) => b.type === 'scene')
const threads = scenes.flatMap((s) => (s.items ?? []).filter((i) => i.type === 'labelToken'))

// The token values from the @theme block in src/index.css, so the SVG's
// var(--color-*) references resolve exactly as they do on the site.
const TOKENS = `
  --color-paper:#ffffff; --color-paper-deep:#f9fafb; --color-ink:#000000;
  --color-ink-soft:#3f4a52; --color-ink-faint:#727272;
  --color-accent:#ff6b00; --color-accent-deep:#c24e00; --color-accent-soft:#ffd9bf;
  --color-brand:#005cb9; --color-brand-soft:#cfe8f7; --color-brand-light:#00a7e1;
  --color-navy:#003049; --font-sans:system-ui,-apple-system,sans-serif;
`

const panels = scenes
  .map((scene, i) => {
    // progress runs 0->1 across the whole essay; approximate each scene's centre.
    const progress = (i + 0.5) / scenes.length
    const svg = renderToStaticMarkup(
      RoundaboutDiagram({ stage: i, progress, threads, note: scene.kicker }) as never,
    )
    return `<figure>
      <figcaption><b>stage ${i}</b> &middot; ${scene.kicker} &middot; ${scene.title}</figcaption>
      <div class="d">${svg}</div>
    </figure>`
  })
  .join('\n')

const compact = renderToStaticMarkup(
  RoundaboutDiagram({ stage: 3, progress: 0.5, threads, note: 'Circulating', compact: true }) as never,
)

process.stdout.write(`<!doctype html><meta charset="utf-8"><title>Roundabout stages</title>
<style>
  :root{${TOKENS}}
  body{margin:0;padding:24px;background:#fff;font:13px/1.4 var(--font-sans);color:#111}
  .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:20px}
  figure{margin:0;border:1px solid #e5e5e5;border-radius:10px;padding:10px;background:#fff}
  figcaption{font-size:11px;color:#555;margin-bottom:6px}
  .d{width:100%}
  .d svg{width:100%;height:auto;display:block}
  .mob{width:176px;border:1px dashed #bbb;border-radius:8px;padding:6px;margin-top:20px}
  h2{font-size:14px;margin:24px 0 8px}
</style>
<div class="grid">${panels}</div>
<h2>Mobile instance (176px, compact: no text annotations)</h2>
<div class="mob">${compact}</div>
`)
