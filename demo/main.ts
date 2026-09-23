import {
  Component,
  action,
  api,
  behavior,
  config,
  css,
  define,
  each,
  effect,
  html,
  render,
  resource,
  signal,
  start,
  when,
} from '../mini.ts'

// ---- Request log (demo only) --------------------------------------------------
// Wraps window.fetch and listens to mini's events so you can see what each feature does.

const logList = document.getElementById('log')!
function log(kind: 'req' | 'res' | 'event' | 'bad', text: string) {
  const li = document.createElement('li')
  li.className = kind
  li.textContent = `${new Date().toLocaleTimeString()}  ${text}`
  logList.prepend(li)
}
document.getElementById('clear-log')!.onclick = () => logList.replaceChildren()

const realFetch = window.fetch.bind(window)
window.fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input)
  const headers = new Headers(init?.headers)
  const csrf = ['X-CSRF-Token', 'X-XSRF-TOKEN'].filter((n) => headers.has(n)).map((n) => `${n}: ${headers.get(n)}`)
  log('req', `→ ${init?.method ?? 'GET'} ${url}${csrf.length ? `   [${csrf.join(', ')}]` : ''}`)
  try {
    const res = await realFetch(input, init)
    const moved = res.redirected ? `, followed a redirect to ${new URL(res.url).pathname}` : ''
    log(res.ok ? 'res' : 'bad', `← ${res.status} ${res.statusText}${moved}   (${url})`)
    return res
  } catch (e) {
    log('bad', `← ${(e as Error).name}   (${url})`)
    throw e
  }
}

const describe: Record<string, (d: any, e: Event) => string> = {
  'mini:before': (d) => `${d.method} ${d.url} starting, target ${d.target.id ? '#' + d.target.id : d.target.tagName.toLowerCase()}`,
  'mini:after': (d) => `swapped the reply into ${d.target.id ? '#' + d.target.id : d.target.tagName.toLowerCase()}`,
  'mini:error': (d) =>
    d.error ? `refused / failed: ${d.error.message ?? d.error}` : `HTTP ${d.response.status}, ${d.swapped ? 'error HTML swapped in (data-swap-error)' : 'nothing swapped'}`,
  'mini:redirect': (d, e) =>
    `redirected to ${new URL(d.url).pathname}: ${e.defaultPrevented ? 'cancelled, swapping the reply instead' : 'navigating the whole page'}`,
}
for (const [type, text] of Object.entries(describe)) {
  document.addEventListener(type, (e) => log(type === 'mini:error' ? 'bad' : 'event', `★ ${type}  ${text((e as CustomEvent).detail, e)}`))
}

// ---- 1. Component with props and state ---------------------------------------

class MiniCounter extends Component {
  static props = {
    label: { type: String, default: 'Count' },
    count: { type: Number, default: 0, reflect: true },
  }
  declare label: string
  declare count: number

  static styles = css`
    button {
      font: inherit;
      padding: 6px 12px;
      border-radius: 6px;
      border: 1px solid #8884;
      background: none;
      color: inherit;
      cursor: pointer;
    }
    strong {
      color: #2f5bd3;
    }
  `

  render() {
    return html`<button @click=${this.increment}>${this.label}: <strong>${this.count}</strong></button>`
  }

  increment() {
    this.count++
    this.emit('count-changed', { count: this.count })
  }
}
define('mini-counter', MiniCounter)

// ---- 2. Fetch JSON and loop ----------------------------------------------------

type User = { id: number; name: string; role: string }

class UserSearch extends Component {
  static shadow = false // use the page's styles

  query = signal('')
  adminsOnly = signal(false)
  users = resource((signal) => api.get<User[]>('/demo-api/users', { query: { q: this.query.value }, signal }), [])

  render() {
    const list = (this.users.data.value ?? []).filter((u) => !this.adminsOnly.value || u.role === 'admin')
    return html`
      <div class="row">
        <input placeholder="Filter users…" .value=${this.query.value} @input=${(e: Event) => (this.query.value = (e.target as HTMLInputElement).value)} />
        <label><input type="checkbox" .checked=${this.adminsOnly.value} @change=${() => (this.adminsOnly.value = !this.adminsOnly.value)} /> Admins only</label>
        ${when(this.users.loading.value, () => html`<span class="muted">Loading…</span>`)}
      </div>
      ${when(
        list.length,
        () => html`<ul>
          ${each(list, 'id', (u) => html`<li><strong>${u.name}</strong> <span class="tag">${u.role}</span></li>`)}
        </ul>`,
        () => html`<p class="muted">No users match.</p>`,
      )}
    `
  }

  disconnectedCallback() {
    super.disconnectedCallback()
    this.users.dispose()
  }
}
define('user-search', UserSearch)

// ---- 3. Loop links from data ---------------------------------------------------

const links = signal([
  { id: 1, url: '#home', label: 'Home' },
  { id: 2, url: '#docs', label: 'Docs' },
  { id: 3, url: '#blog', label: 'Blog' },
])
const active = signal(1)

effect(() =>
  render(
    html`${each(
      links.value,
      'id',
      (l) =>
        html`<a href=${l.url} class=${l.id === active.value ? 'active' : null} @click=${() => (active.value = l.id)}>${l.label}</a>`,
    )}`,
    document.getElementById('links')!,
  ),
)
document.getElementById('shuffle')!.onclick = () => (links.value = [...links.value].sort(() => Math.random() - 0.5))
document.getElementById('add-link')!.onclick = () => {
  const id = links.value.length + 1
  links.value = [...links.value, { id, url: `#page-${id}`, label: `Page ${id}` }]
}

// ---- 4. Behaviors and actions --------------------------------------------------

behavior('dropdown', (el) => {
  const menu = el.querySelector('ul')!
  const onDoc = (e: Event) => {
    if (!el.contains(e.target as Node)) menu.hidden = true
  }
  document.addEventListener('click', onDoc)
  return {
    toggle: () => (menu.hidden = !menu.hidden),
    pick: (_e: Event, item: HTMLElement) => {
      menu.hidden = true
      toast(`Picked: ${item.dataset.value}`)
    },
    destroy: () => document.removeEventListener('click', onDoc),
  }
})

action('copy', (_e, el) => {
  void navigator.clipboard?.writeText(el.dataset.text ?? '').catch(() => {})
  toast(el.dataset.text ?? '')
})

action('mirror', (_e, el) => {
  document.getElementById('mirror')!.textContent = (el as HTMLInputElement).value
})

action('reset-after', (_e, form) => {
  form.addEventListener('mini:after', () => (form as HTMLFormElement).reset(), { once: true })
})

// ---- 7. Errors, redirects and CSRF -------------------------------------------

// A cookie-style CSRF token, like some frameworks set. The demo server accepts it via X-XSRF-TOKEN.
document.cookie = 'XSRF-TOKEN=demo-cookie-token; path=/; SameSite=Lax'

action('csrf-mode', (_e, el) => {
  const mode = (el as HTMLInputElement).value
  config.csrf =
    mode === 'cookie' ? { cookie: 'XSRF-TOKEN', header: 'X-XSRF-TOKEN' } : { meta: 'csrf-token', header: 'X-CSRF-Token' }
  log('event', `config.csrf = ${JSON.stringify(config.csrf)}`)
})

// This one redirect is expected (a moved URL), so swap the reply instead of navigating.
document.getElementById('redirect-swap')!.addEventListener('mini:redirect', (e) => e.preventDefault())

document.addEventListener('mini:error', (e) => {
  const d = (e as CustomEvent).detail
  if (d.swapped) return // e.g. 422 validation errors rendered into the form
  toast(d.response ? `Request failed: HTTP ${d.response.status}` : String(d.error ?? 'Network error'))
})

function toast(message: string) {
  document.getElementById('toast')?.remove()
  const el = document.createElement('div')
  el.id = 'toast'
  el.textContent = message
  document.body.append(el)
  setTimeout(() => el.remove(), 1800)
}

start()
