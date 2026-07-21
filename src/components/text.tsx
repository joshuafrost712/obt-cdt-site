import type { ElementType, ReactNode } from 'react'

/** Structural view of any content node: an id plus whatever text fields it has. */
interface TextNode {
  id: string
}

/**
 * Minimal inline formatting for content strings: **bold** only. Content stays
 * near-plain-text so the edit-in-place oldText equality guard stays reliable.
 */
export function inline(text: string): ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*)/g)
  if (parts.length === 1) return text
  return parts.map((part, i) =>
    part.startsWith('**') && part.endsWith('**') ? <strong key={i}>{part.slice(2, -2)}</strong> : part,
  )
}

interface TxtProps {
  node: TextNode
  field: string
  as?: ElementType
  className?: string
}

/**
 * Renders one text field of a content node, tagged for the devfeedback
 * SelectionLayer (data-dfb-node/-field) so highlighting it offers "Edit text".
 * Renders nothing when the field is empty.
 */
export function Txt({ node, field, as, className }: TxtProps) {
  const Tag: ElementType = as ?? 'span'
  const value = (node as unknown as Record<string, unknown>)[field]
  if (typeof value !== 'string' || !value) return null
  return (
    <Tag className={className} data-dfb-node={node.id} data-dfb-field={field}>
      {inline(value)}
    </Tag>
  )
}

/**
 * Renders a body string as paragraphs (split on blank lines), all tagged as
 * one editable node+field so an edit round-trips the whole body faithfully.
 */
export function Body({ node, field = 'body', className }: { node: TextNode; field?: string; className?: string }) {
  const value = (node as unknown as Record<string, unknown>)[field]
  if (typeof value !== 'string' || !value) return null
  return (
    <div className={className} data-dfb-node={node.id} data-dfb-field={field}>
      {value.split(/\n\s*\n/).map((para, i) => (
        <p key={i}>{inline(para.trim())}</p>
      ))}
    </div>
  )
}
