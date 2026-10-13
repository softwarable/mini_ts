# mini.ts

A tiny single-file UI library for personal projects. No dependencies, ~9 KB gzipped.

| Area | What you get |
|---|---|
| **Signals** | `signal`, `computed`, `effect`, `batch`, `untrack` |
| **Templates** | `html`/`svg` tagged templates, `render`, keyed `each`, `when`, `unsafeHTML` |
| **Components** | `Component` base class (typed props, shadow or light DOM, styles, lifecycle), `define`, `css` |
| **Behaviors** | `data-behavior` + `data-action` (Stimulus-style, delegated) |
| **Fetch** | htmx-style `data-get/post/put/patch/delete`, `swap`, `trigger`, JSON `api`, `resource` |

```ts
import { html, signal, Component, define, start } from './mini'
start() // enables data-behavior / data-action / data-get… on the page
```

Use it by copying `mini.ts` into a project, or build `dist/mini.js` (+ `mini.d.ts`) with `npm run build`.

---

## Signals

```ts
const count = signal(0)
const double = computed(() => count.value * 2)

const stop = effect(() => {
  console.log(count.value, double.value) // re-runs when either changes
  return () => {} // optional cleanup, runs before the next run and on stop()
})

count.value++
batch(() => { a.value = 1; b.value = 2 }) // effects run once
untrack(() => count.value)                 // read without subscribing
count.peek()                               // same
```

Effects run synchronously after a write. An effect that keeps changing a signal it reads throws `mini: effect loop detected`.

A `computed` is lazy and cached. Once nothing reads it anymore (its effects were stopped, or it was only read outside an effect), it lets go of its sources at the next microtask, so a long-lived signal doesn't keep it alive. Reading it again recomputes it and subscribes again.

## Templates

```ts
render(html`<h1>Hello ${name}</h1>`, document.querySelector('#app')!)
```

The first `render` into a container replaces its content. Later calls update only the values that changed. To re-render on signal changes, wrap it: `effect(() => render(view(), el))`. Components do this for you.

### Bindings

| Syntax | Meaning |
|---|---|
| `<p>${value}</p>` | Text (escaped), a template, a Node, an array, `each()`, or nothing for `null`/`undefined`/`false`/`true`/`''` |
| `<a href=${url}>` | Attribute; `null`/`undefined` removes it. Quoted/unquoted both fine |
| `<div class="btn ${kind} ${size}">` | Several values in one attribute |
| `<button ?disabled=${busy}>` | Boolean attribute (present when truthy) |
| `<input .value=${text}>` | DOM property (not escaped, any type: objects, arrays…) |
| `<button @click=${fn}>` | Event listener. `this` is the component (or `render`'s `host` option) |

Signals can be used directly in text and attribute bindings: `${count}` is the same as `${count.value}`. Property (`.x`) and event (`@x`) bindings pass the signal object itself.

Not supported (throws a clear error): bindings in tag names, attribute names, as a whole attribute (`<div ${x}>`), inside HTML comments, or inside `<textarea>`/`<style>`/`<script>`/`<title>`. For `<textarea>`, use `.value=${…}`.

### Loops and conditions

```ts
const links = [
  { id: 1, url: '/', label: 'Home', active: true },
  { id: 2, url: '/about', label: 'About' },
]

html`
  <nav>
    ${each(links, 'id', (l) => html`<a href=${l.url} class=${l.active ? 'active' : null}>${l.label}</a>`)}
  </nav>

  ${when(user, () => html`<p>Hi ${user.name}</p>`, () => html`<a href="/login">Log in</a>`)}
  ${errors.length > 0 && html`<p class="error">${errors[0]}</p>`}
`
```

- `each(items, key, view)`: `key` is a property name or `(item, i) => key`. DOM nodes are matched by key, so reordering moves existing nodes instead of recreating them. Typed text, scroll position and other element state are kept. It moves as few nodes as possible. Keys must be unique.
  - **Focus:** an element that doesn't have to move keeps focus in every browser. When the focused element itself has to move, mini uses `Node.moveBefore()`, which keeps focus. Browsers without `moveBefore()` fall back to `insertBefore()`, which keeps the element and its value but drops focus. Current Chromium has `moveBefore()`.
- A plain `items.map(i => html`…`)` also works (unkeyed, updated by position). It's fine for static or append-only lists.
- `when(cond, then, else?)` only calls the branch it needs. For simple cases `cond && html`…`` works too.
- `unsafeHTML(str)` inserts trusted markup. Never pass user input to it.

**Security:** text and attribute values are escaped, but a URL attribute like `href=${userUrl}` can still be `javascript:…`. Validate URLs that come from users.

## Components

```ts
class TodoItem extends Component {
  static props = {
    label: String,                                 // <todo-item label="…">
    done: { type: Boolean, reflect: true },        // mirrors to the `done` attribute
    priority: { type: Number, default: 1 },
    tags: { type: Array, default: () => [] },      // JSON in attribute: tags='["a"]'
    user: { type: Object, attribute: false },      // property only: .user=${u}
  }
  declare label: string
  declare done: boolean
  declare priority: number
  declare tags: string[]
  declare user: { name: string }

  static styles = css`:host { display: block } .done { opacity: .5 }`

  editing = signal(false) // local state: any signal read in render() triggers a re-render

  render() {
    return html`
      <label class=${this.done ? 'done' : null}>
        <input type="checkbox" .checked=${this.done} @change=${this.toggle} /> ${this.label}
      </label>`
  }

  toggle() {
    this.done = !this.done
    this.emit('todo-toggle', { done: this.done }) // bubbles + composed CustomEvent
  }

  mounted() {           // after first render on each connect; may return a cleanup
    const id = setInterval(() => {}, 1000)
    return () => clearInterval(id)
  }
  updated() {}          // after every render
  unmounted() {}        // on disconnect
}
define('todo-item', TodoItem)
```

- **Props:** attribute names are the kebab-case of the prop name (`maxItems` → `max-items`). Removing an attribute resets the prop to its default. Declare types with `declare x: T` (no runtime field). Class-field defaults (`label = 'x'`) also work.
- **Rendering:** `render()` runs inside an effect. Any prop or signal it reads (including global stores) schedules a re-render, batched to one per microtask. The first render is synchronous on connect.
- **Shadow vs light DOM:** shadow DOM is the default. Set `static shadow = false` to render into the element itself so it uses page CSS. `static styles` apply only with shadow DOM.
- **Waiting for a render in tests:** `await tick()`.

## Behaviors: `data-behavior` / `data-action`

Use these to add behavior to server-rendered HTML without components.

```html
<div data-behavior="dropdown">
  <button data-action="dropdown#toggle">Menu</button>
  <ul hidden>
    <li><a href="#" data-action="dropdown#pick:prevent" data-value="profile">Profile</a></li>
  </ul>
</div>

<button data-action="copy" data-text="Hello">Copy</button>
<input data-action="input->search keydown->hotkey">
```

```ts
behavior('dropdown', (el) => {
  const menu = el.querySelector('ul')!
  return {
    toggle: () => (menu.hidden = !menu.hidden),
    pick: (event, item) => console.log(item.dataset.value),
    destroy: () => {},   // optional: runs when the element leaves the DOM
  }
  // or return a cleanup function, or nothing
})

action('copy', (event, el) => navigator.clipboard.writeText(el.dataset.text!))
```

- A behavior's setup runs for every `[data-behavior~=name]` element: those already on the page, inserted later (MutationObserver), and those in content swapped in by fetch. Cleanup runs when the element is removed. Moving an element doesn't remount it.
- `data-action` tokens are `[event->]name[#method][:prevent][:stop]`, separated by spaces.
  - `name` calls a global `action()`.
  - `name#method` calls a method on the closest `name` behavior.
- Default event: `submit` for forms, `input` for inputs/textareas, `change` for selects, `click` for everything else.
- `getBehavior(el, 'dropdown')` returns a behavior's object.
- Events are delegated from the document, so they work in light DOM only. Inside components, use `@event`.

## Fetch: htmx-style attributes

The server returns **HTML fragments**. mini sends the request when something happens (a click, a submit, typing) and puts the returned HTML into the page. You write no JavaScript for it.

```html
<!-- Click: GET /users, put the reply inside #list -->
<button data-get="/users" data-target="#list">Load users</button>
<ul id="list"></ul>

<!-- Submit: POST the form fields, append the reply to #todos -->
<form data-post="/todos" data-target="#todos" data-swap="beforeend">
  <input name="text"> <button>Add</button>
</form>

<!-- Typing: wait 300ms after the last key, then GET /search?q=… -->
<input name="q" data-get="/search" data-trigger="input delay:300ms" data-target="#results">

<!-- Load as soon as it's on the page -->
<section data-get="/stats" data-trigger="load">Loading…</section>

<!-- Ask first, then DELETE and remove the row -->
<button data-delete="/todos/3" data-target="closest li" data-swap="outerHTML" data-confirm="Delete?">×</button>

<!-- A normal form or link: method and URL come from the HTML itself -->
<form action="/items/42" method="post" data-fetch data-target="#item-42">…</form>
<a href="/items/42" data-fetch data-target="#panel">Item 42</a>
```

### Attributes

| Attribute | Meaning |
|---|---|
| `data-get` `data-post` `data-put` `data-patch` `data-delete` | Method + URL (empty = current URL) |
| `data-fetch` | On a `<form>` or `<a>`: take the method and URL from the native `method`/`action` or `href` ([below](#native-forms-and-links-data-fetch)) |
| `data-trigger` | Event(s), comma-separated, optional `delay:300ms` (debounce). Special: `load`. Default: `submit` for forms, `change` for inputs, `click` otherwise |
| `data-target` | Where the reply goes: CSS selector, `this` (default), `closest <sel>`, `find <sel>` |
| `data-swap` | How it goes in: `innerHTML` (default), `outerHTML`, `beforebegin`, `afterbegin`, `beforeend`, `afterend`, `delete`, `none` |
| `data-select` | Only use the matching elements from the reply |
| `data-vals` | Extra values as JSON: `data-vals='{"page":2}'` |
| `data-confirm` | Ask `confirm()` first |
| `data-swap-error` | Error statuses whose HTML is still swapped in: `"422"`, `"422 409"`, `"4xx"` ([below](#error-responses-and-validation-forms)) |

### How a request works

Every request goes through the same steps. If you understand these, you understand the whole feature.

1. **Find the element.** mini has one listener per event type on the document. When a `click`, `submit` etc. happens, it walks up from the clicked element to the nearest element that has fetch attributes and whose trigger matches the event.
2. **Work out method and URL.** These come from `data-get`/`data-post`/… or, with `data-fetch`, from the form or link. The clicked submit button's `formaction`/`formmethod` can override a `data-fetch` form's.
3. **Safety checks.**
   - A POST/PUT/PATCH/DELETE to another origin is refused here ([cross-origin rules](#cross-origin-rules)).
   - `data-confirm` asks the user.
   - The `mini:before` event fires; calling `preventDefault()` on it cancels the request.
4. **Collect values.**
   - A form sends its fields, plus the clicked submit button's `name=value`.
   - An input with a `name` sends its own value.
   - A non-GET element inside a form sends that form.
   - `data-vals` adds extra values.
   - **Only GET puts values in the query string.** Values are added before any `#fragment`. An explicit `data-get="/search?scope=all"` keeps its own query and adds the fields. A `data-fetch` GET form replaces the action's query with its fields, as a native submit would.
   - **Every other method, DELETE included, sends them in the request body.** That way form data (hidden tokens, record fields, what the user typed) never ends up in URLs, server access logs, browser history or monitoring tools. Make sure your server reads DELETE parameters from the body; some server stacks only parse form bodies for POST.
   - The body is urlencoded, or multipart when the effective enctype is `multipart/form-data` (the clicked button's `formenctype`, else the form's `enctype`, case-insensitive).
5. **Add headers.** `X-Mini-Request: true`, `X-Mini-Target: <target id>`, `config.headers`, and a [CSRF token](#csrf-protection) for same-origin non-GET requests. Your server can use `X-Mini-Request` to return a fragment instead of a full page.
6. **Send.** While it's pending, the element has `data-loading` and the target has `aria-busy="true"`, so you can style loading states with CSS. What happens to a request that's still pending depends on whether it only reads or also writes ([reads and writes](#reads-writes-and-double-submits)).
7. **Read the reply.** The first matching rule wins:
   | Reply | What mini does |
   |---|---|
   | `X-Mini-Redirect: /url` header | Navigate the whole page to `/url` |
   | fetch followed an HTTP redirect | Fire `mini:redirect`. Unless it's cancelled, navigate the whole page to where the redirect ended ([redirects](#redirects-and-expired-sessions)) |
   | 2xx | Swap the HTML into the target, fire `mini:after` |
   | error listed in `data-swap-error` | Swap the HTML, fire `mini:error` with `swapped: true` |
   | any other error / network failure | Change nothing, fire `mini:error` |
8. **Activate new content.** Behaviors, actions and fetch attributes inside the swapped HTML work straight away. `<script>` tags in replies don't run.

### Events

All events bubble from the element that made the request. If that element has left the page (swapped away, or its dialog closed), they fire on `document` instead. Every `detail` includes `source`, the element that made the request, so a listener on `document` can still tell which form finished.

| Event | When | `event.detail` | Cancelable |
|---|---|---|---|
| `mini:before` | Before sending | `{ source, method, url, target }` (`url` is absolute) | Yes: cancels the request |
| `mini:after` | The request succeeded (2xx) | `{ source, response, target, swapped }` | No |
| `mini:error` | HTTP error, network error, or refused request | `{ source, response, text, target, swapped }` or `{ source, error }` | No |
| `mini:redirect` | fetch followed an HTTP redirect | `{ source, url, response }` | Yes: swap the reply instead of navigating |

`swapped` tells you whether the reply changed the page. It's `true` when mini inserted the reply, replaced the target or, with `data-swap="delete"`, removed the target. It's `false` when nothing changed:
- the swap mode is `data-swap="none"`
- the target left the page while the request was running
- an error status isn't listed in `data-swap-error`

So for a `422` reply, `swapped: true` means the user is looking at the validation messages.

```ts
document.addEventListener('mini:error', (e) => {
  const { response, swapped, error } = (e as CustomEvent).detail
  if (!swapped) showToast(error ? 'Network error' : `Failed: HTTP ${response.status}`)
})
```

### Reads, writes and double submits

mini treats the two kinds of request differently, because aborting a request only stops the **browser** from reading the reply. The server still does the work.

- **Reads (GET)** change nothing on the server, so they're safe to throw away. A newer request replaces an older one, which is right for search and filters. If the element leaves the page, the read is aborted.
- **Writes (POST, PUT, PATCH, DELETE)** change data. Aborting one would leave the page out of sync with the server, and sending it twice could save a record twice. So a write always runs to the end, and a second trigger is ignored while it's running.

| | New trigger while one is pending | Element removed, not sent yet (`delay:`) | Element removed, already sent |
|---|---|---|---|
| **GET** | Abort the old one, send the new one | Cancelled | Aborted |
| **POST / PUT / PATCH / DELETE** | **Ignored**: one request, no duplicate save | Cancelled | **Keeps running.** The reply is swapped in if the target is still on the page. Events fire on `document`, with `source`. |

Details:
- **An ignored duplicate is still kept from the browser.** A double-clicked submit never turns into a native full-page POST, and `data-confirm` isn't asked twice.
- **Mixed methods on one element.** A form can have a Preview button (GET) and a Save button (POST). What happens depends on the request that's pending: a pending write blocks new requests, while a pending read is replaced.
- **`await trigger(el)`** while a write is pending waits for that write.

**The UX pattern that fits:** keep the dialog open while it saves, show that it's busy, and close it on success.

```css
form[data-loading] button { opacity: .5; pointer-events: none; } /* busy cue; mini also ignores repeats */
```

```ts
// Close the dialog only when the save succeeded. A 422 re-renders the form in place (data-swap-error),
// and other errors leave it open, so the user always sees what happened.
dialog.addEventListener('mini:after', () => dialog.close())
```

The user sees progress, can't save twice, and the list updates at the moment the dialog closes, not a few seconds later in the middle of something else.

### Native forms and links: `data-fetch`

Instead of repeating the URL in `data-post`, keep the HTML a normal form or link and add `data-fetch`. The page works without JavaScript, and the HTML stays the single source of truth.

```html
<form action="/items/42" method="post" data-fetch data-target="#item-42" data-swap="outerHTML">
  <input name="name" required minlength="2">
  <button name="op" value="save">Save</button>
  <button formaction="/items/42/preview" formmethod="get">Preview</button>
</form>
```

It behaves the way the browser would:

- **Method:** a form's `method` is GET unless it's `post`. `method="dialog"` (or a `formmethod="dialog"` button) is left to the browser.
- **Submit buttons:** the clicked button's `formaction`, `formmethod` and `formenctype` win over the form's, and its `name=value` is sent.
- **Other windows:** a form with `target="_blank"` (or any target other than `_self`), or a submit button with such a `formtarget`, is left to the browser. The browser opens the result in the other window, as it would without mini.
- **Native validation:** `required`, `minlength` and the like run first. The browser only fires `submit` when the form is valid, so an invalid form never sends a request.
- **Links:** use `href` with GET. These are left to the browser, so "open in new tab" and downloads still work:
  - ctrl/cmd/shift/alt-clicks and middle clicks
  - links with a `target` other than `_self`
  - links with a `download` attribute

  These link rules apply to every `<a>` with fetch attributes.

Use `data-get`/`data-post`/… when there's no natural form or link, such as a button that loads a panel.

### Error responses and validation forms

By default an error reply (4xx/5xx) is **not** swapped in. An error page shouldn't replace a table or a modal. The request only fires `mini:error`.

Server-side validation is the exception: the server answers `422` with the form re-rendered, including error messages, and that HTML *should* replace the form. `data-swap-error` opts in:

```html
<div class="modal">
  <form id="item-form" action="/items" method="post" data-fetch
        data-target="#item-form" data-swap="outerHTML" data-swap-error="422">
    …
  </form>
</div>
```

- `422` swaps the returned form, with its messages, in place.
- `500` changes nothing.
- The value can be one status (`"422"`), several (`"422 409"`) or a class (`"4xx"`).
- `mini:error` still fires, with `detail.swapped: true`, so code listening for errors can tell "shown to the user" apart from "failed". `mini:after` only fires for success, so "close the modal on success" logic can listen to `mini:after`.

### Redirects and expired sessions

`fetch` follows HTTP redirects silently. So when a session has expired and the server redirects to `/login`, fetch gets the login page. A naive library would put that login page inside your table or modal.

mini checks `response.redirected` instead. When a request was redirected, it fires `mini:redirect` and then **navigates the whole window** to where the redirect ended. The user lands on the real login page.

If a particular redirect is expected and you want its reply swapped in (say, a moved URL), cancel the event:

```ts
el.addEventListener('mini:redirect', (e) => e.preventDefault())
```

The server can also force a full-page navigation without an HTTP redirect by sending an `X-Mini-Redirect: /somewhere` header.

### CSRF protection

For every **non-GET, same-origin** request, mini adds a CSRF token header. Where the token comes from is configurable:

```ts
// Default: <meta name="csrf-token" content="…">  →  X-CSRF-Token
config.csrf = { meta: 'csrf-token', header: 'X-CSRF-Token' }

// From a cookie: XSRF-TOKEN cookie  →  X-XSRF-TOKEN
config.csrf = { cookie: 'XSRF-TOKEN', header: 'X-XSRF-TOKEN' }

// Both: the cookie is tried first, then the meta tag
config.csrf = { cookie: 'XSRF-TOKEN', meta: 'csrf-token', header: 'X-XSRF-TOKEN' }

// Off
config.csrf = null
```

- The token is looked up **on every request**, so a token the server rotates is picked up automatically.
- Cookie values are URL-decoded before sending.
- The same rules apply to the `data-*` attributes and to `api.post/put/patch/delete`.
- mini only manages this header. Anything else your server expects is up to your HTML, for example hidden form fields, which are sent like any other field.

### Cross-origin rules

The CSRF token must never reach another website. So mini checks where each request goes:

| Request | Same origin | Another origin (`https://other.site/…`, `//other.site/…`) |
|---|---|---|
| `data-*` GET | Sent (GET never carries the token) | Sent, without the token |
| `data-*` POST/PUT/PATCH/DELETE | Sent with the token | **Refused**: nothing is sent, `mini:error` fires |
| `api.*` GET | Sent | Sent |
| `api.*` POST/PUT/PATCH/DELETE | Sent with the token | Sent **without** the token |

- **`<base href>`:** URLs are resolved exactly the way `fetch()` resolves them, against the document base URL. So a relative URL on a page with `<base href="https://other.site/">` counts as another origin and follows the rules above. The check and the request always use the same absolute URL.

Cookies are only sent to your own origin (`credentials: 'same-origin'`). `config.headers` are sent with every request, so don't put secrets there if you call other origins.

### From code

```ts
await trigger(el)                          // run an element's request now
swap('#box', '<p>hi</p>', 'beforeend')     // insert HTML the same way a reply would
swap('#box', html, 'innerHTML', '#part')   // …only the #part element from it
// swap() returns false only for mode 'none' (nothing changed)
```

## JSON api and `resource`

```ts
config.baseUrl = '/api'                 // optional
config.headers['X-App'] = 'mini'        // optional

const users = await api.get<User[]>('/users', { query: { q: 'ada', page: 2 } })
const created = await api.post<User>('/users', { name: 'Ada' }) // JSON body
await api.delete('/users/1')

try { await api.post('/users', {}) }
catch (e) { if (e instanceof ApiError && e.status === 422) console.log(e.data) }
```

- **CSRF:** non-GET calls to your own origin get the CSRF header, following the same rules as above.
- **Redirects:** if a call was redirected to an **HTML** page (typically the login page after a session expired), the api navigates the window there and throws an `ApiError`. A redirect that ends in JSON is returned normally.

JSON bodies are serialized for you. `FormData`, `URLSearchParams`, strings and `Blob`s are sent as-is. Responses are parsed as JSON by `Content-Type`, otherwise as text. A 204 returns `undefined`.

`resource()` turns an async call into signals. It's the easy way to fetch data and loop over it:

```ts
class UserSearch extends Component {
  q = signal('')
  users = resource((signal) => api.get<User[]>('/users', { query: { q: this.q.value }, signal }), [])

  render() {
    const { data, loading, error } = this.users
    return html`
      <input .value=${this.q.value} @input=${(e) => (this.q.value = e.target.value)}>
      ${when(loading.value, () => html`<p>Loading…</p>`)}
      ${when(error.value, () => html`<p class="error">Failed to load</p>`)}
      <ul>${each(data.value, 'id', (u) => html`<li>${u.name}</li>`)}</ul>`
  }
  disconnectedCallback() { super.disconnectedCallback(); this.users.dispose() }
}
```

Signals read before the fetcher's first `await` are tracked. When they change, it re-fetches and aborts the old request. Inside the fetcher, read `data` with `.peek()`, or it will loop. `reload()` fetches again, and `dispose()` stops tracking and aborts the request in flight. After `dispose()`, a late result or error is ignored, even if the fetcher ignored the abort signal.

## Startup

`start(root = document)` enables delegation and DOM observation for behaviors, actions and fetch attributes. It returns a `stop()` function.

Passing an element limits everything to that subtree, for example `start(document.querySelector('#app')!)`:
- Events are handled only inside it. Handling stops at the root, so `data-action`s on its ancestors never run.
- Behaviors registered later with `behavior()` mount only inside it.
- HTML inserted with `swap()` is only activated inside it.

`stop()` cleans up everything it mounted. `mount(el)` activates a subtree immediately (the observer does this for you after a microtask). Templates, signals, components and `api` don't need `start()`.

## Demo

`npm run dev` opens a demo page (`demo/`) backed by a small fake server (`demo/api.ts`). Each section shows one feature, with what to try and what should happen:

1. A component with props and state
2. Fetching JSON with `resource()` and looping with `each()`/`when()`
3. Looping links from data (keyed moves)
4. `data-behavior` / `data-action`
5. `data-get`/`data-post`: time, live search, todos
6. A native form with `data-fetch`: native validation, a `422` validation reply, and the Preview button's `formaction`/`formmethod`
7. Errors, redirects and security: a 500, an expired-session redirect, a redirect you choose to swap, a refused cross-origin POST, and a switch between the meta-tag and cookie CSRF sources

The **request log** at the bottom is the easiest way to learn how fetch works. It lists every request (`→`, with the CSRF header if one was sent), every response (`←`, with status and whether a redirect was followed) and every mini event (`★`), newest first. The log is demo code (it wraps `window.fetch`); it isn't part of the library.

## Development

```bash
npm test               # all tests: unit + real browser
npm run test:unit      # unit tests only (happy-dom), fast
npm run test:browser   # real Chromium tests only
npm run test:watch     # unit tests in watch mode
npm run dev            # the demo above
npm run build          # dist/mini.js + dist/mini.d.ts
npm run size           # minified / gzip size
```

### Tests

There are two suites, both run by `npm test`:

| Suite | Where | Runs in | Use it for |
|---|---|---|---|
| **unit** | `tests/` | [happy-dom](https://github.com/capricorn86/happy-dom), a simulated DOM | Almost everything: logic, edge cases, request policies (with a fake `fetch`). Fast, and the place to add most tests. |
| **browser** | `tests-browser/` | Real headless Chromium through [Playwright](https://playwright.dev) ([Vitest browser mode](https://vitest.dev/guide/browser/)) | What a simulated DOM can't show: the custom-element lifecycle, shadow DOM and constructable stylesheets, computed styles, focus, native form validation and submit buttons, real multipart uploads, real HTTP redirects |

- **Real traffic:** the browser suite talks to a real HTTP server, `tests-browser/server.ts`, which runs inside the Vitest server. Its `/test-api/echo` endpoint replies with exactly what arrived (method, headers, encoding, body), so tests check real network traffic, not a mock.
- **Full-page navigation:** tests that navigate the whole page, such as the expired-session redirect, run inside an iframe so they don't unload the test runner.
- **Chromium version:** Playwright is pinned to an exact version (`1.59.1`), because each Playwright version expects one specific Chromium build. If you update it, install the matching browser with `npx playwright install chromium`.
- **Failures:** a failing browser test saves a screenshot under `.vitest/` (git-ignored).
