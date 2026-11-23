import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  dts: false, // declarations come from tsc (see tsconfig.build.json); typescript 7 has no API for rollup-plugin-dts
  platform: 'node',
  target: 'node24',
  clean: true,
  sourcemap: true,
  // shared's package.json still points at unbuilt TypeScript, so it must be inlined.
  // ws is a real runtime dependency and stays external, as does node:sqlite (a built-in).
  noExternal: ['@logguber/shared'],
  external: ['ws'],
  // The package deliberately has no "type": "module": that keeps dist/index.js CommonJS and
  // dist/index.mjs ESM, with no extra package.json needed in dist.
  // tsup strips the `node:` prefix by default, which turns the prefix-only built-in
  // `node:sqlite` into the non-existent `sqlite`. Keep the specifier as written.
  removeNodeProtocol: false,
})
