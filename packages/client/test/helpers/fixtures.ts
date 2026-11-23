import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LogEntry } from '@logguber/shared'

export function entry(msg: string): LogEntry {
  return { ts: new Date().toISOString(), level: 'info', msg }
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
