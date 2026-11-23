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
