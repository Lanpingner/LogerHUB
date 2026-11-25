import { createLogger } from '../src/logger'
import { createStubGateway, type StubGateway } from './helpers/stub-gateway'
import { base, waitFor, type Received } from './helpers/fixtures'
import type { Logger } from '../src/types'

/** MCP capture sits in front of somebody's tool handler, so the tests that
 *  matter most are the ones about what the *caller* sees: the same value, the
 *  same error object, the same sync/async shape, whatever logging does. */

const gateways: StubGateway[] = []
const loggers: Logger[] = []

afterEach(async () => {
  for (const l of loggers.splice(0)) await l.close()
  for (const g of gateways.splice(0)) await g.close()
})

async function harness() {
  const gateway = await createStubGateway()
  gateways.push(gateway)
  const log = createLogger({ ...base, url: gateway.url })
  loggers.push(log)
  await waitFor(() => gateway.conns.length > 0)
  const entries = async (): Promise<Received[]> => {
    await log.flush()
    return gateway.batches.flatMap((b) => b.entries) as Received[]
  }
  return { log, entries }
}

const one = async (entries: () => Promise<Received[]>): Promise<Received> => {
  const e = await entries()
  expect(e).toHaveLength(1)
  return e[0]
}

describe('the primitive', () => {
  test('records one mcp entry for a finished call', async () => {
    const { log, entries } = await harness()
    log.mcpCall({ tool: 'search_issues', durationMs: 412.5, args: { query: 'disk' }, result: { ok: true } })
    const e = await one(entries)
    expect(e).toMatchObject({ kind: 'mcp', level: 'info', msg: 'mcp search_issues ok' })
    expect(e.meta.mcp).toMatchObject({
      role: 'server',
      tool: 'search_issues',
      duration_ms: 412.5,
      ok: true,
      args: { query: 'disk' },
      result: { ok: true },
    })
    expect(typeof e.meta.mcp.call_id).toBe('string')
  })

  test('an error makes the entry an error, and is recorded as name and message', async () => {
    const { log, entries } = await harness()
    log.mcpCall({ tool: 'get_cash', error: new TypeError('upstream 503') })
    const e = await one(entries)
    expect(e.level).toBe('error')
    expect(e.msg).toBe('mcp get_cash error')
    expect(e.meta.mcp.ok).toBe(false)
    expect(e.meta.mcp.error).toEqual({ name: 'TypeError', message: 'upstream 503' })
  })

  test('a thrown non-Error still records something readable', async () => {
    const { log, entries } = await harness()
    log.mcpCall({ tool: 't', error: 'just a string' })
    expect((await one(entries)).meta.mcp.error).toEqual({ name: 'Error', message: 'just a string' })
  })

  test('a result flagged isError is a failure, the MCP convention for an in-band error', async () => {
    const { log, entries } = await harness()
    log.mcpCall({ tool: 't', result: { isError: true, content: [{ type: 'text', text: 'no such issue' }] } })
    const e = await one(entries)
    expect(e.level).toBe('error')
    expect(e.meta.mcp.ok).toBe(false)
  })

  test('the client role is recorded as such', async () => {
    const { log, entries } = await harness()
    log.mcpCall({ tool: 'get_cash', role: 'client', server: 'atlas-tools' })
    expect((await one(entries)).meta.mcp).toMatchObject({ role: 'client', server: 'atlas-tools' })
  })

  test('an unknown role falls back to server rather than being carried through', async () => {
    const { log, entries } = await harness()
    log.mcpCall({ tool: 't', role: 'wat' as 'server' })
    expect((await one(entries)).meta.mcp.role).toBe('server')
  })

  test('dims travel with the call', async () => {
    const { log, entries } = await harness()
    log.mcpCall({ tool: 't', dims: { company_id: 'acme' } })
    expect((await one(entries)).dims).toMatchObject({ company_id: 'acme' })
  })
})

describe('secrets and size', () => {
  test('secret-bearing keys in arguments and results are redacted', async () => {
    const { log, entries } = await harness()
    log.mcpCall({ tool: 't', args: { query: 'x', api_key: 'sk-123' }, result: { token: 'abc', rows: 2 } })
    const { mcp } = (await one(entries)).meta
    expect(mcp.args).toEqual({ query: 'x', api_key: '[redacted]' })
    expect(mcp.result).toEqual({ token: '[redacted]', rows: 2 })
  })

  test('the logger custom redactKeys reach arguments too', async () => {
    const gateway = await createStubGateway()
    gateways.push(gateway)
    const log = createLogger({ ...base, url: gateway.url, redactKeys: ['tenant'] })
    loggers.push(log)
    await waitFor(() => gateway.conns.length > 0)
    log.mcpCall({ tool: 't', args: { tenant: 'acme' } })
    await log.flush()
    const e = gateway.batches.flatMap((b) => b.entries)[0] as Received
    expect(e.meta.mcp.args).toEqual({ tenant: '[redacted]' })
  })

  test('an oversized argument object becomes a truncation marker', async () => {
    const { log, entries } = await harness()
    log.mcpCall({ tool: 't', args: { pad: 'x'.repeat(9000) }, maxBodyBytes: 512 })
    const { mcp } = (await one(entries)).meta
    expect(mcp.args).toMatchObject({ _truncated: true })
    expect(mcp.args._bytes).toBeGreaterThan(512)
  })

  test('allowFields keeps only the named arguments', async () => {
    const { log, entries } = await harness()
    log.mcpCall({ tool: 't', args: { query: 'x', internal: 'y' }, allowFields: ['query'] })
    expect((await one(entries)).meta.mcp.args).toEqual({ query: 'x' })
  })

  test('capture never records the measurement but neither payload', async () => {
    const { log, entries } = await harness()
    log.mcpCall({ tool: 't', durationMs: 5, args: { query: 'x' }, result: { a: 1 }, capture: 'never' })
    const { mcp } = (await one(entries)).meta
    expect(mcp).toMatchObject({ tool: 't', duration_ms: 5 })
    expect(mcp.args).toBeUndefined()
    expect(mcp.result).toBeUndefined()
  })

  test('capture on-error keeps payloads only for a failed call', async () => {
    const { log, entries } = await harness()
    log.mcpCall({ tool: 'ok', args: { a: 1 }, capture: 'on-error' })
    log.mcpCall({ tool: 'bad', args: { a: 1 }, error: new Error('x'), capture: 'on-error' })
    const e = await entries()
    expect(e[0].meta.mcp.args).toBeUndefined()
    expect(e[1].meta.mcp.args).toEqual({ a: 1 })
  })
})

describe('wrapping a tool handler (server role)', () => {
  test('one entry per call, with a measured duration', async () => {
    const { log, entries } = await harness()
    const handler = log.wrapMcpTool('search_issues', async (q: { query: string }) => {
      await new Promise((r) => setTimeout(r, 15))
      return { content: [{ type: 'text', text: q.query }] }
    })
    await handler({ query: 'disk full' })
    const e = await one(entries)
    expect(e.meta.mcp).toMatchObject({ role: 'server', tool: 'search_issues', ok: true })
    expect(e.meta.mcp.duration_ms).toBeGreaterThanOrEqual(10)
  })

  test('the handler result reaches the caller unchanged, by identity', async () => {
    const { log } = await harness()
    const result = { content: [] }
    const handler = log.wrapMcpTool('t', async () => result)
    expect(await handler()).toBe(result)
  })

  test('a throwing handler throws its own error, with its own stack', async () => {
    const { log, entries } = await harness()
    const boom = new Error('handler blew up')
    const handler = log.wrapMcpTool('t', async () => {
      throw boom
    })
    await expect(handler()).rejects.toBe(boom)
    const e = await one(entries)
    expect(e.level).toBe('error')
    expect(e.meta.mcp).toMatchObject({ ok: false, error: { name: 'Error', message: 'handler blew up' } })
  })

  test('a synchronous handler stays synchronous', async () => {
    const { log, entries } = await harness()
    const handler = log.wrapMcpTool('t', () => 42)
    const out = handler()
    expect(out).toBe(42)
    expect((await one(entries)).meta.mcp.ok).toBe(true)
  })

  test('a synchronous throw propagates and is still recorded', async () => {
    const { log, entries } = await harness()
    const handler = log.wrapMcpTool('t', () => {
      throw new RangeError('nope')
    })
    expect(() => handler()).toThrow('nope')
    expect((await one(entries)).meta.mcp.error).toEqual({ name: 'RangeError', message: 'nope' })
  })

  test('arguments are read from params.arguments when the handler takes an MCP request', async () => {
    const { log, entries } = await harness()
    const handler = log.wrapMcpTool('t', (_req: unknown) => ({ ok: true }))
    handler({ method: 'tools/call', params: { name: 't', arguments: { query: 'x' } } })
    expect((await one(entries)).meta.mcp.args).toEqual({ query: 'x' })
  })

  test('a custom args reader wins over the default extraction', async () => {
    const { log, entries } = await harness()
    const handler = log.wrapMcpTool('t', (_a: number, _b: string) => 1, { args: (a, b) => ({ a, b }) })
    handler(1, 'two')
    expect((await one(entries)).meta.mcp.args).toEqual({ a: 1, b: 'two' })
  })

  test('ignore skips the call entirely and still returns the result', async () => {
    const { log, entries } = await harness()
    const handler = log.wrapMcpTool('t', () => 'kept', { ignore: () => true })
    expect(handler()).toBe('kept')
    expect(await entries()).toHaveLength(0)
  })

  test('resolveDims, note and resolveMeta land on the entry', async () => {
    const { log, entries } = await harness()
    const handler = log.wrapMcpTool('t', () => 1, {
      server: 'atlas-tools',
      resolveDims: () => ({ company_id: 'acme', dropped: undefined }),
      note: () => 'cache warm',
      resolveMeta: () => ({ tags: { agent: 'claude' }, flags: ['retry'] }),
    })
    handler()
    const e = await one(entries)
    expect(e.dims).toMatchObject({ company_id: 'acme' })
    expect(e.dims?.dropped).toBeUndefined()
    expect(e.meta.mcp).toMatchObject({
      server: 'atlas-tools',
      note: 'cache warm',
      tags: { agent: 'claude' },
      flags: ['retry'],
    })
  })

  test('resolveMeta cannot overwrite a measured field', async () => {
    const { log, entries } = await harness()
    const handler = log.wrapMcpTool('t', () => 1, {
      resolveMeta: () => ({ tool: 'forged', ok: false, duration_ms: 99999 }),
    })
    handler()
    const { mcp } = (await one(entries)).meta
    expect(mcp.tool).toBe('t')
    expect(mcp.ok).toBe(true)
    expect(mcp.duration_ms).toBeLessThan(99999)
  })

  test('phases recorded with logger.time land in meta.mcp.timings', async () => {
    const { log, entries } = await harness()
    const handler = log.wrapMcpTool('t', async () =>
      log.time('db', async () => {
        await new Promise((r) => setTimeout(r, 12))
        return 'rows'
      }),
    )
    await handler()
    const timings = (await one(entries)).meta.mcp.timings
    expect(timings.db).toBeGreaterThanOrEqual(8)
  })
})

describe('wrapping an outbound call (client role)', () => {
  test('the tool name comes from the call argument', async () => {
    const { log, entries } = await harness()
    const callTool = log.wrapMcpClient(async (req: { name: string; arguments: unknown }) => ({ echo: req.arguments }))
    await callTool({ name: 'get_cash', arguments: { day: '2026-11-25' } })
    const { mcp } = (await one(entries)).meta
    expect(mcp).toMatchObject({ role: 'client', tool: 'get_cash' })
    expect(mcp.args).toEqual({ day: '2026-11-25' })
  })

  test('an explicit tool resolver wins', async () => {
    const { log, entries } = await harness()
    const callTool = log.wrapMcpClient(async (_n: string) => 1, { tool: (n) => n })
    await callTool('get_pace')
    expect((await one(entries)).meta.mcp.tool).toBe('get_pace')
  })

  test('a rejection reaches the caller unchanged', async () => {
    const { log, entries } = await harness()
    const boom = new Error('transport closed')
    const callTool = log.wrapMcpClient(async () => {
      throw boom
    })
    await expect(callTool()).rejects.toBe(boom)
    expect((await one(entries)).meta.mcp.ok).toBe(false)
  })

  test('with no name anywhere the tool reads as unknown rather than dropping the entry', async () => {
    const { log, entries } = await harness()
    const callTool = log.wrapMcpClient(async () => 1)
    await callTool()
    expect((await one(entries)).meta.mcp.tool).toBe('unknown')
  })
})

describe('nothing may break the host application', () => {
  test('a logger whose log() throws does not cost the tool its result', async () => {
    const broken = {
      log: () => {
        throw new Error('logging is down')
      },
    } as unknown as Logger
    const { wrapMcpTool } = await import('../src/mcp')
    const handler = wrapMcpTool(broken, 't', () => 'result')
    expect(handler()).toBe('result')
  })

  test('throwing option callbacks cost their own field, not the call', async () => {
    const { log, entries } = await harness()
    const boom = () => {
      throw new Error('hostile')
    }
    const handler = log.wrapMcpTool('t', () => 'ok', {
      ignore: boom,
      resolveDims: boom,
      resolveMeta: boom,
      note: boom,
      args: boom,
      callId: boom,
    })
    expect(handler()).toBe('ok')
    const e = await one(entries)
    expect(e.meta.mcp).toMatchObject({ tool: 't', ok: true })
    expect(e.meta.mcp.args).toBeUndefined()
  })

  test('an argument object that cannot be serialised does not throw into the handler', async () => {
    const { log, entries } = await harness()
    const hostile = {
      get boom(): never {
        throw new Error('no reading me')
      },
    }
    const handler = log.wrapMcpTool('t', (_a: unknown) => 'ok')
    expect(handler(hostile)).toBe('ok')
    expect((await one(entries)).meta.mcp.tool).toBe('t')
  })

  test('a thenable that is not a native promise is adopted exactly once', async () => {
    const { log, entries } = await harness()
    let thens = 0
    const lazy = {
      then(res: (v: unknown) => void) {
        thens++
        res('done')
      },
    }
    const handler = log.wrapMcpTool('t', () => lazy)
    expect(await handler()).toBe('done')
    expect(thens).toBe(1)
    expect((await one(entries)).meta.mcp.ok).toBe(true)
  })

  test('a native promise keeps its identity', async () => {
    const { log } = await harness()
    const p = Promise.resolve('v')
    const handler = log.wrapMcpTool('t', () => p)
    expect(handler()).toBe(p)
    await p
  })
})

describe('kind stays the pipeline’s to set', () => {
  test('a level method cannot produce an mcp entry', async () => {
    const { log, entries } = await harness()
    log.info('pretending', { kind: 'mcp' })
    expect((await one(entries)).kind).toBeUndefined()
  })
})
