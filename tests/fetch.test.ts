import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, api, behavior, config, resource, signal, start, swap, tick, trigger } from '../mini'

type Handler = (req: Request) => Response | Promise<Response>
let handler: Handler
let requests: Request[]
let stop: () => void

const htmlRes = (body: string, init: ResponseInit = {}) =>
  new Response(body, { ...init, headers: { 'Content-Type': 'text/html', ...(init.headers as object) } })
const jsonRes = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { ...init, headers: { 'Content-Type': 'application/json' } })

/** Replace window.location with a same-origin fake that records navigations. */
function stubLocation(): string[] {
  const assigned: string[] = []
  const real = new URL(location.href)
  const loc = { origin: real.origin, toString: () => real.href }
  Object.defineProperty(loc, 'href', { set: (v: string) => assigned.push(v), get: () => real.href })
  vi.stubGlobal('location', loc)
  return assigned
}

/** Wait until pending fetches have settled and the DOM has been updated. */
const settle = async () => {
  for (let i = 0; i < 5; i++) await tick()
}

beforeEach(() => {
  document.head.innerHTML = ''
  document.body.innerHTML = ''
  requests = []
  handler = () => htmlRes('ok')
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(new URL(String(input), 'http://localhost/'), init)
    requests.push(req)
    if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError')
    return handler(req)
  })
  stop = start()
})

afterEach(() => {
  stop()
  vi.unstubAllGlobals()
  config.headers = {}
  config.baseUrl = ''
  config.csrf = { header: 'X-CSRF-Token', meta: 'csrf-token' }
  document.cookie = 'XSRF-TOKEN=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/'
})

describe('data-get / data-post', () => {
  it('click loads HTML into the target', async () => {
    handler = () => htmlRes('<li>Ada</li><li>Grace</li>')
    document.body.innerHTML = `<button data-get="/users" data-target="#list">Load</button><ul id="list"></ul>`
    await tick()
    document.querySelector('button')!.click()
    await settle()
    expect(document.querySelector('#list')!.innerHTML).toBe('<li>Ada</li><li>Grace</li>')
    const req = requests[0]
    expect(req.method).toBe('GET')
    expect(new URL(req.url).pathname).toBe('/users')
    expect(req.headers.get('X-Mini-Request')).toBe('true')
    expect(req.headers.get('X-Mini-Target')).toBe('list')
  })

  it('submits forms with urlencoded body and CSRF token, preventing native submit', async () => {
    document.head.innerHTML = '<meta name="csrf-token" content="tok123">'
    handler = async (req) => htmlRes(`<p>saved ${(await req.text()).replace(/&/g, ' ')}</p>`)
    document.body.innerHTML = `
      <form data-post="/save" data-target="#out">
        <input name="name" value="Ada">
        <input type="checkbox" name="admin" value="1" checked>
        <button name="intent" value="publish">Save</button>
      </form>
      <div id="out"></div>`
    await tick()
    const form = document.querySelector('form')!
    const ev = new Event('submit', { bubbles: true, cancelable: true })
    Object.defineProperty(ev, 'submitter', { value: form.querySelector('button') })
    form.dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(true)
    await settle()
    expect(document.querySelector('#out')!.textContent).toBe('saved name=Ada admin=1 intent=publish')
    expect(requests[0].headers.get('X-CSRF-Token')).toBe('tok123')
    expect(requests[0].headers.get('Content-Type')).toContain('application/x-www-form-urlencoded')
  })

  it('GET forms send fields as query params; data-vals adds values', async () => {
    document.body.innerHTML = `
      <form data-get="/search?x=1" data-vals='{"page":2}'><input name="q" value="hi there"></form>`
    await tick()
    document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await settle()
    const url = new URL(requests[0].url)
    expect(url.searchParams.get('x')).toBe('1')
    expect(url.searchParams.get('q')).toBe('hi there')
    expect(url.searchParams.get('page')).toBe('2')
  })

  it('swap modes: outerHTML, beforeend, afterbegin, delete', async () => {
    handler = (req) => htmlRes(`<b>${new URL(req.url).pathname.slice(1)}</b>`)
    document.body.innerHTML = `
      <div id="box"><i>old</i></div>
      <button id="a" data-get="/end" data-target="#box" data-swap="beforeend"></button>
      <button id="b" data-get="/begin" data-target="#box" data-swap="afterbegin"></button>
      <button id="c" data-get="/outer" data-target="#box" data-swap="outerHTML"></button>`
    await tick()
    for (const id of ['a', 'b']) {
      document.getElementById(id)!.click()
      await settle()
    }
    expect(document.getElementById('box')!.innerHTML).toBe('<b>begin</b><i>old</i><b>end</b>')
    document.getElementById('c')!.click()
    await settle()
    expect(document.getElementById('box')).toBeNull()
    expect(document.body.innerHTML).toContain('<b>outer</b>')
  })

  it('data-target supports this / closest / find', async () => {
    handler = () => htmlRes('new')
    document.body.innerHTML = `
      <div class="card"><button data-get="/x" data-target="closest .card">b</button></div>
      <section data-get="/y" data-target="find .slot"><span class="slot"></span><a id="go">go</a></section>`
    await tick()
    document.querySelector('button')!.click()
    await settle()
    expect(document.querySelector('.card')!.textContent).toBe('new')
    document.getElementById('go')!.click()
    await settle()
    expect(document.querySelector('.slot')!.textContent).toBe('new')
  })

  it('data-select picks part of the response', async () => {
    handler = () => htmlRes('<html><body><nav>skip</nav><main id="content"><p>main</p></main></body></html>')
    document.body.innerHTML = `<a href="/page" data-get="/page" data-select="#content" data-target="#slot">x</a><div id="slot"></div>`
    await tick()
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true })
    document.querySelector('a')!.dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(true)
    await settle()
    expect(document.getElementById('slot')!.innerHTML).toBe('<main id="content"><p>main</p></main>')
  })

  it('debounces with data-trigger="input delay:…" and aborts stale requests', async () => {
    vi.useFakeTimers()
    try {
      document.body.innerHTML = `<input name="q" data-get="/search" data-trigger="input delay:200ms" data-target="#r"><div id="r"></div>`
      await vi.advanceTimersByTimeAsync(0)
      const input = document.querySelector('input')!
      for (const v of ['a', 'ab', 'abc']) {
        input.value = v
        input.dispatchEvent(new Event('input', { bubbles: true }))
        await vi.advanceTimersByTimeAsync(50)
      }
      await vi.advanceTimersByTimeAsync(300)
      expect(requests.length).toBe(1)
      expect(new URL(requests[0].url).searchParams.get('q')).toBe('abc')
    } finally {
      vi.useRealTimers()
    }
  })

  it('a newer request for the same element wins', async () => {
    const gates: ((r: Response) => void)[] = []
    handler = () => new Promise((resolve) => gates.push(resolve))
    document.body.innerHTML = `<button data-get="/n" data-target="#t">b</button><div id="t"></div>`
    await tick()
    const button = document.querySelector('button')!
    button.click()
    button.click()
    await tick()
    expect(requests[0].signal.aborted).toBe(true)
    gates[1]?.(htmlRes('second'))
    gates[0]?.(htmlRes('first'))
    await settle()
    expect(document.getElementById('t')!.textContent).toBe('second')
  })

  it('load trigger fires on insert; data-loading is set while in flight', async () => {
    let release!: () => void
    handler = () => new Promise((r) => (release = () => r(htmlRes('loaded'))))
    const div = document.createElement('div')
    div.innerHTML = '<section data-get="/lazy" data-trigger="load">…</section>'
    document.body.append(div)
    await tick()
    const section = document.querySelector('section')!
    expect(section.hasAttribute('data-loading')).toBe(true)
    release()
    await settle()
    expect(section.textContent).toBe('loaded')
    expect(section.hasAttribute('data-loading')).toBe(false)
    expect(requests.length).toBe(1)
  })

  it('emits mini:error on HTTP errors and leaves the target untouched', async () => {
    handler = () => htmlRes('nope', { status: 500 })
    document.body.innerHTML = `<button data-get="/fail" data-target="#t">b</button><div id="t">keep</div>`
    await tick()
    const onError = vi.fn()
    document.addEventListener('mini:error', onError)
    document.querySelector('button')!.click()
    await settle()
    expect(onError).toHaveBeenCalledOnce()
    expect(document.getElementById('t')!.textContent).toBe('keep')
  })

  it('mini:before can cancel; data-confirm asks first', async () => {
    document.body.innerHTML = `
      <button id="a" data-get="/a">a</button>
      <button id="b" data-get="/b" data-confirm="Sure?">b</button>`
    await tick()
    document.getElementById('a')!.addEventListener('mini:before', (e) => e.preventDefault())
    document.getElementById('a')!.click()
    vi.stubGlobal('confirm', () => false)
    document.getElementById('b')!.click()
    await settle()
    expect(requests.length).toBe(0)
  })

  it('activates behaviors inside swapped content', async () => {
    const setup = vi.fn()
    behavior('fresh', setup)
    handler = () => htmlRes('<div data-behavior="fresh"></div>')
    document.body.innerHTML = `<button data-get="/x" data-target="#t">b</button><div id="t"></div>`
    await tick()
    document.querySelector('button')!.click()
    await settle()
    expect(setup).toHaveBeenCalledOnce()
  })

  it('trigger() and swap() work programmatically', async () => {
    handler = () => htmlRes('<b>manual</b>')
    document.body.innerHTML = `<div id="t" data-get="/m"></div><p id="p"></p>`
    await trigger(document.getElementById('t')!)
    expect(document.getElementById('t')!.innerHTML).toBe('<b>manual</b>')
    swap('#p', '<i>1</i><i>2</i><span>no</span>', 'innerHTML', 'i')
    expect(document.getElementById('p')!.innerHTML).toBe('<i>1</i><i>2</i>')
  })

  it('follows X-Mini-Redirect', async () => {
    const assigned = stubLocation()
    handler = () => htmlRes('', { headers: { 'X-Mini-Redirect': '/login' } })
    document.body.innerHTML = `<div id="t" data-post="/x"></div>`
    await trigger(document.getElementById('t')!)
    expect(assigned).toEqual(['/login'])
  })
})

describe('api', () => {
  it('GET parses JSON and supports query params and baseUrl', async () => {
    config.baseUrl = '/api'
    handler = () => jsonRes([{ id: 1 }])
    const data = await api.get<{ id: number }[]>('/users', { query: { q: 'a b', page: 2, skip: null } })
    expect(data).toEqual([{ id: 1 }])
    const url = new URL(requests[0].url)
    expect(url.pathname).toBe('/api/users')
    expect(url.search).toBe('?q=a+b&page=2')
    expect(requests[0].headers.get('Accept')).toBe('application/json')
  })

  it('POST sends JSON with CSRF and global headers', async () => {
    document.head.innerHTML = '<meta name="csrf-token" content="t0k">'
    config.headers = { 'X-App': 'mini' }
    handler = async (req) => jsonRes({ got: await req.json() }, { status: 201 })
    const res = await api.post('/users', { name: 'Ada' })
    expect(res).toEqual({ got: { name: 'Ada' } })
    const req = requests[0]
    expect(req.headers.get('Content-Type')).toBe('application/json')
    expect(req.headers.get('X-CSRF-Token')).toBe('t0k')
    expect(req.headers.get('X-App')).toBe('mini')
  })

  it('throws ApiError with parsed body on failure', async () => {
    handler = () => jsonRes({ errors: { name: 'required' } }, { status: 422 })
    const err = (await api.post("/users", {}).catch((e: unknown) => e)) as ApiError
    expect(err).toBeInstanceOf(ApiError)
    expect(err.status).toBe(422)
    expect(err.data).toEqual({ errors: { name: 'required' } })
  })

  it('handles 204 and text responses', async () => {
    handler = () => new Response(null, { status: 204 })
    expect(await api.delete('/x')).toBeUndefined()
    handler = () => new Response('plain', { headers: { 'Content-Type': 'text/plain' } })
    expect(await api.get('/x')).toBe('plain')
  })
})

describe('resource', () => {
  it('exposes data/loading/error signals and refetches when tracked signals change', async () => {
    handler = (req) => jsonRes([new URL(req.url).searchParams.get('q')])
    const q = signal('a')
    const r = resource((s) => api.get<string[]>('/search', { query: { q: q.value }, signal: s }))
    expect(r.loading.value).toBe(true)
    await settle()
    expect(r.loading.value).toBe(false)
    expect(r.data.value).toEqual(['a'])
    q.value = 'b'
    await settle()
    expect(r.data.value).toEqual(['b'])
    expect(requests.length).toBe(2)
    r.dispose()
  })

  it('captures errors and keeps the previous data', async () => {
    let fail = false
    handler = () => (fail ? jsonRes({}, { status: 500 }) : jsonRes('ok'))
    const r = resource(() => api.get<string>('/x'))
    await settle()
    fail = true
    await r.reload()
    expect(r.error.value).toBeInstanceOf(ApiError)
    expect(r.data.value).toBe('ok')
    expect(r.loading.value).toBe(false)
  })
})

/** Make a Response look like fetch() followed a redirect to `url`. */
function redirected(url: string, res: Response): Response {
  Object.defineProperty(res, 'redirected', { value: true })
  Object.defineProperty(res, 'url', { value: new URL(url, location.href).href })
  return res
}

const submit = (form: HTMLFormElement, submitter?: Element) => {
  const ev = new Event('submit', { bubbles: true, cancelable: true })
  if (submitter) Object.defineProperty(ev, 'submitter', { value: submitter })
  form.dispatchEvent(ev)
  return ev
}

describe('CSRF', () => {
  const cookieCsrf = () => {
    config.csrf = { cookie: 'XSRF-TOKEN', header: 'X-XSRF-TOKEN' }
    document.cookie = 'XSRF-TOKEN=abc%3D%3D; path=/'
  }

  it('reads a URL-encoded cookie and sends it in the configured header', async () => {
    cookieCsrf()
    document.body.innerHTML = `<button data-post="/save">b</button>`
    await tick()
    document.querySelector('button')!.click()
    await settle()
    await api.patch('/items/1', { a: 1 })
    for (const req of requests) {
      expect(req.headers.get('X-XSRF-TOKEN')).toBe('abc==')
      expect(req.headers.get('X-CSRF-Token')).toBeNull()
    }
    expect(requests.length).toBe(2)
  })

  it('falls back to the meta tag when the cookie is missing', async () => {
    config.csrf = { cookie: 'XSRF-TOKEN', meta: 'csrf-token', header: 'X-XSRF-TOKEN' }
    document.head.innerHTML = '<meta name="csrf-token" content="from-meta">'
    await api.post('/x')
    expect(requests[0].headers.get('X-XSRF-TOKEN')).toBe('from-meta')
  })

  it('is not sent on GET, and can be disabled', async () => {
    cookieCsrf()
    await api.get('/x')
    config.csrf = null
    await api.post('/x')
    expect(requests.map((r) => r.headers.get('X-XSRF-TOKEN'))).toEqual([null, null])
  })

})

describe('cross-origin safety', () => {
  beforeEach(() => {
    config.csrf = { cookie: 'XSRF-TOKEN', header: 'X-XSRF-TOKEN' }
    document.cookie = 'XSRF-TOKEN=secret; path=/'
  })

  it('api never sends the CSRF token to another origin', async () => {
    await api.post('https://evil.example/steal', {})
    await api.post('//evil.example/steal', {})
    await api.post(`${location.origin}/ok`, {})
    await api.post('/ok', {})
    expect(requests.map((r) => r.headers.get('X-XSRF-TOKEN'))).toEqual([null, null, 'secret', 'secret'])
  })

  it('declarative state-changing requests to another origin are refused', async () => {
    const onError = vi.fn()
    document.addEventListener('mini:error', onError)
    document.body.innerHTML = `
      <button data-post="https://evil.example/x">a</button>
      <form action="//evil.example/y" method="post" data-fetch></form>`
    await tick()
    document.querySelector('button')!.click()
    submit(document.querySelector('form')!)
    await settle()
    expect(requests.length).toBe(0)
    expect(onError).toHaveBeenCalledTimes(2)
    expect(String(onError.mock.calls[0][0].detail.error)).toMatch(/cross-origin/)
    document.removeEventListener('mini:error', onError)
  })

  it('declarative cross-origin GET is allowed but carries no CSRF token', async () => {
    document.body.innerHTML = `<button data-get="https://cdn.example/snippet">a</button>`
    await tick()
    document.querySelector('button')!.click()
    await settle()
    expect(requests.length).toBe(1)
    expect(requests[0].headers.get('X-XSRF-TOKEN')).toBeNull()
  })
})

describe('redirects', () => {
  it('an HTTP redirect navigates the window instead of swapping the login page', async () => {
    const assigned = stubLocation()
    handler = () => redirected('/login', htmlRes('<form>login page</form>'))
    document.body.innerHTML = `<button data-get="/items" data-target="#t">b</button><table id="t"><tr><td>rows</td></tr></table>`
    await tick()
    document.querySelector('button')!.click()
    await settle()
    expect(assigned).toEqual([`${location.origin}/login`])
    expect(document.getElementById('t')!.textContent).toBe('rows')
  })

  it('cancelling mini:redirect swaps the redirected response instead', async () => {
    const assigned = stubLocation()
    handler = () => redirected('/items/', htmlRes('<b>list</b>'))
    document.body.innerHTML = `<div id="t" data-get="/items"></div>`
    document.getElementById('t')!.addEventListener('mini:redirect', (e) => e.preventDefault())
    await trigger(document.getElementById('t')!)
    expect(assigned).toEqual([])
    expect(document.getElementById('t')!.innerHTML).toBe('<b>list</b>')
  })

  it('api: redirect to an HTML page navigates and throws; redirected JSON is returned', async () => {
    const assigned = stubLocation()
    handler = () => redirected('/login', htmlRes('<html>login</html>'))
    const err = (await api.get('/users').catch((e: unknown) => e)) as ApiError
    expect(err).toBeInstanceOf(ApiError)
    expect(err.message).toMatch(/Redirected/)
    expect(assigned).toEqual([`${location.origin}/login`])

    handler = () => redirected('/users/', jsonRes([1]))
    expect(await api.get('/users')).toEqual([1])
  })
})

describe('data-swap-error', () => {
  it('swaps validation-error HTML for listed statuses and reports it as an error', async () => {
    handler = () => htmlRes('<form id="item-form"><p class="error">Name is required</p></form>', { status: 422 })
    document.body.innerHTML = `
      <div id="modal"><form id="item-form" data-post="/items" data-target="#item-form" data-swap="outerHTML" data-swap-error="422"></form></div>`
    await tick()
    const after = vi.fn()
    const error = vi.fn()
    document.addEventListener('mini:after', after)
    document.addEventListener('mini:error', error)
    submit(document.querySelector('form')!)
    await settle()
    expect(document.querySelector('#modal .error')!.textContent).toBe('Name is required')
    expect(after).not.toHaveBeenCalled()
    expect(error.mock.calls[0][0].detail).toMatchObject({ swapped: true })
    document.removeEventListener('mini:after', after)
    document.removeEventListener('mini:error', error)
  })

  it('does not swap statuses that are not listed; supports 4xx patterns', async () => {
    let status = 500
    handler = () => htmlRes('<b>error page</b>', { status })
    document.body.innerHTML = `
      <div id="a" data-post="/x" data-swap-error="422, 409">keep</div>
      <div id="b" data-post="/x" data-swap-error="4xx">keep</div>`
    await trigger(document.getElementById('a')!)
    status = 409
    await trigger(document.getElementById('b')!)
    expect(document.getElementById('a')!.textContent).toBe('keep')
    expect(document.getElementById('b')!.textContent).toBe('error page')
  })
})

describe('data-fetch', () => {
  it('uses a form\'s native action and method', async () => {
    document.body.innerHTML = `
      <form action="/items/42" method="post" data-fetch data-target="#out"><input name="name" value="Acme"></form>
      <div id="out"></div>`
    await tick()
    const ev = submit(document.querySelector('form')!)
    await settle()
    expect(ev.defaultPrevented).toBe(true)
    expect(requests[0].method).toBe('POST')
    expect(new URL(requests[0].url).pathname).toBe('/items/42')
    expect(await requests[0].text()).toBe('name=Acme')
  })

  it('GET forms (no method) put fields in the query string', async () => {
    document.body.innerHTML = `<form action="/search" data-fetch><input name="q" value="acme"></form>`
    await tick()
    submit(document.querySelector('form')!)
    await settle()
    expect(requests[0].method).toBe('GET')
    expect(new URL(requests[0].url).search).toBe('?q=acme')
  })

  it('respects the submit button\'s formaction and formmethod', async () => {
    document.body.innerHTML = `
      <form action="/items/42" method="post" data-fetch>
        <button name="op" value="save">Save</button>
        <button formaction="/items/42/preview" formmethod="get" name="op" value="preview">Preview</button>
      </form>`
    await tick()
    const [save, preview] = document.querySelectorAll('button')
    submit(document.querySelector('form')!, save)
    await settle()
    submit(document.querySelector('form')!, preview)
    await settle()
    expect([requests[0].method, new URL(requests[0].url).pathname]).toEqual(['POST', '/items/42'])
    expect(await requests[0].text()).toBe('op=save')
    expect([requests[1].method, new URL(requests[1].url).pathname]).toEqual(['GET', '/items/42/preview'])
  })

  it('leaves method="dialog" forms and formmethod="dialog" buttons to the browser', async () => {
    document.body.innerHTML = `
      <form id="a" method="dialog" data-fetch></form>
      <form id="b" action="/x" method="post" data-fetch><button formmethod="dialog">Close</button></form>`
    await tick()
    const a = submit(document.getElementById('a') as HTMLFormElement)
    const b = submit(document.getElementById('b') as HTMLFormElement, document.querySelector('button')!)
    await settle()
    expect([a.defaultPrevented, b.defaultPrevented]).toEqual([false, false])
    expect(requests.length).toBe(0)
  })

  it('links use href; modifier clicks and target=_blank stay native', async () => {
    handler = () => htmlRes('<p>item</p>')
    document.body.innerHTML = `
      <a id="a" href="/items/42" data-fetch data-target="#out">Item</a>
      <a id="b" href="/items/43" target="_blank" data-fetch>New tab</a>
      <div id="out"></div>`
    await tick()
    // Runs after mini's document listener: record its decision, then stop happy-dom navigating.
    const native: boolean[] = []
    const record = (e: Event) => {
      native.push(!e.defaultPrevented)
      e.preventDefault()
    }
    window.addEventListener('click', record)
    document.getElementById('a')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true }))
    document.getElementById('b')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    window.removeEventListener('click', record)
    await settle()
    expect([...native, requests.length]).toEqual([true, true, 0])

    const plain = new MouseEvent('click', { bubbles: true, cancelable: true })
    document.getElementById('a')!.dispatchEvent(plain)
    await settle()
    expect(plain.defaultPrevented).toBe(true)
    expect(new URL(requests[0].url).pathname).toBe('/items/42')
    expect(document.getElementById('out')!.innerHTML).toBe('<p>item</p>')
  })
})

describe('request bodies', () => {
  it('DELETE sends form data in the body, never the URL', async () => {
    document.body.innerHTML = `
      <form>
        <input type="hidden" name="token" value="secret-hidden">
        <input name="note" value="typed by user">
        <button type="button" data-delete="/items/42" data-vals='{"reason":"cleanup"}'>Delete</button>
      </form>`
    await tick()
    document.querySelector('button')!.click()
    await settle()
    const req = requests[0]
    expect(req.method).toBe('DELETE')
    expect(new URL(req.url).pathname + new URL(req.url).search).toBe('/items/42')
    const body = new URLSearchParams(await req.text())
    expect(body.get('token')).toBe('secret-hidden')
    expect(body.get('note')).toBe('typed by user')
    expect(body.get('reason')).toBe('cleanup')
  })

  it('only GET uses the query string', async () => {
    document.body.innerHTML = `
      <button id="g" data-get="/a" data-vals='{"x":1}'></button>
      <button id="p" data-put="/b" data-vals='{"x":1}'></button>`
    await tick()
    document.getElementById('g')!.click()
    document.getElementById('p')!.click()
    await settle()
    const [get, put] = requests
    expect(new URL(get.url).search).toBe('?x=1')
    expect(new URL(put.url).search).toBe('')
    expect(await put.text()).toBe('x=1')
  })

  it('multipart: enctype is case-insensitive and formenctype overrides it', async () => {
    document.body.innerHTML = `
      <form id="upper" action="/u" method="post" enctype="MULTIPART/FORM-DATA" data-fetch><input name="a" value="1"></form>
      <form id="plain" action="/p" method="post" data-fetch>
        <input name="a" value="1">
        <button formenctype="multipart/form-data">Upload</button>
      </form>
      <form id="clobbered" action="/c" method="post" enctype="multipart/form-data" data-fetch><input name="enctype" value="x"></form>`
    await tick()
    submit(document.getElementById('upper') as HTMLFormElement)
    const plain = document.getElementById('plain') as HTMLFormElement
    submit(plain, plain.querySelector('button')!)
    submit(document.getElementById('clobbered') as HTMLFormElement)
    await settle()
    for (const req of requests) expect(req.headers.get('Content-Type')).toMatch(/^multipart\/form-data/)
    expect(requests.length).toBe(3)
  })
})

describe('native navigation stays native', () => {
  /** Record whether mini left the event alone, then stop happy-dom from navigating. */
  function nativeOutcome(dispatch: () => void): boolean[] {
    const native: boolean[] = []
    const record = (e: Event) => {
      native.push(!e.defaultPrevented)
      e.preventDefault()
    }
    window.addEventListener('click', record)
    window.addEventListener('submit', record)
    dispatch()
    window.removeEventListener('click', record)
    window.removeEventListener('submit', record)
    return native
  }

  it('<a download> and target="_blank" links are not intercepted', async () => {
    document.body.innerHTML = `
      <a id="d" href="/report.csv" download data-fetch>CSV</a>
      <a id="t" href="/items/1" target="_BLANK" data-get="/items/1">New tab</a>`
    await tick()
    const native = nativeOutcome(() => {
      for (const id of ['d', 't']) document.getElementById(id)!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    await settle()
    expect(native).toEqual([true, true])
    expect(requests.length).toBe(0)
  })

  it('forms with target="_blank" or a formtarget="_blank" button are not intercepted', async () => {
    document.body.innerHTML = `
      <form id="f" action="/print" method="post" target="_blank" data-fetch></form>
      <form id="g" action="/items" method="post" data-fetch>
        <button id="save">Save</button><button id="print" formtarget="_blank">Print</button>
        <button id="here" formtarget="_self">Here</button>
      </form>`
    await tick()
    const g = document.getElementById('g') as HTMLFormElement
    const native = nativeOutcome(() => {
      submit(document.getElementById('f') as HTMLFormElement)
      submit(g, document.getElementById('print')!)
      submit(g, document.getElementById('here')!)
    })
    await settle()
    expect(native).toEqual([true, true, false])
    expect(requests.map((r) => new URL(r.url).pathname)).toEqual(['/items'])
  })
})

describe('reads vs writes (in-flight policy)', () => {
  /** A fetch handler that waits until the test releases each request. */
  function gated() {
    const gates: ((r: Response) => void)[] = []
    handler = () => new Promise((resolve) => gates.push(resolve))
    return (i: number, res: Response) => gates[i](res)
  }

  it('a double-submitted write sends one request; the second submit is still kept from the browser', async () => {
    const release = gated()
    document.body.innerHTML = `<form action="/items" method="post" data-fetch data-target="#out" data-confirm="Save?"><input name="a" value="1"></form><div id="out"></div>`
    const confirmSpy = vi.fn(() => true)
    vi.stubGlobal('confirm', confirmSpy)
    await tick()
    const form = document.querySelector('form')!
    const first = submit(form)
    const second = submit(form)
    await tick()
    expect([first.defaultPrevented, second.defaultPrevented]).toEqual([true, true])
    expect(requests.length).toBe(1)
    expect(confirmSpy).toHaveBeenCalledOnce() // not asked again for the ignored duplicate
    release(0, htmlRes('saved'))
    await settle()
    expect(document.getElementById('out')!.textContent).toBe('saved')
    submit(form) // once finished, a new submit goes through
    await settle()
    expect(requests.length).toBe(2)
  })

  it('trigger() during a pending write returns the pending request', async () => {
    const release = gated()
    document.body.innerHTML = `<div id="t" data-post="/x"></div>`
    const el = document.getElementById('t')!
    const p1 = trigger(el)
    let secondDone = false
    const p2 = trigger(el).then(() => (secondDone = true))
    await tick()
    expect(secondDone).toBe(false)
    release(0, htmlRes('done'))
    await Promise.all([p1, p2])
    expect(requests.length).toBe(1)
    expect(el.textContent).toBe('done')
  })

  it('a pending read is replaced by a newer request (Preview, then Save)', async () => {
    const release = gated()
    document.body.innerHTML = `
      <form action="/items" method="post" data-fetch data-target="#out">
        <button id="save">Save</button><button id="preview" formaction="/items/preview" formmethod="get">Preview</button>
      </form><div id="out"></div>`
    await tick()
    const form = document.querySelector('form')!
    submit(form, document.getElementById('preview')!)
    submit(form, document.getElementById('save')!)
    await tick()
    expect(requests.map((r) => r.method)).toEqual(['GET', 'POST'])
    expect(requests[0].signal.aborted).toBe(true)
    release(1, htmlRes('saved'))
    release(0, htmlRes('preview'))
    await settle()
    expect(document.getElementById('out')!.textContent).toBe('saved')
  })

  it('removing the source mid-write does not abort it; completion fires on document with source', async () => {
    const release = gated()
    document.body.innerHTML = `<div id="modal"><button id="save" data-post="/items" data-target="#list">Save</button></div><ul id="list"></ul>`
    await tick()
    const button = document.getElementById('save')!
    const after = vi.fn()
    document.addEventListener('mini:after', after)
    button.click()
    await tick()
    document.getElementById('modal')!.remove() // e.g. the dialog closed
    await tick()
    expect(requests[0].signal.aborted).toBe(false)
    release(0, htmlRes('<li>new item</li>'))
    await settle()
    expect(document.getElementById('list')!.innerHTML).toBe('<li>new item</li>')
    expect(after.mock.calls[0][0].target).toBe(document)
    expect(after.mock.calls[0][0].detail).toMatchObject({ source: button, swapped: true })
    document.removeEventListener('mini:after', after)
  })

  it('a finished write whose target is gone is not swapped (swapped: false)', async () => {
    const release = gated()
    document.body.innerHTML = `<div id="modal"><form data-post="/items" data-target="#modal-body"><div id="modal-body">form</div></form></div>`
    await tick()
    const after = vi.fn()
    document.addEventListener('mini:after', after)
    submit(document.querySelector('form')!)
    await tick()
    const body = document.getElementById('modal-body')!
    document.getElementById('modal')!.remove()
    release(0, htmlRes('<p>saved</p>'))
    await settle()
    expect(body.textContent).toBe('form')
    expect(after.mock.calls[0][0].detail).toMatchObject({ swapped: false })
    document.removeEventListener('mini:after', after)
  })

  it('removing the source mid-read aborts it', async () => {
    gated()
    document.body.innerHTML = `<section><button data-get="/panel" data-target="#out">Load</button></section><div id="out">old</div>`
    await tick()
    document.querySelector('button')!.click()
    await tick()
    document.querySelector('section')!.remove()
    await tick()
    expect(requests[0].signal.aborted).toBe(true)
    expect(document.getElementById('out')!.textContent).toBe('old')
  })

  it('every event detail carries the source element', async () => {
    handler = () => htmlRes('ok')
    document.body.innerHTML = `<div id="t" data-get="/x"></div>`
    const el = document.getElementById('t')!
    const sources: unknown[] = []
    for (const type of ['mini:before', 'mini:after']) el.addEventListener(type, (e) => sources.push((e as CustomEvent).detail.source))
    await trigger(el)
    expect(sources).toEqual([el, el])
  })
})

describe('swapped flag', () => {
  const detailOf = (type: string) =>
    new Promise<any>((resolve) => document.addEventListener(type, (e) => resolve((e as CustomEvent).detail), { once: true }))

  it('data-swap="none" reports swapped: false on success and leaves the target alone', async () => {
    handler = () => htmlRes('<b>reply</b>')
    document.body.innerHTML = `<div id="t" data-post="/x" data-swap="none">keep</div>`
    const after = detailOf('mini:after')
    await trigger(document.getElementById('t')!)
    expect((await after).swapped).toBe(false)
    expect(document.getElementById('t')!.textContent).toBe('keep')
  })

  it('data-swap="none" with a listed error status reports swapped: false', async () => {
    handler = () => htmlRes('<p class="error">invalid</p>', { status: 422 })
    document.body.innerHTML = `<div id="t" data-post="/x" data-swap="none" data-swap-error="422">keep</div>`
    const error = detailOf('mini:error')
    await trigger(document.getElementById('t')!)
    expect(await error).toMatchObject({ swapped: false })
    expect(document.getElementById('t')!.textContent).toBe('keep')
  })

  it('data-swap="delete" changes the page, so it reports swapped: true', async () => {
    handler = () => htmlRes('')
    document.body.innerHTML = `<ul><li id="t" data-delete="/items/1" data-swap="delete">row</li></ul>`
    const after = detailOf('mini:after')
    await trigger(document.getElementById('t')!)
    expect((await after).swapped).toBe(true)
    expect(document.getElementById('t')).toBeNull()
  })

  it('swap() returns whether the page changed', () => {
    document.body.innerHTML = `<div id="t">keep</div>`
    expect(swap('#t', '<i>x</i>', 'none')).toBe(false)
    expect(document.getElementById('t')!.textContent).toBe('keep')
    expect(swap('#t', '<i>x</i>')).toBe(true)
  })
})

describe('URL handling', () => {
  afterEach(() => document.head.querySelector('base')?.remove())

  it('a <base href> on another origin: relative writes are refused, api sends no CSRF token', async () => {
    document.head.innerHTML = '<meta name="csrf-token" content="secret"><base href="https://evil.example/">'
    const onError = vi.fn()
    document.addEventListener('mini:error', onError)
    document.body.innerHTML = `<button data-post="/steal">b</button>`
    await tick()
    document.querySelector('button')!.click()
    await settle()
    expect(requests.length).toBe(0)
    expect(String(onError.mock.calls[0][0].detail.error)).toMatch(/cross-origin/)
    document.removeEventListener('mini:error', onError)

    await api.post('/steal', {})
    expect(new URL(requests[0].url).origin).toBe('https://evil.example')
    expect(requests[0].headers.get('X-CSRF-Token')).toBeNull()
  })

  it('a same-origin <base href> still gets the token (fetch and the check use the same URL)', async () => {
    document.head.innerHTML = `<meta name="csrf-token" content="secret"><base href="${location.origin}/app/">`
    document.body.innerHTML = `<button data-post="items">b</button>`
    await tick()
    document.querySelector('button')!.click()
    await settle()
    expect(new URL(requests[0].url).pathname).toBe('/app/items')
    expect(requests[0].headers.get('X-CSRF-Token')).toBe('secret')
  })


  it('data-fetch GET forms replace the action query, like a native submit', async () => {
    document.body.innerHTML = `<form action="/search?q=old&stale=1" data-fetch><input name="q" value="new"></form>`
    await tick()
    submit(document.querySelector('form')!)
    await settle()
    expect(new URL(requests[0].url).search).toBe('?q=new')
  })

  it('explicit data-get keeps its own query and adds the fields', async () => {
    document.body.innerHTML = `<form data-get="/search?scope=all"><input name="q" value="new"></form>`
    await tick()
    submit(document.querySelector('form')!)
    await settle()
    expect(new URL(requests[0].url).search).toBe('?scope=all&q=new')
  })
})
