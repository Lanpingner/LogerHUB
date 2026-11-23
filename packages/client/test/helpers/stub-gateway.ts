import type { IncomingMessage } from 'node:http'
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
}

export interface StubGateway {
  url: string
  batches: BatchFrame[]
  conns: StubConn[]
  /** Change (or clear) the reject code for connections accepted from now on. */
  rejectWith(code: number | undefined): void
  /** Final teardown. */
  close(): Promise<void>
  /** Kill the server and every connection, keeping the port for `start()`. */
  stop(): Promise<void>
  start(): Promise<void>
}

export async function createStubGateway(opts: StubGatewayOptions = {}): Promise<StubGateway> {
  const batches: BatchFrame[] = []
  const conns: StubConn[] = []
  let reject = opts.rejectWith
  let wss: WebSocketServer | undefined
  let port = 0

  const listen = (): Promise<void> =>
    new Promise((resolve, reject_) => {
      const s = new WebSocketServer({ host: '127.0.0.1', port })
      s.once('error', reject_)
      s.once('listening', () => {
        port = (s.address() as AddressInfo).port
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
        conn.send({ ...HELLO_DEFAULTS, ...opts.hello, t: 'hello' })
        ws.on('message', (raw) => {
          const frame = JSON.parse(raw.toString()) as BatchFrame
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
      s.close(() => resolve())
    })

  await listen()
  return {
    url: `ws://127.0.0.1:${port}`,
    batches,
    conns,
    rejectWith: (code) => { reject = code },
    stop: halt,
    start: async () => { if (!wss) await listen() },
    close: halt,
  }
}
