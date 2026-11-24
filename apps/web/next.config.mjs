/** @type {import('next').NextConfig} */
export default {
  // The SQLite store is read directly by server components; keep it external to the bundle.
  serverExternalPackages: ['node:sqlite'],
}
