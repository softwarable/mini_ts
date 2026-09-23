import { afterAll, afterEach, beforeAll, expect, it } from 'vitest'
import { userEvent } from 'vitest/browser'
import { start } from '../mini'
import { echo, events, waitFor } from './helpers'

let stop: () => void
beforeAll(() => {
  stop = start()
})
afterAll(() => stop())
afterEach(() => document.body.replaceChildren())

it('native validation (minlength) blocks the request for real user input', async () => {
  const seen = events('mini:before')
  document.body.innerHTML = `
    <form action="/test-api/echo" method="post" data-fetch data-target="#out">
      <input name="name" minlength="3"><button>Save</button>
    </form><div id="out"></div>`
  await userEvent.type(document.querySelector('input')!, 'ab')
  await userEvent.click(document.querySelector('button')!)
  await new Promise((r) => setTimeout(r, 150))
  expect(seen).toHaveLength(0)
  expect(document.querySelector('input')!.validity.tooShort).toBe(true)
  seen.off()
})

it('pressing Enter submits with the first submit button as submitter', async () => {
  document.body.innerHTML = `
    <form action="/test-api/echo" method="post" data-fetch data-target="#out">
      <input name="name"><button name="op" value="save">Save</button><button name="op" value="draft">Draft</button>
    </form><div id="out"></div>`
  await userEvent.type(document.querySelector('input')!, 'Ada{Enter}')
  await waitFor(() => echo())
  expect(echo()).toMatchObject({ method: 'POST', body: 'name=Ada&op=save', miniRequest: 'true' })
  expect(echo().contentType).toContain('application/x-www-form-urlencoded')
})

it('a clicked button\'s formaction / formmethod / name=value are used', async () => {
  document.body.innerHTML = `
    <form action="/test-api/nowhere" method="post" data-fetch data-target="#out">
      <input name="q" value="acme">
      <button formaction="/test-api/echo" formmethod="get" name="op" value="preview">Preview</button>
    </form><div id="out"></div>`
  await userEvent.click(document.querySelector('button')!)
  await waitFor(() => echo())
  expect(echo()).toMatchObject({ method: 'GET', query: { q: 'acme', op: 'preview' }, body: '' })
})

it('uploads files as real multipart/form-data', async () => {
  document.body.innerHTML = `
    <form action="/test-api/echo" method="post" enctype="multipart/form-data" data-fetch data-target="#out">
      <input type="file" name="doc"><input name="title" value="Report"><button>Upload</button>
    </form><div id="out"></div>`
  const dt = new DataTransfer()
  dt.items.add(new File(['hello file'], 'hello.txt', { type: 'text/plain' }))
  document.querySelector<HTMLInputElement>('input[type=file]')!.files = dt.files
  await userEvent.click(document.querySelector('button')!)
  await waitFor(() => echo())
  expect(echo().contentType).toMatch(/^multipart\/form-data; boundary=/)
  expect(echo().body).toContain('filename="hello.txt"')
  expect(echo().body).toContain('hello file')
  expect(echo().body).toContain('Report')
})

it('a real double-click on Save reaches the server once', async () => {
  const key = `dbl-${Date.now()}`
  document.body.innerHTML = `
    <form action="/test-api/save?key=${key}&ms=400" method="post" data-fetch data-target="#out">
      <button>Save</button>
    </form><div id="out"></div>`
  await userEvent.dblClick(document.querySelector('button')!)
  await waitFor(() => expect(document.querySelector('.saved')).not.toBeNull())
  const count = await fetch(`/test-api/count?key=${key}`).then((r) => r.text())
  expect(count).toBe('1')
  expect(location.pathname).not.toContain('/test-api/') // the second submit didn't go native
})

it('DELETE sends form values in the body, not the URL', async () => {
  document.body.innerHTML = `
    <form><input type="hidden" name="token" value="secret">
      <button type="button" data-delete="/test-api/echo" data-target="#out">Delete</button>
    </form><div id="out"></div>`
  await userEvent.click(document.querySelector('button')!)
  await waitFor(() => echo())
  expect(echo()).toMatchObject({ method: 'DELETE', query: {}, body: 'token=secret' })
})
