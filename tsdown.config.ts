/**
 * Browser-half bundle (PANEL-DESIGN §3.6.3): one CJS factory `lib/client.js`
 * wrapped in `window.__ModuleLoader__.load({ id, factory })`, the shape the
 * official `clientBundle` preset emits (packages/client/tsdown.client.ts
 * clientConfig). The shell's shared modules stay `require(...)` calls; every
 * other import is inlined. The node half is built by tsc into the same `lib/`,
 * so `clean` stays off. No dynamic `import()` chunks: the async-chunk rewrite
 * lives only in the official preset.
 */
import { readFileSync } from 'node:fs'
import { defineConfig } from 'tsdown'

/** Mirror of the official PLATFORM_MODULES (packages/client/web/src/platform.ts:8-15); recheck on DSH upgrades. */
const SHARED = new Set([
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  'zod', '@tanstack/react-virtual',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
])

/** The host registers the factory under the package name. */
const ID = (JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { name: string }).name

export default defineConfig({
  entry: { client: 'src/client/index.ts' },
  tsconfig: 'tsconfig.client.json',
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2024',
  dts: false,
  sourcemap: false,
  clean: false,
  deps: {
    neverBundle: (specifier: string) => SHARED.has(specifier),
    alwaysBundle: (specifier: string) => !SHARED.has(specifier),
  },
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  outputOptions: {
    entryFileNames: 'client.js',
    chunkFileNames: 'client.[name].js',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    banner: chunk => `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, ${chunk.isEntry ? '' : `chunk: ${JSON.stringify(chunk.fileName)}, `}factory: (require) => {`,
    footer: 'return module.exports; } });',
  },
})
