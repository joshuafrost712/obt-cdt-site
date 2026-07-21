import { useLiveQuery } from 'dexie-react-hooks'
import { isFeedbackEnabled } from './enabled'
import { FeedbackProvider } from './FeedbackProvider'
import { useFeedback } from './feedbackContext'
import { SelectionLayer } from './SelectionLayer'
import { CommentWindow } from './CommentWindow'
import { EditWindow } from './EditWindow'
import { FeedbackManager } from './FeedbackManager'
import { fdb } from './db'
import './devfeedback.css'

/**
 * Single mount point for the in-app dev feedback system: highlight → comment,
 * the comment manager, and "send batch to Claude". Renders nothing unless the
 * dev flag is on (see enabled.ts), so production for users is untouched.
 *
 * Must be mounted INSIDE the router (it reads the current route).
 */
export function DevFeedbackRoot() {
  if (!isFeedbackEnabled()) return null
  return (
    <FeedbackProvider>
      <SelectionLayer />
      <CommentWindow />
      <EditWindow />
      <FeedbackManager />
      <ManagerFab />
    </FeedbackProvider>
  )
}

/** Floating button that opens the manager, badged with the open-comment count. */
function ManagerFab() {
  const { setManagerOpen, managerOpen, draft, editDraft } = useFeedback()
  const openCount = useLiveQuery(() => fdb.comments.where('status').equals('open').count(), [], 0)

  if (managerOpen || draft || editDraft) return null

  return (
    <button
      type="button"
      className="dfb-root dfb-fab"
      onClick={() => setManagerOpen(true)}
      aria-label="Open feedback manager"
    >
      🛠 Feedback{openCount ? ` (${openCount})` : ''}
    </button>
  )
}
