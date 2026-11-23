import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BatchFrame, LogEntry } from '@logguber/shared'

export function entry(msg: string): LogEntry {
  return { ts: new Date().toISOString(), level: 'info', msg }
}

/** A one-entry batch; `pad` inflates the message so tests can control row size. */
export function batch(id: string, pad = ''): BatchFrame {
  return { t: 'batch', id, entries: [entry(`m-${id}${pad}`)] }
}

const dirs: string[] = []

/** A fresh empty directory under os.tmpdir(), removed after the suite. */
export function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'logguber-'))
  dirs.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Shared transport/client options; spread into each test's options. */
export const base = {
  apiKey: 'lgb_test_secret',
  service: 'public-api',
  env: 'test',
  onError: () => {},
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Polls `fn` every 5ms until truthy; rejects after `timeoutMs` (default 2000). */
export async function waitFor(fn: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!fn()) {
    if (Date.now() > deadline) throw new Error(`waitFor timed out after ${timeoutMs}ms`)
    await sleep(5)
  }
}
