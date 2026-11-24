import { scryptSync, randomBytes, randomUUID } from 'node:crypto'
import { openStore } from './store.ts'
import { mintKey } from './auth.ts'

const DB_FILE = process.env.LOGGUBER_DB ?? './data/logguber.db'
const store = openStore(DB_FILE)

function hashPassword(pw: string): string {
  const salt = randomBytes(16).toString('hex')
  return 'scrypt$' + salt + '$' + scryptSync(pw, salt, 64).toString('hex')
}

const [cmd, ...args] = process.argv.slice(2)

if (cmd === 'operator') {
  const [email, password] = args
  if (!email || !password) {
    console.error('usage: seed operator <email> <password>')
    process.exit(1)
  }
  if (store.operatorByEmail(email)) {
    console.error('operator ' + email + ' already exists')
    process.exit(1)
  }
  store.insertOperator(randomUUID(), email, hashPassword(password))
  console.log('operator created: ' + email)
} else if (cmd === 'key') {
  const [name, services, envs] = args
  if (!name || !services) {
    console.error('usage: seed key <name> <service[,service]> [env[,env]]')
    process.exit(1)
  }
  const k = mintKey()
  store.insertKey({
    id: randomUUID(),
    name,
    key_id: k.keyId,
    secret_hash: k.hash,
    service_scope: services.split(',').map((s) => s.trim()).filter(Boolean),
    env_scope: envs ? envs.split(',').map((s) => s.trim()).filter(Boolean) : null,
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
