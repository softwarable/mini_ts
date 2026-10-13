import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { batch, computed, effect, signal, tick, untrack } from '../mini'

setFlagsFromString('--expose_gc')
const gc = runInNewContext('gc') as () => void

/**
 * True once `ref`'s target has been garbage collected. Build and drop the objects inside a
 * synchronous helper: a suspended async test can keep temporaries alive in its own frame.
 */
async function collected(ref: WeakRef<object>): Promise<boolean> {
  for (let i = 0; i < 5; i++) {
    await tick()
    gc()
  }
  return ref.deref() === undefined
}

describe('signals', () => {
  it('reads and writes', () => {
    const s = signal(1)
    expect(s.value).toBe(1)
    s.value = 2
    expect(s.value).toBe(2)
    expect(s.peek()).toBe(2)
  })

  it('effect runs immediately and on change', () => {
    const s = signal(1)
    const seen: number[] = []
    effect(() => {
      seen.push(s.value)
    })
    s.value = 2
    s.value = 2 // same value: no re-run
    s.value = 3
    expect(seen).toEqual([1, 2, 3])
  })

  it('effect cleanup runs before re-run and on dispose', () => {
    const s = signal(0)
    const log: string[] = []
    const stop = effect(() => {
      const v = s.value
      log.push(`run ${v}`)
      return () => log.push(`clean ${v}`)
    })
    s.value = 1
    stop()
    s.value = 2
    expect(log).toEqual(['run 0', 'clean 0', 'run 1', 'clean 1'])
  })

  it('tracks dependencies dynamically', () => {
    const flag = signal(true)
    const a = signal('a')
    const b = signal('b')
    const fn = vi.fn(() => (flag.value ? a.value : b.value))
    effect(fn)
    expect(fn).toHaveBeenCalledTimes(1)
    b.value = 'B' // not a dependency yet
    expect(fn).toHaveBeenCalledTimes(1)
    flag.value = false
    expect(fn).toHaveBeenCalledTimes(2)
    a.value = 'A' // no longer a dependency
    expect(fn).toHaveBeenCalledTimes(2)
    b.value = 'BB'
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('computed is lazy and cached', () => {
    const s = signal(2)
    const fn = vi.fn(() => s.value * 10)
    const c = computed(fn)
    expect(fn).not.toHaveBeenCalled()
    expect(c.value).toBe(20)
    expect(c.value).toBe(20)
    expect(fn).toHaveBeenCalledTimes(1)
    s.value = 3
    expect(c.value).toBe(30)
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('effects re-run when a computed changes', () => {
    const first = signal('Ada')
    const last = signal('Lovelace')
    const full = computed(() => `${first.value} ${last.value}`)
    const seen: string[] = []
    effect(() => {
      seen.push(full.value)
    })
    last.value = 'Byron'
    expect(seen).toEqual(['Ada Lovelace', 'Ada Byron'])
  })

  it('a computed is released by its sources once its last effect is disposed', async () => {
    const source = signal(1)
    const ref = (() => {
      const c = computed(() => source.value * 2)
      const dispose = effect(() => {
        c.value
      })
      dispose()
      return new WeakRef(c)
    })()
    expect(await collected(ref)).toBe(true)
  })

  it('a computed read outside any effect does not stay subscribed to its sources', async () => {
    const source = signal(1)
    const ref = (() => {
      const c = computed(() => source.value + 1)
      expect(c.value).toBe(2)
      return new WeakRef(c)
    })()
    expect(await collected(ref)).toBe(true)
  })

  it('a released computed recomputes when read again', async () => {
    const source = signal(1)
    const c = computed(() => source.value * 10)
    const dispose = effect(() => {
      c.value
    })
    dispose()
    await tick()
    source.value = 2
    expect(c.value).toBe(20)
    const seen: number[] = []
    effect(() => {
      seen.push(c.value)
    })
    source.value = 3
    expect(seen).toEqual([20, 30])
  })

  it('a computed is not recomputed when an unrelated signal re-runs its effect', () => {
    const source = signal(1)
    const other = signal('a')
    const fn = vi.fn(() => source.value * 2)
    const c = computed(fn)
    effect(() => {
      c.value
      other.value
    })
    other.value = 'b'
    other.value = 'c'
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('batch runs effects once', () => {
    const a = signal(1)
    const b = signal(1)
    const fn = vi.fn(() => a.value + b.value)
    effect(fn)
    batch(() => {
      a.value = 2
      b.value = 3
    })
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('untrack does not subscribe', () => {
    const a = signal(1)
    const fn = vi.fn(() => untrack(() => a.value))
    effect(fn)
    a.value = 2
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('detects runaway effect loops', () => {
    const s = signal(0)
    expect(() =>
      effect(() => {
        s.value = s.value + 1
      }),
    ).toThrow(/effect loop/)
  })

  it('signals stringify to their value', () => {
    expect(`${signal(5)}`).toBe('5')
  })
})

describe('effect re-runs', () => {
  it('an effect that changes a signal it reads re-runs after it finishes, keeping each cleanup', () => {
    const s = signal(0)
    const log: string[] = []
    const stop = effect(() => {
      const v = s.value
      if (v < 1) s.value = 1
      log.push(`run ${v}`)
      return () => log.push(`clean ${v}`)
    })
    expect(log).toEqual(['run 0', 'clean 0', 'run 1'])
    stop()
    expect(log).toEqual(['run 0', 'clean 0', 'run 1', 'clean 1'])
  })
})
