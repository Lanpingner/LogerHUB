import fs from 'node:fs'
import path from 'node:path'

/**
 * Development installs with pnpm; the Docker images install with npm. Two package
 * managers means two lockfiles, and two lockfiles can resolve the same range to
 * different versions — so the image would run code that was never tested here.
 * That is the one real hazard of the split, and it is only safe because it cannot
 * happen quietly: this test fails when they disagree.
 *
 * `npm ci` already refuses a package-lock.json that does not match package.json,
 * so manifest drift is caught by the build itself. What it cannot see is the two
 * lockfiles pinning different versions of the same dependency. That is this test.
 *
 * When it fails, regenerate the npm lockfile from the manifests alone (npm chokes
 * on pnpm's node_modules layout, so copy the package.json files to an empty
 * directory first and run `npm install --package-lock-only` there).
 */
const root = path.resolve(import.meta.dirname, '../../..')

/**
 * Every version of every package, by name. A set, not a single version: a
 * workspace can legitimately hold two majors of the same package — this repo
 * tests against both Express 4 and 5 — and calling that drift would make the
 * check cry wolf until someone switched it off.
 */
function pnpmVersions(): Map<string, Set<string>> {
  const text = fs.readFileSync(path.join(root, 'pnpm-lock.yaml'), 'utf8')
  const lines = text.split('\n')
  const start = lines.findIndex((l) => l === 'packages:')
  expect(start).toBeGreaterThan(-1)

  const out = new Map<string, Set<string>>()
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]
    // The block ends at the next top-level key.
    if (line !== '' && !line.startsWith(' ')) break
    // Entries look like:  '@babel/code-frame@7.29.7':  or  ws@8.23.0:
    const m = /^ {2}'?((?:@[^/]+\/)?[^@'\s]+)@([^'(\s]+)'?(?:\([^)]*\))*:$/.exec(line)
    if (!m) continue
    const [, name, version] = m
    const seen = out.get(name) ?? new Set<string>()
    seen.add(version)
    out.set(name, seen)
  }
  return out
}

/** The same, from the npm lockfile, skipping workspace links. */
function npmVersions(): Map<string, Set<string>> {
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8')) as {
    packages: Record<string, { version?: string; link?: boolean }>
  }
  const out = new Map<string, Set<string>>()
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (key === '' || entry.link === true || entry.version === undefined) continue
    const cut = key.lastIndexOf('node_modules/')
    if (cut === -1) continue
    const name = key.slice(cut + 'node_modules/'.length)
    const seen = out.get(name) ?? new Set<string>()
    seen.add(entry.version)
    out.set(name, seen)
  }
  return out
}

test('both lockfiles exist, so the image and the tests install the same thing', () => {
  expect(fs.existsSync(path.join(root, 'pnpm-lock.yaml'))).toBe(true)
  expect(fs.existsSync(path.join(root, 'package-lock.json'))).toBe(true)
})

test('the manifests use a range both package managers accept', () => {
  // npm rejects `workspace:*` outright (EUNSUPPORTEDPROTOCOL), and pnpm only
  // resolves a plain `*` to the local package because pnpm-workspace.yaml sets
  // linkWorkspacePackages. Both halves of that have to stay true.
  const manifests = ['apps/ingest/package.json', 'apps/web/package.json', 'packages/client/package.json']
  for (const m of manifests) {
    const text = fs.readFileSync(path.join(root, m), 'utf8')
    expect(text, `${m} uses workspace:*, which npm cannot parse`).not.toContain('workspace:')
  }
  const ws = fs.readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8')
  expect(ws, 'pnpm would fetch workspace siblings from the registry without this').toContain(
    'linkWorkspacePackages: true',
  )
  const rootPkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
    workspaces?: string[]
  }
  expect(rootPkg.workspaces, 'npm needs the workspace layout here; pnpm reads the yaml').toEqual([
    'packages/*',
    'apps/*',
  ])
})

test('the two lockfiles resolve every shared dependency to the same version', () => {
  const pnpm = pnpmVersions()
  const npm = npmVersions()
  // A sanity floor: if the parse silently returned nothing, the comparison below
  // would pass while checking nothing at all.
  expect(pnpm.size).toBeGreaterThan(100)
  expect(npm.size).toBeGreaterThan(100)

  // Drift is npm resolving a version pnpm has nowhere: then the image runs code
  // no test here ever loaded. Overlapping sets are fine.
  const disagreements: string[] = []
  for (const [name, versions] of npm) {
    const mine = pnpm.get(name)
    if (mine === undefined) continue // a dev-only tool one side does not need
    const unseen = [...versions].filter((v) => !mine.has(v))
    if (unseen.length > 0 && unseen.length === versions.size) {
      disagreements.push(`${name}: npm has ${[...versions].join(', ')}, pnpm has ${[...mine].join(', ')}`)
    }
  }
  expect(
    disagreements,
    'The Docker images would run different versions than these tests do. Regenerate ' +
      'package-lock.json from the manifests (see the note at the top of this file).',
  ).toEqual([])
})

test('the runtime dependencies the images install are pinned the same way', () => {
  // The ones that actually ship: everything else is a build-time tool whose drift
  // cannot reach production.
  const pnpm = pnpmVersions()
  const npm = npmVersions()
  for (const name of ['ws', 'next', 'react', 'react-dom', 'monaco-editor']) {
    const a = npm.get(name)
    const b = pnpm.get(name)
    expect(a, `${name} is missing from package-lock.json`).toBeDefined()
    expect(b, `${name} is missing from pnpm-lock.yaml`).toBeDefined()
    expect([...a!].sort(), `${name} differs between the lockfiles`).toEqual([...b!].sort())
  }
})
