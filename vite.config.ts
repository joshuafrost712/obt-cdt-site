import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Base path is host-configurable: '/' for a custom domain, '/<repo>/' for
// GitHub Project Pages. Set VITE_BASE at build time.
const base = process.env.VITE_BASE || '/'

// Dev-only endpoint backing the in-app feedback tools (src/devfeedback). It
// writes each submitted batch to feedback/incoming/<name>.md in the repo so
// Claude can read it next session. Exists only in `vite dev`, never in a build.
function feedbackInbox(): Plugin {
  return {
    name: 'cdt-feedback-inbox',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.method !== 'POST' || !req.url?.split('?')[0].endsWith('/__feedback')) return next()
        let body = ''
        req.on('data', (c) => (body += c))
        req.on('end', () => {
          try {
            const { filename, markdown } = JSON.parse(body) as { filename?: string; markdown?: string }
            const safe = basename(filename ?? 'feedback.md').replace(/[^\w.\-]/g, '_')
            const name = safe.endsWith('.md') ? safe : `${safe}.md`
            const dir = join(process.cwd(), 'feedback', 'incoming')
            mkdirSync(dir, { recursive: true })
            writeFileSync(join(dir, name), markdown ?? '')
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ path: `feedback/incoming/${name}` }))
          } catch (err) {
            res.statusCode = 400
            res.end(JSON.stringify({ error: String(err) }))
          }
        })
      })
    },
  }
}

// Dev-only endpoint for edit-in-place: applies a structured
// {nodeId, field, oldText, newText} edit to src/content/site-content.json.
// The old text must match the file's current value (409 otherwise), so a stale
// page can never clobber a newer edit. Never bumps the content version —
// that stays a deliberate, per-release decision.
function contentEditEndpoint(): Plugin {
  const EDITABLE_FIELDS = new Set([
    'title',
    'kicker',
    'body',
    'label',
    'value',
    'note',
    'caption',
    'attribution',
    'navLabel',
    'metaDescription',
    'tagline',
    'footerNote',
  ])
  return {
    name: 'cdt-content-edit',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.method !== 'POST' || !req.url?.split('?')[0].endsWith('/__content-edit')) return next()
        let body = ''
        req.on('data', (c) => (body += c))
        req.on('end', () => {
          const reply = (code: number, payload: object) => {
            res.statusCode = code
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify(payload))
          }
          try {
            const { nodeId, field, oldText, newText } = JSON.parse(body) as {
              nodeId?: string
              field?: string
              oldText?: string
              newText?: string
            }
            if (!nodeId || !field || !EDITABLE_FIELDS.has(field) || !newText?.trim()) {
              return reply(400, { error: 'nodeId, an editable field, and non-empty newText are required' })
            }
            const file = join(process.cwd(), 'src', 'content', 'site-content.json')
            const content = JSON.parse(readFileSync(file, 'utf8')) as {
              site: Record<string, unknown>
              pages: Array<Record<string, unknown>>
              workshops: Array<Record<string, unknown>>
            }
            let target: Record<string, unknown> | null = null
            const walk = (n: Record<string, unknown>) => {
              if (n.id === nodeId) target = n
              for (const key of ['blocks', 'items'] as const) {
                for (const child of (n[key] as Array<Record<string, unknown>> | undefined) ?? []) walk(child)
              }
            }
            for (const n of [content.site, ...content.pages, ...content.workshops]) walk(n)
            if (!target) return reply(404, { error: `node ${nodeId} not found` })
            const current = (target as Record<string, unknown>)[field]
            if ((current ?? '') !== (oldText ?? '')) {
              return reply(409, { error: 'text changed since the page loaded — reload and retry' })
            }
            ;(target as Record<string, unknown>)[field] = newText.trim()
            writeFileSync(file, JSON.stringify(content, null, 2) + '\n')
            reply(200, { ok: true })
          } catch (err) {
            reply(400, { error: String(err) })
          }
        })
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  base,
  plugins: [feedbackInbox(), contentEditEndpoint(), react(), tailwindcss()],
})
