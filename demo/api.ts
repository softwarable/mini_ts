import type { Plugin } from 'vite'
import type { IncomingMessage, ServerResponse } from 'node:http'

/**
 * A tiny fake backend for the demo page (dev server only).
 * It returns HTML fragments or JSON, like a typical server-rendered app would.
 */
const users = [
  { id: 1, name: 'Ada Lovelace', role: 'admin' },
  { id: 2, name: 'Grace Hopper', role: 'editor' },
  { id: 3, name: 'Alan Turing', role: 'viewer' },
  { id: 4, name: 'Katherine Johnson', role: 'editor' },
  { id: 5, name: 'Linus Torvalds', role: 'viewer' },
  { id: 6, name: 'Margaret Hamilton', role: 'admin' },
]
let todos = [
  { id: 1, text: 'Write mini.ts' },
  { id: 2, text: 'Use it in a real project' },
]
let nextId = 3

/** The CSRF tokens the demo page exposes (meta tag and cookie, set in index.html / main.ts). */
const CSRF = { meta: 'demo-token', cookie: 'demo-cookie-token' }

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
const todoLi = (t: { id: number; text: string }) =>
  `<li id="todo-${t.id}">${esc(t.text)} <button class="link" data-delete="/demo-api/todos/${t.id}" data-target="#todo-${t.id}" data-swap="outerHTML" data-confirm="Delete this todo?">remove</button></li>`

/** The item form, as the server renders it. Also returned (with errors) as the 422 response. */
export const itemForm = ({ name = '', error = '', note = '' } = {}) => `<form id="item-form" action="/demo-api/items" method="post" data-fetch data-target="#item-form" data-swap="outerHTML" data-swap-error="422">
  <div class="row">
    <input name="name" value="${esc(name)}" placeholder="Item name" minlength="2" aria-label="Item name" />
    <button name="op" value="save">Save</button>
    <button formaction="/demo-api/items/preview" formmethod="get" name="op" value="preview">Preview</button>
  </div>
  ${error ? `<p class="error">${esc(error)}</p>` : ''}${note ? `<p class="ok">${esc(note)}</p>` : ''}
</form>`

const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let data = ''
    req.on('data', (c) => (data += c))
    req.on('end', () => resolve(data))
  })

function send(res: ServerResponse, status: number, type: string, body: string) {
  res.statusCode = status
  res.setHeader('Content-Type', type)
  res.end(body)
}

function redirect(res: ServerResponse, location: string) {
  res.statusCode = 302
  res.setHeader('Location', location)
  res.end()
}

/** Accept either CSRF style: meta token in X-CSRF-Token, or cookie token in X-XSRF-TOKEN. */
const csrfOk = (req: IncomingMessage) =>
  req.headers['x-csrf-token'] === CSRF.meta || req.headers['x-xsrf-token'] === CSRF.cookie

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function demoApi(): Plugin {
  return {
    name: 'demo-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        if (!url.pathname.startsWith('/demo-api/')) return next()
        await delay(250) // make loading states visible
        const route = `${req.method} ${url.pathname}`

        // Every state-changing request must carry a valid CSRF token.
        if (req.method !== 'GET' && !csrfOk(req)) return send(res, 403, 'text/html', 'CSRF token missing or invalid')

        // ---- JSON + HTML lists
        const q = (url.searchParams.get('q') ?? '').toLowerCase()
        const matches = users.filter((u) => u.name.toLowerCase().includes(q))
        if (route === 'GET /demo-api/users') return send(res, 200, 'application/json', JSON.stringify(matches))
        if (route === 'GET /demo-api/users.html') {
          const items = matches.map((u) => `<li><strong>${esc(u.name)}</strong> <span class="tag">${u.role}</span></li>`)
          return send(res, 200, 'text/html', items.join('') || '<li class="muted">No matches</li>')
        }
        if (route === 'GET /demo-api/time') {
          return send(res, 200, 'text/html', `<span>Server time: <strong>${new Date().toLocaleTimeString()}</strong></span>`)
        }

        // ---- todos
        if (route === 'GET /demo-api/todos') return send(res, 200, 'text/html', todos.map(todoLi).join(''))
        if (route === 'POST /demo-api/todos') {
          const text = new URLSearchParams(await readBody(req)).get('text')?.trim()
          if (!text) return send(res, 422, 'text/html', 'Text is required')
          const todo = { id: nextId++, text }
          todos.push(todo)
          return send(res, 200, 'text/html', todoLi(todo))
        }
        const del = /^DELETE \/demo-api\/todos\/(\d+)$/.exec(route)
        if (del) {
          todos = todos.filter((t) => t.id !== Number(del[1]))
          return send(res, 200, 'text/html', '')
        }

        // ---- native form with server-side validation
        if (route === 'POST /demo-api/items') {
          await delay(1200) // slow on purpose: try double-clicking Save
          const body = new URLSearchParams(await readBody(req))
          const name = body.get('name')?.trim() ?? ''
          if (!name) return send(res, 422, 'text/html', itemForm({ error: 'The name field is required.' }))
          return send(res, 200, 'text/html', itemForm({ name, note: `Saved "${name}" (sent op=${body.get('op')})` }))
        }
        if (route === 'GET /demo-api/items/preview') {
          const name = url.searchParams.get('name') ?? ''
          return send(res, 200, 'text/html', itemForm({ name, note: `Preview of "${name}" via GET (sent op=${url.searchParams.get('op')})` }))
        }

        // ---- errors and redirects
        if (route === 'GET /demo-api/fail') return send(res, 500, 'text/html', 'Boom')
        if (route === 'GET /demo-api/private') return redirect(res, '/demo-api/login') // "session expired"
        if (route === 'GET /demo-api/old-time') return redirect(res, '/demo-api/time') // a harmless moved URL
        if (route === 'GET /demo-api/login') {
          return send(res, 200, 'text/html', '<!doctype html><title>Login</title><h1>Login page</h1><p>Your session expired. <a href="/">Back to demo</a></p>')
        }
        send(res, 404, 'text/plain', 'Not found')
      })
    },
  }
}
