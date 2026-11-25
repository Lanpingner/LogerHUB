// Builds dist/index.d.ts as ONE self-contained file, used by both the `import` and `require`
// conditions. tsc cannot bundle, and the declarations it emits per file would import
// `@logguber/shared` (inlined into the JS, so not a dependency) and extensionless relative paths.
// The public surface is small: the option types, createLogger, createSink, and two wire types.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'

const tmp = 'dist/.dts'
fs.rmSync(tmp, { recursive: true, force: true })
execFileSync('tsc', ['-p', 'tsconfig.build.json', '--outDir', tmp], { stdio: 'inherit' })

// Whatever types.ts imports from shared is assembled below instead, so the import goes.
const types = fs.readFileSync(`${tmp}/types.d.ts`, 'utf8').replace(/^import type \{[^}]*\} from '@logguber\/shared';\n/m, '')
const wire = fs.readFileSync(`${tmp}/../../../shared/src/protocol.ts`, 'utf8')
/** `export const X = ['a', 'b'] as const` -> `export type Y = 'a' | 'b'`. */
const union = (constName, typeName) => {
  const raw = wire.match(new RegExp(`^export const ${constName} = \\[(.*?)\\] as const$`, 'm'))?.[1]
  if (!raw) return undefined
  return `export type ${typeName} = ${raw.split(',').map((l) => l.trim()).filter((l) => l !== '').join(' | ')}`
}
const level = union('LEVELS', 'Level')
const kind = union('KINDS', 'Kind')
const entry = wire.match(/^export interface LogEntry \{[\s\S]*?^\}$/m)?.[0]
if (!level || !kind || !entry) throw new Error('could not find LEVELS/KINDS/LogEntry in shared/src/protocol.ts')
const fn = (name) => {
  const file = `${tmp}/${name}.d.ts`
  const fnName = name === 'logger' ? 'createLogger' : 'createSink'
  const m = fs.readFileSync(file, 'utf8').match(new RegExp(`^export declare function ${fnName}\\(.*$`, 'm'))
  if (!m) throw new Error(`could not find a single-line "export declare function ${fnName}(" in ${file}`)
  return m[0]
}

const out = [
  types.trimEnd(),
  '',
  '// Wire types, copied from @logguber/shared (which is bundled into the JavaScript).',
  level,
  kind,
  entry,
  '',
  fn('logger'),
  fn('sink'),
  '',
].join('\n')
// LogEntry is copied verbatim, so every type it names must be defined in what we assemble.
const BUILTIN = new Set(['Record', 'Array', 'Partial', 'Readonly', 'Promise', 'Date'])
for (const id of new Set(entry.match(/\b[A-Z]\w*/g) ?? [])) {
  if (BUILTIN.has(id) || id === 'LogEntry') continue
  if (!new RegExp(`(interface|type|class|enum) ${id}\\b`).test(out)) {
    throw new Error(`LogEntry in shared/src/protocol.ts references "${id}", which dist/index.d.ts does not define; extend scripts/build-dts.mjs`)
  }
}
fs.rmSync(tmp, { recursive: true, force: true })
for (const f of fs.readdirSync('dist')) if (f.endsWith('.d.ts')) fs.rmSync(`dist/${f}`)
fs.writeFileSync('dist/index.d.ts', out)
fs.copyFileSync('dist/index.d.ts', 'dist/index.d.mts')
