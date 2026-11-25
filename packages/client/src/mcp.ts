import { randomBytes } from 'node:crypto'
import { redactBody, truncateJson } from './redact'
import { ulid } from './ulid'
import { runWithPhases } from './phases'
import type { Logger, McpCall, McpCapture, McpClientOptions, McpToolOptions } from './types'

const DEFAULT_MAX_BODY_BYTES = 8192
const MAX_TOOL_NAME = 128
const MAX_CALL_ID = 128
/** Only a capture may write these, so `resolveMeta` cannot invent a payload. */
const CAPTURE_OWNED = ['args', 'result', 'capture_failed']

/** The same 8 hex characters a request id uses, so the two read alike in a log. */
function shortId(): string {
  try {
    return randomBytes(4).toString('hex')
  } catch {
    return ulid().slice(-8).toLowerCase()
  }
}

/** The MCP convention for a tool that failed without throwing: an ordinary
 *  result carrying `isError: true`. To an operator that is the same fact as a
 *  thrown error — the call did not do its job — so it reads as one. */
function isErrorResult(result: unknown): boolean {
  try {
    return result !== null && typeof result === 'object' && (result as { isError?: unknown }).isError === true
  } catch {
    return false
  }
}

/** Name and message only: a stack is the host application's internal detail. */
function errorRecord(err: unknown): { name: string; message: string } {
  try {
    if (err instanceof Error) return { name: err.name, message: err.message }
    return { name: 'Error', message: String(err) }
  } catch {
    return { name: 'Error', message: '[unreadable]' }
  }
}

/** `always` (the default) because a tool call without its arguments answers
 *  almost nothing, and call volume is orders of magnitude below HTTP. */
function captures(mode: McpCapture, ok: boolean): boolean {
  return mode === 'always' || (mode !== 'never' && !ok)
}

function text(v: unknown, max: number): string | undefined {
  try {
    if (typeof v !== 'string' || v === '') return undefined
    return v.slice(0, max)
  } catch {
    return undefined
  }
}

function isThenable(v: unknown): v is PromiseLike<unknown> {
  try {
    return v !== null && (typeof v === 'object' || typeof v === 'function') && typeof (v as { then?: unknown }).then === 'function'
  } catch {
    return false
  }
}

/**
 * Records one completed MCP tool call as a `kind: 'mcp'` entry. Everything the
 * wrappers measure funnels through here, so the entry shape, the redaction and
 * the size cap live in exactly one place.
 *
 * Nothing in here may reach the caller: the whole body is guarded, because this
 * is called from inside somebody's tool handler.
 */
export function recordMcpCall(logger: Logger, call: McpCall): void {
  try {
    const tool = text(call.tool, MAX_TOOL_NAME) ?? 'unknown'
    const role = call.role === 'client' ? 'client' : 'server'
    const failed = call.error !== undefined || isErrorResult(call.result)
    const ok = typeof call.ok === 'boolean' ? call.ok : !failed
    const maxBytes =
      typeof call.maxBodyBytes === 'number' && call.maxBodyBytes >= 1
        ? Math.floor(call.maxBodyBytes)
        : DEFAULT_MAX_BODY_BYTES

    const mcp: Record<string, unknown> = {
      role,
      tool,
      call_id: text(call.callId, MAX_CALL_ID) ?? shortId(),
      ok,
    }
    const server = text(call.server, MAX_TOOL_NAME)
    if (server !== undefined) mcp.server = server
    if (typeof call.durationMs === 'number' && Number.isFinite(call.durationMs)) mcp.duration_ms = call.durationMs
    if (call.error !== undefined) mcp.error = errorRecord(call.error)
    if (call.timings !== undefined && Object.keys(call.timings).length > 0) mcp.timings = call.timings
    const note = text(call.note, 256)
    if (note !== undefined) mcp.note = note
    if (call.tags !== undefined) mcp.tags = call.tags
    if (Array.isArray(call.flags) && call.flags.length > 0) mcp.flags = call.flags

    if (captures(call.capture ?? 'always', ok)) {
      // Its own guard: a payload that cannot be read costs the payload, never
      // the measurement the usage counts are derived from. No `redactKeys`
      // here on purpose — the logger redacts all of `meta` again, with the
      // custom keys, in `accept`.
      try {
        const bound = (v: unknown): unknown =>
          v === undefined ? undefined : truncateJson(redactBody(v, { allowFields: call.allowFields }), maxBytes)
        const args = bound(call.args)
        if (args !== undefined) mcp.args = args
        const result = bound(call.result)
        if (result !== undefined) mcp.result = result
      } catch {
        // The flag makes the gap visible: one payload may have been captured
        // and the other not, and the entry would otherwise look complete.
        mcp.capture_failed = true
      }
    }

    // Application facts last, and they cannot overwrite a measured one: a
    // `resolveMeta` returning `ok` or `duration_ms` must not be able to rewrite
    // what was observed, and the three capture-owned keys are off limits
    // entirely so a field cannot appear that no capture produced.
    if (call.meta !== null && typeof call.meta === 'object') {
      for (const [k, v] of Object.entries(call.meta)) {
        if (v === undefined || CAPTURE_OWNED.includes(k) || Object.hasOwn(mcp, k)) continue
        mcp[k] = v
      }
    }

    logger.log(ok ? 'info' : 'error', `mcp ${tool} ${ok ? 'ok' : 'error'}`, {
      kind: 'mcp',
      dims: call.dims,
      meta: { mcp },
    })
  } catch {
    // Logging is best effort; the tool has already run.
  }
}

/** Only the hooks both wrappers share; `wrapMcpClient` adds `tool`. */
type Common<A extends unknown[]> = McpToolOptions<A>

/** Arguments, when the caller has not said how to find them. Covers the two
 *  shapes every MCP implementation uses — an SDK request (`params.arguments`)
 *  and a bare call descriptor (`arguments` / `args`) — and otherwise falls back
 *  to the first parameter, which is right for a plain handler. */
function defaultArgs(first: unknown): unknown {
  if (first === null || typeof first !== 'object') return first
  const o = first as Record<string, unknown>
  const params = o.params
  if (params !== null && typeof params === 'object' && 'arguments' in (params as object)) {
    return (params as Record<string, unknown>).arguments
  }
  if ('arguments' in o) return o.arguments
  if ('args' in o) return o.args
  return first
}

/** A tool name off the call descriptor, for the client wrapper. */
function defaultToolName(first: unknown): string | undefined {
  if (first === null || typeof first !== 'object') return undefined
  const o = first as Record<string, unknown>
  const params = o.params
  const fromParams =
    params !== null && typeof params === 'object' ? (params as Record<string, unknown>).name : undefined
  const candidate = o.name ?? o.tool ?? fromParams
  return typeof candidate === 'string' && candidate !== '' ? candidate : undefined
}

function call<T>(fn: (() => T) | undefined, fallback: T): T {
  if (fn === undefined) return fallback
  try {
    return fn()
  } catch {
    return fallback // costs the field, not the call
  }
}

/**
 * The measuring shell both wrappers are. It guards every foreign call except
 * one: `handler` itself, whose error belongs to the application and must
 * propagate unchanged.
 */
function measured<A extends unknown[], R>(
  logger: Logger,
  role: 'server' | 'client',
  resolveTool: (args: A) => string,
  handler: (...args: A) => R,
  opts: Common<A>,
): (...args: A) => R {
  return function wrapped(this: unknown, ...args: A): R {
    if (call(() => opts.ignore?.(...args) === true, false)) return handler.apply(this, args)

    const start = process.hrtime.bigint()
    let tool = 'unknown'
    try {
      tool = resolveTool(args)
    } catch {
      // An unnamed call is still worth recording.
    }
    let readPhases: (() => Record<string, number>) | undefined

    const done = (result: unknown, error: unknown, errored: boolean): void => {
      let durationMs: number | undefined
      try {
        durationMs = Number(process.hrtime.bigint() - start) / 1e6
      } catch {
        // A lost measurement is better than a lost entry.
      }
      const dims: Record<string, string> = {}
      for (const [k, v] of Object.entries(call(() => opts.resolveDims?.(...args) ?? {}, {}))) {
        if (typeof v === 'string') dims[k] = v
      }
      const extra = call(() => opts.resolveMeta?.(...args), undefined)
      recordMcpCall(logger, {
        tool,
        role,
        server: opts.server,
        callId: call(() => opts.callId?.(...args), undefined),
        durationMs,
        args: call(() => (opts.args ? opts.args(...args) : defaultArgs(args[0])), undefined),
        result: errored ? undefined : result,
        error: errored ? error : undefined,
        note: call(() => opts.note?.(...args), undefined),
        timings: call(() => readPhases?.(), undefined),
        dims: Object.keys(dims).length > 0 ? dims : undefined,
        capture: opts.capture,
        maxBodyBytes: opts.maxBodyBytes,
        allowFields: opts.allowFields,
        // Application facts last, and they cannot overwrite a measured one: a
        // resolveMeta returning `ok` must not be able to rewrite the outcome.
        meta: extra,
      })
    }

    let out: R
    try {
      // Phases are reported from anywhere beneath the handler, so the work runs
      // inside a phase context and `logger.time('db', …)` needs no extra API.
      const run = runWithPhases(() => handler.apply(this, args))
      readPhases = run.phases
      out = run.result
    } catch (err) {
      done(undefined, err, true)
      throw err // the application's error, unchanged
    }

    if (out instanceof Promise) {
      // Both arms record and swallow, so this branch can never become an
      // unhandled rejection of its own; the caller still gets `out` itself.
      try {
        out.then(
          (v) => done(v, undefined, false),
          (e) => done(undefined, e, true),
        )
      } catch {
        done(undefined, undefined, false)
      }
      return out
    }
    if (isThenable(out)) {
      // Adopted exactly once: a lazy thenable starts its work in then(), so
      // observing settlement twice would run the call twice.
      return Promise.resolve(out).then(
        (v) => {
          done(v, undefined, false)
          return v
        },
        (e) => {
          done(undefined, e, true)
          throw e
        },
      ) as R
    }
    done(out, undefined, false)
    return out
  }
}

/** Server role: the calls this process serves. */
export function wrapMcpTool<A extends unknown[], R>(
  logger: Logger,
  tool: string,
  handler: (...args: A) => R,
  opts: McpToolOptions<A> = {},
): (...args: A) => R {
  return measured(logger, 'server', () => tool, handler, opts)
}

/** Client role: the tools this process uses. */
export function wrapMcpClient<A extends unknown[], R>(
  logger: Logger,
  callTool: (...args: A) => R,
  opts: McpClientOptions<A> = {},
): (...args: A) => R {
  return measured(
    logger,
    'client',
    (args) => call(() => opts.tool?.(...args), undefined) ?? defaultToolName(args[0]) ?? 'unknown',
    callTool,
    opts,
  )
}
