import { appendFile } from 'node:fs'
import type { LogEntry, Level } from '@logguber/shared'
import { LEVELS } from '@logguber/shared'
import { safeStringify } from './redact'
import type { ConsoleConfig } from './types'

const LEVEL_COLOR: Record<string, string> = {
  debug: '\x1B[35m',
  info: '\x1B[36m',
  warn: '\x1B[93m',
  error: '\x1B[31m',
  fatal: '\x1B[31m',
}
const PENDING_COLOR = '\x1B[33m'
const RESET = '\x1B[0m'
const DIM = '\x1B[90m'
/** Served from a cache rather than the database. */
const TAG_CACHED = '\x1B[35m'
/** Ran, and went to the database. */
const TAG_LIVE = '\x1B[31m'
const DEFAULT_TAG_LETTERS = ['A', 'P', 'R']
/** Letters that are never cached, so they always read as live. */
const DEFAULT_TAG_ALWAYS = ['R']

function statusColor(status: number): string {
  if (status >= 500) return '\x1B[31m'
  if (status >= 400) return '\x1B[93m'
  return '\x1B[32m'
}

function hhmmss(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
}

function isoish(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19)
}

/**
 * One argument of a variadic call. A plain string passes through unchanged, so existing
 * single-argument call sites read identically; an Error becomes its stack, which is the
 * whole point — `error('failed:', err)` used to drop the error on the floor.
 */
export function formatArg(arg: unknown): string {
  if (arg instanceof Error) return arg.stack ?? `${arg.name}: ${arg.message}`
  if (typeof arg !== 'object' || arg === null) return String(arg)
  if (Array.isArray(arg)) return json(arg)
  // `String()` first, deliberately: it runs a `toString` the application defined on
  // purpose, which is better output than JSON. It also means a hostile `toString`
  // throws here, so the entry is dropped and the failure reported, rather than
  // quietly logged as "{}".
  const s = String(arg)
  return s.startsWith('[object ') ? json(arg) : s
}

function json(v: object): string {
  try {
    return safeStringify(v)
  } catch {
    return '[unserialisable]'
  }
}

/** The entry script's filename, the way a local logger labels its lines. Undefined
 *  when there is no script to name, so the caller can fall back to the service. */
export function defaultLabel(): string | undefined {
  const main = process.argv[1]
  if (typeof main !== 'string' || main === '') return undefined
  const cut = main.lastIndexOf('/')
  const base = cut === -1 ? main : main.slice(cut + 1)
  return base === '' ? undefined : base
}

/**
 * `[APR]`-style tag: the letters that ran are coloured (purple cached, red live) and the
 * rest are dimmed, so one glance says which auth path a request took. `outer` is the line's
 * own colour, restored after each letter so the tag does not bleed into the rest.
 */
function authTag(
  auth: { type?: unknown; cached?: unknown } | undefined,
  letters: string[],
  always: string[],
  outer: string,
  color: boolean,
): string {
  if (!color) return '[' + letters.join('') + ']'
  const ran = typeof auth?.type === 'string' ? auth.type : ''
  const cached = auth?.cached === true
  const resume = RESET + outer
  const body = letters
    .map((l) => {
      if (always.includes(l)) return TAG_LIVE + l + resume
      if (l !== ran) return DIM + l + resume
      return (cached ? TAG_CACHED : TAG_LIVE) + l + resume
    })
    .join('')
  return '[' + body + ']'
}

function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

export interface PendingRequest {
  id: string
  method: string
  url: string
  ip?: string
  startedAt: number
}

export interface ConsoleView {
  /** Prints one already-redacted entry. */
  write(entry: LogEntry): void
  pendingAdd(r: PendingRequest): void
  pendingRemove(id: string): void
  /** Prints a line that is not a log entry, keeping the pending block intact. */
  raw(text: string): void
  close(): void
}

const NOOP: ConsoleView = {
  write: () => {},
  pendingAdd: () => {},
  pendingRemove: () => {},
  raw: () => {},
  close: () => {},
}

export function createConsoleView(cfg: ConsoleConfig | undefined, service: string): ConsoleView {
  if (!cfg?.enabled) return NOOP

  const out = cfg.stream ?? process.stdout
  const isTty = Boolean((out as NodeJS.WriteStream).isTTY)
  // NO_COLOR is a convention worth honouring: a pipeline that strips colour
  // should not have to filter escape codes out of its logs.
  const color = (cfg.color ?? isTty) && !process.env.NO_COLOR
  const label = cfg.label ?? defaultLabel() ?? service
  const minimum = LEVELS.indexOf((cfg.level ?? 'debug') as Level)
  // Deliberately NOT tied to `color`. Colour is a preference and is safe to force
  // anywhere; the in-flight block moves the cursor, which only means anything on a
  // real terminal. Written into a file — under PM2, or any redirect — the movement
  // is ignored and every redraw stacks another copy of the block instead.
  const showPending = Boolean(cfg.pending) && isTty
  const file = cfg.file

  const tagLetters = cfg.authTagLetters?.length ? cfg.authTagLetters : DEFAULT_TAG_LETTERS
  const tagAlways = cfg.authTagAlways ?? DEFAULT_TAG_ALWAYS

  const pending = new Map<string, PendingRequest>()
  let pendingLines = 0

  function toFile(plain: string): void {
    if (!file) return
    // Fire and forget: a failing disk must never block the caller's request,
    // and the gateway already has the durable copy.
    appendFile(file, plain + '\n', () => {})
  }

  function pendingLine(r: PendingRequest): string {
    const elapsed = Date.now() - r.startedAt
    const dur = ('+' + elapsed + 'ms').padStart(8)
    return (
      PENDING_COLOR +
      hhmmss(r.startedAt) + ' ' + dur + ' ' + r.method.padEnd(7) +
      ' [' + r.id + '] ' + r.url +
      (r.ip ? ' from ' + r.ip : '') +
      ' — pending...' +
      RESET
    )
  }

  /**
   * Takes the in-flight block off the screen and leaves the cursor where its first
   * line was. Every redraw starts here: drawing the rows without first going back
   * over the old ones appends a second block rather than replacing the first, and a
   * busy service then fills the screen with copies.
   */
  function eraseBlock(): void {
    if (pendingLines === 0) return
    // Up to the first line of the block, then clear everything below the cursor.
    out.write('\x1B[' + pendingLines + 'A\x1B[J')
    pendingLines = 0
  }

  function redraw(): void {
    if (!showPending) return
    eraseBlock()
    const rows = [...pending.values()]
    for (const r of rows) out.write(pendingLine(r) + '\n')
    pendingLines = rows.length
  }

  /** Every stdout write goes through here, or the cursor arithmetic that keeps
   *  the pending block pinned to the bottom drifts and the terminal corrupts. */
  function print(text: string): void {
    if (!showPending) {
      out.write(text + '\n')
      return
    }
    // The line lands where the block was, and the block is drawn again beneath it,
    // so finished lines scroll up and the in-flight ones stay at the bottom.
    eraseBlock()
    out.write(text + '\n')
    redraw()
  }

  function requestLine(entry: LogEntry): { plain: string; painted: string } | null {
    const http = entry.meta?.http as Record<string, unknown> | undefined
    if (!http || typeof http !== 'object') return null

    const started = Date.parse(entry.ts)
    const duration = Number(http.duration_ms)
    const status = Number(http.status)
    const method = String(http.method ?? '')
    const url = String(http.path ?? http.route ?? '')
    const id = http.request_id ? String(http.request_id) : ''
    const ip = http.ip ? String(http.ip) : ''

    // `tags` and `flags` are the application's own short labels. Dimensions are
    // appended too, so a company or user id shows without a format option per field,
    // but a tag of the same name wins: the application named it deliberately.
    // `true` renders as a bare word rather than `key:value`, so a single ordered
    // record can reproduce any interleaving of labels and flags on the line.
    const shown = new Map<string, string | true>()
    for (const [k, v] of Object.entries(asRecord(http.tags))) {
      if (v === true) shown.set(k, true)
      else if (v != null && v !== '' && typeof v !== 'object') shown.set(k, String(v))
    }
    if (Array.isArray(http.flags)) {
      for (const f of http.flags) if (typeof f === 'string' && f !== '') shown.set(f, true)
    }
    for (const [k, v] of Object.entries(entry.dims ?? {})) {
      const short = k.replace(/_id$/, '')
      if (v && !shown.has(short)) shown.set(short, v)
    }
    const tags = [...shown].map(([k, v]) => (v === true ? ' ' + k : ' ' + k + ':' + v)).join('')

    const extra = typeof http.note === 'string' && http.note !== '' ? ' (' + http.note + ')' : ''
    const dur = (Number.isFinite(duration) ? '+' + Math.round(duration) + 'ms' : '').padStart(8)
    const tone = color ? statusColor(Number.isFinite(status) ? status : 200) : ''
    // The tag is built per line because its letters are painted relative to this
    // line's own colour.
    const tag = http.auth === undefined ? '' : ' ' + authTag(asRecord(http.auth), tagLetters, tagAlways, tone, color)
    const tagPlain = http.auth === undefined ? '' : ' [' + tagLetters.join('') + ']'

    // Field order is fixed: time, duration, method, auth tag, id, url, origin,
    // labels, status. The tag sits after the method, where the logger this
    // replaces put it.
    const head =
      hhmmss(Number.isFinite(started) ? started : Date.now()) + ' ' + dur + ' ' + method.padEnd(7)
    const rest =
      (id ? ' [' + id + ']' : '') + ' ' + url +
      (ip ? ' from ' + ip : '') + tags +
      ' — ' + (Number.isFinite(status) ? status : '?') + extra

    return {
      plain: head + tagPlain + rest,
      painted: tone ? tone + head + tag + rest + RESET : head + tagPlain + rest,
    }
  }

  function plainLine(entry: LogEntry): { plain: string; painted: string } {
    const rest = entry.meta ? safeStringify(entry.meta) : ''
    const body = entry.msg + (rest && rest !== '{}' ? ' ' + rest : '')
    const plain = isoish(Date.parse(entry.ts) || Date.now()) + ' ' + entry.level.toUpperCase().padEnd(5) + ' [' + label + ']: ' + body
    if (!color) return { plain, painted: plain }
    const tone = LEVEL_COLOR[entry.level] ?? ''
    return { plain, painted: tone + plain + RESET }
  }

  return {
    write(entry) {
      if (LEVELS.indexOf(entry.level) < minimum) return
      const formatted = entry.kind === 'request' ? requestLine(entry) ?? plainLine(entry) : plainLine(entry)
      print(formatted.painted)
      toFile(formatted.plain)
    },
    pendingAdd(r) {
      if (!showPending) return
      pending.set(r.id, r)
      redraw()
    },
    pendingRemove(id) {
      if (!showPending) return
      if (pending.delete(id)) redraw()
    },
    raw(text) {
      print(color ? text : text.replace(/\x1B\[[0-9;]*m/g, ''))
    },
    close() {
      if (!showPending) return
      // Leave the terminal as we found it rather than stranding a half-drawn block.
      eraseBlock()
      pending.clear()
    },
  }
}

export const DIM_CODE = DIM
