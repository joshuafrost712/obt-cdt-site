import { useEffect, useState, type ComponentType } from 'react'

/**
 * Client-only, lazy mount for the devfeedback tools. Both imports happen inside
 * an effect so the module (Dexie/IndexedDB, localStorage) never loads during
 * the SSR prerender build and never weighs down the bundle for real visitors:
 * the chunk is fetched only when the dev flag is on (vite dev, or ?dev=1).
 */
export function DevFeedbackMount() {
  const [Comp, setComp] = useState<ComponentType | null>(null)

  useEffect(() => {
    let alive = true
    void import('../../devfeedback/enabled').then(({ isFeedbackEnabled }) => {
      if (!alive || !isFeedbackEnabled()) return
      void import('../../devfeedback/DevFeedbackRoot').then((m) => {
        if (alive) setComp(() => m.DevFeedbackRoot)
      })
    })
    return () => {
      alive = false
    }
  }, [])

  return Comp ? <Comp /> : null
}
