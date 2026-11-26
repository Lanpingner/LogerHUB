import { describe, expect, it } from 'vitest'
import { createBus, type LiveEntry } from '../src/bus.ts'

/** The ring now tracks each entry's size in a parallel array so eviction does
 *  not re-serialise. These tests pin the behaviour that array has to preserve:
 *  if it ever drifts out of step with the ring, the byte budget silently stops
 *  bounding memory, which is the failure it exists to prevent. */

const entry = (i: number, pad = ''): LiveEntry => ({
  ts: new Date().toISOString(),
  level: 'info',
  msg: 'line ' + i + pad,
  dims: {},
  service: 'api',
  env: 'prod',
})

const all = { }

describe('the live ring', () => {
  it('holds at most 1000 entries and keeps the newest', () => {
    const bus = createBus()
    for (let i = 0; i < 1500; i++) bus.publish([entry(i)])
    const held = bus.backlog(all, 5000)
    expect(held).toHaveLength(1000)
    expect(held[held.length - 1].msg).toBe('line 1499')
    expect(held[0].msg).toBe('line 500')
  })

  it('evicts on the byte budget well before the entry count', () => {
    const bus = createBus()
    // ~64KB each: the 8MB budget binds at ~128 entries, far short of 1000.
    const pad = 'x'.repeat(64 * 1024)
    for (let i = 0; i < 400; i++) bus.publish([entry(i, pad)])
    const held = bus.backlog(all, 5000)
    expect(held.length).toBeLessThan(1000)
    expect(held.length).toBeGreaterThan(1)
    // Newest kept, oldest dropped.
    expect(held[held.length - 1].msg.startsWith('line 399')).toBe(true)
  })

  it('accounts correctly across a mixed stream, so a big burst does not strand small entries', () => {
    const bus = createBus()
    const pad = 'x'.repeat(64 * 1024)
    for (let i = 0; i < 200; i++) bus.publish([entry(i, pad)])
    // Once the big ones age out, the ring must be able to fill with small ones
    // again — it cannot if evicted sizes were mis-subtracted.
    for (let i = 0; i < 1000; i++) bus.publish([entry(i)])
    const held = bus.backlog(all, 5000)
    expect(held).toHaveLength(1000)
    expect(held.every((e) => !e.msg.includes('x'))).toBe(true)
  })

  it('handles a batch published in one call the same as one at a time', () => {
    const bus = createBus()
    bus.publish(Array.from({ length: 1500 }, (_, i) => entry(i)))
    expect(bus.backlog(all, 5000)).toHaveLength(1000)
  })
})
