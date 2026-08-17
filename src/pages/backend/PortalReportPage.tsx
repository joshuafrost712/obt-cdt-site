import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { AuthGate, ErrorNote } from './shared'
import { getMyReport, type PortalReport } from '../../lib/backend/portalApi'
import { Markdown } from '../../lib/backend/markdown'
import { siteLabel } from '../../lib/content/loader'

export default function PortalReportPage() {
  return (
    <AuthGate title={siteLabel('portal.report.title', 'Your report')}>
      {() => <ReportBody />}
    </AuthGate>
  )
}

function ReportBody() {
  const { reportId } = useParams()
  const [state, setState] = useState<'loading' | 'missing' | 'ready' | 'error'>('loading')
  const [report, setReport] = useState<PortalReport | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true
    if (!reportId) {
      setState('missing')
      return
    }
    getMyReport(reportId)
      .then((r) => {
        if (!alive) return
        setReport(r)
        setState(r ? 'ready' : 'missing')
      })
      .catch((e: unknown) => {
        if (!alive) return
        setError(e instanceof Error ? e.message : String(e))
        setState('error')
      })
    return () => {
      alive = false
    }
  }, [reportId])

  if (state === 'error') return <ErrorNote error={error} />
  if (state === 'loading') {
    return <p className="mt-8 text-ink-faint">{siteLabel('portal.report.loading', 'Loading…')}</p>
  }

  // A filtered read and a genuinely absent row are indistinguishable on the wire
  // — RLS denies by returning nothing, not by erroring — so this must not claim
  // that something went wrong. It says what is true: not in your record.
  if (state === 'missing' || !report) {
    return (
      <div className="mt-8 rounded-2xl border border-ink/10 bg-white/60 p-6">
        <p className="text-sm leading-relaxed text-ink-soft">
          {siteLabel(
            'portal.report.notfound',
            'There is no report with that link in your record. If you were expecting one, contact the track administrator.',
          )}
        </p>
        <Link to="/portal" className="mt-4 inline-block text-sm underline">
          {siteLabel('portal.report.back', 'Back to your reports')}
        </Link>
      </div>
    )
  }

  return (
    <article className="mt-8">
      <Link to="/portal" className="text-sm underline">
        {siteLabel('portal.report.back', 'Back to your reports')}
      </Link>

      <header className="mt-6">
        <h2 className="font-display text-2xl font-semibold text-ink">{report.title || report.subject}</h2>
        <p className="mt-1 text-sm text-ink-faint">
          {report.workshop_name}
          {report.date_label && ` · ${report.date_label}`}
        </p>
        {report.superseded_by && (
          <p className="mt-4 rounded-lg bg-paper-deep px-4 py-3 text-sm text-ink-soft">
            {siteLabel(
              'portal.report.superseded',
              'A later version of this report was sent. This is the version you received on the date above.',
            )}
          </p>
        )}
      </header>

      <Markdown source={report.body_md} />
    </article>
  )
}
