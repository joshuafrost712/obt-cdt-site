/**
 * DORMANT — not routed, not reachable.
 *
 * Written against `supabase/schema.sql`'s fresh-project design (a `profiles`
 * table with a role column, plus `registrations` / `evaluations` /
 * `certificates`). The live portal project has none of those tables: it is a
 * reports-only portal whose schema lives in `supabase/migrations/`. Routing this
 * page would show a participant a raw PostgREST "table not found".
 *
 * Kept rather than deleted because docs/PHASE-2-BACKEND.md still describes this
 * design and a memo pointing at deleted files becomes archaeology. Bring it back
 * when event registration or certificates are actually built.
 */
import { useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { getProfile, listMyCertificates, type CertificateRow } from '../../lib/backend/api'
import { AuthGate, ErrorNote, shortRange } from './shared'

export default function CertificatesPage() {
  return <AuthGate title="Certificates">{(session) => <CertificatesBody session={session} />}</AuthGate>
}

function CertificatesBody({ session }: { session: Session }) {
  const [certs, setCerts] = useState<CertificateRow[] | null>(null)
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')

  useEffect(() => {
    let alive = true
    Promise.all([listMyCertificates(session.user.id), getProfile(session.user.id)])
      .then(([c, p]) => {
        if (!alive) return
        setCerts(c)
        setName(p?.full_name ?? '')
      })
      .catch((err) => alive && setError(String(err.message ?? err)))
    return () => {
      alive = false
    }
  }, [session.user.id])

  if (error) return <ErrorNote error={error} />
  if (!certs) return <p className="mt-8 text-ink-faint">Loading your certificates…</p>

  const download = async (cert: CertificateRow) => {
    setBusy(cert.id)
    try {
      // pdfmake (and its ~2 MB font pack) loads only when a PDF is requested.
      const { downloadCertificate } = await import('../../lib/backend/certificatePdf')
      downloadCertificate({
        participantName: name || 'Participant',
        eventTitle: cert.events?.title ?? 'OBT-CDT event',
        eventLocation: cert.events?.location ?? '',
        dateRange: shortRange(cert.events?.start_date ?? null, cert.events?.end_date ?? null),
        issuedAt: cert.issued_at,
      })
    } finally {
      setBusy('')
    }
  }

  return (
    <div className="mt-8">
      {certs.length === 0 ? (
        <p className="max-w-xl text-sm leading-relaxed text-ink-soft">
          No certificates have been issued to you yet. Certificates appear here after a completed workshop's records
          are finalized.
        </p>
      ) : (
        <>
          <p className="max-w-xl text-sm leading-relaxed text-ink-soft">
            Download a print-ready PDF for any workshop you have completed. Your name appears as it is written on your
            profile.
          </p>
          <ul className="mt-6 space-y-4">
            {certs.map((cert) => (
              <li key={cert.id} className="flex flex-wrap items-center gap-4 rounded-2xl border border-ink/10 bg-white/60 p-5">
                <div className="min-w-0 flex-1">
                  <p className="font-display text-lg font-semibold text-ink">{cert.events?.title ?? 'OBT-CDT event'}</p>
                  <p className="text-sm text-ink-soft">
                    {[cert.events?.location, shortRange(cert.events?.start_date ?? null, cert.events?.end_date ?? null)]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                  <p className="mt-1 text-xs text-ink-faint">Issued {cert.issued_at}</p>
                </div>
                <button
                  type="button"
                  disabled={busy === cert.id}
                  onClick={() => void download(cert)}
                  className="rounded-full bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-accent disabled:opacity-40"
                >
                  {busy === cert.id ? 'Preparing…' : 'Download PDF'}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}
