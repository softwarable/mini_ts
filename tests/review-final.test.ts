import { afterEach, expect, it, vi } from 'vitest'
import { api, behavior, effect, signal, start, tick, trigger } from '../mini'

// Regression tests from the final review (<base href> CSRF check, effect re-runs, start/stop
// timing, URL fragments, native GET form queries). They failed before the fixes.

afterEach(() => {
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

it('completes an effect run before rerunning it after a synchronous signal write', () => {
  const count = signal(0)
  const live = new Set<number>()
  const stop = effect(() => {
    const value = count.value
    live.add(value)
    if (value === 0) count.value = 1
    return () => { live.delete(value) }
  })
  stop()
  expect([...live]).toEqual([])
})

it('cleans up removed behaviors when stop runs before the observer callback', () => {
  const cleanup = vi.fn()
  behavior('review-final-cleanup', () => cleanup)
  document.body.innerHTML = '<div data-behavior="review-final-cleanup"></div>'
  const stop = start()
  document.querySelector('div')!.remove()
  stop()
  expect(cleanup).toHaveBeenCalledOnce()
})

it('mounts descendants created by an initial behavior setup', async () => {
  const childSetup = vi.fn()
  behavior('review-final-child', childSetup)
  behavior('review-final-parent', el => {
    el.innerHTML = '<button data-behavior="review-final-child">Child</button>'
  })
  document.body.innerHTML = '<div data-behavior="review-final-parent"></div>'
  const stop = start()
  try {
    await tick()
    expect(childSetup).toHaveBeenCalledOnce()
  } finally { stop() }
})

it('places declarative GET fields before the URL fragment', async () => {
  const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => new Response('ok'))
  vi.stubGlobal('fetch', fetcher)
  document.body.innerHTML = '<form data-get="/search#results"><input name="q" value="new"></form>'
  await trigger(document.querySelector('form')!)
  expect(new URL(fetcher.mock.calls[0][0], location.href).searchParams.get('q')).toBe('new')
})

it('places API query options before the URL fragment', async () => {
  const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => new Response('ok'))
  vi.stubGlobal('fetch', fetcher)
  await api.get('/search#results', { query: { q: 'new' } })
  expect(new URL(fetcher.mock.calls[0][0], location.href).searchParams.get('q')).toBe('new')
})
