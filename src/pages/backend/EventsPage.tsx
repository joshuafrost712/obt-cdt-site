import { useCallback, useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import {
  cancelRegistration,
  listEvents,
  listMyRegistrations,
  register,
  type EventRow,
  type Registration,
} from '../../lib/backend/api'
import { AuthGate, ErrorNote, shortRange } from './shared'

export default function EventsPage() {
  return <AuthGate title="Events">{(session) => <EventsBody session={session} />}</AuthGate>
}

const STATUS_LABEL: Record<EventRow['status'], string> = {
  open: 'Open',
  'fully-booked': 'Fully booked',
  completed: 'Completed',
  cancelled: 'Cancelled',
}

function EventsBody({ session }: { session: Session }) {
  const [events, setEvents] = useState<EventRow[] | null>(null)
  const [regs, setRegs] = useState<Registration[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')

  const reload = useCallback(() => {
    Promise.all([listEvents(), listMyRegistrations(session.user.id)])
      .then(([e, r]) => {
        setEvents(e)
        setRegs(r)
      })
      .catch((err) => setError(String(err.message ?? err)))
  }, [session.user.id])

  useEffect(reload, [reload])

  if (error) return <ErrorNote error={error} />
  if (!events) return <p className="mt-8 text-ink-faint">Loading events…</p>

  const regFor = (eventId: string) => regs.find((r) => r.event_id === eventId && r.status !== 'cancelled')

  const act = async (fn: () => Promise<void>, key: string) => {
    setBusy(key)
    try {
      await fn()
      reload()
    } catch (err) {
      setError(String((err as Error).message ?? err))
    } finally {
      setBusy('')
    }
  }

  const upcoming = events.filter((e) => e.status === 'open' || e.status === 'fully-booked')
  const past = events.filter((e) => e.status === 'completed' || e.status === 'cancelled')

  return (
    <div className="mt-8 space-y-10">
      <section>
        <h2 className="font-display text-2xl font-semibold text-ink">Upcoming</h2>
        {upcoming.length === 0 && <p className="mt-3 text-sm text-ink-soft">Nothing open for sign-up right now.</p>}
        <div className="mt-4 space-y-4">
          {upcoming.map((event) => {
            const mine = regFor(event.id)
            return (
              <div key={event.id} className="rounded-2xl border border-ink/10 bg-white/60 p-5">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="font-display text-lg font-semibold text-ink">{event.title}</h3>
                  <span
                    className={`rounded-full px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wide ${
                      event.status === 'open' ? 'bg-brand-soft text-brand' : 'bg-accent-deep text-white'
                    }`}
                  >
                    {STATUS_LABEL[event.status]}
                  </span>
                </div>
                <p className="mt-1 text-sm text-ink-soft">
                  {[event.location, shortRange(event.start_date, event.end_date)].filter(Boolean).join(' · ')}
                </p>
                {event.description && <p className="mt-2 text-sm leading-relaxed text-ink-soft">{event.description}</p>}
                <div className="mt-3 flex items-center gap-3">
                  {mine ? (
                    <>
                      <span className="text-sm font-semibold text-brand">
                        {mine.status === 'waitlist' ? 'You are on the waitlist' : 'You are registered'}
                      </span>
                      <button
                        type="button"
                        disabled={busy === event.id}
                        onClick={() => void act(() => cancelRegistration(mine.id), event.id)}
                        className="rounded-full border border-ink/20 px-3 py-1 text-xs font-medium text-ink-soft hover:bg-paper-deep disabled:opacity-40"
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      disabled={busy === event.id}
                      onClick={() => void act(() => register(session.user.id, event), event.id)}
                      className="rounded-full bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-accent disabled:opacity-40"
                    >
                      {event.status === 'fully-booked' ? 'Join the waitlist' : 'Register'}
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </section>

      {past.length > 0 && (
        <section>
          <h2 className="font-display text-2xl font-semibold text-ink">Past events</h2>
          <ul className="mt-4 space-y-2">
            {past.map((event) => {
              const mine = regs.find((r) => r.event_id === event.id)
              return (
                <li key={event.id} className="flex flex-wrap items-baseline gap-x-3 rounded-xl bg-white/50 px-4 py-3">
                  <span className="font-medium text-ink">{event.title}</span>
                  <span className="text-sm text-ink-faint">
                    {[event.location, shortRange(event.start_date, event.end_date)].filter(Boolean).join(' · ')}
                  </span>
                  {mine?.status === 'attended' && <span className="text-xs font-semibold uppercase tracking-wide text-brand">Attended</span>}
                </li>
              )
            })}
          </ul>
        </section>
      )}
    </div>
  )
}
