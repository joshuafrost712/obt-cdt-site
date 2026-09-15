import { useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from './client'
import { inRecovery, markRecovery } from './recovery'

export interface SessionState {
  /** undefined = still resolving; null = signed out. */
  session: Session | null | undefined
  /**
   * True when this browser arrived through a password-reset link and has not
   * set a password yet. Read from storage on mount, so it survives the reload
   * and the route change that criterion 1a asserts; see `recovery.ts`.
   */
  recovery: boolean
}

/** Live auth session (magic-link redirects included). */
export function useSession(): SessionState {
  const [session, setSession] = useState<Session | null | undefined>(undefined)
  // Seeded from storage rather than from the event, because the event fires
  // once and this hook mounts per route. SSR-safe: `inRecovery()` returns false
  // when storage is unreadable.
  const [recovery, setRecovery] = useState<boolean>(() => inRecovery())

  useEffect(() => {
    let alive = true
    void supabase()
      .auth.getSession()
      .then(({ data }) => {
        if (alive) setSession(data.session)
      })
    const { data: sub } = supabase().auth.onAuthStateChange((event, s) => {
      if (!alive) return
      // GoTrue emits this exactly once, as it parses and then clears the URL
      // fragment. Persist it immediately: by the next mount the fragment is
      // gone and this event will not be re-emitted.
      if (event === 'PASSWORD_RECOVERY') {
        markRecovery()
        setRecovery(true)
      }
      setSession(s)
    })
    return () => {
      alive = false
      sub.subscription.unsubscribe()
    }
  }, [])

  return { session, recovery }
}
