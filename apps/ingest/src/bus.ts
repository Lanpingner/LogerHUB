import type { LogEntry } from '@logguber/shared'

export interface LiveEntry extends LogEntry {
  service: string
  env: string
}

export interface Filter {
  services?: string[]
  envs?: string[]
  levels?: string[]
  dims?: Record<string, string>
}

function matches(e: LiveEntry, f: Filter): boolean {
  if (f.services?.length && !f.services.includes(e.service)) return false
  if (f.envs?.length && !f.envs.includes(e.env)) return false
  if (f.levels?.length && !f.levels.includes(e.level)) return false
  if (f.dims) {
    for (const [k, v] of Object.entries(f.dims)) {
      if (!v) continue
      if (e.dims?.[k] !== v) return false
    }
  }
  return true
}

const RING = 1000

/** In-process fan-out so live tail does not wait on storage, plus a ring buffer
 *  so opening the tail shows context instead of an empty screen.
 *  Delivery is best-effort by design: a stalled subscriber is skipped, never
 *  allowed to back up ingest, because the durable copy is going to Loki anyway. */
export function createBus() {
  const ring: LiveEntry[] = []
  const subs = new Set<{ filter: Filter; send: (e: LiveEntry) => void }>()

  return {
    publish(entries: LiveEntry[]) {
      for (const e of entries) {
        ring.push(e)
        if (ring.length > RING) ring.shift()
        for (const s of subs) {
          if (!matches(e, s.filter)) continue
          try {
            s.send(e)
          } catch {
            subs.delete(s)
          }
        }
      }
    },
    subscribe(filter: Filter, send: (e: LiveEntry) => void) {
      const sub = { filter, send }
      subs.add(sub)
      return () => subs.delete(sub)
    },
    backlog(filter: Filter, limit = 200): LiveEntry[] {
      const out: LiveEntry[] = []
      for (let i = ring.length - 1; i >= 0 && out.length < limit; i--) {
        if (matches(ring[i], filter)) out.push(ring[i])
      }
      return out.reverse()
    },
    subscriberCount: () => subs.size,
  }
}

export type Bus = ReturnType<typeof createBus>
