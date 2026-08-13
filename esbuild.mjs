import { build, context } from 'esbuild'

const watch = process.argv.includes('--watch')

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  // The extension host provides `vscode`; nothing else is external, and nothing
  // from dsh is bundled — the harness is always the user's own install.
  external: ['vscode'],
  sourcemap: true,
  minify: !watch,
  logLevel: 'info',
}

if (watch) {
  const ctx = await context(options)
  await ctx.watch()
} else {
  await build(options)
}
