import { useState } from 'react'
import { useFeedback } from './feedbackContext'
import { addComment, type Importance } from './db'

/**
 * The comment window. Opens anchored to whatever the user highlighted (or as a
 * page-level note when there is no selection). Captures the comment text and an
 * importance rank, then stores it in the feedback DB.
 */
export function CommentWindow() {
  const { draft, closeComment } = useFeedback()
  const [comment, setComment] = useState('')
  const [importance, setImportance] = useState<Importance>('medium')
  const [saving, setSaving] = useState(false)

  if (!draft) return null

  const save = async () => {
    const text = comment.trim()
    if (!text || saving) return
    setSaving(true)
    await addComment({
      route: draft.route,
      selectionText: draft.selectionText,
      locationLabel: draft.locationLabel,
      comment: text,
      importance,
    })
    setComment('')
    setImportance('medium')
    setSaving(false)
    closeComment()
  }

  return (
    <div className="dfb-root dfb-overlay" role="dialog" aria-label="Add feedback comment">
      <div className="dfb-panel">
        <div className="dfb-panel-head">
          <strong>Add comment</strong>
          <button type="button" className="dfb-x" onClick={closeComment}>
            Cancel
          </button>
        </div>

        <div className="dfb-meta">
          <span className="dfb-tag">{draft.route}</span>
          {draft.locationLabel && <span className="dfb-tag dfb-tag-soft">{draft.locationLabel}</span>}
        </div>

        {draft.selectionText ? (
          <blockquote className="dfb-quote">{draft.selectionText}</blockquote>
        ) : (
          <p className="dfb-muted">Page-level note (no text highlighted).</p>
        )}

        <textarea
          autoFocus
          rows={4}
          className="dfb-textarea"
          placeholder="What's the feedback? Dictate or type…"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void save()
          }}
        />

        <div className="dfb-row">
          <label className="dfb-muted">
            Importance{' '}
            <select value={importance} onChange={(e) => setImportance(e.target.value as Importance)}>
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </select>
          </label>
          <div className="dfb-spacer" />
          <button type="button" className="dfb-btn dfb-btn-primary" disabled={!comment.trim() || saving} onClick={save}>
            Save
          </button>
        </div>
      </div>
    </div>
  )
}
