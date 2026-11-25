/** Shared between the server query layer and the client console. */
export interface LogRow {
  id: string
  ts: number
  level: string
  application: string
  service: string
  env: string
  method?: string
  path?: string
  route?: string
  status?: number
  duration?: number
  company?: string
  user?: string
  apiKey?: string
  requestId?: string
  traceId?: string
  instance?: string
  /** The address the gateway saw the batch arrive from. Observed server-side,
   *  never sent by the client, so it is the one field a sender cannot shape. */
  sourceIp?: string
  msg: string
  payload: Record<string, unknown> | null
}

export interface Bucket {
  t: number
  total: number
  errors: number
}

export interface SearchResponse {
  rows: LogRow[]
  logql: string
  issues: { message: string }[]
  error?: string
  tookMs: number
  buckets: Bucket[]
}

export interface OverviewResponse {
  requests: number
  perSecond: number
  successRate: number
  clientErrorRate: number
  serverErrorRate: number
  lines: number
  errors: number
  bytes: number
  applications: number
  buckets: Bucket[]
  byApplication: { name: string; requests: number; errors: number }[]
  topClients: { name: string; requests: number; errors: number }[]
}
