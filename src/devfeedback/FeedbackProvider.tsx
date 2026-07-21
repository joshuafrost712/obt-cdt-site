import { useMemo, useState, type ReactNode } from 'react'
import { FeedbackContext, type Draft, type EditDraft, type FeedbackCtxValue } from './feedbackContext'

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [draft, setDraft] = useState<Draft | null>(null)
  const [editDraft, setEditDraft] = useState<EditDraft | null>(null)
  const [managerOpen, setManagerOpen] = useState(false)

  const value = useMemo<FeedbackCtxValue>(
    () => ({
      draft,
      openComment: (d) => {
        setDraft(d)
        setEditDraft(null)
        setManagerOpen(false)
      },
      closeComment: () => setDraft(null),
      editDraft,
      openEdit: (d) => {
        setEditDraft(d)
        setDraft(null)
        setManagerOpen(false)
      },
      closeEdit: () => setEditDraft(null),
      managerOpen,
      setManagerOpen,
    }),
    [draft, editDraft, managerOpen],
  )

  return <FeedbackContext.Provider value={value}>{children}</FeedbackContext.Provider>
}
