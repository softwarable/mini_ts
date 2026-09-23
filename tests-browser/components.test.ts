import { afterEach, expect, it } from 'vitest'
import { Component, css, define, each, html, signal, tick } from '../mini'

afterEach(() => document.body.replaceChildren())

it('upgrades elements that were in the page before define(), keeping early properties', async () => {
  class Late extends Component {
    static props = { label: String, count: { type: Number, default: 0 } }
    declare label: string
    declare count: number
    render() {
      return html`<b>${this.label}:${this.count}</b>`
    }
  }
  document.body.innerHTML = '<x-late label="from-attr"></x-late>'
  const el = document.querySelector('x-late') as Late
  el.count = 5 // set while it's still a plain HTMLElement
  define('x-late', Late)
  expect(el.shadowRoot!.textContent).toBe('from-attr:5')
  el.setAttribute('label', 'changed')
  await tick()
  expect(el.shadowRoot!.textContent).toBe('changed:5')
})

it('runs the real custom element lifecycle: connect, disconnect, reconnect', async () => {
  const log: string[] = []
  class Life extends Component {
    n = signal(0)
    render() {
      return html`${this.n.value}`
    }
    mounted() {
      log.push('mounted')
      return () => log.push('cleanup')
    }
    unmounted() {
      log.push('unmounted')
    }
  }
  define('x-life', Life)
  const el = document.createElement('x-life') as Life
  document.body.append(el)
  const other = document.createElement('div')
  document.body.append(other)
  other.append(el) // a move is disconnect + connect for custom elements
  el.n.value = 3
  await tick()
  el.remove()
  el.n.value = 4 // no render while detached
  await tick()
  expect(el.shadowRoot!.textContent).toBe('3')
  document.body.append(el)
  expect(el.shadowRoot!.textContent).toBe('4')
  expect(log).toEqual(['mounted', 'cleanup', 'unmounted', 'mounted', 'cleanup', 'unmounted', 'mounted'])
})

it('shares one constructable stylesheet per class, scoped to the shadow root', () => {
  class Red extends Component {
    static styles = css`p { color: rgb(255, 0, 0); }`
    render() {
      return html`<p>red</p>`
    }
  }
  define('x-red', Red)
  document.body.innerHTML = '<x-red></x-red><x-red></x-red><p id="page">page</p>'
  const [a, b] = document.querySelectorAll('x-red')
  expect(a.shadowRoot!.adoptedStyleSheets).toHaveLength(1)
  expect(a.shadowRoot!.adoptedStyleSheets[0]).toBe(b.shadowRoot!.adoptedStyleSheets[0])
  expect(a.shadowRoot!.querySelector('style')).toBeNull() // no fallback <style> needed
  expect(getComputedStyle(a.shadowRoot!.querySelector('p')!).color).toBe('rgb(255, 0, 0)')
  expect(getComputedStyle(document.getElementById('page')!).color).not.toBe('rgb(255, 0, 0)')
})

it('light-DOM components use page styles', () => {
  const style = document.createElement('style')
  style.textContent = '.light-text { color: rgb(0, 128, 0); }'
  document.head.append(style)
  class Light extends Component {
    static shadow = false
    render() {
      return html`<span class="light-text">light</span>`
    }
  }
  define('x-light', Light)
  document.body.innerHTML = '<x-light></x-light>'
  expect(getComputedStyle(document.querySelector('.light-text')!).color).toBe('rgb(0, 128, 0)')
  style.remove()
})

it('child components receive rich data through .prop bindings', async () => {
  class Item extends Component {
    static props = { user: { type: Object, attribute: false } }
    declare user: { name: string }
    render() {
      return html`${this.user?.name}`
    }
  }
  define('x-item', Item)
  class List extends Component {
    users = signal([{ id: 1, name: 'Ada' }])
    render() {
      return html`${each(this.users.value, 'id', (u) => html`<x-item .user=${u}></x-item>`)}`
    }
  }
  define('x-list', List)
  const list = document.createElement('x-list') as List
  document.body.append(list)
  list.users.value = [...list.users.value, { id: 2, name: 'Grace' }]
  await tick()
  const names = [...list.shadowRoot!.querySelectorAll('x-item')].map((i) => i.shadowRoot!.textContent)
  expect(names).toEqual(['Ada', 'Grace'])
})
