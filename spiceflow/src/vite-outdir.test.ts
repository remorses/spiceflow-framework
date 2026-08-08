import { realpathSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'
import {
  resolveConfig,
  type Plugin,
  type PluginOption,
  type ResolvedConfig,
  type UserConfig,
} from 'vite'

import spiceflow from './vite.js'

const tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

async function createTempApp() {
  const rawRoot = await mkdtemp(path.join(tmpdir(), 'spiceflow-vite-outdir-'))
  const root = realpathSync(rawRoot)
  tempRoots.push(root)
  await mkdir(path.join(root, 'src'), { recursive: true })
  await writeFile(
    path.join(root, 'src/main.tsx'),
    [
      `import { Spiceflow } from 'spiceflow'`,
      `export const app = new Spiceflow()`,
      `  .layout('/*', async ({ children }) => (`,
      `    <html><body>{children}</body></html>`,
      `  ))`,
      `  .page('/', async () => <div>ok</div>)`,
      '',
    ].join('\n'),
  )
  return root
}

async function resolveSpiceflowConfig(options?: {
  cloudflare?: boolean
  userConfig?: UserConfig
}) {
  const root = await createTempApp()
  const plugins: PluginOption[] = [spiceflow({ entry: './src/main.tsx' })]

  if (options?.cloudflare) {
    plugins.unshift({ name: 'vite-plugin-cloudflare' })
  }

  const config = await resolveConfig(
    {
      ...options?.userConfig,
      root,
      build: { ...options?.userConfig?.build, outDir: '.custom-build' },
      plugins: [...(options?.userConfig?.plugins ?? []), ...plugins],
    },
    'build',
    'production',
  )

  return { root, config }
}

function getOptimizeDepsKeepNames(
  config: ResolvedConfig,
  name: 'client' | 'rsc' | 'ssr',
) {
  return config.environments[name].optimizeDeps.rolldownOptions?.output
    ?.keepNames
}

describe('spiceflow outDir normalization', () => {
  test('top-level build.outDir becomes the single source of truth', async () => {
    const { root, config } = await resolveSpiceflowConfig()

    expect(path.resolve(root, config.build.outDir)).toBe(
      path.resolve(root, '.custom-build'),
    )
    expect(config.environments.client.build.outDir).toBe(
      path.resolve(root, '.custom-build/client'),
    )
    expect(config.environments.rsc.build.outDir).toBe(
      path.resolve(root, '.custom-build/rsc'),
    )
    expect(config.environments.ssr.build.outDir).toBe(
      path.resolve(root, '.custom-build/ssr'),
    )
  })

  test('cloudflare keeps ssr nested under the rsc worker root', async () => {
    const { root, config } = await resolveSpiceflowConfig({ cloudflare: true })

    expect(path.resolve(root, config.build.outDir)).toBe(
      path.resolve(root, '.custom-build'),
    )
    expect(config.environments.client.build.outDir).toBe(
      path.resolve(root, '.custom-build/client'),
    )
    expect(config.environments.rsc.build.outDir).toBe(
      path.resolve(root, '.custom-build/rsc'),
    )
    expect(config.environments.ssr.build.outDir).toBe(
      path.resolve(root, '.custom-build/rsc/ssr'),
    )
  })

  test('cloudflare outDir override wins even when cloudflare plugin sets ssr outDir first', async () => {
    // Simulates the real @cloudflare/vite-plugin behavior: it registers before
    // spiceflow and unconditionally sets ssr.build.outDir to a sibling path.
    // spiceflow's enforce:'post' config hook must override it to the nested path.
    const root = await createTempApp()
    const cloudflarePlugin = {
      name: 'vite-plugin-cloudflare',
      config() {
        return {
          environments: {
            ssr: {
              build: {
                outDir: '.custom-build/ssr',
              },
            },
          },
        }
      },
    }
    const config = await resolveConfig(
      {
        root,
        build: { outDir: '.custom-build' },
        plugins: [cloudflarePlugin, spiceflow({ entry: './src/main.tsx' })],
      },
      'build',
      'production',
    )

    expect(config.environments.ssr.build.outDir).toBe(
      path.resolve(root, '.custom-build/rsc/ssr'),
    )
  })
  test('server environments normalize to js entry filenames', async () => {
    const { config } = await resolveSpiceflowConfig()

    expect(config.plugins.some((plugin) => plugin.name === 'spiceflow:output-module-package')).toBe(
      true,
    )
    expect(config.environments.rsc.build.rollupOptions.output).toMatchObject({
      entryFileNames: '[name].js',
    })
    expect(config.environments.ssr.build.rollupOptions.output).toMatchObject({
      entryFileNames: '[name].js',
    })
  })

  test('all environments enable holdUntilCrawlEnd', async () => {
    const { config } = await resolveSpiceflowConfig()

    expect(config.environments.client.optimizeDeps.holdUntilCrawlEnd).toBe(true)
    expect(config.environments.rsc.optimizeDeps.holdUntilCrawlEnd).toBe(true)
    expect(config.environments.ssr.optimizeDeps.holdUntilCrawlEnd).toBe(true)
  })

  test('server environments opt into dep discovery', async () => {
    const { config } = await resolveSpiceflowConfig()

    expect(config.environments.client.optimizeDeps.noDiscovery).toBe(false)
    expect(config.environments.rsc.optimizeDeps.noDiscovery).toBe(false)
    expect(config.environments.ssr.optimizeDeps.noDiscovery).toBe(false)
  })

  test('all environments get optimizeDeps entries for the app entry', async () => {
    const { config } = await resolveSpiceflowConfig()

    expect(config.environments.client.optimizeDeps.entries).toContain(
      './src/main.{js,jsx,ts,tsx,mjs,mts,cjs,cts}',
    )
    expect(config.environments.rsc.optimizeDeps.entries).toContain(
      './src/main.{js,jsx,ts,tsx,mjs,mts,cjs,cts}',
    )
    expect(config.environments.ssr.optimizeDeps.entries).toContain(
      './src/main.{js,jsx,ts,tsx,mjs,mts,cjs,cts}',
    )
  })

  test('preserves function names by default', async () => {
    const { config } = await resolveSpiceflowConfig()

    expect(config.build.rollupOptions.output).toMatchObject({
      keepNames: true,
    })
    expect(getOptimizeDepsKeepNames(config, 'client')).toBe(true)
    expect(getOptimizeDepsKeepNames(config, 'rsc')).toBe(true)
    expect(getOptimizeDepsKeepNames(config, 'ssr')).toBe(true)
  })

  test('preserves output arrays without duplicating entries', async () => {
    const { config } = await resolveSpiceflowConfig({
      userConfig: {
        build: {
          rollupOptions: {
            output: [{ format: 'es', entryFileNames: 'one.js' }],
          },
        },
      },
    })

    expect(config.build.rollupOptions.output).toMatchInlineSnapshot(`
      [
        {
          "entryFileNames": "one.js",
          "format": "es",
          "keepNames": true,
        },
      ]
    `)
  })

  test('does not override explicit keepNames config', async () => {
    const { config } = await resolveSpiceflowConfig({
      userConfig: {
        build: {
          rollupOptions: { output: { keepNames: false } },
        },
        environments: {
          rsc: {
            optimizeDeps: {
              rolldownOptions: { output: { keepNames: false } },
            },
          },
        },
        optimizeDeps: {
          rolldownOptions: { output: { keepNames: false } },
        },
      },
    })

    expect(config.build.rollupOptions.output).toMatchObject({
      keepNames: false,
    })
    expect(getOptimizeDepsKeepNames(config, 'client')).toBe(false)
    expect(getOptimizeDepsKeepNames(config, 'rsc')).toBe(false)
    expect(getOptimizeDepsKeepNames(config, 'ssr')).toBe(true)
  })
})

describe('spiceflow:rewrite-loadcss-entry', () => {
  // Must match the real load-global-css.rsc.ts code shape
  const loadCssSource = `import.meta.viteRsc.loadCss('virtual:app-entry')`

  function findRewritePlugin(config: ResolvedConfig): Plugin {
    const plugin = config.plugins.find(
      (p) => p.name === 'spiceflow:rewrite-loadcss-entry',
    )
    if (!plugin) throw new Error('rewrite-loadcss-entry plugin not found')
    return plugin
  }

  test('replaces virtual:app-entry with the resolved virtual entry, stripping \\0 prefix', async () => {
    const root = await createTempApp()

    // Simulates an external plugin (like holocron) registering a virtual module
    // as the app entry. Vite resolves virtual modules to \0-prefixed IDs.
    const virtualEntryPlugin = {
      name: 'test-virtual-entry',
      resolveId(id: string) {
        if (id === 'virtual:my-test-entry') return '\0virtual:my-test-entry'
      },
      load(id: string) {
        if (id === '\0virtual:my-test-entry') {
          return `import { Spiceflow } from 'spiceflow'\nexport const app = new Spiceflow()`
        }
      },
    }

    const config = await resolveConfig(
      {
        root,
        plugins: [virtualEntryPlugin, spiceflow({ entry: 'virtual:my-test-entry' })],
      },
      'build',
      'production',
    )

    const plugin = findRewritePlugin(config)
    const transform = (plugin.transform as Function).bind({
      // Mock the PluginContext.resolve — Vite resolves virtual modules to \0-prefixed IDs
      resolve: async (id: string) => {
        if (id === 'virtual:my-test-entry') {
          return { id: '\0virtual:my-test-entry' }
        }
        return null
      },
    })

    const fakeId = path.join(root, 'node_modules/spiceflow/src/load-global-css.rsc.ts')
    const result = await transform(loadCssSource, fakeId)

    // The rewrite must strip the \0 prefix — downstream this.resolve('\0...')
    // fails because Vite treats \0-prefixed IDs as already-resolved and won't
    // re-resolve them, breaking CSS collection entirely.
    expect(result).not.toContain('\0')
    expect(result).toContain("loadCss('virtual:my-test-entry')")
  })

  test('leaves non-virtual file entries unchanged (no \\0 in resolved path)', async () => {
    const root = await createTempApp()

    const config = await resolveConfig(
      {
        root,
        plugins: [spiceflow({ entry: './src/main.tsx' })],
      },
      'build',
      'production',
    )

    const plugin = findRewritePlugin(config)
    const absoluteEntry = path.resolve(root, 'src/main.tsx')
    const transform = (plugin.transform as Function).bind({
      resolve: async (id: string) => {
        if (id === './src/main.tsx') {
          return { id: absoluteEntry }
        }
        return null
      },
    })

    const fakeId = path.join(root, 'node_modules/spiceflow/src/load-global-css.rsc.ts')
    const result = await transform(loadCssSource, fakeId)

    // For real file entries, resolved.id is an absolute path without \0.
    expect(result).not.toContain('\0')
    expect(result).not.toContain('virtual:app-entry')
    expect(result).toContain(absoluteEntry)
  })
})
