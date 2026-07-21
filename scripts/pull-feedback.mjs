#!/usr/bin/env node
/**
 * Pull new in-app feedback from the Google Sheet into feedback/incoming/.
 *
 * The deployed app POSTs each comment batch to a Google Apps Script web app,
 * which appends it as a row in a Sheet (see feedback/server/). This script
 * hits that same web app's pull endpoint (?pull=<token>), which returns every
 * row not yet pulled and stamps them so we never fetch a row twice. Each new
 * row is written as one markdown file in feedback/incoming/ — the same inbox
 * the local dev tools use — so "review the feedback batch" works unchanged.
 *
 * Config comes from (first found wins):
 *   1. env vars FEEDBACK_PULL_URL + FEEDBACK_PULL_TOKEN
 *   2. feedback/.pull.json  { "url": "...exec", "token": "..." }  (gitignored)
 *
 * If no config is present it exits quietly (code 0), so a hook or poller that
 * runs everywhere doesn't error where the app isn't set up.
 *
 * Run manually:  npm run pull-feedback
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const incomingDir = join(repoRoot, 'feedback', 'incoming')

function loadConfig() {
  const url = process.env.FEEDBACK_PULL_URL
  const token = process.env.FEEDBACK_PULL_TOKEN
  if (url && token) return { url, token }
  const cfgPath = join(repoRoot, 'feedback', '.pull.json')
  if (existsSync(cfgPath)) {
    try {
      const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
      if (cfg.url && cfg.token) return cfg
    } catch {
      /* malformed — treated as no config below */
    }
  }
  return null
}

// Filesystem-safe slug from an ISO-ish timestamp string.
function stamp(received) {
  const s = String(received || '').replace(/[:.]/g, '-').replace(/[^\w-]/g, '_')
  return s || 'unknown-time'
}

async function main() {
  const cfg = loadConfig()
  if (!cfg) {
    // Not configured here — nothing to do. Quiet success.
    return
  }

  const endpoint = `${cfg.url}${cfg.url.includes('?') ? '&' : '?'}pull=${encodeURIComponent(cfg.token)}`
  let data
  try {
    const res = await fetch(endpoint, { redirect: 'follow' })
    data = await res.json()
  } catch (err) {
    console.error(`pull-feedback: could not reach the sheet endpoint — ${err.message}`)
    process.exitCode = 1
    return
  }

  if (!data || data.ok !== true) {
    console.error(`pull-feedback: endpoint error — ${JSON.stringify(data)}`)
    process.exitCode = 1
    return
  }

  const rows = data.rows || []
  if (rows.length === 0) {
    console.log('pull-feedback: no new feedback.')
    return
  }

  mkdirSync(incomingDir, { recursive: true })
  for (const r of rows) {
    const name = `sheet-${stamp(r.received)}-r${r.row}.md`
    const header = `<!-- pulled from Google Sheet row ${r.row}, received ${r.received} -->\n\n`
    writeFileSync(join(incomingDir, name), header + (r.markdown || ''), 'utf8')
    console.log(`pull-feedback: wrote feedback/incoming/${name}`)
  }
  console.log(`pull-feedback: ${rows.length} new comment${rows.length === 1 ? '' : 's'} synced.`)
}

main()
