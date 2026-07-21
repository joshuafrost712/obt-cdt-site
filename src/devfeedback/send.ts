/**
 * Ship a rendered batch to the developer. Three paths, tried in order of
 * fidelity:
 *
 *   1. Local dev inbox — under `vite dev`, POST to the `/__feedback` endpoint
 *      (the Vite plugin in vite.config.ts writes it to feedback/incoming/<name>.md
 *      in the repo). Only exists while developing.
 *   2. Remote sink — in a DEPLOYED build, POST to the Google Apps Script web app
 *      at VITE_FEEDBACK_URL, which appends the batch as a row in a Google Sheet.
 *      This is what lets a real user (e.g. on a phone) submit fluidly with no
 *      file handling. See feedback/server/ for the script + deploy steps.
 *   3. Download fallback — if neither endpoint is reachable (offline, or no URL
 *      configured), download the markdown so nothing is lost.
 *
 * Kept self-contained (its own download helper) so the whole devfeedback/
 * folder copies into another app unchanged.
 */
export interface SendResult {
  ok: boolean
  path?: string
  remote?: boolean
  fallback?: 'download'
}

// Public Apps Script web-app URL, injected at build time. Unset in local dev
// (the dev inbox is used) and in any build that hasn't configured a sink.
const REMOTE_URL = import.meta.env.VITE_FEEDBACK_URL as string | undefined

function downloadText(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export async function sendBatch(markdown: string): Promise<SendResult> {
  const filename = `feedback-${new Date().toISOString().replace(/[:.]/g, '-')}.md`
  const payload = JSON.stringify({ filename, markdown })

  // 1. Local dev inbox (writes straight into the repo).
  if (import.meta.env.DEV) {
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}__feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
      })
      if (res.ok) {
        const data = (await res.json().catch(() => ({}))) as { path?: string }
        return { ok: true, path: data.path }
      }
    } catch {
      // dev endpoint unreachable — fall through
    }
  }

  // 2. Deployed remote sink (Google Apps Script → Sheet). text/plain keeps it a
  // "simple" request (no CORS preflight); no-cors makes it fire-and-forget —
  // Apps Script never sends CORS headers, so the response is opaque and a
  // resolved fetch is treated as delivered. A true network error still throws
  // and drops us to the download fallback so the batch is never lost.
  if (REMOTE_URL) {
    try {
      await fetch(REMOTE_URL, {
        method: 'POST',
        mode: 'no-cors',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: payload,
      })
      return { ok: true, remote: true }
    } catch {
      // offline / endpoint down — fall through to download
    }
  }

  // 3. Fallback: download the markdown.
  downloadText(filename, markdown)
  return { ok: true, fallback: 'download' }
}
