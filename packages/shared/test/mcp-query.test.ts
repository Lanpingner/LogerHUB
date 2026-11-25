import { compile, matches, parse, suggest, type Candidate } from '../src/query.ts'
import { KINDS } from '../src/protocol.ts'

/** `tool:` and `kind:` are what make MCP traffic findable. Both have to work in
 *  two places that share nothing but this module: compiled to LogQL for stored
 *  lines, and evaluated in-process for the live stream. */

function mcpCandidate(over: Partial<Candidate> = {}): Candidate {
  return {
    service: 'atlas-tools',
    env: 'prod',
    level: 'info',
    msg: 'mcp search_issues ok',
    dims: {},
    meta: {
      kind: 'mcp',
      mcp: { role: 'server', tool: 'search_issues', duration_ms: 412, ok: true, call_id: 'a1b2c3d4' },
    },
    ...over,
  }
}

const q = (s: string) => parse(s).query

describe('the kinds a log entry may declare', () => {
  test('are exactly request and mcp', () => {
    expect([...KINDS]).toEqual(['request', 'mcp'])
  })
})

describe('tool: and kind: as query fields', () => {
  test('both parse without an issue', () => {
    expect(parse('tool:search_issues kind:mcp').issues).toEqual([])
  })

  test('tool: compiles to a label filter on the promoted metadata key', () => {
    expect(compile(q('tool:search_issues')).logql).toContain('| tool = "search_issues"')
  })

  test('kind: compiles to a label filter', () => {
    expect(compile(q('kind:mcp')).logql).toContain('| kind = "mcp"')
  })

  test('neither takes a numeric comparison', () => {
    expect(parse('tool:>5').issues[0].message).toMatch(/cannot be compared/)
  })

  test('a wildcard tool becomes an anchored regex', () => {
    expect(compile(q('tool:search_*')).logql).toContain('| tool =~ "^search_.*$"')
  })
})

describe('matching a live MCP row', () => {
  test('tool: reads meta.mcp.tool', () => {
    expect(matches(mcpCandidate(), q('tool:search_issues'))).toBe(true)
    expect(matches(mcpCandidate(), q('tool:get_cash'))).toBe(false)
  })

  test('kind: reads the entry kind carried on the payload', () => {
    expect(matches(mcpCandidate(), q('kind:mcp'))).toBe(true)
    expect(matches(mcpCandidate(), q('kind:request'))).toBe(false)
  })

  test('a kind: term does not match a row that carries no kind', () => {
    expect(matches(mcpCandidate({ meta: { mcp: { tool: 'x' } } }), q('kind:mcp'))).toBe(false)
  })

  test('duration: works on an MCP row, because the field name is shared with HTTP', () => {
    expect(matches(mcpCandidate(), q('duration:>100'))).toBe(true)
    expect(matches(mcpCandidate(), q('duration:>1000'))).toBe(false)
  })

  test('an HTTP row is unaffected: a tool: term simply does not match it', () => {
    const http = mcpCandidate({ meta: { kind: 'request', http: { method: 'GET', status: 200 } } })
    expect(matches(http, q('tool:search_issues'))).toBe(false)
    expect(matches(http, q('kind:request'))).toBe(true)
  })
})

describe('autocomplete', () => {
  test('offers the known kinds', () => {
    expect(suggest('kind:', 5, { services: [], envs: [] }).map((s) => s.label)).toEqual(['request', 'mcp'])
  })
})
