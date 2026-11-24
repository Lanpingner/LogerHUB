// Regenerates BOTH lockfiles, back to back, from the same manifests.
//
// Development installs with pnpm; the Docker images install with npm. Two package
// managers means two lockfiles, and the hazard is that they resolve the same range
// to different versions — then the image runs code no test here ever loaded. That
// drifts most easily through *transitive* dependencies, which neither `pnpm update`
// nor editing a manifest will realign.
//
// Regenerating them in one go is what keeps them honest, because both resolve from
// the same registry state at the same moment. `pnpm test` fails if they disagree,
// so forgetting to run this is caught rather than shipped.
//
//   node scripts/relock.mjs
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, stdio: 'inherit', env: { ...process.env, NODE_OPTIONS: '--dns-result-order=ipv4first' } })

/** Every workspace manifest, found the way both package managers find them. */
function manifests() {
  const out = ['package.json']
  for (const dir of ['packages', 'apps']) {
    const base = path.join(root, dir)
    if (!fs.existsSync(base)) continue
    for (const name of fs.readdirSync(base)) {
      const rel = path.join(dir, name, 'package.json')
      if (fs.existsSync(path.join(root, rel))) out.push(rel)
    }
  }
  return out
}

console.log('1/2  pnpm-lock.yaml')
fs.rmSync(path.join(root, 'pnpm-lock.yaml'), { force: true })
run('pnpm', ['install', '--lockfile-only'], root)

console.log('\n2/2  package-lock.json')
// npm cannot walk pnpm's node_modules layout — it crashes on the .pnpm directory —
// so it resolves in a scratch copy holding nothing but the manifests.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'relock-'))
try {
  for (const rel of manifests()) {
    const dest = path.join(scratch, rel)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.copyFileSync(path.join(root, rel), dest)
  }
  run('npm', ['install', '--package-lock-only', '--ignore-scripts'], scratch)
  fs.copyFileSync(path.join(scratch, 'package-lock.json'), path.join(root, 'package-lock.json'))
} finally {
  fs.rmSync(scratch, { recursive: true, force: true })
}

console.log('\nBoth lockfiles regenerated. Run `pnpm test` to confirm they agree.')
