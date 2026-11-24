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

/** -1, 0 or 1, comparing dotted numeric versions; prerelease tags sort low. */
function compare(a: string, b: string): number {
  const parts = (v: string): number[] => v.split('-')[0].split('.').map((n) => Number(n) || 0)
  const [x, y] = [parts(a), parts(b)]
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0)
    if (d !== 0) return d > 0 ? 1 : -1
  }
  return 0
}

const max = (versions: Set<string>): string => [...versions].sort(compare).at(-1)!

/**
 * How many packages npm may legitimately be ahead on. pnpm holds back recent
 * publishes, so a handful is normal; dozens means a manifest changed and only
 * one lockfile was regenerated, which is the mistake this file exists to catch.
 */
const COOLDOWN_ALLOWANCE = 25

test('neither lockfile is behind the other in a way that signals a missed relock', () => {
  const pnpm = pnpmVersions()
  const npm = npmVersions()
  // A sanity floor: if a parse silently returned nothing, the comparisons below
  // would pass while checking nothing at all.
  expect(pnpm.size).toBeGreaterThan(100)
  expect(npm.size).toBeGreaterThan(100)

  /** npm resolved something newer: expected, because pnpm holds back fresh publishes. */
  const npmAhead: string[] = []
  /** npm resolved something OLDER, or unrelated. The cooldown cannot explain that. */
  const unexplained: string[] = []

  for (const [name, versions] of npm) {
    const mine = pnpm.get(name)
    if (mine === undefined) continue // a tool only one side installs
    const overlap = [...versions].some((v) => mine.has(v))
    if (overlap) continue
    const line = `${name}: npm has ${[...versions].sort(compare).join(', ')}, pnpm has ${[...mine].sort(compare).join(', ')}`
    if (compare(max(versions), max(mine)) > 0) npmAhead.push(line)
    else unexplained.push(line)
  }

  // pnpm 11 refuses packages published in the last day or two as supply-chain
  // protection and npm has no equivalent, so npm being a patch ahead on a few
  // packages is the system working as configured, not a mistake. npm being
  // BEHIND cannot be explained that way: it means the lockfiles were generated
  // from different manifests.
  expect(unexplained, 'Run `node scripts/relock.mjs` — these cannot be explained by pnpm holding back recent releases').toEqual([])

  expect(
    npmAhead.length,
    `${npmAhead.length} packages differ, which is too many to be recent publishes. ` +
      'Run `node scripts/relock.mjs` to regenerate both lockfiles together.\n' +
      npmAhead.join('\n'),
  ).toBeLessThanOrEqual(COOLDOWN_ALLOWANCE)
})

test('the images never install a package OLDER than the one tested here', () => {
  // The direction that matters. Newer-by-a-patch is pnpm's cooldown; older means
  // the image is running something superseded, which no policy explains.
  const pnpm = pnpmVersions()
  const npm = npmVersions()
  const behind: string[] = []
  for (const name of ['ws', 'next', 'react', 'react-dom', 'monaco-editor', 'express']) {
    const a = npm.get(name)
    const b = pnpm.get(name)
    if (a === undefined || b === undefined) continue
    if (compare(max(a), max(b)) < 0) behind.push(`${name}: image has ${max(a)}, tests use ${max(b)}`)
  }
  expect(behind, 'Run `node scripts/relock.mjs`').toEqual([])
})
