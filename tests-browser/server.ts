import type { Plugin } from 'vite'
import type { IncomingMessage, ServerResponse } from 'node:http'

/**
 * A real HTTP backend for the browser tests (served by the Vitest browser server).
 * Endpoints echo what actually arrived over the network, so tests can check real
 * encodings, headers and redirects rather than a mocked fetch.
 */

const readBody = (req: IncomingMessage) =>
  new Promise<Buffer>((resolve) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
  })

function send(res: ServerResponse, status: number, body: string, type = 'text/html') {
  res.statusCode = status
  res.setHeader('Content-Type', type)
  res.end(body)
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))
const counters = new Map<string, number>()

/** A page (for iframes) that loads mini from source, like an app would. */
const page = (body: string) => `<!doctype html><meta charset="utf-8"><title>test page</title>
${body}
<script type="module">
  import * as mini from '/mini.ts'
  mini.start()
  window.mini = mini
  window.ready = true
</script>`

export function testApi(): Plugin {
  return {
    name: 'test-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        if (!url.pathname.startsWith('/test-api/')) return next()
        const path = url.pathname.slice('/test-api'.length)

        // Echo the request as JSON inside <pre data-echo>, so it can be swapped into the page.
        if (path === '/echo') {
          const raw = await readBody(req)
          const echo = {
            method: req.method,
            query: Object.fromEntries(url.searchParams),
            contentType: req.headers['content-type'] ?? null,
            body: raw.toString('latin1'),
            csrf: req.headers['x-csrf-token'] ?? null,
            xsrf: req.headers['x-xsrf-token'] ?? null,
            miniRequest: req.headers['x-mini-request'] ?? null,
          }
          return send(res, 200, `<pre data-echo>${esc(JSON.stringify(echo))}</pre>`)
        }

        // A slow write that counts how many times it really reached the server.
        if (path === '/save') {
          const key = url.searchParams.get('key') ?? 'default'
          counters.set(key, (counters.get(key) ?? 0) + 1)
          await delay(Number(url.searchParams.get('ms') ?? 300))
          return send(res, 200, `<p class="saved">saved ${counters.get(key)}</p>`)
        }
        if (path === '/count') return send(res, 200, String(counters.get(url.searchParams.get('key') ?? 'default') ?? 0), 'text/plain')

        // Server-side validation: 422 with the re-rendered form.
        if (path === '/validate') {
          const name = new URLSearchParams((await readBody(req)).toString()).get('name')?.trim()
          if (!name) {
            return send(res, 422, `<form id="vform" action="/test-api/validate" method="post" data-fetch data-target="#vform" data-swap="outerHTML" data-swap-error="422"><input name="name"><p class="error">Name is required</p><button>Save</button></form>`)
          }
          return send(res, 200, `<p id="vform" class="ok">Saved ${esc(name)}</p>`)
        }

        // Expired session: redirect to the login page.
        if (path === '/private') {
          res.statusCode = 302
          res.setHeader('Location', '/test-api/login')
          return res.end()
        }
        if (path === '/login') return send(res, 200, '<!doctype html><title>login</title><h1>Login page</h1>')

        if (path === '/page/redirect') {
          return send(res, 200, page(`<button id="go" data-get="/test-api/private" data-target="#out">go</button><div id="out">untouched</div>`))
        }

        send(res, 404, 'Not found', 'text/plain')
      })
    },
  }
}
