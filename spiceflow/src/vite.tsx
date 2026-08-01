// Spiceflow Vite plugin: integrates @vitejs/plugin-rsc for RSC support,
// provides SSR middleware, virtual modules, and prerender support.
import dns from 'node:dns'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import url from 'node:url'

// Keep localhost resolving to 127.0.0.1 (IPv4) instead of ::1 (IPv6).
// Node 17+ reorders DNS results and may prefer IPv6, which causes two Vite
// servers to silently share the same port on different IP families. Setting
// verbatim prevents reordering so localhost stays on IPv4, while Vite still
// prints "localhost" in the terminal URL instead of "127.0.0.1".
dns.setDefaultResultOrder('verbatim')

import rsc, { RscPluginOptions } from '@vitejs/plugin-rsc'
import type { RolldownOutput, RolldownWatcher } from 'rolldown'
import {
  build as viteBuild,
  esmExternalRequirePlugin,
  type MinimalPluginContextWithoutEnvironment,
  type Plugin,
  type ResolvedConfig,
  type UserConfig,
  type ViteDevServer,
} from 'vite'
import { prerenderPlugin } from './react/prerender.js'
import { serverFileGuardPlugin } from './server-file-guard.js'
import { logger } from './logger.js'
import { traceAndCopyDependencies, type NftOptions } from './trace-dependencies.js'
import { federationDevExternalizePlugin } from './federation-dev-externalize.js'
import { vercelPlugin } from './vercel.js'

const require = createRequire(import.meta.url)
const pluginRscRpcPath = require.resolve('@vitejs/plugin-rsc/utils/rpc')

// Self-resolve entry paths from spiceflow's own location so they work even
// when spiceflow is a transitive dependency (e.g. installed inside a wrapper
// plugin's node_modules and not directly accessible from the consumer's root).
const __spiceflowDir = path.dirname(url.fileURLToPath(import.meta.url))
const spiceflowEntries = {
  rsc: path.resolve(__spiceflowDir, 'react/entry.rsc'),
  ssr: path.resolve(__spiceflowDir, 'react/entry.ssr'),
  client: path.resolve(__spiceflowDir, 'react/entry.client'),
}

// Packages that must resolve to a single copy across all environments.
// The resolveId hook in spiceflow:dedupe-singleton re-resolves these from
// spiceflow's own directory so pnpm transitive deps don't create duplicates.
const dedupePackages = new Set([
  'spiceflow',
  'react',
  'react-dom',
])

// Fake importer path anchored inside spiceflow's own directory. When
// this.resolve() starts resolution from here, it finds the same physical
// copy of react/react-dom that spiceflow itself uses (peer deps resolve
// upward from spiceflow's node_modules to the consumer's).
const dedupeImporter = path.join(__spiceflowDir, '_dedupe_importer_.js')

// Per production build id. Regenerated on each `vite build` (buildStart) so
// two builds in the same Node process get different ids. Shared across the
// RSC/SSR/client environments of a single build via this module scope.
let buildDeploymentId = createBuildDeploymentId()
let mintedDeploymentIdForCurrentBuild = false

function createBuildDeploymentId(): string {
  // timestamp + entropy: unique across rapid rebuilds in one process
  return `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`
}

// For absolute URL bases (e.g. federation remotes using
// `base: 'https://remote.example.com/app/'`), extract just the pathname
// so route matching and serveStatic work correctly. Asset URLs already
// include the full origin via Vite's built-in base handling.
function extractBasePathname(base: string): string {
  if (base.startsWith('http://') || base.startsWith('https://')) {
    const pathname = new URL(base).pathname.replace(/\/$/, '')
    return pathname || ''
  }
  return base === '/' ? '' : base.replace(/\/$/, '')
}

type BuildOutDirConfig = Pick<ResolvedConfig, 'root' | 'build'>
type OutputKeepNamesConfig = { keepNames?: boolean }

function resolveBuildOutDir(config: BuildOutDirConfig) {
  return path.isAbsolute(config.build.outDir)
    ? config.build.outDir
    : path.resolve(config.root, config.build.outDir)
}

function defaultOutputKeepNames<T extends OutputKeepNamesConfig>(output?: T) {
  if (output?.keepNames !== undefined) return output
  return { ...(output ?? ({} as T)), keepNames: true }
}

function defaultOutputKeepNamesOption<T extends OutputKeepNamesConfig>(
  output?: T | T[],
) {
  if (Array.isArray(output)) return output.map(defaultOutputKeepNames)
  return defaultOutputKeepNames(output)
}

function setDefaultOutputKeepNames<T extends OutputKeepNamesConfig>(output: T) {
  if (output.keepNames !== undefined) return
  output.keepNames = true
}

function normalizeEnvironmentOutDirs(userConfig: UserConfig): UserConfig {
  const isCloudflare = hasPluginNamed(
    userConfig.plugins,
    'vite-plugin-cloudflare',
  )
  const rootOutDir = userConfig.build?.outDir ?? 'dist'
  const clientOutDir = path.join(rootOutDir, 'client')
  const rscOutDir = path.join(rootOutDir, 'rsc')
  const ssrOutDir = isCloudflare
    ? path.join(rootOutDir, 'rsc/ssr')
    : path.join(rootOutDir, 'ssr')
  const rscOutput = userConfig.environments?.rsc?.build?.rollupOptions?.output
  const ssrOutput = userConfig.environments?.ssr?.build?.rollupOptions?.output

  return {
    build: {
      outDir: rootOutDir,
    },
    environments: {
      client: {
        build: {
          outDir:
            userConfig.environments?.client?.build?.outDir ?? clientOutDir,
        },
      },
      rsc: {
        build: {
          outDir: userConfig.environments?.rsc?.build?.outDir ?? rscOutDir,
          rollupOptions: {
            output: Array.isArray(rscOutput)
              ? rscOutput.map((output) =>
                  defaultOutputKeepNames({
                    ...output,
                    entryFileNames: output.entryFileNames ?? '[name].js',
                  }),
                )
              : defaultOutputKeepNames({
                  ...(rscOutput ?? {}),
                  entryFileNames: rscOutput?.entryFileNames ?? '[name].js',
                }),
          },
        },
      },
      ssr: {
        build: {
          outDir: userConfig.environments?.ssr?.build?.outDir ?? ssrOutDir,
          rollupOptions: {
            output: Array.isArray(ssrOutput)
              ? ssrOutput.map((output) =>
                  defaultOutputKeepNames({
                    ...output,
                    entryFileNames: output.entryFileNames ?? '[name].js',
                  }),
                )
              : defaultOutputKeepNames({
                  ...(ssrOutput ?? {}),
                  entryFileNames: ssrOutput?.entryFileNames ?? '[name].js',
                }),
          },
        },
      },
    },
  }
}

export const spiceflowPlugin = spiceflow

export default function spiceflow({
  entry,
  importMap,
  externalizeShared,
  serveStaticImport = 'spiceflow',
  nft,
}: {
  entry: string
  /** Externalize React and shared deps from client chunks at build time so
   *  federation payloads use bare specifiers resolved by the host's import map. */
  externalizeShared?: boolean
  /** Additional import map entries merged into the auto-generated map.
   *  Useful for ESM components that import bare specifiers like `framer` or `framer-motion`.
   *  Example: `{ 'framer-motion': 'https://esm.sh/framer-motion?external=react' }` */
  importMap?: Record<string, string>
  /** Module specifier that exports `serveStatic`; used by the production virtual app entry. */
  serveStaticImport?: string
  /** Options for @vercel/nft dependency tracing during standalone builds.
   *  By default, `emitGlobs` is disabled to prevent OOM on large projects while keeping
   *  native addon detection and __dirname file references working.
   *  Pass `{ analysis: true }` to re-enable glob expansion, or `{ analysis: false }` to
   *  disable all analysis for maximum speed and minimum memory. */
  nft?: NftOptions
}): Plugin[] {
  let server: ViteDevServer
  let resolvedOutDir = 'dist'
  let resolvedClientOutDir = path.join(resolvedOutDir, 'client')
  let resolvedRscOutDir = path.join(resolvedOutDir, 'rsc')
  let resolvedSsrOutDir = path.join(resolvedOutDir, 'ssr')
  let resolvedBase = ''
  let buildCleanedOnce = false
  let isCloudflareProject = false
  let isCloudflareRuntime = false
  let isVitestRuntime = false
  let externalizeSharedInDev = false
  let importMapJson = ''
  let modulePreloadUrls: string[] = []
  const rscOptions: RscPluginOptions = {
    entries: spiceflowEntries,
    serverHandler: false as const,
    loadModuleDevProxy: true,
    // Keep spiceflow client modules in a dedicated chunk so federation encode
    // can drop them (hosts already provide React/spiceflow via import map).
    // User "use client" modules keep normal Vite chunk names — same path for
    // remotes and non-remote producers (e.g. holocron chat).
    clientChunks(meta: { id: string; normalizedId: string }) {
      if (meta.id.includes('spiceflow/') || meta.id.includes('spiceflow\\')) {
        return 'spiceflow-framework'
      }
    },

    // Use RSC_ENCRYPTION_KEY env var when set (stable across deploys), otherwise
    // let the plugin generate a random key (fine for dev and single-deploy setups).
    defineEncryptionKey: process.env.RSC_ENCRYPTION_KEY
      ? JSON.stringify(process.env.RSC_ENCRYPTION_KEY)
      : undefined,
    // Catch invalid cross-environment imports at build time (e.g. importing a server-only
    // module from a client component) instead of failing at runtime.
    validateImports: true,
  }

  const plugins: Array<Plugin | Plugin[]> = [
    {
      name: 'spiceflow:deployment-id',
      // One new id per production build command. plugin-rsc may call buildStart
      // once per environment; only mint the id on the first call of this build.
      buildStart() {
        if (this.environment?.mode !== 'build') return
        if (mintedDeploymentIdForCurrentBuild) return
        mintedDeploymentIdForCurrentBuild = true
        buildDeploymentId = createBuildDeploymentId()
      },
    },
    {
      name: 'spiceflow:normalize-environment-outdirs',
      config(userConfig) {
        externalizeSharedInDev = Boolean(
          externalizeShared &&
            typeof userConfig.base === 'string' &&
            (userConfig.base.startsWith('http://') ||
              userConfig.base.startsWith('https://')),
        )
        return normalizeEnvironmentOutDirs(userConfig)
      },
      configResolved(resolvedConfig) {
        // The cloudflare plugin unconditionally sets ssr.build.outDir to a
        // sibling path (dist/ssr) regardless of plugin order. If it ran after
        // our config hook, it overwrote our nested path. Re-apply the correct
        // nested outDir so workerd can resolve "../ssr/index.js" imports.
        const isCloudflare = resolvedConfig.plugins.some(
          (p) => p.name === 'vite-plugin-cloudflare',
        )
        if (!isCloudflare) return
        const rootOutDir = resolvedConfig.build.outDir
        const nestedSsrOutDir = path.resolve(
          resolvedConfig.root,
          rootOutDir,
          'rsc/ssr',
        )
        resolvedConfig.environments.ssr.build.outDir = nestedSsrOutDir
      },
    },
    // Must run BEFORE rsc() — strips the base path from plugin-rsc's internal
    // RPC requests. plugin-rsc's loadModuleDevProxy builds endpoint URLs using
    // origin+base (from server.resolvedUrls) but its middleware matches only
    // the pathname without base. Without this, every RPC call 404s when base != '/'.
    {
      name: 'spiceflow:rsc-rpc-base-fix',
      configureServer(server) {
        if (!resolvedBase) return
        server.middlewares.use((req, res, next) => {
          if (req.url?.includes('__vite_rsc_load_module_dev_proxy')) {
            // The RPC endpoint URL is origin+base+"__vite_rsc..." (no slash
            // separator) so we can't just strip a base prefix. Instead,
            // rewrite to start from /__vite_rsc... so the pathname matches.
            const idx = req.url.indexOf('__vite_rsc_load_module_dev_proxy')
            if (idx > 0) {
              req.url = '/' + req.url.slice(idx)
            }
          }
          next()
        })
      },
    },
    // In cloudflare mode, the `virtual:app-entry` module doesn't exist in the
    // RSC environment's module graph (workerd uses its own worker-entry). This
    // breaks loadCss('virtual:app-entry') because collectCss can't walk the
    // graph. Fix: replace 'virtual:app-entry' with the actual entry file path
    // which IS in the module graph. Must run before rsc() so vite-rsc's loadCss
    // transform sees the resolved path.
    {
      name: 'spiceflow:rewrite-loadcss-entry',
      async transform(code, id) {
        if (!id.includes('load-global-css.rsc')) return
        if (!code.includes('loadCss(')) return
        if (!code.includes('virtual:app-entry')) return
        const resolved = await this.resolve(entry)
        if (!resolved) return
        // Use resolved.id (absolute path) so rsc:importer-resources can resolve
        // it regardless of importer context. Strip the \0 prefix that Vite adds
        // to resolved virtual module IDs — downstream this.resolve('\0...') fails
        // because Vite doesn't re-resolve already-resolved IDs.
        const resolvedId = resolved.id.replace(/^\0/, '')
        return code
          .replace(
            `loadCss('virtual:app-entry')`,
            `loadCss('${resolvedId}')`,
          )
          .replace(
            `loadCss("virtual:app-entry")`,
            `loadCss("${resolvedId}")`,
          )
      },
    },
    ...rsc(rscOptions),
    // Inject $$id on server reference functions so getActionAbortController()
    // can map a function back to its action ID.
    //
    // WHY: React's client-side createServerReference() stores the action ID
    // in a private WeakMap (knownServerReferences) — not as a property on the
    // function. There's no public API to read it back. We need the ID to look
    // up the AbortController for an in-flight action call.
    //
    // HOW: @vitejs/plugin-rsc transforms "use server" files into client proxy
    // modules with a stable output format. This post-transform wraps each
    // createServerReference() call to set $$id on the returned function.
    //
    // BEFORE (plugin-rsc output):
    //   export const myAction = $$ReactClient.createServerReference(
    //     "/src/actions.tsx#myAction", $$ReactClient.callServer, undefined,
    //     $$ReactClient.findSourceMapURL, "myAction"
    //   )
    //
    // AFTER (our transform):
    //   export const myAction = (($__sr) => ($__sr.$$id = "/src/actions.tsx#myAction", $__sr))(
    //     $$ReactClient.createServerReference(
    //       "/src/actions.tsx#myAction", $$ReactClient.callServer, undefined,
    //       $$ReactClient.findSourceMapURL, "myAction"
    //     )
    //   )
    //
    // The regex relies on the plugin-rsc output format: $$ReactClient.createServerReference("ID", ...simple args).
    // Arguments are always strings, identifiers, or `undefined` — no nested parentheses.
    // @vitejs/plugin-rsc is pinned in package.json so this doesn't silently
    // break on a minor update. When upgrading, verify the output format still matches.
    //
    // NOTE: In JS replacement strings, $$ is an escape for a literal $.
    // So $$$$id in the replacement produces $$id in the output.
    {
      name: 'spiceflow:server-ref-id',
      enforce: 'post' as const,
      transform(code) {
        if (!code.includes('createServerReference(')) return
        return code.replace(
          /(\$\$ReactClient\.createServerReference\(("[^"]*"),([^)]*)\))/g,
          '(($__sr) => ($__sr.$$$$id = $2, $__sr))($1)',
        )
      },
    },
    // Strip dev-only findSourceMapURL from production client/SSR builds.
    // @vitejs/plugin-rsc/browser defines findSourceMapURL() which references
    // /__vite_rsc_findSourceMapURL (a dev-only Vite endpoint). React never
    // calls it in production, but the code survives tree-shaking because it's
    // passed as an option to createFromReadableStream/createFromFetch.
    // When the dist output is later consumed by webpack/turbopack (e.g. via
    // a Next.js catch-all route), they treat the URL as a module specifier
    // and fail to resolve it. Replacing the function body with a no-op fixes
    // the downstream bundler error without affecting runtime behavior.
    {
      name: 'spiceflow:strip-find-source-map-url',
      apply: 'build' as const,
      transform(code, id) {
        if (!id.includes('@vitejs/plugin-rsc')) return
        if (!code.includes('findSourceMapURL')) return
        return code.replace(
          /function findSourceMapURL\([^)]*\)\s*\{[^}]*__vite_rsc_findSourceMapURL[^}]*\}/,
          'function findSourceMapURL() {}',
        )
      },
    },
    prerenderPlugin(),
    serverFileGuardPlugin(),
    outputModulePackagePlugin(),
    // Automatically generate Vercel Build Output when VERCEL=1 is set
    ...(process.env.VERCEL === '1' ? [vercelPlugin()] : []),
    // Trace runtime dependencies into dist/node_modules/ so the build output
    // is self-contained (just copy dist/ into Docker and run it).
    // Skipped for Vercel (has its own tracing) and Cloudflare (bundles everything).
    standaloneTracePlugin(nft),

    // Rewrite optimizeDeps entries so @vitejs/plugin-rsc vendor CJS files
    // resolve through the spiceflow framework package (where the plugin is installed)
    // rather than from the app root where the plugin isn't a direct dependency.
    {
      name: 'spiceflow:optimize-deps-rewrite',
      configEnvironment(_name, config) {
        if (!config.optimizeDeps?.include) return
        config.optimizeDeps.include = config.optimizeDeps.include.map(
          (entry) => {
            if (entry.startsWith('@vitejs/plugin-rsc')) {
              return `spiceflow > ${entry}`
            }
            return entry
          },
        )
      },
    },

    {
      name: 'spiceflow:plugin-rsc-rpc-alias',
      resolveId(source) {
        if (source === '@vitejs/plugin-rsc/utils/rpc') {
          return pluginRscRpcPath
        }
      },
    },

    {
      name: 'spiceflow:config',
      config(userConfig, env) {
        isVitestRuntime = Boolean(process.env.VITEST && env.mode === 'test')
        // Capture base early — Vite normalizes it to '/' by default, but the
        // raw user value is available here before configResolved runs.
        const rawBase = userConfig.base || '/'
        const isAbsoluteUrl =
          rawBase.startsWith('http://') || rawBase.startsWith('https://')
        if (rawBase !== '/' && !rawBase.startsWith('/') && !isAbsoluteUrl) {
          throw new Error(
            `[spiceflow] config.base must be an absolute path starting with "/", got "${rawBase}". ` +
              `CDN URLs (https://...) and relative paths (./) are not supported. ` +
              `Use base: "/my-app" instead.`,
          )
        }
        resolvedBase = extractBasePathname(rawBase)
        const userOnWarn = userConfig.build?.rollupOptions?.onwarn
        const userBuildOutput = userConfig.build?.rollupOptions?.output
        if (Array.isArray(userBuildOutput)) {
          for (const output of userBuildOutput) {
            setDefaultOutputKeepNames(output)
          }
        }
        const isCloudflare = hasPluginNamed(
          userConfig.plugins,
          'vite-plugin-cloudflare',
        )
        isCloudflareProject = isCloudflare
        if (isCloudflare) {
          logger.info('detected Cloudflare plugin')
          // Cloudflare child environments already expose worker-side module imports.
          // Using plugin-rsc's Node dev proxy here makes child `ssr` call
          // `.runner.import(...)` on a non-runnable CloudflareDevEnvironment.
          rscOptions.loadModuleDevProxy = false
        }
        return {
          // Enable app build mode so `vite build` builds all environments
          // (client + SSR + RSC) without requiring the --app CLI flag.
          builder: {},
          // Disable Vite's built-in SPA fallback middleware so it doesn't
          // intercept unmatched paths with a 200 before our middleware runs.
          appType: 'custom' as const,
          // Disable clear screen by default so build logs and dev server
          // output stay visible. Users can opt back in with clearScreen: true.
          ...(userConfig.clearScreen === true ? {} : { clearScreen: false }),
          server: {
            // Default to strictPort so the dev server fails fast when the port
            // is taken instead of silently picking a random one. Skip when the
            // user explicitly opted out or when no custom port was set (5173).
            ...(userConfig.server?.strictPort === false
              ? {}
              : {
                  strictPort:
                    userConfig.server?.port != null &&
                    userConfig.server.port !== 5173,
                }),
          },
          // Replace process.env.NODE_ENV at build time so React uses its production
          // bundle. Without this, the built output contains runtime checks like
          // `"production" !== process.env.NODE_ENV` that always evaluate to the dev
          // path, adding ~28% CPU overhead from debug stack traces and fake call sites.
          define: {
            ...(env.command === 'build'
              ? {
                  'process.env.NODE_ENV': JSON.stringify(
                    process.env.NODE_ENV || 'production',
                  ),
                }
              : {}),
          },
          build: {
            rollupOptions: {
              ...(Array.isArray(userBuildOutput)
                ? {}
                : { output: defaultOutputKeepNamesOption(userBuildOutput) }),
              onwarn(warning, defaultHandler) {
                // Suppress IMPORT_IS_UNDEFINED for virtual:app-entry — it uses
                // `import * as entry` + re-export which Rollup can't statically verify,
                // but the runtime check (`if (!entry.app) throw ...`) already covers it.
                if (
                  warning.code === 'IMPORT_IS_UNDEFINED' &&
                  warning.id?.includes('\0virtual:app-entry')
                ) {
                  return
                }
                if (userOnWarn) {
                  userOnWarn(warning, defaultHandler)
                } else {
                  defaultHandler(warning)
                }
              },
            },
          },
        }
      },
      configResolved(config) {
        resolvedOutDir = config.build.outDir
        resolvedClientOutDir = config.environments.client.build.outDir
        resolvedRscOutDir = config.environments.rsc.build.outDir
        resolvedSsrOutDir = config.environments.ssr.build.outDir
        resolvedBase = extractBasePathname(config.base || '/')
        isCloudflareRuntime = config.plugins.some((plugin) =>
          plugin.name.startsWith('vite-plugin-cloudflare:'),
        )
        assertSingleSpiceflowInstance(config.root)
      },
      buildStart() {
        // Clean environment output dirs once before the first build step.
        // buildStart fires for every builder.build() call in the plugin-rsc
        // 5-step pipeline, so we guard with a flag to avoid wiping outputs
        // from earlier steps (e.g. step 5/SSR would delete dist/rsc built
        // in step 3, causing writeAssetsManifest to fail with ENOENT).
        if (buildCleanedOnce) return
        buildCleanedOnce = true
        for (const dir of [
          resolvedClientOutDir,
          resolvedSsrOutDir,
          resolvedRscOutDir,
        ]) {
          try {
            fs.rmSync(dir, { recursive: true, force: true })
          } catch {}
        }
      },
      // Preserve all entry point exports in the RSC environment so user-defined
      // named exports (Durable Objects, Workflows, Queue consumers, etc.)
      // survive Rollup's tree-shaking and appear in the built Worker output.
      configEnvironment(name, config) {
        config.optimizeDeps ??= {}
        config.optimizeDeps.rolldownOptions ??= {}
        config.optimizeDeps.rolldownOptions.output = defaultOutputKeepNames(
          config.optimizeDeps.rolldownOptions.output,
        )

        if (name === 'rsc') {
          config.build ??= {}
          config.build.rollupOptions ??= {}
          config.build.rollupOptions.preserveEntrySignatures = 'allow-extension'
        }
      },
    },
    // Point optimizeDeps.entries at the user's app entry so each environment can
    // crawl the full import graph up front instead of discovering deps mid-request.
    //
    // Vite only applies top-level optimizeDeps defaults to the client environment.
    // Non-client environments default to noDiscovery=true, which ignores entries and
    // skips holdUntilCrawlEnd entirely. Spiceflow opts ssr/rsc back into discovery so
    // all three environments can stabilize their dep graph before serving requests.
    //
    // Also ensures Vite processes spiceflow through its transform pipeline (noExternal)
    // so conditional package.json exports (react-server vs default) resolve correctly.
    // Excludes spiceflow from client dep optimization so RSC client references
    // (loaded via client-in-server-package-proxy from raw node_modules) share the same
    // module instances as the entry.client imports.
    {
      name: 'spiceflow:optimize-deps',
      configEnvironment(name, config) {
        config.resolve ??= {}
        config.optimizeDeps ??= {}
        config.optimizeDeps.holdUntilCrawlEnd = true

        // When running under Vitest, inject the spiceflow-vitest condition so
        // #rsc-runtime resolves to the vitest shim instead of the real RSC
        // runtime (which depends on Vite RSC APIs not available in test).
        // Placed before other conditions so it takes priority in the
        // package.json imports field key order.
        if (isVitestRuntime) {
          config.resolve.conditions = mergeUnique(
            ['spiceflow-vitest'],
            config.resolve.conditions ?? [],
          )
        }

        // Package private `#imports` can target different runtime entry points
        // than public `exports`. The RSC environment already resolves with the
        // `react-server` condition, but the plain SSR environment uses the normal
        // server conditions unless we add an explicit SSR-only condition here.
        // This lets internal imports like `#router-context` resolve to the real
        // AsyncLocalStorage implementation in SSR while the client environment
        // still resolves to the browser-safe fallback.
        if (name === 'ssr') {
          config.resolve.conditions = mergeUnique(config.resolve.conditions, [
            'ssr',
          ])
        }

        if (name === 'rsc') {
          config.resolve.conditions = mergeUnique(config.resolve.conditions, [
            'react-server',
          ])
        }

        // Only add filesystem entries to optimizeDeps — virtual modules and
        // bare specifiers aren't files so they can't be used as globs.
        const looksLikeFilePath = /\.[cm]?[jt]sx?$/.test(entry)
        if (looksLikeFilePath) {
          const entryGlob = entry.replace(
            /\.[cm]?[jt]sx?$/,
            '.{js,jsx,ts,tsx,mjs,mts,cjs,cts}',
          )
          config.optimizeDeps.entries = mergeUnique(
            toArray(config.optimizeDeps.entries),
            [entryGlob],
          )
        }


        if (name === 'rsc' || name === 'ssr') {
          config.optimizeDeps.noDiscovery = false
          // Vite's externalization check extracts the base package name from
          // any import specifier (e.g. 'spiceflow/react' → 'spiceflow') via
          // getNpmPackageName, so listing 'spiceflow' here covers all subpaths.
          addNoExternal(config, 'spiceflow')

          if (isCloudflareProject) {
            config.resolve.noExternal = true
          }
        }

        // Each environment runs its own independent optimizer, so deps discovered
        // late by the rsc/ssr optimizer still cause reloads even if the client
        // optimizer finished cleanly. Explicitly include known CJS/late-discovered
        // deps that spiceflow transitively imports so all three environments
        // pre-bundle them upfront instead of finding them mid-request.
        //
        // IMPORTANT: when new dependencies are shown in the `vite dev` as new dependencies optimized.
        // add them here if they are optimized because of spiceflow.
        // so new users will not get initial error overlay on first page load. add in the right runtime
        if (name === 'client') {
          config.optimizeDeps.exclude = mergeUnique(
            config.optimizeDeps.exclude,
            ['spiceflow', '@vitejs/plugin-rsc'],
          )
          config.optimizeDeps.include = mergeUnique(
            config.optimizeDeps.include,
            [
              'spiceflow > @vitejs/plugin-rsc/vendor/react-server-dom/client.browser',
              'react',
              'react/jsx-runtime',
              'react/jsx-dev-runtime',
              'react-dom',
              'react-dom/client',
              'spiceflow > its-fine',
              'spiceflow > eventsource-parser/stream',
            ],
          )
        }



        if (name === 'rsc') {
          const include = [
            'spiceflow > eventsource-parser/stream',
            'react-dom/server',
          ]

          if (canResolveDependency('zod')) {
            include.push('spiceflow > zod')
          }

          config.optimizeDeps.include = mergeUnique(
            config.optimizeDeps.include,
            include,
          )
        }

        if (name === 'ssr') {
          config.optimizeDeps.include = mergeUnique(
            config.optimizeDeps.include,
            [
              'spiceflow > eventsource-parser/stream',
              'react-dom/server',
              'react-dom/client',
              'react-dom/server.edge',
            ],
          )
        }

        // Keep resolve.dedupe for react packages as a baseline hint for
        // Vite's built-in resolver. The real singleton enforcement happens in
        // the spiceflow:dedupe-singleton plugin below via resolveId, which
        // works even when spiceflow is a transitive dep under pnpm.
        config.resolve ??= {}
        config.resolve.dedupe = mergeUnique(config.resolve.dedupe, [
          'react',
          'react-dom',
          'react/jsx-runtime',
          'react/jsx-dev-runtime',
        ])
      },
    },

    // Force spiceflow, react, and react-dom to resolve to a single copy across
    // all environments, even when spiceflow is a transitive dependency under
    // pnpm's strict node_modules layout.
    //
    // Vite's resolve.dedupe sets basedir=root then walks node_modules/, but
    // pnpm only symlinks direct deps at the root. Transitive deps are buried
    // in .pnpm/ and invisible from root, so dedupe silently falls back to
    // importer-based resolution, producing duplicate module instances.
    //
    // This resolveId hook intercepts bare specifiers and re-resolves them from
    // spiceflow's own directory (the canonical copy loaded by Vite). It uses
    // this.resolve() so Vite's full resolver still handles package.json exports
    // conditions (react-server, ssr, browser, etc.) per environment.
    {
      name: 'spiceflow:dedupe-singleton',
      enforce: 'pre' as const,
      async resolveId(id, importer, options) {
        // Only intercept bare specifiers, not relative/absolute paths or
        // virtual modules
        if (
          id.startsWith('.') ||
          id.startsWith('/') ||
          id.startsWith('\0') ||
          id.includes('?')
        ) {
          return null
        }

        // Extract bare package name (e.g. 'react' from 'react/jsx-runtime',
        // '@scope/pkg' from '@scope/pkg/sub')
        const pkgName = id.startsWith('@')
          ? id.split('/').slice(0, 2).join('/')
          : id.split('/')[0]

        if (!dedupePackages.has(pkgName)) return null

        // Re-resolve from spiceflow's own package.json location. This is the
        // canonical copy Vite loaded, so all importers converge on the same
        // physical files. skipSelf prevents infinite recursion.
        const resolved = await this.resolve(id, dedupeImporter, {
          ...options,
          skipSelf: true,
        })

        return resolved
      },
    },

    // In vitest mode, strip "use server" and "use client" directives so the
    // RSC plugin doesn't transform action files into server references.
    // Actions become plain functions that tests can import and call directly.
    {
      name: 'spiceflow:strip-directives',
      enforce: 'pre' as const,
      transform(code: string, id: string) {
        if (!isVitestRuntime) return
        if (!/\.[cm]?[jt]sx?$/.test(id)) return
        // Match "use server" or "use client" as the first statement.
        // Replace with same-length whitespace to preserve source maps.
        const directiveRe = /^(["']use (?:server|client)["'];?)/
        const match = code.match(directiveRe)
        if (!match) return
        return {
          code:
            code.slice(0, match.index!) +
            ' '.repeat(match[0].length) +
            code.slice(match.index! + match[0].length),
          map: null,
        }
      },
    },

    // SSR middleware for dev and preview servers
    {
      name: 'spiceflow:ssr-middleware',
      configureServer(_server) {
        // Cloudflare dev/preview already route requests through the worker entry.
        // Installing the Node SSR middleware here breaks the supported dev flow
        // because SSR then needs to call back into the non-runnable worker env.
        if (isCloudflareRuntime) return
        server = _server
        return () => {
          server.middlewares.use(async (req, res, next) => {
            if (req.url?.includes('__inspect')) return next()
            // Skip internal plugin-rsc dev proxy RPC requests — these must
            // be handled by the plugin's own middleware, not our SSR handler.
            // Without this guard, RPC requests fall through to fetchHandler
            // which triggers loadModule() again → infinite recursion.
            if (req.url?.includes('__vite_rsc_load_module_dev_proxy'))
              return next()
            // Vite's base middleware strips config.base from req.url, but
            // Spiceflow needs the full URL (including base) so its basePath
            // matching works consistently across dev/preview/production.
            if (resolvedBase && req.url && !req.url.startsWith(resolvedBase)) {
              req.url = resolvedBase + req.url
            }
            try {
              const resolvedEntry =
                await server.environments.ssr.pluginContainer.resolveId(
                  spiceflowEntries.ssr,
                )
              if (!resolvedEntry) {
                throw new Error(
                  `Failed to resolve spiceflow SSR entry: ${spiceflowEntries.ssr}`,
                )
              }
              const runner = Reflect.get(server.environments.ssr, 'runner')
              if (!runner || typeof runner.import !== 'function') {
                throw new Error('Vite SSR environment runner is unavailable')
              }
              const mod: any = await runner.import(resolvedEntry.id)
              const { createRequest, sendResponse } =
                await import('./react/fetch.js')
              const request = createRequest(req, res)
              const response = await mod.fetchHandler(request)
              sendResponse(response, res)
            } catch (e) {
              next(e)
            }
          })
        }
      },
      async configurePreviewServer(previewServer) {
        // Preview should also go through the built worker entry when Cloudflare owns the runtime.
        if (isCloudflareRuntime) return
        const mod = await import(path.resolve(resolvedSsrOutDir, 'index.js'))
        const { createRequest, sendResponse } = await import('./react/fetch.js')
        return () => {
          previewServer.middlewares.use(async (req, res, next) => {
            // Re-add Vite's stripped base prefix (see configureServer comment)
            if (resolvedBase && req.url && !req.url.startsWith(resolvedBase)) {
              req.url = resolvedBase + req.url
            }
            try {
              const request = createRequest(req, res)
              const response = await mod.fetchHandler(request)
              sendResponse(response, res)
            } catch (e) {
              next(e)
            }
          })
        }
      },
    },

    // Build timestamp inlined as a constant.
    // No runtime fs access needed, works on Node, Cloudflare, edge runtimes, etc.
    createVirtualPlugin('virtual:spiceflow-deployment-id', () => {
      return `export default ${JSON.stringify(buildDeploymentId)}`
    }),
    // Resolved directory paths for RSC runtime filesystem access.
    // In dev: publicDir = <cwd>/public, distDir = <cwd>.
    // In prod: resolved from the rsc/ directory (sibling of client/).
    // This virtual module gets code-split into rsc/assets/ (not rsc/index.js),
    // so we detect the assets/ nesting at runtime and walk up to rsc/.
    // On Cloudflare Workers, import.meta.filename is undefined (no filesystem),
    // so both exports fall back to empty strings.
    createVirtualPlugin('virtual:spiceflow-dirs', () => {
      const clientRelativeFromRsc = path.relative(
        resolvedRscOutDir,
        resolvedClientOutDir,
      )
      const distRelativeFromRsc = path.relative(
        resolvedRscOutDir,
        resolvedOutDir,
      )
      return [
        `import { resolve, dirname, basename } from 'node:path'`,
        `import { fileURLToPath as __fileURLToPath } from 'node:url'`,
        `let publicDir = ''`,
        `let distDir = ''`,
        // Resolve the dist directory from the current module's location.
        // import.meta.filename is available in Node.js 20.11+; fall back to
        // import.meta.url (which webpack, Bun, and older Node ESM provide).
        `function __resolveFilename() {`,
        `  if (typeof import.meta.filename === 'string') return import.meta.filename`,
        `  if (typeof import.meta.url === 'string' && import.meta.url.startsWith('file:')) return __fileURLToPath(import.meta.url)`,
        `  return ''`,
        `}`,
        `if (import.meta.hot) {`,
        `  publicDir = resolve(process.cwd(), 'public')`,
        `  distDir = process.cwd()`,
        `} else {`,
        `  const __fn = __resolveFilename()`,
        `  if (__fn) {`,
        `    const thisDir = dirname(__fn)`,
        `    const rscDir = basename(thisDir) === 'assets' ? dirname(thisDir) : thisDir`,
        `    publicDir = resolve(rscDir, ${JSON.stringify(clientRelativeFromRsc)})`,
        `    distDir = resolve(rscDir, ${JSON.stringify(distRelativeFromRsc)})`,
        `  }`,
        `}`,
        `export { publicDir, distDir }`,
      ].join('\n')
    }),
    // Resolves to user's app entry module.
    // Re-exports all named exports (for Cloudflare Durable Objects, etc.)
    // and `default` (for Cloudflare Workers default export).
    createVirtualPlugin('virtual:app-entry', async function () {
      // Resolve the entry through Vite's plugin pipeline so both filesystem
      // paths (./src/main.tsx) and virtual modules (virtual:holocron-app)
      // are handled uniformly without manual path.resolve / pathToFileURL.
      const resolved = await this.resolve(entry)
      if (!resolved) {
        throw new Error(
          `[spiceflow] Could not resolve entry "${entry}". ` +
            `Make sure the file exists or the virtual module is registered by a plugin.`,
        )
      }
      // Strip the \0 prefix that Vite adds to virtual module IDs — import
      // statements use the unprefixed form and Vite re-resolves them.
      const resolvedEntry = resolved.id.startsWith('\0')
        ? resolved.id.slice(1)
        : resolved.id
      const clientRelative = path.relative(
        resolvedRscOutDir,
        resolvedClientOutDir,
      )

      const escapedBase = resolvedBase.replace(/'/g, "\\'")
      const lines = [
        `import * as entry from '${resolvedEntry}'`,
        `if (!entry.app) throw new Error('[spiceflow] Your entry file must export a Spiceflow instance as "app". Example:\\n\\n  export const app = new Spiceflow()\\n    .page("/", async () => <Home />)\\n    .listen(3000)\\n')`,
      ]
      // Set basePath from Vite's config.base on the root app instance.
      // Error if the user already set a conflicting basePath in the constructor.
      if (resolvedBase) {
        lines.push(
          `if (entry.app.basePath && entry.app.basePath !== '${escapedBase}') throw new Error('[spiceflow] Base path must be configured via Vite config.base only, not the Spiceflow constructor. Remove basePath from new Spiceflow({ basePath }) and set base: "${escapedBase}" in vite.config.ts instead.')`,
          `entry.app.basePath = '${escapedBase}'`,
        )
      }
      // Auto-inject serveStatic for client build output in production.
      // In dev, import.meta.hot is truthy so this is skipped — Vite serves
      // client assets from source. Cloudflare Workers handle static files
      // via their own runtime.
      if (!isCloudflareRuntime) {
        const baseLen = resolvedBase.length
        lines.push(
          `import { serveStatic as __serveStatic } from '${serveStaticImport}'`,
          `import { resolve as __resolve, dirname as __dirname, basename as __basename } from 'node:path'`,
          `import { fileURLToPath as __toPath } from 'node:url'`,
          // Resolve the current module's filename from import.meta.filename
          // (Node 20.11+) or import.meta.url (webpack, Bun, older Node ESM).
          `const __thisFile = typeof import.meta.filename === 'string' ? import.meta.filename : (typeof import.meta.url === 'string' && import.meta.url.startsWith('file:') ? __toPath(import.meta.url) : '')`,
          `if (!import.meta.hot && __thisFile) {`,
          // Vite may code-split the entry into rsc/assets/*.js instead of
          // rsc/index.js. Detect the assets/ nesting and walk up so the
          // relative path to client/ resolves correctly. Same pattern used
          // by virtual:spiceflow-dirs for publicDir/distDir.
          `  const __thisDir = __dirname(__thisFile)`,
          `  const __rscDir = __basename(__thisDir) === 'assets' ? __dirname(__thisDir) : __thisDir`,
          `  const __clientDir = __resolve(__rscDir, '${clientRelative}')`,
          // Strip base path prefix from request paths so serveStatic can find
          // files on disk (e.g. /base/assets/style.css → /assets/style.css)
          ...(resolvedBase
            ? [
                `  entry.app.use(__serveStatic({ root: __clientDir, rewriteRequestPath: (p) => p.startsWith('${escapedBase}') ? p.slice(${baseLen}) || '/' : p }))`,
              ]
            : [`  entry.app.use(__serveStatic({ root: __clientDir }))`]),
          `}`,
        )
      }
      // Re-export everything from the user entry so named exports like
      // Durable Objects, Workflows, etc. survive the build.
      lines.push(
        `export * from '${resolvedEntry}'`,
        `export default entry.default`,
      )
      return lines.join('\n')
    }),
    federationSharedPlugin({
      externalizeShared: !!externalizeShared,
      setImportMapJson(json) {
        importMapJson = json
        const imports = JSON.parse(json).imports as Record<string, string>
        modulePreloadUrls = [...new Set(Object.values(imports))]
      },
    }),
    ...(importMap
      ? [
          userImportMapPlugin(
            importMap,
            () => importMapJson,
            (json) => {
              importMapJson = json
            },
          ),
        ]
      : []),
    createVirtualPlugin('virtual:spiceflow-import-map', function () {
      // In dev mode, generate import map using Vite's ?url imports so that
      // the shared entry re-export files resolve to dev-server URLs that
      // browsers can load. In build mode, return the pre-built JSON string
      // populated by federationSharedPlugin and userImportMapPlugin.
      if (this.environment?.config.command === 'serve') {
        const importStatements: string[] = []
        const mapEntries: string[] = []
        const preloadUrls: string[] = []
        let idx = 0

        for (const [name, specifiers] of Object.entries(SPECIFIER_MAP)) {
          const filePath = SHARED_ENTRIES[name]
          if (!filePath) continue
          const varName = `__url_${idx++}`
          importStatements.push(
            `import ${varName} from ${JSON.stringify(filePath + '?url')}`,
          )
          preloadUrls.push(varName)
          for (const spec of specifiers) {
            mapEntries.push(`${JSON.stringify(spec)}: ${varName}`)
          }
        }

        if (importMap) {
          for (const [spec, value] of Object.entries(importMap)) {
            if (value.startsWith('http://') || value.startsWith('https://')) {
              mapEntries.push(
                `${JSON.stringify(spec)}: ${JSON.stringify(value)}`,
              )
            } else {
              const varName = `__url_${idx++}`
              importStatements.push(
                `import ${varName} from ${JSON.stringify(value + '?url')}`,
              )
              mapEntries.push(`${JSON.stringify(spec)}: ${varName}`)
            }
          }
        }

        return [
          ...importStatements,
          `export const modulePreloadUrls = [${preloadUrls.join(', ')}]`,
          `export default JSON.stringify({ imports: { ${mapEntries.join(', ')} } })`,
        ].join('\n')
      }

      return [
        `export const modulePreloadUrls = ${JSON.stringify(modulePreloadUrls)}`,
        `export default ${JSON.stringify(importMapJson)}`,
      ].join('\n')
    }),
    // Externalize React and shared deps from client chunks at build time so
    // bare specifiers are resolved by the import map (injected into HTML by
    // federationSharedPlugin). Active for federation producers and first-party
    // apps that serve externalized client payloads.
    ...(externalizeShared
      ? [
          {
            name: 'spiceflow:externalize-shared',
            apply: 'build' as const,
            applyToEnvironment(environment) {
              if (environment.name !== 'client') return false
              return esmExternalRequirePlugin({
                external: REACT_EXTERNALS,
              })
            },
          } satisfies Plugin,
        ]
      : []),
    // OXC JSX, strict entry signatures, and dev-mode externalization keep
    // cross-origin client chunks independent and import-map compatible.
    ...(externalizeShared
      ? [
          {
            name: 'spiceflow:externalize-shared-client',
            config() {
              return {
                oxc: { jsx: { runtime: 'automatic' } },
              }
            },
            configEnvironment(name: string, config: any) {
              if (name !== 'client') return
              config.build ??= {}
              config.build.rollupOptions ??= {}
              config.build.rollupOptions.preserveEntrySignatures = 'strict'
            },
          } satisfies Plugin,
          ...federationDevExternalizePlugin(
            REACT_EXTERNALS,
            () => externalizeSharedInDev,
          ),
        ]
      : []),
  ]

  return plugins.flatMap((plugin) =>
    Array.isArray(plugin) ? plugin : [plugin],
  )
}

const REACT_EXTERNALS = [
  'react',
  'react-dom',
  'react-dom/client',
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
  'spiceflow/react',
]

const sharedDir = path.resolve(
  path.dirname(url.fileURLToPath(import.meta.url)),
  'federation/shared',
)

const SHARED_ENTRIES: Record<string, string> = {
  'federation-react': path.join(sharedDir, 'react.js'),
  'federation-react-dom': path.join(sharedDir, 'react-dom.js'),
  'federation-react-dom-client': path.join(sharedDir, 'react-dom-client.js'),
  'federation-jsx-runtime': path.join(sharedDir, 'react-jsx-runtime.js'),
  'federation-spiceflow-react': path.join(sharedDir, 'spiceflow-react.js'),
}

const SPECIFIER_MAP: Record<string, string[]> = {
  'federation-react': ['react'],
  'federation-react-dom': ['react-dom'],
  'federation-react-dom-client': ['react-dom/client'],
  'federation-jsx-runtime': ['react/jsx-runtime', 'react/jsx-dev-runtime'],
  'federation-spiceflow-react': ['spiceflow/react'],
}

function federationSharedPlugin({
  externalizeShared,
  setImportMapJson,
}: {
  externalizeShared: boolean
  setImportMapJson: (json: string) => void
}): Plugin {
  const chunkRefs = new Map<string, string>()
  let base = '/'

  return {
    name: 'spiceflow:federation-shared',
    apply: 'build',

    configResolved(config) {
      base = config.base || '/'
    },

    async buildStart() {
      if (this.environment?.name !== 'client') return
      if (externalizeShared) {
        const outputs = await buildFederationSharedEntries(
          this.environment.config,
        )
        const imports: Record<string, string> = {}
        const prefix = base.endsWith('/') ? base : base + '/'

        for (const output of outputs) {
          this.emitFile({
            type: 'asset',
            fileName: output.fileName,
            source: output.type === 'chunk' ? output.code : output.source,
          })
          if (output.type !== 'chunk' || !output.isEntry) continue

          for (const specifier of SPECIFIER_MAP[output.name] ?? []) {
            imports[specifier] = prefix + output.fileName
          }
        }

        setImportMapJson(JSON.stringify({ imports }, null, 2))
        return
      }

      for (const [name, filePath] of Object.entries(SHARED_ENTRIES)) {
        const ref = this.emitFile({
          type: 'chunk',
          id: filePath,
          name,
          preserveSignature: 'strict',
        })
        chunkRefs.set(name, ref)
      }
    },

    generateBundle() {
      if (this.environment?.name !== 'client') return
      if (externalizeShared) return
      const imports: Record<string, string> = {}
      // Use the Vite base so paths are absolute when base is a full URL
      const prefix = base.endsWith('/') ? base : base + '/'
      for (const [name, ref] of chunkRefs) {
        const fileName = this.getFileName(ref)
        const specifiers = SPECIFIER_MAP[name]
        if (specifiers) {
          for (const spec of specifiers) {
            imports[spec] = prefix + fileName
          }
        }
      }
      setImportMapJson(JSON.stringify({ imports }, null, 2))
    },
  }
}

async function buildFederationSharedEntries(config: ResolvedConfig) {
  // Shared providers need a separate module graph. React must stay external in
  // the app graph while being bundled into these import-map targets.
  const result = await viteBuild({
    configFile: false,
    envDir: false,
    publicDir: false,
    root: config.root,
    mode: config.mode,
    logLevel: 'warn',
    define: config.define,
    resolve: {
      alias: config.resolve.alias,
      conditions: config.resolve.conditions,
      dedupe: config.resolve.dedupe,
      extensions: config.resolve.extensions,
      mainFields: config.resolve.mainFields,
      preserveSymlinks: config.resolve.preserveSymlinks,
    },
    build: {
      write: false,
      copyPublicDir: false,
      minify: config.build.minify,
      target: config.build.target,
      rolldownOptions: {
        input: SHARED_ENTRIES,
        preserveEntrySignatures: 'strict',
        output: {
          format: 'es',
          entryFileNames: 'assets/federation-shared/[name]-[hash].js',
          chunkFileNames: 'assets/federation-shared/[name]-[hash].js',
          assetFileNames: 'assets/federation-shared/[name]-[hash][extname]',
        },
      },
    },
  })

  const isRolldownOutput = (
    value: RolldownOutput | RolldownWatcher,
  ): value is RolldownOutput => {
    return (
      Object.hasOwn(value, 'output') &&
      Array.isArray(Reflect.get(value, 'output'))
    )
  }

  if (!Array.isArray(result) && !isRolldownOutput(result)) {
    throw new Error('Unexpected watcher from federation shared build')
  }

  return (Array.isArray(result) ? result : [result]).flatMap(
    (output) => output.output,
  )
}

// Merges user-provided import map entries into the auto-generated one.
// Values starting with http:// or https:// are used as-is (external URLs).
// All other values are treated as local file paths — Vite builds them into
// hashed chunks so the browser loads the same bundled instance as the host
// app (deduplication). This is the same pattern used for React shared entries.
function userImportMapPlugin(
  userEntries: Record<string, string>,
  getImportMapJson: () => string,
  setImportMapJson: (json: string) => void,
): Plugin {
  const chunkRefs = new Map<string, string>()
  let base = '/'

  return {
    name: 'spiceflow:user-import-map',
    apply: 'build',

    configResolved(config) {
      base = config.base || '/'
    },

    buildStart() {
      if (this.environment?.name !== 'client') return
      for (const [specifier, value] of Object.entries(userEntries)) {
        if (value.startsWith('http://') || value.startsWith('https://'))
          continue
        const ref = this.emitFile({
          type: 'chunk',
          id: value,
          name: `importmap-${specifier.replace(/[^a-zA-Z0-9-]/g, '-')}`,
          preserveSignature: 'strict',
        })
        chunkRefs.set(specifier, ref)
      }
    },

    generateBundle() {
      if (this.environment?.name !== 'client') return
      const current = JSON.parse(getImportMapJson() || '{"imports":{}}')
      const prefix = base.endsWith('/') ? base : base + '/'
      for (const [specifier, value] of Object.entries(userEntries)) {
        if (value.startsWith('http://') || value.startsWith('https://')) {
          current.imports[specifier] = value
          continue
        }
        const ref = chunkRefs.get(specifier)
        if (ref) {
          current.imports[specifier] = prefix + this.getFileName(ref)
        }
      }
      setImportMapJson(JSON.stringify(current, null, 2))
    },
  }
}

function hasPluginNamed(
  plugins: UserConfig['plugins'],
  pluginName: string,
): boolean {
  if (!plugins) return false

  for (const plugin of plugins) {
    if (!plugin) continue
    if (Array.isArray(plugin)) {
      if (hasPluginNamed(plugin, pluginName)) return true
      continue
    }
    if (Reflect.get(plugin, 'name') === pluginName) {
      return true
    }
  }

  return false
}

function mergeUnique<T>(base: T[] | undefined, add: T[]): T[] {
  return Array.from(new Set([...(base ?? []), ...add]))
}

function toArray(value: string | string[] | undefined): string[] {
  if (!value) return []
  return Array.isArray(value) ? value : [value]
}

// Detect duplicate spiceflow installations at build time. Two copies of
// spiceflow means two separate React contexts, two router instances, etc.
// which causes cryptic runtime errors like "FlightDataContext is missing".
// Catching this early with a clear message saves hours of debugging.
function assertSingleSpiceflowInstance(projectRoot: string) {
  try {
    const projectRequire = createRequire(
      path.resolve(projectRoot, 'package.json'),
    )
    const resolvedFromProject = path.dirname(
      projectRequire.resolve('spiceflow/package.json'),
    )
    const pluginSpiceflowDir = path.resolve(__spiceflowDir, '..')
    if (
      fs.realpathSync(resolvedFromProject) !==
      fs.realpathSync(pluginSpiceflowDir)
    ) {
      throw new Error(
        '[spiceflow] Duplicate spiceflow installation detected.\n\n' +
          `  Plugin loaded from: ${pluginSpiceflowDir}\n` +
          `  Project resolves to: ${resolvedFromProject}\n\n` +
          'Two copies of spiceflow will cause runtime errors (missing contexts, ' +
          'broken routing, hydration mismatches). Fix this by deduplicating:\n\n' +
          '  pnpm dedupe spiceflow   # or npm dedupe / bun install\n\n' +
          'If you use a wrapper plugin that depends on spiceflow, make sure it ' +
          'lists spiceflow as a peerDependency, not a regular dependency.',
      )
    }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('[spiceflow]')) throw e
    // If resolution fails entirely (e.g. spiceflow is not in node_modules
    // because it's linked or the project uses a non-standard layout), skip
    // the check — the build will fail later with a more specific error.
  }
}

function canResolveDependency(id: string): boolean {
  try {
    require.resolve(id, { paths: [process.cwd()] })
    return true
  } catch {
    return false
  }
}

function addNoExternal(
  config: { resolve?: { noExternal?: unknown } },
  pkg: string,
) {
  config.resolve ??= {}
  const existing = config.resolve.noExternal
  if (existing === true) return
  // Preserve false (user explicitly disabled) — we still need spiceflow processed
  const arr = Array.isArray(existing)
    ? existing
    : existing && existing !== false
      ? [existing]
      : []
  config.resolve.noExternal = Array.from(new Set([...arr, pkg]))
}

function standaloneTracePlugin(nftOptions?: NftOptions): Plugin {
  type BuildAppContext = MinimalPluginContextWithoutEnvironment & {
    environment?: {
      config: BuildOutDirConfig
    }
  }

  let outDir = 'dist'
  let rootDir = process.cwd()
  let skip = false

  return {
    name: 'spiceflow:standalone-trace',
    apply: 'build',

    configResolved(config) {
      outDir = resolveBuildOutDir(config)
      rootDir = config.root
      const isVercel = process.env.VERCEL === '1'
      const isCloudflare = config.plugins.some((p) =>
        p.name.startsWith('vite-plugin-cloudflare'),
      )
      skip =
        isVercel ||
        isCloudflare ||
        process.env.SPICEFLOW_SKIP_STANDALONE_TRACE === '1'
    },

    buildApp: {
      order: 'post' as const,
      async handler(this: BuildAppContext) {
        if (skip) return
        const resolvedOutDir = this.environment?.config
          ? resolveBuildOutDir(this.environment.config)
          : outDir

        await traceAndCopyDependencies({
          outDir: resolvedOutDir,
          rootDir: this.environment?.config?.root ?? rootDir,
          targetDir: resolvedOutDir,
          nftOptions,
        })
      },
    },
  }
}

function outputModulePackagePlugin(): Plugin {
  let outDir = 'dist'

  return {
    name: 'spiceflow:output-module-package',
    apply: 'build',
    configResolved(config) {
      outDir = resolveBuildOutDir(config)
    },
    buildApp: {
      order: 'post' as const,
      async handler() {
        const { mkdir, writeFile } = await import('node:fs/promises')
        await mkdir(outDir, { recursive: true })
        await writeFile(
          path.join(outDir, 'package.json'),
          JSON.stringify({ type: 'module' }),
        )
      },
    },
  }
}

/** Subset of Rollup/Vite PluginContext used by virtual module load callbacks. */
type VirtualLoadContext = {
  resolve: (source: string, importer?: string) => Promise<{ id: string } | null>
  environment?: { config: { command: string } }
}

function createVirtualPlugin(
  virtualName: string,
  loadFn: (
    this: VirtualLoadContext,
    id: string,
    options?: { ssr?: boolean },
  ) => string | void | Promise<string | void>,
): Plugin {
  const shortName = virtualName.replace('virtual:', '')
  const resolvedId = '\0' + virtualName
  return {
    name: `spiceflow:virtual-${shortName}`,
    resolveId(source) {
      return source === virtualName ? resolvedId : undefined
    },
    load(id, options) {
      if (id === resolvedId) {
        return loadFn.call(this, id, options)
      }
    },
  }
}
