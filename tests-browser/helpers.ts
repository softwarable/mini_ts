import { expect } from 'vitest'

/** Poll until `check` stops throwing (real network + rendering take real time). */
export const waitFor = (check: () => void, timeout = 3000) => expect.poll(() => {
  try {
    check()
    return true
  } catch {
    return false
  }
}, { timeout }).toBe(true)

/** The JSON a /test-api/echo reply put in the page. */
export function echo(root: ParentNode = document) {
  const pre = root.querySelector('[data-echo]')
  if (!pre) throw new Error('no echo in the page yet')
  return JSON.parse(pre.textContent!) as {
    method: string
    query: Record<string, string>
    contentType: string | null
    body: string
    csrf: string | null
    xsrf: string | null
    miniRequest: string | null
  }
}

/** Collect mini:* events fired anywhere in the document. */
export function events(...types: string[]) {
  const seen: { type: string; detail: any }[] = []
  const on = (e: Event) => seen.push({ type: e.type, detail: (e as CustomEvent).detail })
  for (const t of types) document.addEventListener(t, on)
  return Object.assign(seen, { off: () => types.forEach((t) => document.removeEventListener(t, on)) })
}
