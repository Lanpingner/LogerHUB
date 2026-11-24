import { randomUUID } from 'node:crypto'
import { openStore } from './store.ts'
import { mintKey } from './auth.ts'
import { hashPassword, MIN_PASSWORD_LENGTH } from '@logguber/shared/password'

const DB_FILE = process.env.LOGGUBER_DB ?? './data/logguber.db'
const store = openStore(DB_FILE)

/** Reads a password without putting it in argv, where any process on the host
 *  can read it from /proc, and where it lands in shell history. */
function readPassword(): Promise<string> {
  return new Promise((resolve, reject) => {
    process.stderr.write('Password: ')
    const stdin = process.stdin
    const tty = Boolean(stdin.isTTY)
    if (tty) stdin.setRawMode?.(true)
    stdin.resume()
    stdin.setEncoding('utf8')
    let value = ''
    const done = (err?: Error) => {
      if (tty) stdin.setRawMode?.(false)
      stdin.pause()
      process.stderr.write('\n')
      err ? reject(err) : resolve(value)
    }
    stdin.on('data', (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\n' || ch === '\r' || ch === '\u0004') return done()
        if (ch === '\u0003') return done(new Error('cancelled'))
        if (ch === '\u007f') value = value.slice(0, -1)
        else value += ch
      }
      if (!tty && !chunk.includes('\n')) return
    })
    stdin.on('end', () => done())
  })
}

const [cmd, ...args] = process.argv.slice(2)

if (cmd === 'operator') {
  const [email, argvPassword] = args
  if (!email) {
    console.error('usage: seed operator <email>   (the password is read from stdin)')
    process.exit(1)
  }
  if (argvPassword) {
    console.error('Refusing a password given on the command line: it is visible to every')
    console.error('process on this host and lands in your shell history.')
    console.error('Run: seed operator ' + email + '    and type it when prompted,')
    console.error('or:  printf %s "$PASSWORD" | seed operator ' + email)
    process.exit(1)
  }
  if (store.operatorByEmail(email)) {
    console.error('operator ' + email + ' already exists')
    process.exit(1)
  }
  const password = await readPassword()
  if (password.length < MIN_PASSWORD_LENGTH) {
    console.error('Password must be at least ' + MIN_PASSWORD_LENGTH + ' characters.')
    process.exit(1)
  }
  store.insertOperator(randomUUID(), email, hashPassword(password))
  console.log('operator created: ' + email)
} else if (cmd === 'key') {
  const [name, services, envs] = args
  if (!name || !services || !envs) {
    console.error('usage: seed key <name> <service[,service]> <env[,env]>')
    console.error('')
    console.error('Environments are required. A key with no environment scope may write any')
    console.error('environment name, and each distinct name becomes a Loki stream.')
    process.exit(1)
  }
  const k = mintKey()
  store.insertKey({
    id: randomUUID(),
    name,
    key_id: k.keyId,
    secret_hash: k.hash,
    service_scope: services.split(',').map((s) => s.trim()).filter(Boolean),
    env_scope: envs.split(',').map((s) => s.trim()).filter(Boolean),
    ip_allowlist: [],
  })
  console.log('key "' + name + '" created. This is the only time the secret is shown:')
  console.log('')
  console.log('  ' + k.full)
  console.log('')
} else if (cmd === 'list') {
  for (const k of store.listKeys()) {
    const envs = k.env_scope ? k.env_scope.join(',') : '*'
    const state = k.disabled_at ? ' [disabled]' : ''
    console.log(k.key_id + '  ' + k.name.padEnd(20) + ' services=' + k.service_scope.join(',') + ' envs=' + envs + state)
  }
} else {
  console.log('commands: operator <email> <password> | key <name> <services> [envs] | list')
}

store.close()
