import { afterEach, describe, expect, it, vi } from 'vitest'
import { Component, css, define, each, html, signal, tick } from '../mini'

const text = (el: Element | ShadowRoot | null) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim()

let n = 0
/** Unique tag per test so definitions don't collide. */
const tag = (name: string) => `${name}-${++n}`

afterEach(() => {
  document.body.innerHTML = ''
})

describe('Component', () => {
  it('renders into a shadow root on connect', () => {
    class Hello extends Component {
      render() {
        return html`<p>hello</p>`
      }
    }
    const t = tag('x-hello')
    define(t, Hello)
    const el = document.createElement(t)
    document.body.append(el)
    expect(text(el.shadowRoot!)).toBe('hello')
  })

  it('reads typed props from attributes', () => {
    class Card extends Component {
      static props = {
        title: String,
        count: { type: Number, default: 1 },
        open: Boolean,
        tags: { type: Array, default: () => [] },
        maxItems: Number,
      }
      declare title: string
      declare count: number
      declare open: boolean
      declare tags: string[]
      declare maxItems: number
      render() {
        return html`${this.title}|${this.count + 1}|${this.open ? 'open' : 'closed'}|${this.tags.join(',')}|${this.maxItems}`
      }
    }
    const t = tag('x-card')
    define(t, Card)
    document.body.innerHTML = `<${t} title="Hi" count="41" open tags='["a","b"]' max-items="3"></${t}>`
    const el = document.querySelector(t) as Card
    expect(text(el.shadowRoot)).toBe('Hi|42|open|a,b|3')
    expect(el.count).toBe(41)
    expect(el.open).toBe(true)
  })

  it('re-renders when props change (batched per microtask)', async () => {
    const renders = vi.fn()
    class Counter extends Component {
      static props = { count: { type: Number, default: 0 } }
      declare count: number
      render() {
        renders()
        return html`<button @click=${() => this.count++}>${this.count}</button>`
      }
    }
    const t = tag('x-counter')
    define(t, Counter)
    const el = document.createElement(t) as Counter
    document.body.append(el)
    expect(renders).toHaveBeenCalledTimes(1)

    el.count = 5
    el.count = 6
    expect(text(el.shadowRoot)).toBe('0') // not yet
    await tick()
    expect(text(el.shadowRoot)).toBe('6')
    expect(renders).toHaveBeenCalledTimes(2)

    el.shadowRoot!.querySelector('button')!.click()
    await tick()
    expect(text(el.shadowRoot)).toBe('7')
  })

  it('attribute changes update props; removing falls back to default', async () => {
    class Label extends Component {
      static props = { label: { type: String, default: 'none' } }
      declare label: string
      render() {
        return html`${this.label}`
      }
    }
    const t = tag('x-label')
    define(t, Label)
    const el = document.createElement(t) as Label
    document.body.append(el)
    el.setAttribute('label', 'set')
    await tick()
    expect(text(el.shadowRoot)).toBe('set')
    el.removeAttribute('label')
    await tick()
    expect(text(el.shadowRoot)).toBe('none')
  })

  it('reflects props to attributes when asked', () => {
    class Toggle extends Component {
      static props = { open: { type: Boolean, reflect: true }, size: { type: Number, reflect: true } }
      declare open: boolean
      declare size: number
    }
    const t = tag('x-toggle')
    define(t, Toggle)
    const el = document.createElement(t) as Toggle
    el.open = true
    el.size = 3
    expect(el.hasAttribute('open')).toBe(true)
    expect(el.getAttribute('size')).toBe('3')
    el.open = false
    expect(el.hasAttribute('open')).toBe(false)
  })

  it('local state with signals and external stores', async () => {
    const store = signal('global')
    class Stateful extends Component {
      local = signal(0)
      render() {
        return html`${store}:${this.local.value}`
      }
    }
    const t = tag('x-state')
    define(t, Stateful)
    const el = document.createElement(t) as Stateful
    document.body.append(el)
    expect(text(el.shadowRoot)).toBe('global:0')
    store.value = 'changed'
    el.local.value = 1
    await tick()
    expect(text(el.shadowRoot)).toBe('changed:1')
  })

  it('class-field defaults and properties set before upgrade are reactive', async () => {
    class Late extends Component {
      static props = { name: String }
      name = 'field-default'
      render() {
        return html`${this.name}`
      }
    }
    const t = tag('x-late')
    const early = document.createElement(t) as Late
    early.name = 'set-before-define'
    document.body.append(early)
    define(t, Late)
    expect(text(early.shadowRoot)).toBe('set-before-define')

    const el = document.createElement(t) as Late
    document.body.append(el)
    expect(text(el.shadowRoot)).toBe('field-default')
    el.name = 'updated'
    await tick()
    expect(text(el.shadowRoot)).toBe('updated')
  })

  it('passes rich data to child components with .prop', async () => {
    class Item extends Component {
      static props = { user: { type: Object, attribute: false } }
      declare user: { name: string }
      render() {
        return html`<i>${this.user?.name}</i>`
      }
    }
    const child = tag('x-item')
    define(child, Item)
    // Tag names can't be interpolated, so build the parent template for this tag.
    const strings = Object.assign([`<ul>`, `</ul>`], { raw: [`<ul>`, `</ul>`] }) as TemplateStringsArray
    const itemStrings = Object.assign([`<${child} .user=`, `></${child}>`], {
      raw: [`<${child} .user=`, `></${child}>`],
    }) as TemplateStringsArray

    class List extends Component {
      users = signal([{ id: 1, name: 'Ada' }])
      render() {
        return html(strings, each(this.users.value, 'id', (u) => html(itemStrings, u)))
      }
    }
    const t = tag('x-list')
    define(t, List)
    const el = document.createElement(t) as List
    document.body.append(el)
    const items = () => [...el.shadowRoot!.querySelectorAll(child)].map((c) => text(c.shadowRoot))
    expect(items()).toEqual(['Ada'])
    el.users.value = [...el.users.value, { id: 2, name: 'Grace' }]
    await tick()
    expect(items()).toEqual(['Ada', 'Grace'])
  })

  it('light DOM rendering with static shadow = false', () => {
    class Light extends Component {
      static shadow = false
      render() {
        return html`<span class="light">in light dom</span>`
      }
    }
    const t = tag('x-light')
    define(t, Light)
    const el = document.createElement(t)
    document.body.append(el)
    expect(el.shadowRoot).toBeNull()
    expect(el.querySelector('.light')).not.toBeNull()
  })

  it('applies static styles to the shadow root', () => {
    class Styled extends Component {
      static styles = css`
        p {
          color: red;
        }
      `
      render() {
        return html`<p>styled</p>`
      }
    }
    const t = tag('x-styled')
    define(t, Styled)
    const el = document.createElement(t)
    document.body.append(el)
    const root = el.shadowRoot!
    const adopted = root.adoptedStyleSheets?.length ?? 0
    const inline = root.querySelector('style')?.textContent ?? ''
    expect(adopted > 0 || inline.includes('color: red')).toBe(true)
    expect(text(root)).toBe('styled')
  })

  it('lifecycle: mounted (with cleanup), updated, unmounted; stops rendering when detached', async () => {
    const log: string[] = []
    class Life extends Component {
      static props = { v: { type: Number, default: 0 } }
      declare v: number
      render() {
        log.push(`render ${this.v}`)
        return html`${this.v}`
      }
      mounted() {
        log.push('mounted')
        return () => log.push('cleanup')
      }
      updated() {
        log.push('updated')
      }
      unmounted() {
        log.push('unmounted')
      }
    }
    const t = tag('x-life')
    define(t, Life)
    const el = document.createElement(t) as Life
    document.body.append(el)
    el.v = 1
    await tick()
    el.remove()
    el.v = 2
    await tick()
    expect(log).toEqual(['render 0', 'updated', 'mounted', 'render 1', 'updated', 'cleanup', 'unmounted'])

    document.body.append(el) // reconnect renders the latest value
    expect(text(el.shadowRoot)).toBe('2')
  })

  it('emit() dispatches bubbling composed events', () => {
    class Emitter extends Component {
      fire() {
        this.emit('picked', { id: 7 })
      }
    }
    const t = tag('x-emit')
    define(t, Emitter)
    const el = document.createElement(t) as Emitter
    document.body.append(el)
    const handler = vi.fn()
    document.body.addEventListener('picked', handler)
    el.fire()
    expect(handler).toHaveBeenCalledOnce()
    expect((handler.mock.calls[0][0] as CustomEvent).detail).toEqual({ id: 7 })
  })

  it('event handlers in templates get the component as `this`', () => {
    class Self extends Component {
      clicked = 0
      onClick() {
        this.clicked++
      }
      render() {
        return html`<button @click=${this.onClick}>b</button>`
      }
    }
    const t = tag('x-self')
    define(t, Self)
    const el = document.createElement(t) as Self
    document.body.append(el)
    el.shadowRoot!.querySelector('button')!.click()
    expect(el.clicked).toBe(1)
  })
})
