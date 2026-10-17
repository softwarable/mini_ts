/**
 * mini.ts — a tiny, single-file UI library.
 *
 *   1. Signals     signal, computed, effect, batch, untrack
 *   2. Templates   html, svg, render, each, when, unsafeHTML
 *   3. Components  Component, define, css
 *   4. Behaviors   behavior, action, getBehavior (data-behavior / data-action)
 *   5. Fetch       data-get/post/…, trigger, swap, api, resource, config
 *   6. Startup     start, mount, tick
 *
 * Rules: no dependencies, no work at import time (tree-shakeable), call start()
 * to enable the declarative data-* features. See README.md and CLAUDE.md.
 */

// ═══════════════════════════════════════════════════════════════════════════
// 1. Signals
// ═══════════════════════════════════════════════════════════════════════════

interface Observer {
  deps: Set<Set<Observer>>
  notify(): void
}

let current: Observer | null = null
let batchDepth = 0
let flushing = false
const pending = new Set<Effect>()

function track(subs: Set<Observer>) {
  if (current) {
    subs.add(current)
    current.deps.add(subs)
  }
}

function unlink(o: Observer) {
  for (const subs of o.deps) {
    subs.delete(o)
    if (subs.size === 0) {
      const owner = owners.get(subs)
      if (owner) scheduleRelease(owner)
    }
  }
  o.deps.clear()
}

// A computed with no subscribers lets go of its sources, so a long-lived signal doesn't keep
// every computed that ever read it alive. Release waits a microtask: an effect re-running drops
// its subscriptions and takes them again synchronously, and must not lose the cached value.
const owners = new WeakMap<Set<Observer>, Computed<unknown>>()
const releasing = new Set<Computed<unknown>>()
let releaseQueued = false

function scheduleRelease(c: Computed<unknown>) {
  releasing.add(c)
  if (releaseQueued) return
  releaseQueued = true
  queueMicrotask(() => {
    releaseQueued = false
    // Releasing one computed can leave its own computed sources unused: they are added
    // to the set while it is being iterated, and visited in the same pass.
    for (const r of releasing) {
      releasing.delete(r)
      r.releaseIfUnused()
    }
  })
}

function notifyAll(subs: Set<Observer>) {
  batchDepth++
  try {
    for (const s of [...subs]) s.notify()
  } finally {
    batchDepth--
    if (batchDepth === 0) flush()
  }
}

function flush() {
  if (flushing) return
  flushing = true
  let guard = 0
  let loopError: Error | undefined
  try {
    while (pending.size) {
      if (++guard > 10_000) {
        pending.clear()
        loopError = new Error('mini: effect loop detected (an effect keeps changing a signal it reads)')
        break
      }
      const e = pending.values().next().value!
      pending.delete(e)
      e.runSafely()
    }
  } finally {
    flushing = false
  }
  // A runaway loop is a programming error in the effect currently being
  // created, so preserve the synchronous exception used to diagnose it.
  if (loopError) throw loopError
}

/** Report an asynchronous effect failure without blocking other queued effects. */
function reportEffectError(error: unknown) {
  const report = (globalThis as typeof globalThis & { reportError?: (error: unknown) => void }).reportError
  if (typeof report === 'function') report(error)
  else console.error('mini: effect failed', error)
}

/** Read-only reactive value. `Signal` and `computed()` both extend this. */
export abstract class ReadonlySignal<T = unknown> {
  abstract get value(): T
  /** Read without subscribing the current effect. */
  abstract peek(): T
  toString() {
    return String(this.value)
  }
}

export class Signal<T = unknown> extends ReadonlySignal<T> {
  #v: T
  #subs = new Set<Observer>()
  constructor(v: T) {
    super()
    this.#v = v
  }
  get value(): T {
    track(this.#subs)
    return this.#v
  }
  set value(v: T) {
    if (Object.is(v, this.#v)) return
    this.#v = v
    notifyAll(this.#subs)
  }
  peek(): T {
    return this.#v
  }
}

class Computed<T> extends ReadonlySignal<T> implements Observer {
  deps = new Set<Set<Observer>>()
  #subs = new Set<Observer>()
  #dirty = true
  #v!: T
  #error: { e: unknown } | undefined
  constructor(private fn: () => T) {
    super()
    owners.set(this.#subs, this as Computed<unknown>)
  }
  /** @internal Drop the subscriptions to its sources if nothing reads it anymore. */
  releaseIfUnused() {
    if (this.#subs.size || !this.deps.size) return
    unlink(this)
    this.#dirty = true
  }
  notify() {
    if (this.#dirty) return
    this.#dirty = true
    for (const s of [...this.#subs]) s.notify()
  }
  get value(): T {
    track(this.#subs)
    return this.peek()
  }
  peek(): T {
    if (this.#dirty) {
      unlink(this)
      const prev = current
      current = this
      try {
        this.#v = this.fn()
        this.#error = undefined
      } catch (e) {
        // Keep the deps read before the throw, so a later change re-runs it.
        this.#error = { e }
      } finally {
        current = prev
      }
      this.#dirty = false
    }
    // Read outside any effect: don't stay subscribed to the sources (until something subscribes).
    if (!this.#subs.size && this.deps.size) scheduleRelease(this as Computed<unknown>)
    if (this.#error) throw this.#error.e
    return this.#v
  }
}

type Cleanup = () => void

class Effect implements Observer {
  deps = new Set<Set<Observer>>()
  #cleanup: Cleanup | undefined
  #disposed = false
  constructor(
    private fn: () => unknown,
    private schedule?: (run: () => void) => void,
  ) {}
  notify() {
    if (this.#disposed) return
    if (this.schedule) this.schedule(() => this.runSafely())
    else pending.add(this)
  }
  runSafely() {
    try {
      this.run()
    } catch (error) {
      reportEffectError(error)
    }
  }
  run() {
    if (this.#disposed) return
    unlink(this)
    // Clear before invoking: if either cleanup or the next run throws, an old
    // cleanup must never be retained and called a second time.
    const cleanup = this.#cleanup
    this.#cleanup = undefined
    cleanup?.()
    const prev = current
    current = this
    // Batch writes made during the run: if fn changes a signal it read, the re-run waits
    // until this run has finished (and stored its cleanup) instead of nesting inside it.
    batchDepth++
    try {
      const r = this.fn()
      this.#cleanup = typeof r === 'function' ? (r as Cleanup) : undefined
    } finally {
      current = prev
      batchDepth--
      if (batchDepth === 0) flush()
    }
  }
  dispose() {
    this.#disposed = true
    unlink(this)
    pending.delete(this)
    const cleanup = this.#cleanup
    this.#cleanup = undefined
    cleanup?.()
  }
}

/** Create a writable reactive value. Read/write through `.value`. */
export function signal<T>(value: T): Signal<T> {
  return new Signal(value)
}

/** Derived value; recomputed lazily when the signals it reads change. */
export function computed<T>(fn: () => T): ReadonlySignal<T> {
  return new Computed(fn)
}

/**
 * Run `fn` now and again whenever a signal it read changes.
 * `fn` may return a cleanup function (run before each re-run and on dispose).
 * Returns a dispose function.
 */
export function effect(fn: () => unknown): Cleanup {
  const e = new Effect(fn)
  try {
    e.run()
  } catch (error) {
    // run() may already have subscribed before failing. Do not leave an effect
    // alive when the caller never received its disposer.
    e.dispose()
    throw error
  }
  return () => e.dispose()
}

/** Apply several signal writes, running dependent effects once at the end. */
export function batch<T>(fn: () => T): T {
  batchDepth++
  try {
    return fn()
  } finally {
    batchDepth--
    if (batchDepth === 0) flush()
  }
}

/** Run `fn` without tracking signal reads. */
export function untrack<T>(fn: () => T): T {
  const prev = current
  current = null
  try {
    return fn()
  } finally {
    current = prev
  }
}

const unwrap = (v: unknown) => (v instanceof ReadonlySignal ? v.value : v)

// ═══════════════════════════════════════════════════════════════════════════
// 2. Templates
// ═══════════════════════════════════════════════════════════════════════════
//
// A template is parsed once (per call site) into a <template> element. Every
// ${hole} becomes either a comment marker (child position) or an attribute
// renamed to `m-<n>` (attribute position). Rendering clones the template once;
// updates only touch the parts whose values changed.

const TPL = Symbol('mini.template')
const EACH = Symbol('mini.each')
const RAW = Symbol('mini.raw')

export interface TemplateResult {
  readonly [TPL]: true
  readonly strings: TemplateStringsArray
  readonly values: unknown[]
  readonly svg: boolean
}

interface EachResult<T> {
  readonly [EACH]: true
  items: Iterable<T>
  key: (item: T, index: number) => unknown
  view: (item: T, index: number) => unknown
}

interface RawResult {
  readonly [RAW]: string
}

/** Tag for HTML templates: html`<p>${text}</p>`. Values are escaped. */
export function html(strings: TemplateStringsArray, ...values: unknown[]): TemplateResult {
  return { [TPL]: true, strings, values, svg: false }
}

/** Tag for standalone SVG fragments (not needed inside an <svg> in html``). */
export function svg(strings: TemplateStringsArray, ...values: unknown[]): TemplateResult {
  return { [TPL]: true, strings, values, svg: true }
}

/**
 * Keyed list. Items are matched by key between renders, so DOM nodes (and
 * their focus / input state) move instead of being recreated.
 *   each(users, 'id', u => html`<li>${u.name}</li>`)
 *   each(users, u => u.id, (u, i) => html`…`)
 */
export function each<T>(
  items: Iterable<T> | null | undefined,
  key: keyof T | ((item: T, index: number) => unknown),
  view: (item: T, index: number) => unknown,
): EachResult<T> {
  const keyFn = typeof key === 'function' ? key : (item: T) => item[key]
  return { [EACH]: true, items: items ?? [], key: keyFn, view }
}

/** Conditional: when(cond, () => html`yes`, () => html`no`). Branches are lazy. */
export function when<T, F = undefined>(
  cond: unknown,
  then: () => T,
  otherwise?: () => F,
): T | F | undefined {
  return cond ? then() : otherwise?.()
}

/** Render a trusted HTML string without escaping. Never pass user input. */
export function unsafeHTML(markup: string | null | undefined): RawResult {
  return { [RAW]: markup ?? '' }
}

const isTemplate = (v: any): v is TemplateResult => v != null && v[TPL] === true
const isEach = (v: any): v is EachResult<unknown> => v != null && v[EACH] === true
const isRaw = (v: any): v is RawResult => v != null && typeof v[RAW] === 'string'

// ---- template preparation ---------------------------------------------------

const MARK = '$m$'
const CHILD_RE = /^m\$(\d+)$/
const ATTR_RE = /^m-(\d+)$/

type PartSpec =
  | { kind: 'child'; node: number; value: number }
  | { kind: 'attr'; node: number; value: number; name: string; strings: string[] }

interface Prepared {
  el: HTMLTemplateElement
  specs: PartSpec[]
}

const cache = { html: new WeakMap<TemplateStringsArray, Prepared>(), svg: new WeakMap<TemplateStringsArray, Prepared>() }

const enum S {
  Text,
  Comment,
  Tag,
  AfterEq,
  Dq,
  Sq,
  Unq,
  Raw,
}

const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title'])

/** Build the marked-up HTML for a template and remember attribute names. */
function markup(strings: TemplateStringsArray): { out: string; names: Map<number, string> } {
  let out = ''
  let state = S.Text
  let nameStart = 0
  let nameEnd = 0
  let attrMarked = false
  let tagStart = -1
  let rawTag = ''
  const names = new Map<number, string>() // hole index -> original attribute name

  const finishOpeningTag = (): S => {
    const tag = /^[^\s/>]+/.exec(out.slice(tagStart))?.[0].toLowerCase() ?? ''
    rawTag = tag
    return RAW_TEXT.has(tag) ? S.Raw : S.Text
  }

  for (let i = 0; i < strings.length; i++) {
    const s = strings[i]
    for (let j = 0; j < s.length; j++) {
      const c = s[j]
      switch (state) {
        case S.Text:
          if (c === '<') {
            if (s.startsWith('!--', j + 1)) {
              state = S.Comment
            } else if (/[a-zA-Z]/.test(s[j + 1] ?? '')) {
              state = S.Tag
              tagStart = out.length + 1
            }
          }
          break
        case S.Raw:
          if (c === '<' && s.slice(j + 2, j + 2 + rawTag.length).toLowerCase() === rawTag && s[j + 1] === '/') {
            state = S.Text
          }
          break
        case S.Comment:
          if (c === '>' && s.slice(j - 2, j) === '--') state = S.Text
          break
        case S.Tag:
          if (c === '>') {
            state = finishOpeningTag()
          } else if (c === '=') {
            nameEnd = out.length
            while (nameEnd > 0 && /\s/.test(out[nameEnd - 1])) nameEnd--
            nameStart = nameEnd
            while (nameStart > 0 && !/[\s"'>/]/.test(out[nameStart - 1])) nameStart--
            attrMarked = false
            state = S.AfterEq
          }
          break
        case S.AfterEq:
          if (c === '"') state = S.Dq
          else if (c === "'") state = S.Sq
          else if (c === '>') state = finishOpeningTag()
          else if (!/\s/.test(c)) state = S.Unq
          break
        case S.Dq:
          if (c === '"') state = S.Tag
          break
        case S.Sq:
          if (c === "'") state = S.Tag
          break
        case S.Unq:
          if (/\s/.test(c)) state = S.Tag
          else if (c === '>') state = finishOpeningTag()
          break
      }
      out += c
    }

    if (i === strings.length - 1) break

    // Place a marker for hole i based on where the scanner is.
    if (state === S.Text) {
      out += `<!--m$${i}-->`
    } else if (state === S.Dq || state === S.Sq || state === S.AfterEq) {
      if (!attrMarked) {
        names.set(i, out.slice(nameStart, nameEnd))
        const renamed = `m-${i}`
        out = out.slice(0, nameStart) + renamed + out.slice(nameEnd)
        attrMarked = true
      }
      if (state === S.AfterEq) {
        out += `"${MARK}"`
        state = S.Tag
      } else {
        out += MARK
      }
    } else {
      const where = state === S.Comment ? 'inside an HTML comment' : state === S.Raw ? `inside <${rawTag}>` : 'in this position'
      throw new Error(
        `mini: bindings are not supported ${where}. Use a text or attribute-value position ` +
          `(for <textarea> use .value=\${…}). Template: ${strings.join('${…}').slice(0, 120)}`,
      )
    }
  }
  return { out, names }
}

function prepare(result: TemplateResult): Prepared {
  const store = result.svg ? cache.svg : cache.html
  let prepared = store.get(result.strings)
  if (prepared) return prepared

  const { out, names } = markup(result.strings)
  const el = document.createElement('template')
  el.innerHTML = result.svg ? `<svg>${out}</svg>` : out
  if (result.svg) {
    const wrapper = el.content.firstChild!
    el.content.replaceChildren(...wrapper.childNodes)
  }

  const specs: PartSpec[] = []
  const walker = document.createTreeWalker(el.content, 129 /* elements + comments */)
  let index = -1
  let node: Node | null
  while ((node = walker.nextNode())) {
    index++
    if (node.nodeType === 1) {
      const elem = node as Element
      for (const attr of elem.getAttributeNames()) {
        const m = ATTR_RE.exec(attr)
        if (!m) continue
        const statics = elem.getAttribute(attr)!.split(MARK)
        elem.removeAttribute(attr)
        const value = Number(m[1])
        specs.push({ kind: 'attr', node: index, value, name: names.get(value)!, strings: statics })
      }
    } else {
      const m = CHILD_RE.exec((node as Comment).data)
      if (m) {
        ;(node as Comment).data = ''
        node.parentNode!.insertBefore(document.createComment(''), node)
        index++ // the start marker we just inserted is visited when cloning
        specs.push({ kind: 'child', node: index, value: Number(m[1]) })
      }
    }
  }

  const holes = specs.reduce((n, s) => n + (s.kind === 'child' ? 1 : s.strings.length - 1), 0)
  if (holes !== result.strings.length - 1) {
    throw new Error(
      `mini: could not place all bindings (found ${holes} of ${result.strings.length - 1}). ` +
        `Check for bindings inside <textarea>, <style>, <script> or malformed HTML.`,
    )
  }
  // Child parts update first so e.g. <select .value=${v}> sees its <option>s.
  specs.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'child' ? -1 : 1))

  prepared = { el, specs }
  store.set(result.strings, prepared)
  return prepared
}

// ---- parts ------------------------------------------------------------------

export interface RenderOptions {
  /** `this` for event handlers (components pass themselves). */
  host?: unknown
}

interface Part {
  set(values: unknown[]): void
}

class AttrPart implements Part {
  #last: unknown[] = []
  #first = true
  constructor(
    private el: Element,
    private name: string,
    private strings: string[],
    private start: number,
  ) {}
  set(values: unknown[]) {
    const n = this.strings.length - 1
    let changed = this.#first
    this.#first = false
    for (let i = 0; i < n; i++) {
      const v = unwrap(values[this.start + i])
      if (!Object.is(v, this.#last[i])) changed = true
      this.#last[i] = v
    }
    if (!changed) return
    if (n === 1 && this.strings[0] === '' && this.strings[1] === '') {
      const v = this.#last[0]
      if (v == null) this.el.removeAttribute(this.name)
      else this.el.setAttribute(this.name, String(v))
      return
    }
    let s = this.strings[0]
    for (let i = 0; i < n; i++) s += (this.#last[i] ?? '') + this.strings[i + 1]
    this.el.setAttribute(this.name, s)
  }
}

class BoolPart implements Part {
  constructor(
    private el: Element,
    private name: string,
    private i: number,
  ) {}
  set(values: unknown[]) {
    this.el.toggleAttribute(this.name, !!unwrap(values[this.i]))
  }
}

class PropPart implements Part {
  constructor(
    private el: Element,
    private name: string,
    private i: number,
  ) {}
  set(values: unknown[]) {
    const v = values[this.i]
    const el = this.el as any
    // read untracked: a component's prop is a signal, and the render setting it mustn't start
    // following it (a new object each render would make it render again, and again)
    if (!Object.is(untrack(() => el[this.name]), v)) el[this.name] = v
  }
}

class EventPart implements Part {
  #fn: unknown = null
  #bound = false
  constructor(
    private el: Element,
    private type: string,
    private i: number,
    private host: unknown,
  ) {}
  set(values: unknown[]) {
    this.#fn = values[this.i]
    if (!this.#bound && this.#fn) {
      this.#bound = true
      this.el.addEventListener(this.type, this)
    }
  }
  handleEvent(e: Event) {
    const fn = this.#fn
    if (typeof fn === 'function') fn.call(this.host ?? this.el, e)
    else if (fn && typeof (fn as EventListenerObject).handleEvent === 'function') (fn as EventListenerObject).handleEvent(e)
  }
}

class Instance {
  parts: Part[] = []
  constructor(
    public tpl: Prepared,
    private opts: RenderOptions,
  ) {}
  clone(): DocumentFragment {
    const frag = document.importNode(this.tpl.el.content, true)
    const walker = document.createTreeWalker(frag, 129)
    const specs = this.tpl.specs
    const byNode = new Map<number, PartSpec[]>()
    for (const s of specs) (byNode.get(s.node) ?? byNode.set(s.node, []).get(s.node)!).push(s)
    const made = new Map<PartSpec, Part>()
    let index = -1
    let node: Node | null
    while (made.size < specs.length && (node = walker.nextNode())) {
      index++
      for (const s of byNode.get(index) ?? []) made.set(s, this.#make(s, node))
    }
    this.parts = specs.map((s) => made.get(s)!)
    return frag
  }
  #make(s: PartSpec, node: Node): Part {
    if (s.kind === 'child') return new ChildPart(node.previousSibling!, node, this.opts, s.value)
    const el = node as Element
    const prefix = s.name[0]
    const name = s.name.slice(1)
    const single = s.strings.length === 2 && s.strings[0] === '' && s.strings[1] === ''
    if ((prefix === '@' || prefix === '.' || prefix === '?') && !single) {
      throw new Error(`mini: "${s.name}" must be bound to a single value, e.g. ${s.name}=\${value}`)
    }
    if (prefix === '@') return new EventPart(el, name, s.value, this.opts.host)
    if (prefix === '.') return new PropPart(el, name, s.value)
    if (prefix === '?') return new BoolPart(el, name, s.value)
    return new AttrPart(el, s.name, s.strings, s.value)
  }
  update(values: unknown[]) {
    for (const p of this.parts) p.set(values)
  }
}

function removeRange(start: Node, end: Node) {
  const parent = start.parentNode!
  let n: Node | null = start
  while (n) {
    const next: Node | null = n.nextSibling
    parent.removeChild(n)
    if (n === end) break
    n = next
  }
}

/**
 * Move a marker-delimited range before `before`. Uses Node.moveBefore() where available, which
 * keeps focus and other live state (insertBefore removes then re-inserts, which blurs the node).
 */
function moveRange(start: Node, end: Node, before: Node) {
  const parent = before.parentNode as Node & { moveBefore?: (node: Node, child: Node | null) => void }
  let n: Node | null = start
  while (n) {
    const next: Node | null = n.nextSibling
    if (parent.moveBefore) {
      try {
        parent.moveBefore(n, before)
      } catch {
        parent.insertBefore(n, before) // e.g. moves the browser refuses across roots
      }
    } else parent.insertBefore(n, before)
    if (n === end) break
    n = next
  }
}

/** Indices (as a mask) of a longest increasing subsequence, ignoring -1s. */
function lis(arr: Int32Array): Uint8Array {
  const n = arr.length
  const prev = new Int32Array(n)
  const tails: number[] = []
  for (let i = 0; i < n; i++) {
    const v = arr[i]
    if (v < 0) continue
    let lo = 0
    let hi = tails.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (arr[tails[mid]] < v) lo = mid + 1
      else hi = mid
    }
    prev[i] = lo > 0 ? tails[lo - 1] : -1
    tails[lo] = i
  }
  const out = new Uint8Array(n)
  let k = tails.length ? tails[tails.length - 1] : -1
  for (let j = tails.length; j-- > 0; ) {
    out[k] = 1
    k = prev[k]
  }
  return out
}

type Kind = 'empty' | 'text' | 'node' | 'raw' | 'tpl' | 'list' | 'each'

/** A dynamic region between two comment markers. */
class ChildPart implements Part {
  #kind: Kind = 'empty'
  #value: unknown
  #inst?: Instance
  #list?: ChildPart[]
  #keyed?: { key: unknown; part: ChildPart }[]
  constructor(
    readonly start: Node,
    readonly end: Node,
    private opts: RenderOptions,
    private i = 0,
  ) {}

  set(values: unknown[]) {
    this.setValue(values[this.i])
  }

  setValue(raw: unknown) {
    const v = unwrap(raw)
    if (v == null || v === false || v === true || v === '') return this.#to('empty')
    if (isTemplate(v)) return this.#template(v)
    if (isEach(v)) return this.#each(v)
    if (isRaw(v)) return this.#raw(v[RAW])
    if (v instanceof Node) return this.#node(v)
    if (typeof v === 'object' && Symbol.iterator in v && typeof v !== 'string') return this.#iter(v as Iterable<unknown>)
    return this.#text(String(v))
  }

  /** Remove everything between the markers and switch kind. */
  #to(kind: Kind) {
    if (this.#kind === kind && kind === 'empty') return
    const parent = this.end.parentNode!
    while (this.start.nextSibling && this.start.nextSibling !== this.end) parent.removeChild(this.start.nextSibling)
    this.#kind = kind
    this.#value = this.#inst = this.#list = this.#keyed = undefined
  }

  #insert(node: Node) {
    this.end.parentNode!.insertBefore(node, this.end)
  }

  #text(s: string) {
    if (this.#kind === 'text') {
      if (this.#value !== s) (this.start.nextSibling as Text).data = s
    } else {
      this.#to('text')
      this.#insert(document.createTextNode(s))
    }
    this.#value = s
  }

  #node(n: Node) {
    if (this.#kind === 'node' && this.#value === n) return
    this.#to('node')
    this.#insert(n)
    this.#value = n
  }

  #raw(s: string) {
    if (this.#kind === 'raw' && this.#value === s) return
    this.#to('raw')
    const t = document.createElement('template')
    t.innerHTML = s
    this.#insert(t.content)
    this.#value = s
  }

  #template(r: TemplateResult) {
    const tpl = prepare(r)
    if (this.#kind === 'tpl' && this.#inst!.tpl === tpl) {
      this.#inst!.update(r.values)
      return
    }
    this.#to('tpl')
    const inst = new Instance(tpl, this.opts)
    const frag = inst.clone()
    inst.update(r.values)
    this.#insert(frag)
    this.#inst = inst
  }

  #newChild(before: Node): ChildPart {
    const parent = before.parentNode!
    const s = parent.insertBefore(document.createComment(''), before)
    const e = parent.insertBefore(document.createComment(''), before)
    return new ChildPart(s, e, this.opts)
  }

  #iter(items: Iterable<unknown>) {
    if (this.#kind !== 'list') {
      this.#to('list')
      this.#list = []
    }
    const list = this.#list!
    let i = 0
    for (const item of items) {
      if (i >= list.length) list.push(this.#newChild(this.end))
      list[i++].setValue(item)
    }
    while (list.length > i) {
      const p = list.pop()!
      removeRange(p.start, p.end)
    }
  }

  #each(r: EachResult<unknown>) {
    if (this.#kind !== 'each') {
      this.#to('each')
      this.#keyed = []
    }
    const old = this.#keyed!
    const items = [...r.items]
    const n = items.length
    const keys = items.map(r.key)
    if (new Set(keys).size !== n) throw new Error('mini: each() keys must be unique')

    const oldIndex = new Map(old.map((e, i) => [e.key, i]))
    const source = new Int32Array(n).fill(-1)
    const used = new Uint8Array(old.length)
    for (let i = 0; i < n; i++) {
      const oi = oldIndex.get(keys[i])
      if (oi !== undefined) {
        source[i] = oi
        used[oi] = 1
      }
    }
    for (let oi = 0; oi < old.length; oi++) {
      if (!used[oi]) removeRange(old[oi].part.start, old[oi].part.end)
    }

    // Items on the longest increasing subsequence keep their place; others move.
    const stay = lis(source)
    const next: { key: unknown; part: ChildPart }[] = new Array(n)
    let anchor: Node = this.end
    for (let i = n - 1; i >= 0; i--) {
      let part: ChildPart
      if (source[i] < 0) part = this.#newChild(anchor)
      else {
        part = old[source[i]].part
        if (!stay[i]) moveRange(part.start, part.end, anchor)
      }
      part.setValue(r.view(items[i], i))
      next[i] = { key: keys[i], part }
      anchor = part.start
    }
    this.#keyed = next
  }
}

const roots = new WeakMap<Node, ChildPart>()

/**
 * Render a value (usually an html`` result) into a container. The first call
 * replaces the container's content; later calls update it in place.
 */
export function render(value: unknown, container: Element | DocumentFragment, options: RenderOptions = {}): void {
  let part = roots.get(container)
  // Start over if other code cleared the container (e.g. innerHTML = '') since the last render.
  if (!part || part.end.parentNode !== container) {
    container.replaceChildren()
    const start = container.appendChild(document.createComment(''))
    const end = container.appendChild(document.createComment(''))
    part = new ChildPart(start, end, options)
    roots.set(container, part)
  }
  part.setValue(value)
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. Components
// ═══════════════════════════════════════════════════════════════════════════

type PropType = StringConstructor | NumberConstructor | BooleanConstructor | ArrayConstructor | ObjectConstructor

export interface PropOptions {
  type: PropType
  /** Default value. Use a function for arrays/objects: `default: () => []`. */
  default?: unknown
  /** Attribute name (default: kebab-case of the prop), or false for property-only. */
  attribute?: string | boolean
  /** Write the value back to the attribute when the property changes. */
  reflect?: boolean
}

export type PropDef = PropType | PropOptions

const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())

/** Tag for component styles; returns the CSS text. */
export function css(strings: TemplateStringsArray, ...values: unknown[]): string {
  return String.raw({ raw: strings }, ...values)
}

const canAdopt =
  typeof Document !== 'undefined' &&
  'adoptedStyleSheets' in Document.prototype &&
  typeof CSSStyleSheet !== 'undefined' &&
  'replaceSync' in CSSStyleSheet.prototype

interface ComponentClass {
  props: Record<string, PropDef>
  styles?: string
  shadow: boolean
  _meta?: Meta
}

interface Meta {
  props: Map<string, Required<Omit<PropOptions, 'attribute'>> & { attribute: string | false }>
  attrs: Map<string, string> // attribute name -> prop name
  sheet?: CSSStyleSheet
}

function meta(ctor: ComponentClass & Function): Meta {
  if (Object.hasOwn(ctor, '_meta')) return ctor._meta!
  const m: Meta = { props: new Map(), attrs: new Map() }
  for (const [name, def] of Object.entries(ctor.props ?? {})) {
    const o: PropOptions = typeof def === 'function' ? { type: def } : def
    const attribute = o.attribute === undefined || o.attribute === true ? kebab(name) : o.attribute
    m.props.set(name, { type: o.type, default: o.default, attribute, reflect: !!o.reflect })
    if (attribute) m.attrs.set(attribute, name)
    if (!(name in ctor.prototype) || !Object.getOwnPropertyDescriptor(ctor.prototype, name)?.get) {
      Object.defineProperty(ctor.prototype, name, {
        configurable: true,
        get(this: Component) {
          return this._prop(name).value
        },
        set(this: Component, v: unknown) {
          this._setProp(name, v)
        },
      })
    }
  }
  ctor._meta = m
  return m
}

function fromAttr(v: string | null, type: PropType, fallback: unknown): unknown {
  if (type === Boolean) return v !== null
  if (v === null) return fallback
  if (type === Number) return Number(v)
  if (type === Array || type === Object) {
    try {
      return JSON.parse(v)
    } catch {
      return fallback
    }
  }
  return v
}

/**
 * Base class for web components.
 *
 *   class MyCounter extends Component {
 *     static props = { count: { type: Number, default: 0 } }
 *     declare count: number
 *     render() { return html`<button @click=${() => this.count++}>${this.count}</button>` }
 *   }
 *   define('my-counter', MyCounter)
 *
 * render() runs inside an effect: any signal or prop it reads triggers a
 * re-render (batched to one per microtask).
 */
export class Component extends HTMLElement {
  static props: Record<string, PropDef> = {}
  static styles?: string
  /** Render into a shadow root (true) or directly into the element (false). */
  static shadow = true

  static get observedAttributes(): string[] {
    return [...meta(this as unknown as ComponentClass & Function).attrs.keys()]
  }

  #signals = new Map<string, Signal<unknown>>()
  #effect?: Effect
  #cleanup?: Cleanup
  #reflecting = false
  #early = new Map<string, unknown>()

  constructor() {
    super()
    // Properties set before the element was upgraded win over class-field defaults.
    for (const name of this.#meta.props.keys()) {
      if (Object.hasOwn(this, name)) {
        this.#early.set(name, (this as any)[name])
        delete (this as any)[name]
      }
    }
  }

  /** Override to return the component's template. */
  render?(): unknown
  /** Called after the first render on every connect. May return a cleanup. */
  mounted?(): void | Cleanup
  /** Called on disconnect. */
  unmounted?(): void
  /** Called after every render. */
  updated?(): void

  get #meta(): Meta {
    return meta(this.constructor as unknown as ComponentClass & Function)
  }

  /** The node templates render into (shadow root or the element itself). */
  get renderRoot(): Element | ShadowRoot {
    const ctor = this.constructor as unknown as ComponentClass
    if (!ctor.shadow) return this
    if (this.shadowRoot) return this.shadowRoot
    const root = this.attachShadow({ mode: 'open' })
    const styles = ctor.styles
    if (styles) {
      const m = this.#meta
      if (canAdopt) {
        if (!m.sheet) {
          m.sheet = new CSSStyleSheet()
          m.sheet.replaceSync(styles)
        }
        root.adoptedStyleSheets = [m.sheet]
      }
    }
    return root
  }

  /** @internal */
  _prop(name: string): Signal<unknown> {
    let s = this.#signals.get(name)
    if (!s) {
      const def = this.#meta.props.get(name)!
      const d = def.default
      s = signal(typeof d === 'function' ? (d as () => unknown)() : def.type === Boolean ? (d ?? false) : d)
      this.#signals.set(name, s)
    }
    return s
  }

  /** @internal */
  _setProp(name: string, v: unknown) {
    this._prop(name).value = v
    const def = this.#meta.props.get(name)!
    if (def.reflect && def.attribute && !this.#reflecting) {
      this.#reflecting = true
      if (def.type === Boolean) this.toggleAttribute(def.attribute, !!v)
      else if (v == null) this.removeAttribute(def.attribute)
      else this.setAttribute(def.attribute, typeof v === 'object' ? JSON.stringify(v) : String(v))
      this.#reflecting = false
    }
  }

  /** Move own properties (set before upgrade, or class-field defaults) into prop signals. */
  #adoptOwnProps() {
    for (const name of this.#meta.props.keys()) {
      if (Object.hasOwn(this, name)) {
        const v = (this as any)[name]
        delete (this as any)[name]
        ;(this as any)[name] = v
      }
    }
  }

  attributeChangedCallback(attr: string, _old: string | null, value: string | null) {
    if (this.#reflecting) return
    const name = this.#meta.attrs.get(attr)
    if (!name) return
    const def = this.#meta.props.get(name)!
    const d = typeof def.default === 'function' ? (def.default as () => unknown)() : def.default
    this.#reflecting = true
    ;(this as any)[name] = fromAttr(value, def.type, d)
    this.#reflecting = false
  }

  connectedCallback() {
    this.#adoptOwnProps()
    for (const [name, v] of this.#early) (this as any)[name] = v
    this.#early.clear()
    const root = this.renderRoot
    if (this.render) {
      // One flag per effect: a render queued before a disconnect must not block the next connection.
      let queued = false
      const fx = new Effect(
        () => {
          render(this.render!(), root, { host: this })
          untrack(() => this.updated?.())
        },
        (run) => {
          if (queued) return
          queued = true
          queueMicrotask(() => {
            queued = false
            run()
          })
        },
      )
      this.#effect = fx
      fx.run()
    }
    // Fallback when constructable stylesheets are unavailable (after render, which clears the root once).
    const ctor = this.constructor as unknown as ComponentClass
    if (ctor.shadow && ctor.styles && !canAdopt && !root.querySelector('style[data-mini]')) {
      const style = document.createElement('style')
      style.dataset.mini = ''
      style.textContent = ctor.styles
      root.prepend(style)
    }
    const c = untrack(() => this.mounted?.())
    if (typeof c === 'function') this.#cleanup = c
  }

  disconnectedCallback() {
    this.#effect?.dispose()
    this.#effect = undefined
    this.#cleanup?.()
    this.#cleanup = undefined
    this.unmounted?.()
  }

  /** Dispatch a bubbling, composed CustomEvent from this element. */
  emit<T>(type: string, detail?: T, init: EventInit = {}): boolean {
    return this.dispatchEvent(new CustomEvent(type, { bubbles: true, composed: true, cancelable: true, ...init, detail }))
  }
}

/** Register a component class under a tag name (no-op if already defined). */
export function define(tag: string, ctor: CustomElementConstructor): void {
  if (ctor.prototype instanceof Component) meta(ctor as unknown as ComponentClass & Function)
  if (!customElements.get(tag)) customElements.define(tag, ctor)
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. Behaviors — data-behavior / data-action
// ═══════════════════════════════════════════════════════════════════════════
//
//   <div data-behavior="dropdown">
//     <button data-action="dropdown#toggle">Menu</button>
//   </div>
//   <button data-action="click->copy:prevent" data-text="hi">Copy</button>

export type BehaviorInstance = { destroy?(): void; [method: string]: any }
export type BehaviorSetup = (el: HTMLElement) => void | Cleanup | BehaviorInstance
export type ActionHandler = (event: Event, el: HTMLElement) => void

const behaviors = new Map<string, BehaviorSetup>()
const actions = new Map<string, ActionHandler>()
const mounted = new WeakMap<Element, Map<string, void | Cleanup | BehaviorInstance>>()

/** Register a behavior, attached to every element with data-behavior~="name". */
export function behavior(name: string, setup: BehaviorSetup): void {
  behaviors.set(name, setup)
  if (!started) return
  const sel = `[data-behavior~="${name}"]`
  const scope = rootElement()
  if (scope.matches(sel)) mountBehaviors(scope)
  for (const el of scope.querySelectorAll(sel)) mountBehaviors(el)
}

/** Register a global action for data-action="name" / data-action="event->name". */
export function action(name: string, handler: ActionHandler): void {
  actions.set(name, handler)
}

/** Get the object returned by a behavior's setup for an element. */
export function getBehavior<T extends BehaviorInstance = BehaviorInstance>(el: Element, name: string): T | undefined {
  const inst = mounted.get(el)?.get(name)
  return inst && typeof inst === 'object' ? (inst as T) : undefined
}

function destroy(inst: void | Cleanup | BehaviorInstance) {
  try {
    if (typeof inst === 'function') inst()
    else inst?.destroy?.()
  } catch (err) {
    console.error('mini: behavior cleanup failed', err)
  }
}

function mountBehaviors(el: Element) {
  const names = (el.getAttribute('data-behavior') ?? '').split(/\s+/).filter(Boolean)
  let map = mounted.get(el)
  for (const [name, inst] of map ?? []) {
    if (!names.includes(name)) {
      destroy(inst)
      map!.delete(name)
    }
  }
  for (const name of names) {
    if (map?.has(name)) continue
    const setup = behaviors.get(name)
    if (!setup) continue
    if (!map) mounted.set(el, (map = new Map()))
    try {
      map.set(name, setup(el as HTMLElement))
    } catch (err) {
      console.error(`mini: behavior "${name}" failed to mount`, err)
    }
  }
}

function unmountBehaviors(el: Element) {
  const map = mounted.get(el)
  if (!map) return
  for (const inst of map.values()) destroy(inst)
  mounted.delete(el)
}

interface ActionSpec {
  event: string
  target: string
  prevent: boolean
  stop: boolean
}

const actionCache = new Map<string, ActionSpec[]>()

function defaultActionEvent(el: Element): string {
  const tag = el.tagName
  if (tag === 'FORM') return 'submit'
  if (tag === 'SELECT') return 'change'
  if (tag === 'INPUT' || tag === 'TEXTAREA') return 'input'
  return 'click'
}

function parseActions(el: Element, attr: string): ActionSpec[] {
  const key = el.tagName + '|' + attr
  let specs = actionCache.get(key)
  if (specs) return specs
  specs = attr
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => {
      const [head, ...mods] = token.split(':')
      const arrow = head.indexOf('->')
      return {
        event: arrow >= 0 ? head.slice(0, arrow) : defaultActionEvent(el),
        target: arrow >= 0 ? head.slice(arrow + 2) : head,
        prevent: mods.includes('prevent'),
        stop: mods.includes('stop'),
      }
    })
  actionCache.set(key, specs)
  return specs
}

function runActions(e: Event, el: Element, attr: string) {
  for (const spec of parseActions(el, attr)) {
    if (spec.event !== e.type) continue
    if (spec.prevent) e.preventDefault()
    if (spec.stop) e.stopPropagation()
    const hash = spec.target.indexOf('#')
    try {
      if (hash >= 0) {
        const name = spec.target.slice(0, hash)
        const method = spec.target.slice(hash + 1)
        const host = el.closest(`[data-behavior~="${name}"]`)
        const inst = host && getBehavior(host, name)
        if (inst && typeof inst[method] === 'function') inst[method](e, el)
        else console.warn(`mini: no behavior method "${spec.target}" for`, el)
      } else {
        const fn = actions.get(spec.target)
        if (fn) fn(e, el as HTMLElement)
        else console.warn(`mini: no action "${spec.target}" registered`)
      }
    } catch (err) {
      console.error(`mini: action "${spec.target}" failed`, err)
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. Fetch — htmx-style attributes + JSON api helper
// ═══════════════════════════════════════════════════════════════════════════
//
//   <button data-get="/users" data-target="#list">Load</button>
//   <form data-post="/users" data-target="#list" data-swap="beforeend">…</form>
//   <input name="q" data-get="/search" data-trigger="input delay:300ms" data-target="#results">
//   <form action="/items/42" method="post" data-fetch data-target="#item">…</form>

export interface CsrfConfig {
  /** Request header the token is sent in. */
  header: string
  /** Read the token from this cookie (URL-decoded), e.g. `XSRF-TOKEN`. Checked first. */
  cookie?: string
  /** Read the token from `<meta name="…" content="…">`. */
  meta?: string
}

export const config = {
  /** Prepended to relative URLs used by api() / resource(). */
  baseUrl: '',
  /** Extra headers sent with every request. */
  headers: {} as Record<string, string>,
  /**
   * CSRF token for non-GET requests. Only ever sent to the page's own origin.
   * Cookie style: `config.csrf = { cookie: 'XSRF-TOKEN', header: 'X-XSRF-TOKEN' }`.
   * Set to null to disable.
   */
  csrf: { header: 'X-CSRF-Token', meta: 'csrf-token' } as CsrfConfig | null,
}

export type SwapMode = 'innerHTML' | 'outerHTML' | 'beforebegin' | 'afterbegin' | 'beforeend' | 'afterend' | 'delete' | 'none'

const VERBS = ['get', 'post', 'put', 'patch', 'delete'] as const

/** Native form method: only "post" and "dialog" are special; anything else is GET. */
function formMethod(m: string | null): string | null {
  const v = (m ?? 'get').toLowerCase()
  return v === 'post' ? 'POST' : v === 'dialog' ? null : 'GET'
}

/** [method, url] from data-get/post/… or, with data-fetch, from the native action/method/href. */
function verbOf(el: Element): [string, string] | null {
  for (const v of VERBS) {
    const url = el.getAttribute('data-' + v)
    if (url !== null) return [v.toUpperCase(), url]
  }
  if (el.hasAttribute('data-fetch')) {
    if (el instanceof HTMLFormElement) {
      const method = formMethod(el.getAttribute('method'))
      return method ? [method, el.getAttribute('action') ?? ''] : null
    }
    if (el instanceof HTMLAnchorElement) return ['GET', el.getAttribute('href') ?? '']
  }
  return null
}

const VERB_SELECTOR = VERBS.map((v) => `[data-${v}]`).join(',') + ',[data-fetch]'

interface TriggerSpec {
  event: string
  delay: number
}

const triggerCache = new Map<string, TriggerSpec[]>()

function defaultTrigger(el: Element): string {
  const tag = el.tagName
  if (tag === 'FORM') return 'submit'
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return 'change'
  return 'click'
}

function triggers(el: Element): TriggerSpec[] {
  const attr = el.getAttribute('data-trigger') ?? defaultTrigger(el)
  let specs = triggerCache.get(attr)
  if (specs) return specs
  specs = attr
    .split(',')
    .map((part) => part.trim().split(/\s+/))
    .filter((words) => words[0])
    .map(([event, ...mods]) => {
      const d = mods.map((m) => /^delay:(\d+)(ms|s)?$/.exec(m)).find(Boolean)
      return { event, delay: d ? Number(d[1]) * (d[2] === 's' ? 1000 : 1) : 0 }
    })
  triggerCache.set(attr, specs)
  return specs
}

/** True when a (possibly relative) URL points at the page's own origin. */
function isSameOrigin(url: string): boolean {
  try {
    return resolveUrl(url).origin === location.origin
  } catch {
    return false
  }
}

/** Resolve a URL the way fetch() does: against the document base URL, which <base href> can change. */
function resolveUrl(url: string): URL {
  return new URL(url, document.baseURI)
}

function readCookie(name: string): string | undefined {
  for (const part of document.cookie.split(';')) {
    const i = part.indexOf('=')
    if (i < 0 || part.slice(0, i).trim() !== name) continue
    const raw = part.slice(i + 1).trim()
    try {
      return decodeURIComponent(raw)
    } catch {
      return raw
    }
  }
}

function csrfToken(c: CsrfConfig): string | undefined {
  const fromCookie = c.cookie ? readCookie(c.cookie) : undefined
  if (fromCookie) return fromCookie
  if (c.meta) return document.querySelector<HTMLMetaElement>(`meta[name="${c.meta}"]`)?.content || undefined
}

/** config.headers plus the CSRF header for same-origin, state-changing requests. */
function requestHeaders(method: string, url: string): Record<string, string> {
  const h: Record<string, string> = { ...config.headers }
  const c = config.csrf
  if (c && method !== 'GET' && method !== 'HEAD' && typeof document !== 'undefined' && isSameOrigin(url)) {
    const token = csrfToken(c)
    if (token) h[c.header] = token
  }
  return h
}

function resolveTarget(el: Element): Element | null {
  const t = el.getAttribute('data-target')?.trim()
  if (!t || t === 'this') return el
  if (t.startsWith('closest ')) return el.closest(t.slice(8))
  if (t.startsWith('find ')) return el.querySelector(t.slice(5))
  return document.querySelector(t)
}

function collect(el: Element, method: string, submitter?: Element | null): FormData {
  const fd = new FormData()
  const form = el instanceof HTMLFormElement ? el : method !== 'GET' ? el.closest('form') : null
  if (form) for (const [k, v] of new FormData(form)) fd.append(k, v)
  const sub = submitter as HTMLButtonElement | null | undefined
  if (sub?.name) fd.append(sub.name, sub.value)

  // FormData(form) excludes buttons. A button that owns data-post/etc. handles
  // its click directly rather than arriving as a SubmitEvent.submitter, so keep
  // its action name/value alongside the rest of the enclosing form fields.
  if (form && el instanceof HTMLButtonElement && el !== submitter && el.name) {
    fd.append(el.name, el.value)
  }
  // When the enclosing form was collected, the triggering field is already in
  // FormData (including repeated `name[]` values). Adding it again would either
  // duplicate it or collapse the group. A standalone field needs explicit
  // handling for multi-selects and files because `.value` represents only one
  // value (or a fake path).
  if (!form && !(el instanceof HTMLFormElement)) {
    const field = el as HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
    if (field.name) {
      if (field instanceof HTMLSelectElement && field.multiple) {
        for (const option of field.selectedOptions) fd.append(field.name, option.value)
      } else if (field instanceof HTMLInputElement && field.type === 'file') {
        for (const file of field.files ?? []) fd.append(field.name, file)
      } else {
        const unchecked =
          field instanceof HTMLInputElement &&
          (field.type === 'checkbox' || field.type === 'radio') &&
          !field.checked
        if (!unchecked) fd.append(field.name, field.value)
      }
    }
  }
  const vals = el.getAttribute('data-vals')
  if (vals) {
    try {
      for (const [k, v] of Object.entries(JSON.parse(vals))) fd.set(k, typeof v === 'string' ? v : JSON.stringify(v))
    } catch {
      console.error('mini: data-vals must be valid JSON', el)
    }
  }
  return fd
}

/**
 * Whether the effective enctype (submit button's formenctype, else the form's enctype) is
 * multipart. Read from attributes, since a field named "enctype" shadows form.enctype.
 */
function isMultipart(el: Element, submitter?: Element | null): boolean {
  const form = el instanceof HTMLFormElement ? el : el.closest('form')
  const value = submitter?.getAttribute('formenctype') ?? form?.getAttribute('enctype') ?? ''
  return value.trim().toLowerCase() === 'multipart/form-data'
}

/** The browsing context a native navigation would use: formtarget / target, else "". */
function nativeTarget(el: Element, submitter?: Element | null): string {
  return (submitter?.getAttribute('formtarget') ?? el.getAttribute('target') ?? '').trim().toLowerCase()
}

function toParams(fd: FormData): URLSearchParams {
  const p = new URLSearchParams()
  for (const [k, v] of fd) if (typeof v === 'string') p.append(k, v)
  return p
}

/** Fire a mini:* event from the source element, or from document once it has left the page. */
function emit(el: Element, type: string, detail: object, cancelable = false): boolean {
  const target = el.isConnected ? el : document
  return target.dispatchEvent(new CustomEvent(type, { bubbles: true, cancelable, detail: { source: el, ...detail } }))
}

/**
 * Insert HTML relative to a target, then activate any behaviors / fetch
 * triggers inside it. `select` picks elements out of the HTML first.
 * Returns whether the page changed (false only for mode "none").
 */
export function swap(target: Element | string, markup: string, mode: SwapMode = 'innerHTML', select?: string): boolean {
  const el = typeof target === 'string' ? document.querySelector(target) : target
  if (!el) throw new Error(`mini: swap target not found: ${target}`)
  if (mode === 'none') return false
  const t = document.createElement('template')
  t.innerHTML = markup
  let frag = t.content
  if (select) {
    const picked = document.createDocumentFragment()
    picked.append(...frag.querySelectorAll(select))
    frag = picked
  }
  const nodes = [...frag.childNodes]
  switch (mode) {
    case 'innerHTML':
      el.replaceChildren(frag)
      break
    case 'outerHTML':
      el.replaceWith(frag)
      break
    case 'beforebegin':
      el.before(frag)
      break
    case 'afterbegin':
      el.prepend(frag)
      break
    case 'beforeend':
      el.append(frag)
      break
    case 'afterend':
      el.after(frag)
      break
    case 'delete':
      el.remove()
      break
    default:
      throw new Error(`mini: unknown swap mode "${mode}"`)
  }
  if (started) for (const n of nodes) if (n instanceof Element && n.isConnected && root.contains(n)) mount(n)
  return true
}

/**
 * The request an element has in flight. Reads (GET) are replaceable: a newer request or
 * removing the element aborts them. Writes are not: aborting can't undo what the server
 * already did, so they always run to the end and repeat triggers are ignored meanwhile.
 */
interface Inflight {
  method: string
  controller: AbortController
  promise: Promise<void>
}

const inflight = new WeakMap<Element, Inflight>()
const timers = new WeakMap<Element, ReturnType<typeof setTimeout>>()

/** The element left the page: drop its unsent (delayed) request and abort an in-flight read. */
function cancelRequest(el: Element) {
  clearTimeout(timers.get(el))
  timers.delete(el)
  const req = inflight.get(el)
  if (req?.method === 'GET') req.controller.abort()
}

/**
 * Perform the request described by an element's data-get/post/… attributes
 * and swap the response into its target. Resolves when the swap is done.
 */
export async function trigger(el: Element, submitter?: Element | null): Promise<void> {
  const verb = verbOf(el)
  if (!verb) throw new Error('mini: trigger() needs data-get/post/put/patch/delete or data-fetch')
  let [method, url] = verb
  // A native submit button can override a data-fetch form's action/method.
  if (submitter && el instanceof HTMLFormElement && el.hasAttribute('data-fetch')) {
    url = submitter.getAttribute('formaction') ?? url
    if (submitter.hasAttribute('formmethod')) method = formMethod(submitter.getAttribute('formmethod')) ?? method
  }
  // A write is still running for this element (e.g. a double-clicked Save): ignore this one.
  const running = inflight.get(el)
  if (running && running.method !== 'GET') return running.promise

  // Check and fetch the same absolute URL, so the origin check can't be fooled by <base href>.
  try {
    url = resolveUrl(url || location.href).href
  } catch {
    emit(el, 'mini:error', { error: new Error(`mini: invalid URL "${url}"`) })
    return
  }
  if (method !== 'GET' && !isSameOrigin(url)) {
    emit(el, 'mini:error', { error: new Error(`mini: refusing cross-origin ${method} to ${url}`) })
    return
  }
  const message = el.getAttribute('data-confirm')
  if (message && !confirm(message)) return
  let target: Element | null
  try {
    target = resolveTarget(el)
  } catch (cause) {
    emit(el, 'mini:error', {
      error: new Error(`mini: invalid target selector "${el.getAttribute('data-target')}"`, { cause }),
    })
    return
  }
  if (!target) {
    emit(el, 'mini:error', { error: new Error(`target not found: ${el.getAttribute('data-target')}`) })
    return
  }
  if (!emit(el, 'mini:before', { method, url, target }, true)) return

  running?.controller.abort() // a newer request replaces a pending read
  const controller = new AbortController()
  const promise = send(el, target, method, url, submitter, controller)
  inflight.set(el, { method, controller, promise })
  return promise
}

async function send(
  el: Element,
  target: Element,
  method: string,
  url: string,
  submitter: Element | null | undefined,
  controller: AbortController,
): Promise<void> {
  const fd = collect(el, method, submitter)
  let body: BodyInit | undefined
  // Only GET puts values in the URL. Every other method sends a body, so form data
  // (hidden tokens, record fields…) never ends up in URLs, logs or history.
  if (method === 'GET') {
    const u = new URL(url)
    // A native GET form submission replaces the action's query with the form's fields.
    if (el instanceof HTMLFormElement && el.hasAttribute('data-fetch')) u.search = ''
    for (const [k, v] of toParams(fd)) u.searchParams.append(k, v)
    url = u.href
  } else {
    body = isMultipart(el, submitter) ? fd : toParams(fd)
  }

  const headers: Record<string, string> = { ...requestHeaders(method, url), 'X-Mini-Request': 'true', Accept: 'text/html' }
  if (target.id) headers['X-Mini-Target'] = target.id

  el.setAttribute('data-loading', '')
  target.setAttribute('aria-busy', 'true')
  try {
    const res = await fetch(url, { method, headers, body, signal: controller.signal, credentials: 'same-origin' })
    const redirect = res.headers.get('X-Mini-Redirect')
    if (redirect) {
      location.href = redirect
      return
    }
    // An HTTP redirect (e.g. an expired session sent to /login) navigates the whole window
    // instead of swapping the login page into the target. Cancel mini:redirect to swap anyway.
    if (res.redirected && emit(el, 'mini:redirect', { url: res.url, response: res }, true)) {
      location.href = res.url
      return
    }
    const text = await res.text()
    if (controller.signal.aborted) return
    // `swapped` = the reply changed the page. Not when the target left the page while a write
    // was running (nowhere to swap), and not for data-swap="none".
    const put = () =>
      target.isConnected &&
      swap(target, text, (el.getAttribute('data-swap') ?? 'innerHTML') as SwapMode, el.getAttribute('data-select') ?? undefined)
    if (!res.ok) {
      const swapped = swapsError(el, res.status) && put()
      emit(el, 'mini:error', { response: res, text, target, swapped })
      return
    }
    const swapped = put()
    emit(el, 'mini:after', { response: res, target, swapped })
  } catch (error) {
    if ((error as Error)?.name !== 'AbortError') emit(el, 'mini:error', { error, target })
  } finally {
    if (inflight.get(el)?.controller === controller) {
      inflight.delete(el)
      el.removeAttribute('data-loading')
      target.removeAttribute('aria-busy')
    }
  }
}

/** data-swap-error="422" / "422 409" / "4xx": error statuses whose HTML is swapped in anyway. */
function swapsError(el: Element, status: number): boolean {
  const attr = el.getAttribute('data-swap-error')
  if (!attr) return false
  const code = String(status)
  return attr.split(/[\s,]+/).some((t) => t === code || (/^\dxx$/i.test(t) && t[0] === code[0]))
}

function onFetchEvent(e: Event, el: Element): boolean {
  const spec = triggers(el).find((t) => t.event === e.type)
  if (!spec) return false
  const submitter = (e as SubmitEvent).submitter ?? null
  const opensElsewhere = (t: string) => t !== '' && t !== '_self'
  // Leave new-tab / download style link clicks to the browser.
  if (e.type === 'click' && el instanceof HTMLAnchorElement) {
    const m = e as MouseEvent
    if (m.button > 0 || m.metaKey || m.ctrlKey || m.shiftKey || m.altKey) return false
    if (el.hasAttribute('download') || opensElsewhere(nativeTarget(el))) return false
  }
  // Native form submissions that target another window, or close a dialog, stay native.
  if (e.type === 'submit' && el instanceof HTMLFormElement && el.hasAttribute('data-fetch')) {
    if (opensElsewhere(nativeTarget(el, submitter))) return false
  }
  if (submitter?.getAttribute('formmethod')?.toLowerCase() === 'dialog') return false
  if (e.type === 'submit' || (e.type === 'click' && el.matches('a, button, input[type=submit], input[type=image]'))) {
    e.preventDefault()
  }
  if (spec.delay) {
    clearTimeout(timers.get(el))
    timers.set(
      el,
      setTimeout(() => {
        timers.delete(el)
        if (el.isConnected) void trigger(el, submitter)
      }, spec.delay),
    )
  } else {
    void trigger(el, submitter)
  }
  return true
}

// ---- JSON api ---------------------------------------------------------------

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly data: unknown,
    readonly response: Response,
    message = `HTTP ${status} ${response.statusText}`.trim(),
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export interface ApiOptions extends Omit<RequestInit, 'body' | 'method'> {
  /** Query parameters appended to the URL (null/undefined values are skipped). */
  query?: Record<string, string | number | boolean | null | undefined>
}

async function request<T>(method: string, url: string, body?: unknown, opts: ApiOptions = {}): Promise<T> {
  const { query, headers, ...init } = opts
  const u = resolveUrl(/^https?:\/\//.test(url) ? url : config.baseUrl + url)
  for (const [k, v] of Object.entries(query ?? {})) if (v != null) u.searchParams.append(k, String(v))
  const full = u.href
  const h = new Headers({ Accept: 'application/json', ...requestHeaders(method, full) })
  let payload: BodyInit | undefined
  if (body !== undefined) {
    if (
      typeof body === 'string' ||
      body instanceof FormData ||
      body instanceof URLSearchParams ||
      body instanceof Blob ||
      body instanceof ArrayBuffer
    ) {
      payload = body as BodyInit
    } else {
      payload = JSON.stringify(body)
      h.set('Content-Type', 'application/json')
    }
  }
  new Headers(headers).forEach((v, k) => h.set(k, v))
  const res = await fetch(full, {
    credentials: 'same-origin',
    ...init,
    method,
    headers: h,
    body: payload,
  })
  const type = res.headers.get('Content-Type') ?? ''
  // Redirected to an HTML page (typically the login page after the session expired).
  if (res.redirected && type.includes('text/html')) {
    location.href = res.url
    throw new ApiError(res.status, undefined, res, `Redirected to ${res.url}`)
  }
  const data = res.status === 204 ? undefined : type.includes('json') ? await res.json() : await res.text()
  if (!res.ok) throw new ApiError(res.status, data, res)
  return data as T
}

/** Small JSON fetch wrapper. Throws ApiError on non-2xx responses. */
export const api = {
  get: <T = unknown>(url: string, opts?: ApiOptions) => request<T>('GET', url, undefined, opts),
  delete: <T = unknown>(url: string, opts?: ApiOptions) => request<T>('DELETE', url, undefined, opts),
  post: <T = unknown>(url: string, body?: unknown, opts?: ApiOptions) => request<T>('POST', url, body, opts),
  put: <T = unknown>(url: string, body?: unknown, opts?: ApiOptions) => request<T>('PUT', url, body, opts),
  patch: <T = unknown>(url: string, body?: unknown, opts?: ApiOptions) => request<T>('PATCH', url, body, opts),
}

export interface Resource<T> {
  data: Signal<T | undefined>
  loading: Signal<boolean>
  error: Signal<unknown>
  /** Fetch again now. */
  reload(): Promise<void>
  /** Stop tracking and abort any in-flight request. */
  dispose(): void
}

/**
 * Async data as signals. Signals read synchronously inside `fetcher` (before
 * its first await) are tracked: when they change, the data is re-fetched and
 * the previous request is aborted.
 *
 *   const q = signal('')
 *   const users = resource((signal) => api.get<User[]>('/users', { query: { q: q.value }, signal }))
 *   html`${when(users.loading.value, () => 'Loading…')} ${each(users.data.value, 'id', …)}`
 */
export function resource<T>(fetcher: (signal: AbortSignal) => Promise<T>, initial?: T): Resource<T> {
  const data = signal<T | undefined>(initial)
  const loading = signal(false)
  const error = signal<unknown>(null)
  let ctrl: AbortController | undefined

  const run = (): Promise<void> => {
    ctrl?.abort()
    const c = (ctrl = new AbortController())
    let promise: Promise<T>
    try {
      promise = fetcher(c.signal)
    } catch (e) {
      promise = Promise.reject(e)
    }
    untrack(() =>
      batch(() => {
        loading.value = true
        error.value = null
      }),
    )
    return promise.then(
      (v) => {
        if (c !== ctrl) return
        batch(() => {
          data.value = v
          loading.value = false
        })
      },
      (e) => {
        if (c !== ctrl) return
        batch(() => {
          if (!c.signal.aborted) error.value = e
          loading.value = false
        })
      },
    )
  }

  // reload() re-runs the tracking effect so dependencies are refreshed too.
  let last: Promise<void> = Promise.resolve()
  const fx = new Effect(() => {
    last = run()
  })
  fx.run()
  return {
    data,
    loading,
    error,
    reload() {
      fx.run()
      return last
    },
    dispose() {
      fx.dispose()
      ctrl?.abort()
      // A fetcher that ignores the abort signal can still settle later: with no current
      // request, its result no longer matches and is dropped.
      ctrl = undefined
    },
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 6. Startup — event delegation + DOM observation
// ═══════════════════════════════════════════════════════════════════════════

let started = false
let root: Document | Element = typeof document !== 'undefined' ? document : (null as never)
let observer: MutationObserver | undefined
const listening = new Set<string>()
const loaded = new WeakSet<Element>()
// Delegated listeners for these events must use capture because they do not
// bubble from the element that emits them. Custom events still need
// `{ bubbles: true }` unless their type is listed here.
const NON_BUBBLING = new Set([
  'abort',
  'blur',
  'canplay',
  'canplaythrough',
  'close',
  'cuechange',
  'durationchange',
  'emptied',
  'ended',
  'error',
  'focus',
  'invalid',
  'load',
  'loadeddata',
  'loadedmetadata',
  'loadstart',
  'mouseenter',
  'mouseleave',
  'pause',
  'play',
  'playing',
  'pointerenter',
  'pointerleave',
  'progress',
  'ratechange',
  'scroll',
  'scrollend',
  'seeked',
  'seeking',
  'stalled',
  'suspend',
  'timeupdate',
  'toggle',
  'volumechange',
  'waiting',
])
const DEFAULT_EVENTS = ['click', 'submit', 'input', 'change', 'keydown']

function onEvent(e: Event) {
  let el: Element | null = e.target instanceof Element ? e.target : ((e.target as Node | null)?.parentElement ?? null)
  let fetched = false
  while (el) {
    const a = el.getAttribute('data-action')
    if (a) runActions(e, el, a)
    if (!fetched && verbOf(el)) fetched = onFetchEvent(e, el)
    if (!e.bubbles || e.cancelBubble || el === root) break
    el = el.parentElement
  }
}

/** The start() scope as an element (the <html> element when started on the document). */
function rootElement(): Element {
  return root.nodeType === 9 ? (root as Document).documentElement : (root as Element)
}

function listen(type: string) {
  if (listening.has(type) || type === 'load') return
  listening.add(type)
  root.addEventListener(type, onEvent, NON_BUBBLING.has(type))
}

/**
 * Activate data-behavior, data-action and data-get/… (load triggers) inside a
 * subtree. Called automatically for new DOM after start(); safe to repeat.
 */
export function mount(node: ParentNode): void {
  const els: Element[] = node instanceof Element ? [node] : []
  els.push(...node.querySelectorAll('[data-behavior],[data-action],[data-trigger],' + VERB_SELECTOR))
  for (const el of els) {
    if (el.hasAttribute('data-behavior')) mountBehaviors(el)
    const a = el.getAttribute('data-action')
    if (a) for (const s of parseActions(el, a)) listen(s.event)
    if (verbOf(el)) {
      for (const t of triggers(el)) {
        if (t.event === 'load') {
          if (!loaded.has(el)) {
            loaded.add(el)
            void trigger(el)
          }
        } else listen(t.event)
      }
    }
  }
}

function unmount(node: Element) {
  unmountBehaviors(node)
  for (const el of node.querySelectorAll('[data-behavior]')) unmountBehaviors(el)
  cancelRequest(node)
  for (const el of node.querySelectorAll(VERB_SELECTOR)) cancelRequest(el)
}

/**
 * Enable the declarative features (behaviors, actions, fetch attributes) for
 * the document or a subtree. Returns a stop function.
 */
export function start(scope: Document | Element = document): () => void {
  if (started) return stop
  started = true
  root = scope
  for (const t of DEFAULT_EVENTS) listen(t)
  // Observe first, so elements that behavior setups insert during the initial mount are seen too.
  observer = new MutationObserver((records) => onMutations(records))
  observer.observe(scope, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['data-behavior', 'data-action', 'data-trigger', 'data-fetch', ...VERBS.map((v) => 'data-' + v)],
  })
  mount(rootElement())
  return stop
}

function onMutations(records: MutationRecord[], removalsOnly = false) {
  for (const r of records) {
    if (r.type === 'childList') {
      for (const n of r.removedNodes) if (n instanceof Element && !n.isConnected) unmount(n)
      if (!removalsOnly) for (const n of r.addedNodes) if (n instanceof Element && n.isConnected) mount(n)
    } else if (!removalsOnly && r.target instanceof Element && r.target.isConnected) {
      if (r.attributeName === 'data-behavior') mountBehaviors(r.target)
      else mount(r.target)
    }
  }
}

function stop() {
  if (!started) return
  // Removals the observer hasn't reported yet: run their cleanups before disconnecting.
  if (observer) onMutations(observer.takeRecords(), true)
  observer?.disconnect()
  for (const t of listening) root.removeEventListener(t, onEvent, NON_BUBBLING.has(t))
  listening.clear()
  unmount(rootElement())
  started = false
}

/** Resolve after pending renders, DOM observers and microtasks have run. */
export function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0))
}
