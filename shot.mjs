// Screenshots the console's authenticated pages by driving Chrome over CDP.
import { spawn } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { createHmac } from 'node:crypto'

const PORT = 9333
const BASE = process.env.BASE ?? 'http://localhost:3002'
const SESSION_SECRET = process.env.SESSION_SECRET ?? 'local-session-secret-change-me'
const OUT = '/tmp/shots'
const pages = process.argv.slice(2)
if (!pages.length) pages.push('usage', '/', 'live', 'admin')

mkdirSync(OUT, { recursive: true })

const payload = Buffer.from(JSON.stringify({ email: 'admin@local', expires: Date.now() + 3600_000 })).toString('base64url')
const cookie = payload + '.' + createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url')

const chrome = spawn(
  'google-chrome-stable',
  [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--hide-scrollbars',
    '--force-color-profile=srgb',
    '--window-size=1440,1800',
    '--remote-debugging-port=' + PORT,
    // Node's built-in WebSocket always sends an Origin header, which Chrome's
    // CDP endpoint rejects unless the origin is explicitly allowed.
    '--remote-allow-origins=*',
    // Without this an extension's background page shows up in /json/list and
    // can be attached to instead of the real tab.
    '--disable-extensions',
    'about:blank',
  ],
  { stdio: ['ignore', 'ignore', 'pipe'] },
)
const cleanup = () => { try { chrome.kill('SIGKILL') } catch {} }
process.on('exit', cleanup)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let target
for (let i = 0; i < 60; i++) {
  await sleep(250)
  try {
    const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json()
    target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
    if (target) break
  } catch {}
}
if (!target) throw new Error('chrome did not expose a page target')
console.log('attached to ' + target.url)

// Node's built-in WebSocket, so this script needs no dependency.
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true })
  ws.addEventListener('error', reject, { once: true })
})

let nextId = 1
const pending = new Map()
const events = []
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data))
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)
  } else if (msg.method) {
    events.push(msg)
  }
})
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })

await send('Page.enable')
await send('Network.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', {
  width: 1440,
  height: 1800,
  deviceScaleFactor: 1,
  mobile: false,
})
await send('Network.setCookie', {
  name: 'logguber_session',
  value: cookie,
  domain: 'localhost',
  path: '/',
})

for (const page of pages) {
  const path = page.startsWith('/') ? page : '/' + page
  const name = path === '/' ? 'search' : path.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '')
  await send('Page.navigate', { url: BASE + path })
  await sleep(2600)
  // Let the live page accumulate a few lines before the shutter.
  if (path === '/live') await sleep(3500)
  const full = await send('Page.getLayoutMetrics')
  const h = Math.min(4200, Math.ceil(full.cssContentSize?.height ?? 1800))
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: h, deviceScaleFactor: 1, mobile: false })
  await sleep(500)
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
  writeFileSync(OUT + '/' + name + '.png', Buffer.from(shot.data, 'base64'))
  console.log('wrote ' + OUT + '/' + name + '.png  (' + 1440 + 'x' + h + ')')
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1800, deviceScaleFactor: 1, mobile: false })
}

ws.close()
cleanup()
process.exit(0)
