import { StrictMode } from 'react'
import { createRoot, hydrateRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import { guardAgainstFraming } from './lib/frameBuster'
import './index.css'

// Interim clickjacking control for the portal (spec CDT-00 D3). Runs before the
// app mounts, and on portal routes only. When it returns 'refused' the document
// has already been replaced with a notice and the app must NOT mount over it.
// See src/lib/frameBuster.ts for why refusal rather than escape, and
// docs/SECURITY.md for what this does not protect against.
const frameVerdict = guardAgainstFraming(import.meta.env.BASE_URL)

const rootEl = frameVerdict === 'refused' ? null : document.getElementById('root')
const app = (
  <StrictMode>
    <BrowserRouter basename={import.meta.env.BASE_URL}>
      <App />
    </BrowserRouter>
  </StrictMode>
)

// Prerendered pages ship real HTML; hydrate it. Dev (empty root) renders fresh.
// A null root means the frame guard refused this load and owns the document.
if (rootEl) {
  if (rootEl.hasChildNodes()) {
    hydrateRoot(rootEl, app)
  } else {
    createRoot(rootEl).render(app)
  }
}
