import { afterEach, expect, it, vi } from 'vitest'
import { action, api, Component, computed, define, effect, html, render, resource, signal, start, tick } from '../mini'

afterEach(() => { document.body.replaceChildren(); vi.unstubAllGlobals() })

it('preserves Headers passed to api', async () => {
  const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => new Response('{}', { headers: { 'Content-Type': 'application/json' } }))
  vi.stubGlobal('fetch', fetcher)
  await api.get('/x', { headers: new Headers({ Authorization: 'Bearer test' }) })
  expect(new Headers(fetcher.mock.calls[0][1]!.headers).get('Authorization')).toBe('Bearer test')
})

it('renders static attribute portions when the initial binding is undefined', () => {
  const root = document.createElement('div')
  render(html`<div class="button ${undefined}"></div>`, root)
  expect(root.querySelector('div')!.getAttribute('class')).toBe('button ')
})

it('does not lose updates when reconnected with an old render pending', async () => {
  class Counter extends Component {
    count = signal(0)
    render() { return html`${this.count.value}` }
  }
  define('review-counter', Counter)
  const el = document.createElement('review-counter') as Counter
  document.body.append(el)
  el.count.value = 1
  el.remove()
  document.body.append(el)
  el.count.value = 2
  await tick()
  expect(el.shadowRoot!.textContent).toBe('2')
})

it('does not execute actions outside the start scope', () => {
  const handler = vi.fn()
  action('review-outside', handler)
  document.body.innerHTML = '<div data-action="review-outside"><section><button>click</button></section></div>'
  const stop = start(document.querySelector('section')!)
  try {
    document.querySelector('button')!.click()
    expect(handler).not.toHaveBeenCalled()
  } finally { stop() }
})

it('refreshes conditional dependencies on resource reload', async () => {
  let useB = false
  const a = signal('a'), b = signal('b')
  const fetcher = vi.fn(async () => useB ? b.value : a.value)
  const r = resource(fetcher)
  try {
    await tick()
    useB = true
    await r.reload()
    b.value = 'new b'
    await tick()
    expect(r.data.value).toBe('new b')
  } finally { r.dispose() }
})

it('retries a failed computed after its input changes', () => {
  const s = signal(0)
  const c = computed(() => { if (!s.value) throw new Error('not ready'); return s.value })
  let value = 0
  const stop = effect(() => { try { value = c.value } catch {} })
  try {
    s.value = 1
    expect(value).toBe(1)
  } finally { stop() }
})

it('cancels delayed requests when their element is removed', async () => {
  const fetcher = vi.fn(async () => new Response('ok'))
  vi.stubGlobal('fetch', fetcher)
  document.body.innerHTML = '<button data-post="/save" data-trigger="click delay:30ms">Save</button>'
  const stop = start()
  try {
    const button = document.querySelector('button')!
    button.click()
    button.remove()
    await new Promise(r => setTimeout(r, 60))
    expect(fetcher).not.toHaveBeenCalled()
  } finally { stop() }
})
