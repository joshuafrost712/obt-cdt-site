import { useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from './client'

export interface SessionState {
  /** undefined = still resolving; null = signed out. */
  session: Session | null | undefined
}

/** Live auth session (magic-link redirects included). */
export function useSession(): SessionState {
  const [session, setSession] = useState<Session | null | undefined>(undefined)

  useEffect(() => {
    let alive = true
    void supabase()
      .auth.getSession()
      .then(({ data }) => {
        if (alive) setSession(data.session)
      })
    const { data: sub } = supabase().auth.onAuthStateChange((_event, s) => {
      if (alive) setSession(s)
    })
    return () => {
      alive = false
      sub.subscription.unsubscribe()
    }
  }, [])

  return { session }
}
