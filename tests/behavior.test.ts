import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { action, behavior, getBehavior, start, swap, tick } from '../mini'

let stop: () => void

beforeEach(() => {
  document.body.innerHTML = ''
  stop = start()
})

afterEach(() => {
  stop()
  document.body.innerHTML = ''
})

describe('data-behavior', () => {
  it('mounts on existing and inserted elements, cleans up on removal', async () => {
    const log: string[] = []
    behavior('tracked', (el) => {
      log.push(`mount ${el.id}`)
      return () => log.push(`unmount ${el.id}`)
    })
    document.body.innerHTML = '<div id="a" data-behavior="tracked"></div>'
    await tick()
    const b = document.createElement('section')
    b.innerHTML = '<p id="b" data-behavior="tracked"></p>'
    document.body.append(b)
    await tick()
    document.getElementById('a')!.remove()
    b.remove()
    await tick()
    expect(log).toEqual(['mount a', 'mount b', 'unmount a', 'unmount b'])
  })

  it('does not remount elements that are moved', async () => {
    const setup = vi.fn()
    behavior('movable', setup)
    document.body.innerHTML = '<div id="one"></div><div id="two"><i data-behavior="movable"></i></div>'
    await tick()
    document.getElementById('one')!.append(document.querySelector('i')!)
    await tick()
    expect(setup).toHaveBeenCalledOnce()
  })

  it('mounts elements registered after start and behaviors registered late', async () => {
    document.body.innerHTML = '<div data-behavior="late"></div>'
    await tick()
    const setup = vi.fn()
    behavior('late', setup)
    expect(setup).toHaveBeenCalledOnce()
  })

  it('supports several behaviors and reacts to attribute changes', async () => {
    const log: string[] = []
    behavior('b1', () => () => log.push('b1 off'))
    behavior('b2', () => {
      log.push('b2 on')
    })
    document.body.innerHTML = '<div data-behavior="b1"></div>'
    await tick()
    document.querySelector('div')!.setAttribute('data-behavior', 'b2')
    await tick()
    expect(log).toEqual(['b1 off', 'b2 on'])
  })

  it('behavior objects expose methods to data-action="name#method"', async () => {
    behavior('dropdown', (el) => {
      const menu = el.querySelector('ul')!
      return {
        toggle() {
          menu.hidden = !menu.hidden
        },
        close() {
          menu.hidden = true
        },
      }
    })
    document.body.innerHTML = `
      <div data-behavior="dropdown">
        <button data-action="dropdown#toggle">Menu</button>
        <ul hidden><li><a href="#" data-action="dropdown#close:prevent">x</a></li></ul>
      </div>`
    await tick()
    const ul = document.querySelector('ul')!
    document.querySelector('button')!.click()
    expect(ul.hidden).toBe(false)
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true })
    document.querySelector('a')!.dispatchEvent(ev)
    expect(ul.hidden).toBe(true)
    expect(ev.defaultPrevented).toBe(true)
    expect(getBehavior(document.querySelector('[data-behavior]')!, 'dropdown')).toHaveProperty('toggle')
  })
})

describe('data-action', () => {
  it('runs global actions with event and element', async () => {
    const fn = vi.fn()
    action('greet', fn)
    document.body.innerHTML = '<button data-action="greet" data-name="Ada"><span>hi</span></button>'
    await tick()
    document.querySelector('span')!.click()
    expect(fn).toHaveBeenCalledOnce()
    const [e, el] = fn.mock.calls[0]
    expect(e.type).toBe('click')
    expect(el.dataset.name).toBe('Ada')
  })

  it('uses sensible default events and explicit event->name', async () => {
    const log: string[] = []
    action('log', (e) => log.push(e.type))
    document.body.innerHTML = `
      <form data-action="log:prevent"><input data-action="log keydown->log"><select data-action="log"></select></form>`
    await tick()
    const input = document.querySelector('input')!
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'a' }))
    document.querySelector('select')!.dispatchEvent(new Event('change', { bubbles: true }))
    const submit = new Event('submit', { bubbles: true, cancelable: true })
    document.querySelector('form')!.dispatchEvent(submit)
    expect(log).toEqual(['input', 'keydown', 'change', 'submit'])
    expect(submit.defaultPrevented).toBe(true)
  })

  it('listens for custom event types found in the DOM', async () => {
    const fn = vi.fn()
    action('custom', fn)
    document.body.innerHTML = '<div data-action="my-event->custom"></div>'
    await tick()
    document.querySelector('div')!.dispatchEvent(new CustomEvent('my-event', { bubbles: true }))
    expect(fn).toHaveBeenCalledOnce()
  })

  it(':stop stops outer actions', async () => {
    const outer = vi.fn()
    action('outer', outer)
    action('inner', () => {})
    document.body.innerHTML = '<div data-action="outer"><button data-action="inner:stop">b</button></div>'
    await tick()
    document.querySelector('button')!.click()
    expect(outer).not.toHaveBeenCalled()
  })

  it('warns for unknown actions instead of throwing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    document.body.innerHTML = '<button data-action="nope">b</button>'
    await tick()
    document.querySelector('button')!.click()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('start(scope)', () => {
  it('behaviors registered after a scoped start only mount inside the scope', async () => {
    stop() // replace the document-wide start from beforeEach
    document.body.innerHTML = `
      <div id="outside" data-behavior="scoped-late"></div>
      <section id="app" data-behavior="scoped-late"><p id="inside" data-behavior="scoped-late"></p></section>`
    stop = start(document.getElementById('app')!)
    const mounted: string[] = []
    behavior('scoped-late', (el) => {
      mounted.push(el.id)
    })
    expect(mounted.sort()).toEqual(['app', 'inside'])
    stop()
    stop = start()
  })

  it('swap() outside the scope does not activate behaviors there', async () => {
    stop()
    const setup = vi.fn()
    behavior('scoped-swap', setup)
    document.body.innerHTML = `<section id="app"></section><div id="outside"></div>`
    stop = start(document.getElementById('app')!)
    swap('#outside', '<i data-behavior="scoped-swap"></i>')
    swap('#app', '<b data-behavior="scoped-swap"></b>')
    expect(setup).toHaveBeenCalledOnce()
    expect(setup.mock.calls[0][0].tagName).toBe('B')
    stop()
    stop = start()
  })
})
