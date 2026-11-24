// Runs from `prepublishOnly`, after the build. Every check here guards a way this
// package could be published broken, where the breakage only shows up in someone
// else's project — the one place we cannot fix it quickly.
//
// The central hazard: `@logguber/shared` is a workspace devDependency that tsup
// inlines into the bundle. Nothing consumers install provides it, so any surviving
// reference to it — in the JavaScript or in the type declarations — is a package
// that fails on `import`.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8')
const pkg = JSON.parse(read('package.json'))

const problems = []
const fail = (msg) => problems.push(msg)

// 1. The files the manifest promises must exist.
for (const f of ['dist/index.js', 'dist/index.mjs', 'dist/index.d.ts', 'dist/index.d.mts', 'README.md', 'LICENSE']) {
  if (!fs.existsSync(path.join(root, f))) fail(`missing ${f}`)
}

// 2. Nothing may reference the bundled workspace package at runtime or in types.
//    Comments are fine; an import or require is not.
const IMPORT_OF_WORKSPACE = /(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*)['"]@logguber\/[^'"]+['"]/
for (const f of ['dist/index.js', 'dist/index.mjs', 'dist/index.d.ts', 'dist/index.d.mts']) {
  if (!fs.existsSync(path.join(root, f))) continue
  const text = read(f)
  const m = IMPORT_OF_WORKSPACE.exec(text)
  if (m) {
    const line = text.slice(0, m.index).split('\n').length
    fail(`${f}:${line} imports ${m[0]}, which consumers do not have. It must be inlined by the build.`)
  }
}

// 3. A `workspace:` dependency cannot be resolved by anyone outside this repo.
//    devDependencies are not installed by consumers, so only real deps matter.
for (const [name, range] of Object.entries(pkg.dependencies ?? {})) {
  if (String(range).startsWith('workspace:')) fail(`dependencies.${name} is "${range}"; a published package cannot use the workspace protocol`)
  if (String(range).startsWith('file:')) fail(`dependencies.${name} is "${range}"; a published package cannot use a file path`)
}

// 4. Metadata npm either requires or that makes the package usable.
if (pkg.private === true) fail('"private": true would refuse the publish')
if (!pkg.license) fail('no license field')
if (!pkg.repository) fail('no repository field')
if (pkg.version === '0.0.0') fail('version is still 0.0.0')
// A scoped package defaults to restricted; without this the publish is rejected.
if (pkg.name.startsWith('@') && pkg.publishConfig?.access !== 'public') {
  fail('a scoped package needs "publishConfig": { "access": "public" } to publish publicly')
}

// 5. The declaration file is the package's documentation for typed consumers:
//    it must stand alone, needing nothing but Node's own types.
if (fs.existsSync(path.join(root, 'dist/index.d.ts'))) {
  const dts = read('dist/index.d.ts')
  for (const m of dts.matchAll(/from ['"]([^'"]+)['"]/g)) {
    if (!m[1].startsWith('node:')) fail(`dist/index.d.ts imports "${m[1]}"; declarations must depend only on node: builtins`)
  }
}

if (problems.length > 0) {
  console.error('This package is not ready to publish:\n')
  for (const p of problems) console.error('  - ' + p)
  console.error('')
  process.exit(1)
}
console.log(`${pkg.name}@${pkg.version} is ready to publish.`)
