import { afterAll, afterEach, beforeAll, expect, it } from 'vitest'
import { userEvent } from 'vitest/browser'
import { behavior, config, start } from '../mini'
import { echo, events, waitFor } from './helpers'

let stop: () => void
beforeAll(() => {
  stop = start()
})
afterAll(() => stop())
afterEach(() => {
  document.body.replaceChildren()
  config.csrf = { header: 'X-CSRF-Token', meta: 'csrf-token' }
  document.cookie = 'XSRF-TOKEN=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/'
})

it('swaps a real 422 validation form in place, then the success reply', async () => {
  document.body.innerHTML = `
    <div id="modal"><form id="vform" action="/test-api/validate" method="post" data-fetch
      data-target="#vform" data-swap="outerHTML" data-swap-error="422"><input name="name"><button>Save</button></form></div>`
  await userEvent.click(document.querySelector('button')!)
  await waitFor(() => expect(document.querySelector('#modal .error')?.textContent).toBe('Name is required'))
  // The swapped-in form works immediately.
  await userEvent.type(document.querySelector('#vform input')!, 'Ada')
  await userEvent.click(document.querySelector('#vform button')!)
  await waitFor(() => expect(document.querySelector('#modal .ok')?.textContent).toBe('Saved Ada'))
})

it('activates behaviors inside swapped HTML', async () => {
  const mounted: string[] = []
  behavior('echo-seen', (el) => {
    mounted.push(el.tagName)
  })
  document.body.innerHTML = `<button data-get="/test-api/echo" data-target="#out">Load</button><div id="out"></div>`
  // The echo reply contains <pre data-echo>; tag it as a behavior host after the swap.
  document.addEventListener('mini:after', () => document.querySelector('[data-echo]')!.setAttribute('data-behavior', 'echo-seen'), { once: true })
  await userEvent.click(document.querySelector('button')!)
  await waitFor(() => expect(mounted).toEqual(['PRE']))
})

it('sends the CSRF token from a real cookie, URL-decoded', async () => {
  document.cookie = 'XSRF-TOKEN=a%2Bb%3D%3D; path=/'
  config.csrf = { cookie: 'XSRF-TOKEN', header: 'X-XSRF-TOKEN' }
  document.body.innerHTML = `<button data-post="/test-api/echo" data-target="#out">Post</button><div id="out"></div>`
  await userEvent.click(document.querySelector('button')!)
  await waitFor(() => echo())
  expect(echo()).toMatchObject({ method: 'POST', xsrf: 'a+b==', csrf: null })
})

it('refuses a cross-origin POST before anything is sent', async () => {
  const seen = events('mini:error', 'mini:before')
  document.body.innerHTML = `<button data-post="https://example.com/steal" data-target="#out">Post</button><div id="out"></div>`
  await userEvent.click(document.querySelector('button')!)
  await waitFor(() => expect(seen.map((e) => e.type)).toEqual(['mini:error']))
  expect(String(seen[0].detail.error)).toMatch(/cross-origin/)
  seen.off()
})

it('a real HTTP redirect is detected; cancelling mini:redirect swaps the reply', async () => {
  document.body.innerHTML = `<button data-get="/test-api/private" data-target="#out">Go</button><div id="out"></div>`
  const button = document.querySelector('button')!
  const redirects: string[] = []
  button.addEventListener('mini:redirect', (e) => {
    redirects.push(new URL((e as CustomEvent).detail.url).pathname)
    e.preventDefault()
  })
  await userEvent.click(button)
  await waitFor(() => expect(document.querySelector('#out h1')?.textContent).toBe('Login page'))
  expect(redirects).toEqual(['/test-api/login'])
})

/** Load a /test-api page in an iframe, so a full-page navigation doesn't unload the test runner. */
async function frame(src: string) {
  const iframe = document.createElement('iframe')
  iframe.src = src
  document.body.append(iframe)
  await waitFor(() => expect((iframe.contentWindow as any)?.ready).toBe(true), 5000)
  return iframe
}

it('an expired session (302 to login) navigates the whole page, for data-* requests', async () => {
  const iframe = await frame('/test-api/page/redirect')
  iframe.contentDocument!.getElementById('go')!.click()
  await waitFor(() => expect(iframe.contentWindow!.location.pathname).toBe('/test-api/login'), 5000)
  expect(iframe.contentDocument!.querySelector('h1')!.textContent).toBe('Login page')
})

it('an expired session navigates the whole page, for api calls', async () => {
  const iframe = await frame('/test-api/page/redirect')
  const win = iframe.contentWindow as any
  const error = await win.mini.api.get('/test-api/private').catch((e: Error) => e)
  expect(error.name).toBe('ApiError')
  await waitFor(() => expect(iframe.contentWindow!.location.pathname).toBe('/test-api/login'), 5000)
})
