import { readFileSync } from 'node:fs'
import path from 'node:path'

// Single source of truth for the console's version: the package manifest that
// gets bumped for a release. The status bar used to carry a hardcoded literal,
// which meant it reported the same number no matter what was deployed.
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

/** @type {import('next').NextConfig} */
export default {
  // The SQLite store is read directly by server components; keep it external to the bundle.
  serverExternalPackages: ['node:sqlite'],

  // Inlined at build time, so the running console can be identified from the UI.
  env: { NEXT_PUBLIC_APP_VERSION: pkg.version },

  // Emit a self-contained server with only the dependencies Next traced as
  // reachable. Without this the runtime image has to carry the whole install —
  // TypeScript, the build toolchain, every @types package — because there is no
  // way to tell which of it `next start` actually needs.
  output: 'standalone',

  // Tracing has to start at the monorepo root, not apps/web: the app imports
  // @logguber/shared, which lives outside its own directory. Without this the
  // traced output omits it and the server fails to start.
  outputFileTracingRoot: path.join(import.meta.dirname, '../..'),
}
