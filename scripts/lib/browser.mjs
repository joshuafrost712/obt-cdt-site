// A minimal Chrome DevTools Protocol driver: launch headless Chrome, load a
// page, capture what the console said, screenshot it, and read a metric back.
//
// No dependency. Node's global WebSocket (21+) is the whole client, which is
// the reason this file exists rather than a puppeteer install: spec CDT-00's
// checks have to be runnable in any session, and a browser download is the kind
// of prerequisite that turns into a skipped check.
//
// `--headless=new` is required. Old headless renders this site blank, because
// the reveal-on-scroll animation never fires.
//
// CSP violations arrive on two channels and both are captured, because a
// blocked resource is a Log.entryAdded and a blocked script is also a
// securitypolicyviolation event. Reading only console output misses cases.

import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const CHROME =
  process.env.CHROME_PATH ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Chrome logs this as a console error on every page, and it is not a violation:
// it is the browser telling us the thing spec CDT-00 D2 already says out loud,
// that frame-ancestors is ignored in a meta tag. Counting it as a violation
// would make criterion 3 permanently red for a directive we keep on purpose.
// Anything else matching /Content Security Policy|Refused to/ is real.
const EXPECTED_CSP_NOTICES = [
  /directive 'frame-ancestors' is ignored when delivered via a <meta> element/i,
]

const isExpectedNotice = (text) => EXPECTED_CSP_NOTICES.some((re) => re.test(text))

export async function launch({ port = 9333, width = 1440, height = 2400 } = {}) {
  const profile = await mkdtemp(path.join(tmpdir(), 'cdt00-chrome-'))
  const child = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      `--window-size=${width},${height}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
    ],
    { stdio: 'ignore' },
  )

  let version
  for (let i = 0; i < 60; i++) {
    try {
      version = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json())
      break
    } catch {
      await sleep(250)
    }
  }
  if (!version) {
    child.kill()
    throw new Error(`Chrome did not open a debugging port on ${port}`)
  }

  return {
    version,
    port,
    async close() {
      try {
        await fetch(`http://127.0.0.1:${port}/json/close/`).catch(() => {})
      } catch {}
      child.kill()
      await rm(profile, { recursive: true, force: true })
    },
  }
}

class Session {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    this.events = []
    // sessionId -> targetInfo, for out-of-process iframes (see send()).
    this.childSessions = new Map()
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)
      } else if (msg.method) {
        if (msg.method === 'Target.attachedToTarget') {
          this.childSessions.set(msg.params.sessionId, msg.params.targetInfo)
        }
        if (msg.method === 'Target.detachedFromTarget') {
          this.childSessions.delete(msg.params.sessionId)
        }
        this.events.push(msg)
      }
    })
  }

  // The handbook is roughly 22,000px tall, so a beyond-viewport capture of it
  // takes well over the default. Timeouts are per call rather than global.
  // `sessionId` addresses an auto-attached child target. A cross-SITE iframe is
  // put in its own renderer process, and Page.createIsolatedWorld from the parent
  // session cannot reach it, so reading such a frame needs its own session. That
  // is not an edge case here: the deployed site is on github.io while a test
  // harness page is on localhost.
  send(method, params = {}, timeout = 30000, sessionId = undefined) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} timed out after ${timeout}ms`))
      }, timeout)
    })
  }
}

async function connect(browser) {
  const target = await fetch(`http://127.0.0.1:${browser.port}/json/new`, {
    method: 'PUT',
  }).then((r) => r.json())
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', reject, { once: true })
  })
  const s = new Session(ws)
  await Promise.all([
    s.send('Page.enable'),
    s.send('Runtime.enable'),
    s.send('Log.enable'),
    s.send('Network.enable'),
    // flatten:true routes child-target traffic over this same socket, addressed
    // by sessionId. Without it, a cross-site iframe is invisible to this session.
    s.send('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    }),
  ])
  return { session: s, targetId: target.id, ws }
}

/**
 * Load one URL and report what happened on it.
 * Returns { violations, consoleErrors, requests, status, lcp, screenshot }.
 */
export async function visit(
  browser,
  url,
  { settle = 1400, screenshot = false, fullPage = false, scroll = false, frames = false } = {},
) {
  const { session, targetId, ws } = await connect(browser)
  const violations = []
  const notices = []
  const consoleErrors = []
  const requests = []

  // securitypolicyviolation fires in the page; forward it into a global the
  // driver reads back, because CDP has no dedicated CSP-violation event.
  await session.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      window.__cspViolations = [];
      document.addEventListener('securitypolicyviolation', (e) => {
        window.__cspViolations.push({
          directive: e.effectiveDirective || e.violatedDirective,
          blockedURI: e.blockedURI,
          source: e.sourceFile || '',
          line: e.lineNumber || 0,
        });
      });
      window.__lcp = 0;
      try {
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) window.__lcp = entry.startTime;
        }).observe({ type: 'largest-contentful-paint', buffered: true });
      } catch (e) {}
    `,
  })

  await session.send('Page.navigate', { url })
  await sleep(settle)
  if (scroll) {
    // The reveal-on-scroll animation gates most of the page's content.
    await session.send('Runtime.evaluate', {
      expression: `(async () => {
        const step = Math.round(window.innerHeight * 0.8);
        for (let y = 0; y < document.body.scrollHeight; y += step) {
          window.scrollTo(0, y);
          await new Promise(r => setTimeout(r, 60));
        }
        window.scrollTo(0, 0);
        await new Promise(r => setTimeout(r, 200));
      })()`,
      awaitPromise: true,
    })
  }
  await sleep(300)

  for (const ev of session.events) {
    if (ev.method === 'Log.entryAdded') {
      const e = ev.params.entry
      if (e.level === 'error') {
        const text = e.text || ''
        if (isExpectedNotice(text)) {
          notices.push(text)
        } else if (/Content Security Policy|Refused to/i.test(text)) {
          violations.push({ source: 'Log', text, url: e.url || '' })
        } else {
          consoleErrors.push({ source: e.source, text, url: e.url || '' })
        }
      }
    }
    if (ev.method === 'Runtime.consoleAPICalled' && ev.params.type === 'error') {
      const text = (ev.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ')
      if (isExpectedNotice(text)) {
        notices.push(text)
      } else if (/Content Security Policy|Refused to/i.test(text)) {
        violations.push({ source: 'console', text, url: '' })
      } else if (text) {
        consoleErrors.push({ source: 'console', text, url: '' })
      }
    }
    if (ev.method === 'Network.requestWillBeSent') {
      requests.push(ev.params.request.url)
    }
  }

  const pageViolations = await session
    .send('Runtime.evaluate', {
      expression: 'JSON.stringify(window.__cspViolations || [])',
      returnByValue: true,
    })
    .then((r) => JSON.parse(r.result.value || '[]'))
    .catch(() => [])
  for (const v of pageViolations) {
    violations.push({ source: 'event', text: `${v.directive} blocked ${v.blockedURI}`, url: v.source })
  }

  const lcp = await session
    .send('Runtime.evaluate', { expression: 'window.__lcp || 0', returnByValue: true })
    .then((r) => Math.round(r.result.value))
    .catch(() => 0)

  const title = await session
    .send('Runtime.evaluate', { expression: 'document.title', returnByValue: true })
    .then((r) => r.result.value)
    .catch(() => '')

  const bodyText = await session
    .send('Runtime.evaluate', {
      expression: 'document.body ? document.body.innerText.slice(0, 400) : ""',
      returnByValue: true,
    })
    .then((r) => r.result.value)
    .catch(() => '')

  // Read the top document's URL while the socket is still open. This has to sit
  // before ws.close(); it was below it once, which made every frame-buster check
  // report an empty href and read as a failure.
  const href = await session
    .send('Runtime.evaluate', { expression: 'location.href', returnByValue: true })
    .then((r) => r.result.value)
    .catch(() => '')

  // A cross-origin child frame cannot be read from the parent page, so the
  // frame-buster check reads it through CDP instead: walk the frame tree and
  // evaluate in an isolated world per child frame. Without this, "is the portal
  // refusing to render inside the frame?" is unanswerable from the outside.
  const childFrames = []
  if (frames) {
    const probe = async (read, url) =>
      childFrames.push({
        url,
        title: await read('document.title'),
        text: (await read('document.body ? document.body.innerText : ""')) || '',
        marker: await read(
          'document.querySelector("[data-testid=\'cdt-frame-refused\']") ? true : false',
        ),
      })

    // Same-process iframes: an isolated world in the parent's session reaches them.
    try {
      const { frameTree } = await session.send('Page.getFrameTree')
      for (const child of frameTree.childFrames || []) {
        const { executionContextId } = await session.send('Page.createIsolatedWorld', {
          frameId: child.frame.id,
          worldName: 'cdt00-probe',
        })
        await probe(
          (expr) =>
            session
              .send('Runtime.evaluate', {
                expression: expr,
                contextId: executionContextId,
                returnByValue: true,
              })
              .then((r) => r.result.value)
              .catch(() => ''),
          child.frame.url,
        )
      }
    } catch {
      /* no frames, or the page navigated away mid-probe */
    }

    // Cross-site iframes: their own renderer process, their own session.
    for (const [sessionId, info] of session.childSessions) {
      if (info.type !== 'iframe') continue
      if (childFrames.some((f) => f.url === info.url)) continue
      try {
        await session.send('Runtime.enable', {}, 30000, sessionId)
        await probe(
          (expr) =>
            session
              .send('Runtime.evaluate', { expression: expr, returnByValue: true }, 30000, sessionId)
              .then((r) => r.result.value)
              .catch(() => ''),
          info.url,
        )
      } catch {
        /* target went away */
      }
    }
  }

  let shot = null
  if (screenshot) {
    shot = await session
      .send('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: fullPage,
      })
      .then((r) => Buffer.from(r.data, 'base64'))
  }

  ws.close()
  await fetch(`http://127.0.0.1:${browser.port}/json/close/${targetId}`).catch(() => {})

  return {
    violations,
    notices,
    consoleErrors,
    requests,
    lcp,
    title,
    href,
    bodyText,
    childFrames,
    screenshot: shot,
  }
}

/**
 * Load a URL at a fixed viewport and return just the PNG.
 * `anchor` scrolls one element into view first, which is how a section of the
 * 22,000px handbook gets photographed without capturing the whole page.
 */
export async function shoot(
  browser,
  url,
  { width, height = 900, fullPage = true, anchor = null },
) {
  const { session, targetId, ws } = await connect(browser)
  await session.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: width < 600,
  })
  await session.send('Page.navigate', { url })
  await sleep(1600)
  await session.send('Runtime.evaluate', {
    expression: `(async () => {
      const step = Math.round(window.innerHeight * 0.8);
      for (let y = 0; y < document.body.scrollHeight; y += step) {
        window.scrollTo(0, y);
        await new Promise(r => setTimeout(r, 70));
      }
      window.scrollTo(0, 0);
      await new Promise(r => setTimeout(r, 400));
    })()`,
    awaitPromise: true,
  })
  await session.send('Runtime.evaluate', {
    expression: 'document.fonts ? document.fonts.ready.then(() => true) : true',
    awaitPromise: true,
  })
  if (anchor) {
    // Scroll to the anchor TWICE. The reveal-on-scroll animation changes element
    // heights as it fires, so a single scrollIntoView lands at an offset that has
    // moved by the time the capture happens, and a before/after pair ends up
    // photographing different parts of the page.
    const goTo = () =>
      session.send('Runtime.evaluate', {
        expression: `(() => {
          const el = document.querySelector(${JSON.stringify(anchor)});
          if (!el) return 'anchor-missing';
          el.scrollIntoView({ block: 'start', behavior: 'instant' });
          return Math.round(window.scrollY);
        })()`,
        returnByValue: true,
      })
    const first = await goTo()
    await sleep(700)
    const second = await goTo()
    await sleep(700)
    const third = await goTo()
    if (third.result.value !== second.result.value) {
      console.warn(
        `    anchor ${anchor} has not settled: ${first.result.value} → ` +
          `${second.result.value} → ${third.result.value}`,
      )
    }
  }
  const png = await session
    .send(
      'Page.captureScreenshot',
      { format: 'png', captureBeyondViewport: fullPage },
      fullPage ? 180000 : 30000,
    )
    .then((r) => Buffer.from(r.data, 'base64'))
  ws.close()
  await fetch(`http://127.0.0.1:${browser.port}/json/close/${targetId}`).catch(() => {})
  return png
}
