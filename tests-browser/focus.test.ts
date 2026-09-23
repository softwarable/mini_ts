import { afterEach, expect, it } from 'vitest'
import { userEvent } from 'vitest/browser'
import { each, html, render } from '../mini'

afterEach(() => document.body.replaceChildren())

const view = (ids: number[]) => html`${each(ids, (id) => id, (id) => html`<input data-id=${id} />`)}`
const input = (id: number) => document.querySelector(`[data-id="${id}"]`) as HTMLInputElement

it('keeps focus, typed text and caret on an input that stays in place while others move', async () => {
  render(view([1, 2, 3, 4]), document.body)
  await userEvent.click(input(2))
  await userEvent.keyboard('hello')
  input(2).setSelectionRange(2, 2)
  render(view([4, 1, 2, 3]), document.body) // 4 moves; 2 keeps its place
  expect(document.activeElement).toBe(input(2))
  expect(input(2).value).toBe('hello')
  expect(input(2).selectionStart).toBe(2)
})

it('keeps focus on an input that itself has to move', async () => {
  render(view([1, 2, 3, 4]), document.body)
  await userEvent.click(input(1))
  await userEvent.keyboard('typed')
  render(view([2, 3, 4, 1]), document.body) // 1 is the one that moves
  expect(input(1).value).toBe('typed')
  expect(document.activeElement).toBe(input(1))
  await userEvent.keyboard('!')
  expect(input(1).value).toBe('typed!')
})
