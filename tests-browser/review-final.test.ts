import { afterEach, expect, it, vi } from 'vitest'
import { config, start, trigger } from '../mini'
import { echo, waitFor } from './helpers'

// Regression tests from the final review (<base href> CSRF check, effect re-runs, start/stop
// timing, URL fragments, native GET form queries). They failed before the fixes.

afterEach(() => {
  document.head.querySelectorAll('[data-final-review]').forEach(el => el.remove())
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

it('refuses a relative POST that resolves cross-origin through the document base URL', async () => {
  const base = document.createElement('base')
  base.dataset.finalReview = ''
  base.href = 'https://example.com/'
  const token = document.createElement('meta')
  token.dataset.finalReview = ''
  token.name = 'csrf-token'
  token.content = 'review-secret'
  document.head.prepend(base, token)
  document.body.innerHTML = '<button data-post="/save">Save</button>'
  // Use the browser's own URL resolution and Headers implementation, without sending a token.
  const sent: Request[] = []
  vi.spyOn(window, 'fetch').mockImplementation(async (input, init) => {
    sent.push(new Request(input, init))
    return new Response('ok')
  })
  expect(new Request('/save').url).toBe('https://example.com/save')
  const prior = config.csrf
  config.csrf = { header: 'X-CSRF-Token', meta: 'csrf-token' }
  try {
    await trigger(document.querySelector('button')!)
    expect(sent.map(req => ({ url: req.url, csrf: req.headers.get('X-CSRF-Token') }))).toEqual([])
  } finally { config.csrf = prior }
})

it('data-fetch GET forms replace the action query like native forms', async () => {
  // Establish the native behavior with a real form submission in an isolated iframe.
  const iframe = document.createElement('iframe')
  document.body.append(iframe)
  iframe.contentDocument!.body.innerHTML = `<form action="${location.origin}/test-api/echo?q=old&stale=1"><input name="q" value="new"></form>`
  iframe.contentDocument!.querySelector('form')!.requestSubmit()
  await waitFor(() => expect(echo(iframe.contentDocument!).query).toEqual({ q: 'new' }))
  iframe.remove()

  document.body.innerHTML = '<form action="/search?q=old&stale=1" data-fetch><input name="q" value="new"></form>'
  const sent: Request[] = []
  vi.spyOn(window, 'fetch').mockImplementation(async (input, init) => {
    sent.push(new Request(input, init))
    return new Response('ok')
  })
  const stop = start()
  try {
    document.querySelector('form')!.requestSubmit()
    await Promise.resolve()
    expect(new URL(sent[0].url).search).toBe('?q=new')
  } finally { stop() }
})
