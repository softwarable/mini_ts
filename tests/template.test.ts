import { beforeEach, describe, expect, it, vi } from 'vitest'
import { each, effect, html, render, signal, svg, unsafeHTML, when } from '../mini'

let root: HTMLElement

/** innerHTML without the comment markers the renderer uses. */
const out = (el: Element = root) => el.innerHTML.replace(/<!--.*?-->/g, '')

beforeEach(() => {
  document.body.innerHTML = ''
  root = document.createElement('div')
  document.body.append(root)
})

describe('text bindings', () => {
  it('renders text and escapes HTML', () => {
    render(html`<p>Hello ${'<b>world</b>'}</p>`, root)
    expect(out()).toBe('<p>Hello &lt;b&gt;world&lt;/b&gt;</p>')
  })

  it('updates only the changed text node', () => {
    const view = (name: string) => html`<p class="x">Hi ${name}!</p>`
    render(view('Ada'), root)
    const p = root.querySelector('p')
    render(view('Grace'), root)
    expect(root.querySelector('p')).toBe(p)
    expect(out()).toBe('<p class="x">Hi Grace!</p>')
  })

  it('renders nothing for null, undefined, false, true and empty string', () => {
    for (const v of [null, undefined, false, true, '']) {
      render(html`<i>${v}</i>`, root)
      expect(out()).toBe('<i></i>')
    }
  })

  it('renders numbers and zero', () => {
    render(html`<i>${0}</i>`, root)
    expect(out()).toBe('<i>0</i>')
  })

  it('renders DOM nodes', () => {
    const b = document.createElement('b')
    render(html`<i>${b}</i>`, root)
    expect(root.querySelector('i > b')).toBe(b)
  })

  it('switches between text, template and nothing', () => {
    const view = (v: unknown) => html`<div>${v}</div>`
    render(view('text'), root)
    render(view(html`<b>bold</b>`), root)
    expect(out()).toBe('<div><b>bold</b></div>')
    render(view(null), root)
    expect(out()).toBe('<div></div>')
    render(view('again'), root)
    expect(out()).toBe('<div>again</div>')
  })

  it('renders top-level text and multiple roots', () => {
    render(html`a ${1} <b>b</b> ${2}`, root)
    expect(out()).toBe('a 1 <b>b</b> 2')
  })

  it('unsafeHTML renders raw markup', () => {
    render(html`<div>${unsafeHTML('<em>trusted</em>')}</div>`, root)
    expect(out()).toBe('<div><em>trusted</em></div>')
  })
})

describe('attribute bindings', () => {
  it('sets, updates and removes attributes', () => {
    const view = (href: string | null) => html`<a href=${href}>link</a>`
    render(view('/a'), root)
    expect(root.querySelector('a')!.getAttribute('href')).toBe('/a')
    render(view('/b'), root)
    expect(root.querySelector('a')!.getAttribute('href')).toBe('/b')
    render(view(null), root)
    expect(root.querySelector('a')!.hasAttribute('href')).toBe(false)
  })

  it('supports quoted, single-quoted and unquoted values', () => {
    render(html`<a href="${'/a'}" title='${'t'}' data-x=${'x'}>l</a>`, root)
    const a = root.querySelector('a')!
    expect([a.getAttribute('href'), a.getAttribute('title'), a.dataset.x]).toEqual(['/a', 't', 'x'])
  })

  it('supports several holes in one attribute', () => {
    const view = (a: string, b: string | null) => html`<div class="btn ${a} mid ${b} end"></div>`
    render(view('one', 'two'), root)
    expect(root.querySelector('div')!.className).toBe('btn one mid two end')
    render(view('uno', null), root)
    expect(root.querySelector('div')!.className).toBe('btn uno mid  end')
  })

  it('keeps static attributes and attribute order independent of bindings', () => {
    render(html`<input type="text" value=${'v'} placeholder="p" name=${'n'} />`, root)
    const input = root.querySelector('input')!
    expect(input.getAttribute('type')).toBe('text')
    expect(input.getAttribute('value')).toBe('v')
    expect(input.getAttribute('placeholder')).toBe('p')
    expect(input.getAttribute('name')).toBe('n')
  })

  it('?attr toggles boolean attributes', () => {
    const view = (d: boolean) => html`<button ?disabled=${d}>b</button>`
    render(view(true), root)
    expect(root.querySelector('button')!.hasAttribute('disabled')).toBe(true)
    render(view(false), root)
    expect(root.querySelector('button')!.hasAttribute('disabled')).toBe(false)
  })

  it('.prop sets properties (case preserved)', () => {
    const data = { a: 1 }
    render(html`<input .value=${'hello'} .customData=${data} />`, root)
    const input = root.querySelector('input') as HTMLInputElement & { customData: unknown }
    expect(input.value).toBe('hello')
    expect(input.customData).toBe(data)
  })

  it('.value on select applies after options are rendered', () => {
    const opts = ['a', 'b', 'c']
    render(html`<select .value=${'b'}>${opts.map((o) => html`<option value=${o}>${o}</option>`)}</select>`, root)
    expect(root.querySelector('select')!.value).toBe('b')
  })

  it('@event binds listeners and swaps handlers without re-binding', () => {
    const first = vi.fn()
    const second = vi.fn()
    const view = (fn: () => void) => html`<button @click=${fn}>b</button>`
    render(view(first), root)
    const button = root.querySelector('button')!
    const spy = vi.spyOn(button, 'addEventListener')
    button.click()
    render(view(second), root)
    button.click()
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
    expect(spy).not.toHaveBeenCalled()
  })

  it('@event handlers get the host as `this`', () => {
    const host = { name: 'host' }
    let seen: unknown
    render(
      html`<button
        @click=${function (this: unknown) {
          seen = this
        }}
      ></button>`,
      root,
      { host },
    )
    root.querySelector('button')!.click()
    expect(seen).toBe(host)
  })

  it('supports camelCase attribute names in svg', () => {
    render(html`<svg viewBox=${'0 0 10 10'}><circle r=${5}></circle></svg>`, root)
    expect(root.querySelector('svg')!.getAttribute('viewBox')).toBe('0 0 10 10')
    expect(root.querySelector('circle')!.getAttribute('r')).toBe('5')
  })

  it('svg`` renders standalone svg fragments', () => {
    const svgEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    root.append(svgEl)
    render(svg`<rect width=${10}></rect>`, svgEl as unknown as Element)
    const rect = svgEl.querySelector('rect')!
    expect(rect.namespaceURI).toBe('http://www.w3.org/2000/svg')
    expect(rect.getAttribute('width')).toBe('10')
  })
})

describe('errors', () => {
  it('rejects bindings in element position', () => {
    expect(() => render(html`<div ${'x'}></div>`, root)).toThrow(/not supported/)
  })

  it('rejects bindings inside textarea', () => {
    expect(() => render(html`<textarea>${'x'}</textarea>`, root)).toThrow(/textarea/)
  })

  it('rejects multi-part values for special bindings', () => {
    expect(() => render(html`<input .value="a${'b'}" />`, root)).toThrow(/single value/)
  })
})

describe('conditionals', () => {
  it('when() renders the matching branch', () => {
    const view = (ok: boolean) => html`<div>${when(ok, () => html`<b>yes</b>`, () => html`<i>no</i>`)}</div>`
    render(view(true), root)
    expect(out()).toBe('<div><b>yes</b></div>')
    render(view(false), root)
    expect(out()).toBe('<div><i>no</i></div>')
  })

  it('&& works for simple conditions', () => {
    const view = (show: boolean) => html`<div>${show && html`<b>shown</b>`}</div>`
    render(view(false), root)
    expect(out()).toBe('<div></div>')
    render(view(true), root)
    expect(out()).toBe('<div><b>shown</b></div>')
  })
})

describe('lists', () => {
  it('renders arrays of templates (unkeyed)', () => {
    const view = (items: string[]) => html`<ul>${items.map((i) => html`<li>${i}</li>`)}</ul>`
    render(view(['a', 'b']), root)
    expect(out()).toBe('<ul><li>a</li><li>b</li></ul>')
    render(view(['a', 'b', 'c']), root)
    expect(out()).toBe('<ul><li>a</li><li>b</li><li>c</li></ul>')
    render(view(['x']), root)
    expect(out()).toBe('<ul><li>x</li></ul>')
    render(view([]), root)
    expect(out()).toBe('<ul></ul>')
  })

  it('loops over data to build links with attributes', () => {
    const links = [
      { id: 1, url: '/home', label: 'Home', active: true },
      { id: 2, url: '/about', label: 'About', active: false },
    ]
    render(
      html`<nav>
        ${each(links, 'id', (l) => html`<a href=${l.url} class=${l.active ? 'on' : null}>${l.label}</a>`)}
      </nav>`,
      root,
    )
    const as = [...root.querySelectorAll('a')]
    expect(as.map((a) => a.outerHTML.replace(/<!--.*?-->/g, ''))).toEqual(['<a href="/home" class="on">Home</a>', '<a href="/about">About</a>'])
  })

  type Item = { id: number; label: string }
  const list = (items: Item[]) => html`<ul>${each(items, 'id', (i) => html`<li>${i.label}</li>`)}</ul>`
  const items = (...ids: number[]) => ids.map((id) => ({ id, label: `item ${id}` }))
  const lis = () => [...root.querySelectorAll('li')]
  const labels = () => lis().map((li) => li.textContent)

  it('keyed each() keeps DOM nodes when reordering', () => {
    render(list(items(1, 2, 3, 4, 5)), root)
    const before = new Map(lis().map((li) => [li.textContent, li]))
    render(list(items(5, 3, 1, 4, 2)), root)
    expect(labels()).toEqual(['item 5', 'item 3', 'item 1', 'item 4', 'item 2'])
    for (const li of lis()) expect(before.get(li.textContent)).toBe(li)
  })

  it('keyed each() moves only what it must', () => {
    render(list(items(1, 2, 3, 4)), root)
    const ul = root.querySelector('ul')!
    const spy = vi.spyOn(ul, 'insertBefore')
    render(list(items(4, 1, 2, 3)), root) // one item moved to the front
    // item 4 = start marker + <li> + end marker = 3 inserts; nothing else moves
    expect(spy.mock.calls.length).toBe(3)
    expect(labels()).toEqual(['item 4', 'item 1', 'item 2', 'item 3'])
  })

  it('keyed each() inserts, removes and updates', () => {
    render(list(items(1, 2, 3)), root)
    const two = lis()[1]
    render(list([{ id: 0, label: 'zero' }, { id: 2, label: 'TWO' }, { id: 4, label: 'four' }]), root)
    expect(labels()).toEqual(['zero', 'TWO', 'four'])
    expect(lis()[1]).toBe(two)
    render(list([]), root)
    expect(labels()).toEqual([])
    render(list(items(7)), root)
    expect(labels()).toEqual(['item 7'])
  })

  it('keyed each() survives random permutations', () => {
    let seed = 42
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
    for (let round = 0; round < 50; round++) {
      const ids = [...Array(Math.floor(rand() * 12)).keys()].filter(() => rand() > 0.3).sort(() => rand() - 0.5)
      render(list(items(...ids)), root)
      expect(labels()).toEqual(ids.map((id) => `item ${id}`))
    }
  })

  it('keyed each() throws on duplicate keys', () => {
    expect(() => render(list(items(1, 1)), root)).toThrow(/unique/)
  })

  it('each() accepts a key function and passes the index', () => {
    render(html`${each(['a', 'b'], (s) => s, (s, i) => html`<b>${i}:${s}</b>`)}`, root)
    expect(out()).toBe('<b>0:a</b><b>1:b</b>')
  })

  it('nested templates update in place', () => {
    const view = (rows: Item[], title: string) => html`
      <section>
        <h1>${title}</h1>
        ${each(rows, 'id', (r) => html`<p>${html`<span>${r.label}</span>`}</p>`)}
      </section>`
    render(view(items(1, 2), 'A'), root)
    const span = root.querySelector('span')
    render(view([{ id: 1, label: 'changed' }, ...items(2)], 'B'), root)
    expect(root.querySelector('span')).toBe(span)
    expect(span!.textContent).toBe('changed')
    expect(root.querySelector('h1')!.textContent).toBe('B')
  })

  it('keeps input state when list items move', () => {
    const view = (ids: number[]) => html`${each(ids, (id) => id, (id) => html`<input data-id=${id} />`)}`
    render(view([1, 2, 3]), root)
    ;(root.querySelector('[data-id="2"]') as HTMLInputElement).value = 'typed'
    render(view([3, 2, 1]), root)
    expect((root.querySelector('[data-id="2"]') as HTMLInputElement).value).toBe('typed')
  })
})

describe('render()', () => {
  it('renders again after other code cleared the container', () => {
    const view = (ids: number[]) => html`${each(ids, (id) => id, (id) => html`<i>${id}</i>`)}`
    render(view([1, 2]), root)
    root.innerHTML = ''
    render(view([2, 1]), root)
    expect(out()).toBe('<i>2</i><i>1</i>')
    root.replaceChildren(document.createElement('p'))
    render(view([3]), root)
    expect(out()).toBe('<i>3</i>')
  })
})

describe('signals in templates', () => {
  it('unwraps signals and re-renders with effect()', () => {
    const count = signal(1)
    effect(() => render(html`<b title=${count}>${count}</b>`, root))
    expect(out()).toBe('<b title="1">1</b>')
    count.value = 2
    expect(out()).toBe('<b title="2">2</b>')
  })
})
