import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocketServer, type WebSocket } from 'ws'
import { HELLO_DEFAULTS, type BatchFrame, type HelloFrame, type ServerFrame } from '@logguber/shared'

export interface StubConn {
  /** The upgrade request: url and headers, for handshake assertions. */
  request: Pick<IncomingMessage, 'url' | 'headers'>
  closed: boolean
  send(frame: ServerFrame): void
  sendRaw(data: string): void
  closeWith(code: number): void
}

export interface StubGatewayOptions {
  /** Called for every received batch. When omitted the stub acks everything. */
  onBatch?: (b: BatchFrame, c: StubConn) => void
  hello?: Partial<HelloFrame>
  /** Close every new connection with this code immediately after upgrade. */
  rejectWith?: number
  /** Refuse the HTTP upgrade itself with this status (e.g. 401). */
  refuseUpgradeWith?: number
  /** Accept connections but never send `hello`. */
  withholdHello?: boolean
}

export interface StubGateway {
  url: string
  batches: BatchFrame[]
  conns: StubConn[]
  /** Change (or clear) the reject code for connections accepted from now on. */
  rejectWith(code: number | undefined): void
  /** Raw frames a client sent that were not valid JSON, for tests that send garbage. */
  garbage: string[]
  /** Final teardown. */
  close(): Promise<void>
  /** Kill the server and every connection, keeping the port for `start()`. */
  stop(): Promise<void>
  start(): Promise<void>
}

export async function createStubGateway(opts: StubGatewayOptions = {}): Promise<StubGateway> {
  const batches: BatchFrame[] = []
  const conns: StubConn[] = []
  const garbage: string[] = []
  let reject = opts.rejectWith
  let wss: WebSocketServer | undefined
  let closed = false
  let httpServer: ReturnType<typeof createServer> | undefined
  const open = new Set<import('node:net').Socket>()
  let port = 0

  const listen = (): Promise<void> =>
    new Promise((resolve, reject_) => {
      const http = createServer()
      httpServer = http
      const s = new WebSocketServer({
        server: http,
        verifyClient: opts.refuseUpgradeWith
          ? (_info, cb) => cb(false, opts.refuseUpgradeWith, 'refused')
          : undefined,
      })
      http.on('connection', (sock) => {
        open.add(sock)
        sock.once('close', () => open.delete(sock))
      })
      http.once('error', (e) => {
        http.close() // do not leave a half-created server behind
        reject_(e)
      })
      http.listen(port, '127.0.0.1', () => {
        port = (http.address() as AddressInfo).port
        wss = s
        resolve()
      })
      s.on('connection', (ws: WebSocket, req: IncomingMessage) => {
        const conn: StubConn = {
          request: { url: req.url, headers: req.headers },
          closed: false,
          send: (f) => ws.send(JSON.stringify(f)),
          sendRaw: (d) => ws.send(d),
          closeWith: (code) => ws.close(code),
        }
        ws.on('close', () => { conn.closed = true })
        ws.on('error', () => {})
        conns.push(conn)
        if (reject !== undefined) {
          ws.close(reject)
          return
        }
        if (!opts.withholdHello) conn.send({ ...HELLO_DEFAULTS, ...opts.hello, t: 'hello' })
        ws.on('message', (raw) => {
          let frame: BatchFrame
          try {
            frame = JSON.parse(raw.toString()) as BatchFrame
          } catch {
            garbage.push(raw.toString())
            return
          }
          if (frame.t !== 'batch') return
          batches.push(frame)
          if (opts.onBatch) opts.onBatch(frame, conn)
          else conn.send({ t: 'ack', id: frame.id })
        })
      })
    })

  const halt = (): Promise<void> =>
    new Promise((resolve) => {
      const s = wss
      wss = undefined
      if (!s) return resolve()
      for (const c of s.clients) c.terminate()
      for (const sock of open) sock.destroy() // connections still mid-handshake
      s.close()
      // WebSocketServer.close leaves an externally supplied http server running.
      const h = httpServer
      httpServer = undefined
      if (h) h.close(() => resolve())
      else resolve()
    })

  await listen()
  return {
    url: `ws://127.0.0.1:${port}`,
    batches,
    conns,
    rejectWith: (code) => { reject = code },
    garbage,
    stop: halt,
    start: async () => {
      if (closed) throw new Error('stub gateway was closed; create a new one')
      if (!wss) await listen()
    },
    close: async () => {
      closed = true
      await halt()
    },
  }
}
