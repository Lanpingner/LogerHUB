import { KINDS } from './protocol.ts'

/** LogerHub query language.
 *
 *  `app:atlas status:>=500 duration:>1000 NOT path:/health`
 *
 *  Parsed into a validated AST, then compiled. Untrusted input is never
 *  concatenated into LogQL: field names are checked against a fixed table and
 *  every value is escaped by the compiler. */

export type Op = '=' | '!=' | '>' | '>=' | '<' | '<=' | '~'

export interface Term {
  kind: 'term'
  field: FieldName
  op: Op
  value: string
  negated: boolean
}

export interface TextTerm {
  kind: 'text'
  value: string
  negated: boolean
}

export type Node = Term | TextTerm

export interface Clause {
  /** Terms within a clause are ANDed; clauses are ORed. */
  and: Node[]
}

export interface Query {
  or: Clause[]
}

export interface ParseIssue {
  from: number
  to: number
  message: string
}

export interface ParseResult {
  query: Query
  issues: ParseIssue[]
}

/** The only fields a query may name. Anything else is a parse error rather
 *  than a silently ignored filter. */
export const FIELDS = {
  app: { kind: 'label', label: 'service', numeric: false, help: 'Application or service name' },
  application: { kind: 'label', label: 'service', numeric: false, help: 'Application name' },
  service: { kind: 'label', label: 'service', numeric: false, help: 'Service name' },
  env: { kind: 'label', label: 'env', numeric: false, help: 'Environment' },
  environment: { kind: 'label', label: 'env', numeric: false, help: 'Environment' },
  level: { kind: 'label', label: 'level', numeric: false, help: 'debug, info, warn, error, fatal' },

  status: { kind: 'meta', label: 'status', numeric: true, help: 'HTTP status, supports >= and <' },
  duration: { kind: 'meta', label: 'duration_ms', numeric: true, help: 'Milliseconds, supports > and <' },
  method: { kind: 'meta', label: 'method', numeric: false, help: 'GET, POST, PUT, PATCH, DELETE' },
  path: { kind: 'meta', label: 'path', numeric: false, help: 'Request path' },
  route: { kind: 'meta', label: 'route', numeric: false, help: 'Normalised route template' },
  company: { kind: 'meta', label: 'company_id', numeric: false, help: 'Client company id' },
  user: { kind: 'meta', label: 'user_id', numeric: false, help: 'End user id' },
  key: { kind: 'meta', label: 'api_key_id', numeric: false, help: 'API key id' },
  request: { kind: 'meta', label: 'request_id', numeric: false, help: 'Request id' },
  trace: { kind: 'meta', label: 'trace_id', numeric: false, help: 'Trace id' },
  instance: { kind: 'meta', label: 'instance', numeric: false, help: 'Server instance' },

  kind: { kind: 'meta', label: 'kind', numeric: false, help: 'request or mcp' },
  tool: { kind: 'meta', label: 'tool', numeric: false, help: 'MCP tool name' },
} as const

export type FieldName = keyof typeof FIELDS

export const FIELD_NAMES = Object.keys(FIELDS) as FieldName[]

const OPS: [string, Op][] = [
  ['>=', '>='],
  ['<=', '<='],
  ['!=', '!='],
  ['=~', '~'],
  ['>', '>'],
  ['<', '<'],
  ['=', '='],
]

interface Token {
  text: string
  from: number
  to: number
}

function tokenize(input: string): Token[] {
  const out: Token[] = []
  let i = 0
  while (i < input.length) {
    while (i < input.length && /\s/.test(input[i])) i++
    if (i >= input.length) break
    const from = i
    let text = ''
    let quoted = false
    while (i < input.length) {
      const ch = input[i]
      if (ch === '"') {
        quoted = !quoted
        i++
        continue
      }
      if (!quoted && /\s/.test(ch)) break
      text += ch
      i++
    }
    out.push({ text, from, to: i })
  }
  return out
}

export function parse(input: string): ParseResult {
  const issues: ParseIssue[] = []
  const tokens = tokenize(input)

  const clauses: Clause[] = []
  let current: Node[] = []
  let negateNext = false

  const flush = () => {
    if (current.length) clauses.push({ and: current })
    current = []
  }

  for (const token of tokens) {
    const upper = token.text.toUpperCase()
    if (upper === 'AND') continue
    if (upper === 'OR') {
      flush()
      continue
    }
    if (upper === 'NOT' || token.text === '-') {
      negateNext = true
      continue
    }

    const colon = token.text.indexOf(':')
    if (colon <= 0) {
      current.push({ kind: 'text', value: token.text, negated: negateNext })
      negateNext = false
      continue
    }

    const rawField = token.text.slice(0, colon).toLowerCase()
    let rest = token.text.slice(colon + 1)

    if (!(rawField in FIELDS)) {
      issues.push({
        from: token.from,
        to: token.from + rawField.length,
        message: 'Unknown field "' + rawField + '". Known fields: ' + FIELD_NAMES.join(', '),
      })
      continue
    }
    const field = rawField as FieldName
    const spec = FIELDS[field]

    let op: Op = '='
    for (const [text, mapped] of OPS) {
      if (rest.startsWith(text)) {
        op = mapped
        rest = rest.slice(text.length)
        break
      }
    }
    if (rest.includes('*') && op === '=') op = '~'

    if (!rest) {
      issues.push({ from: token.from, to: token.to, message: rawField + ' needs a value' })
      continue
    }
    if (spec.numeric) {
      if (!/^-?\d+(\.\d+)?$/.test(rest)) {
        issues.push({ from: token.from, to: token.to, message: rawField + ' takes a number, got "' + rest + '"' })
        continue
      }
    } else if (op === '>' || op === '>=' || op === '<' || op === '<=') {
      issues.push({ from: token.from, to: token.to, message: rawField + ' cannot be compared with ' + op })
      continue
    }

    current.push({ kind: 'term', field, op, value: rest, negated: negateNext })
    negateNext = false
  }
  flush()

  return { query: { or: clauses }, issues }
}

/* ---------- compiling ---------- */

function quote(v: string): string {
  return '"' + v.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
}

function escapeRe(v: string): string {
  return v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** A wildcard becomes an anchored regex, with every other character escaped. */
function wildcardToRegex(v: string): string {
  return '^' + v.split('*').map(escapeRe).join('.*') + '$'
}

export interface CompiledQuery {
  /** Stream selector plus label filters, ready for Loki. */
  logql: string
  /** True when the query names no stream label at all. */
  broad: boolean
}

export function compile(query: Query, extra?: { service?: string; env?: string; level?: string }): CompiledQuery {
  // Loki takes one stream selector, so only the first clause's label terms can
  // narrow the stream. Remaining clauses become line filters.
  const first = query.or[0]?.and ?? []
  const labels = new Map<string, string>()

  if (extra?.service) labels.set('service', extra.service)
  if (extra?.env) labels.set('env', extra.env)
  if (extra?.level) labels.set('level', extra.level)

  for (const node of first) {
    if (node.kind !== 'term' || node.negated) continue
    const spec = FIELDS[node.field]
    if (spec.kind !== 'label') continue
    if (node.op === '=' ) labels.set(spec.label, node.value)
  }

  const selector = labels.size
    ? '{' + [...labels.entries()].map(([k, v]) => k + '=' + quote(v)).join(', ') + '}'
    : '{service=~".+"}'

  const parts: string[] = [selector]

  // Free text first: cheapest filter, applied before parsing metadata.
  for (const clause of query.or) {
    for (const node of clause.and) {
      if (node.kind !== 'text') continue
      parts.push((node.negated ? ' != ' : ' |= ') + quote(node.value))
    }
  }

  for (const clause of query.or) {
    for (const node of clause.and) {
      if (node.kind !== 'term') continue
      const spec = FIELDS[node.field]
      const name = spec.label
      if (spec.kind === 'label' && !node.negated && node.op === '=' && labels.get(name) === node.value) continue

      if (node.op === '~' || node.value.includes('*')) {
        parts.push(' | ' + name + (node.negated ? ' !~ ' : ' =~ ') + quote(wildcardToRegex(node.value)))
      } else if (spec.numeric) {
        const op = node.op === '=' ? '==' : node.op === '!=' ? '!=' : node.op
        parts.push(' | ' + name + ' ' + op + ' ' + node.value)
      } else {
        parts.push(' | ' + name + (node.negated ? ' != ' : ' = ') + quote(node.value))
      }
    }
  }

  return { logql: parts.join(''), broad: labels.size === 0 }
}

/* ---------- client-side matching, for the live stream ---------- */

export interface Candidate {
  service: string
  env: string
  level: string
  msg: string
  dims: Record<string, string>
  meta: Record<string, unknown>
}

function fieldValue(c: Candidate, field: FieldName): string | undefined {
  const spec = FIELDS[field]
  if (spec.kind === 'label') {
    if (spec.label === 'service') return c.service
    if (spec.label === 'env') return c.env
    if (spec.label === 'level') return c.level
  }
  // `kind` lives on the entry itself rather than under a per-kind namespace. The
  // line body carries it (see the gateway's `line()`), so it is read from the top
  // of `meta` — the one field that is not inside `http` or `mcp`.
  if (spec.label === 'kind') {
    const k = (c.meta as { kind?: unknown }).kind
    return typeof k === 'string' ? k : undefined
  }
  const section = (name: 'http' | 'mcp'): Record<string, unknown> | undefined => {
    const v = (c.meta as Record<string, unknown>)[name]
    return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : undefined
  }
  // An entry has one or the other, never both, so the order between them is
  // arbitrary; dims still win, as they always did.
  const fromMeta = section('http')?.[spec.label] ?? section('mcp')?.[spec.label]
  const v = c.dims[spec.label] ?? fromMeta
  return v == null ? undefined : String(v)
}

/* The live view calls `matches` once per buffered row on every render, so a
 * per-row or per-node cost here is multiplied by thousands of rows and then by
 * the log arrival rate. Both expensive steps are therefore memoised:
 * stringifying and lower-casing a row's meta, and compiling a wildcard to a
 * RegExp. Measured on 2000 rows, this took one free-text term from 5.2ms per
 * render to 0.1ms. */

/** Lower-cased `msg + ' ' + JSON.stringify(meta)`, keyed on the meta object.
 *  `msg` is stored alongside and re-checked, so two rows that happen to share
 *  one meta object are still judged separately. A row whose meta is mutated
 *  after first use would be judged against its old text; rows are built once
 *  by `toRow` and never mutated. */
const haystacks = new WeakMap<object, { msg: string; hay: string }>()

function haystack(c: Candidate): string {
  const build = () => (c.msg + ' ' + JSON.stringify(c.meta)).toLowerCase()
  if (c.meta === null || typeof c.meta !== 'object') return build()
  const key = c.meta as object
  const hit = haystacks.get(key)
  if (hit !== undefined && hit.msg === c.msg) return hit.hay
  const hay = build()
  haystacks.set(key, { msg: c.msg, hay })
  return hay
}

/** Per-node derived values. Nodes come from `parse`, which the view memoises,
 *  so these survive for as long as the query text is unchanged. */
const nodeCache = new WeakMap<Node, { needle?: string; re?: RegExp }>()

function derived(node: Node): { needle?: string; re?: RegExp } {
  let d = nodeCache.get(node)
  if (d === undefined) {
    d = {}
    nodeCache.set(node, d)
  }
  return d
}

function matchNode(c: Candidate, node: Node): boolean {
  if (node.kind === 'text') {
    const d = derived(node)
    d.needle ??= node.value.toLowerCase()
    const hit = haystack(c).includes(d.needle)
    return node.negated ? !hit : hit
  }
  const actual = fieldValue(c, node.field)
  let hit: boolean
  if (actual == null) {
    hit = false
  } else if (node.op === '~' || node.value.includes('*')) {
    const d = derived(node)
    d.re ??= new RegExp(wildcardToRegex(node.value), 'i')
    hit = d.re.test(actual)
  } else if (FIELDS[node.field].numeric) {
    const a = Number(actual)
    const b = Number(node.value)
    hit =
      node.op === '>' ? a > b
      : node.op === '>=' ? a >= b
      : node.op === '<' ? a < b
      : node.op === '<=' ? a <= b
      : node.op === '!=' ? a !== b
      : a === b
  } else {
    hit = node.op === '!=' ? actual !== node.value : actual.toLowerCase() === node.value.toLowerCase()
  }
  return node.negated ? !hit : hit
}

export function matches(c: Candidate, query: Query): boolean {
  if (!query.or.length) return true
  return query.or.some((clause) => clause.and.every((node) => matchNode(c, node)))
}

/* ---------- autocomplete ---------- */

export interface Suggestion {
  insert: string
  label: string
  detail: string
}

export function suggest(input: string, caret: number, known: { services: string[]; envs: string[] }): Suggestion[] {
  const upto = input.slice(0, caret)
  const token = /[^\s]*$/.exec(upto)?.[0] ?? ''
  const colon = token.indexOf(':')

  if (colon === -1) {
    return FIELD_NAMES.filter((f) => f.startsWith(token.toLowerCase()))
      .slice(0, 8)
      .map((f) => ({ insert: f + ':', label: f + ':', detail: FIELDS[f].help }))
  }

  const field = token.slice(0, colon).toLowerCase()
  const partial = token.slice(colon + 1).toLowerCase()
  if (!(field in FIELDS)) return []

  const values: string[] =
    field === 'kind'
      ? [...KINDS]
      : field === 'level'
      ? ['debug', 'info', 'warn', 'error', 'fatal']
      : field === 'method'
        ? ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']
        : field === 'status'
          ? ['200', '201', '400', '401', '403', '404', '422', '>=400', '>=500']
          : field === 'duration'
            ? ['>100', '>500', '>1000', '>5000']
            : field === 'env' || field === 'environment'
              ? known.envs
              : field === 'app' || field === 'application' || field === 'service'
                ? known.services
                : []

  return values
    .filter((v) => v.toLowerCase().startsWith(partial))
    .slice(0, 8)
    .map((v) => ({ insert: field + ':' + v, label: v, detail: field }))
}
