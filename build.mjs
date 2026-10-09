import { build } from 'esbuild'
await build({ entryPoints: ['src/provider.mjs'], outfile: 'index.mjs', bundle: true, platform: 'node', target: 'node22', format: 'esm', external: ['electron'], legalComments: 'inline' })
