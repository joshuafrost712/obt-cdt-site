/**
 * A small renderer for the markdown subset Honest Eval's reports actually emit.
 *
 * `segmentsToMarkdown()` over there produces exactly: `#`/`##`/`###` headings,
 * `- ` bullets, blank-line-separated paragraphs, and `**bold**` / `_italic_`
 * inline. That is the whole grammar, so a dependency would be several kilobytes
 * to handle syntax this input never contains.
 *
 * **Never `dangerouslySetInnerHTML`.** The text is prose about people, arriving
 * from another system, rendered on a public site. Returning React elements means
 * there is no HTML sink to get wrong — not now, and not after somebody later
 * adds a field to the envelope.
 */
import type { ReactNode } from 'react'

/** `**bold**` and `_italic_`, non-nesting, which is all the reports use. */
function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = []
  const re = /(\*\*([^*]+)\*\*|_([^_]+)_)/g
  let last = 0
  let m: RegExpExecArray | null
  let i = 0
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index))
    if (m[2] !== undefined) {
      out.push(
        <strong key={`${keyBase}-b${i}`} className="font-semibold text-ink">
          {m[2]}
        </strong>,
      )
    } else {
      out.push(<em key={`${keyBase}-i${i}`}>{m[3]}</em>)
    }
    last = m.index + m[0].length
    i += 1
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

export function Markdown({ source }: { source: string }) {
  const lines = source.replace(/\r\n/g, '\n').split('\n')
  const blocks: ReactNode[] = []
  let paragraph: string[] = []
  let bullets: string[] = []
  let key = 0

  const flushParagraph = () => {
    if (paragraph.length === 0) return
    const text = paragraph.join(' ')
    blocks.push(
      <p key={`p${key++}`} className="mt-4 leading-relaxed text-ink-soft">
        {inline(text, `p${key}`)}
      </p>,
    )
    paragraph = []
  }

  const flushBullets = () => {
    if (bullets.length === 0) return
    blocks.push(
      <ul key={`u${key++}`} className="mt-4 list-disc space-y-2 pl-5 text-ink-soft">
        {bullets.map((b, i) => (
          <li key={i} className="leading-relaxed">
            {inline(b, `u${key}-${i}`)}
          </li>
        ))}
      </ul>,
    )
    bullets = []
  }

  const flushAll = () => {
    flushParagraph()
    flushBullets()
  }

  for (const raw of lines) {
    const line = raw.trimEnd()

    if (line.trim() === '') {
      flushAll()
      continue
    }

    const heading = /^(#{1,3})\s+(.*)$/.exec(line)
    if (heading) {
      flushAll()
      const level = heading[1].length
      const text = heading[2]
      const cls =
        level === 1
          ? 'mt-8 font-display text-2xl font-semibold text-ink'
          : level === 2
            ? 'mt-8 font-display text-xl font-semibold text-ink'
            : 'mt-6 font-display text-base font-semibold text-ink'
      blocks.push(
        level === 1 ? (
          <h2 key={`h${key++}`} className={cls}>
            {inline(text, `h${key}`)}
          </h2>
        ) : level === 2 ? (
          <h3 key={`h${key++}`} className={cls}>
            {inline(text, `h${key}`)}
          </h3>
        ) : (
          <h4 key={`h${key++}`} className={cls}>
            {inline(text, `h${key}`)}
          </h4>
        ),
      )
      continue
    }

    const bullet = /^[-*]\s+(.*)$/.exec(line)
    if (bullet) {
      flushParagraph()
      bullets.push(bullet[1])
      continue
    }

    flushBullets()
    paragraph.push(line.trim())
  }

  flushAll()
  return <div className="report-body">{blocks}</div>
}
