// Vite plugin that externalizes React (and other shared modules) from client
// component chunks in dev mode for federation producers. Without this, Vite's
// dev server resolves import "react" to pre-bundled internal paths like
// /@fs/.../node_modules/.vite/deps/react.js. Federation consumers need bare
// specifiers so the browser resolves them via the import map injected in HTML.
//
// Only active with externalizeShared and only affects the client environment.
// The ssr and rsc environments continue resolving React normally through Vite's
// module graph.
//
// Three mechanisms work together:
// 1. configEnvironment: excludes externalized modules from dep optimization
// 2. resolveId hook: returns { id, external: true } so Vite skips resolution
// 3. transform hook (late): strips /@id/ prefixes and HMR/Fast Refresh
//    artifacts from @vitejs/plugin-react
import type { Plugin } from 'vite'

const resolvedExternals = new Set<string>()
export const federationDevCssPath = '/__spiceflow_federation_dev_css'

const cssRequestRegex =
  /\.(?:css|less|sass|scss|styl|stylus|pcss|postcss|sss)(?:$|\?)/

function isExternal(id: string, externals: string[]): boolean {
  return externals.some((ext) => id === ext || id.startsWith(`${ext}/`))
}

export function federationDevExternalizePlugin(
  externals: string[],
  isCrossOrigin: () => boolean,
): Plugin[] {
  // Pre-populate the set so resolveId works on first run without discovery
  for (const ext of externals) resolvedExternals.add(ext)

  return [
    {
      name: 'spiceflow:federation-dev-externalize',
      enforce: 'pre',
      apply: 'serve',

      configEnvironment(name, config: any) {
        if (name !== 'client' || !isCrossOrigin()) return
        // Exclude from dep optimization so Vite doesn't pre-bundle them
        config.optimizeDeps ??= {}
        config.optimizeDeps.exclude ??= []
        for (const ext of externals) {
          if (!config.optimizeDeps.exclude.includes(ext)) {
            config.optimizeDeps.exclude.push(ext)
          }
        }
      },

      // plugin-rsc leaves clientReferenceDeps empty in dev. Resolve CSS from
      // Vite's live client graph when the consumer requests the metadata link.
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          const url = new URL(req.url || '/', 'http://localhost')
          const basePath = new URL(
            server.config.base,
            'http://localhost',
          ).pathname.replace(/\/$/, '')
          if (url.pathname !== `${basePath}${federationDevCssPath}`) {
            return next()
          }

          const moduleId = url.searchParams.get('module')
          if (!moduleId) {
            res.statusCode = 400
            res.end('Missing module query parameter')
            return
          }

          try {
            const client = server.environments.client
            await client.transformRequest(moduleId)
            const entry = await client.moduleGraph.getModuleByUrl(moduleId)
            const visited = new Set<string>()
            const cssUrls = new Set<string>()

            function collectCss(mod: typeof entry) {
              if (!mod?.id || visited.has(mod.id)) return
              visited.add(mod.id)
              for (const imported of mod.importedModules) {
                if (cssRequestRegex.test(imported.url)) {
                  cssUrls.add(imported.url)
                  continue
                }
                collectCss(imported)
              }
            }

            collectCss(entry)
            const css = [...cssUrls]
              .map((href) => {
                const separator = href.includes('?') ? '&' : '?'
                return `@import url(${JSON.stringify(`${href}${separator}direct`)});`
              })
              .join('\n')

            res.statusCode = 200
            res.setHeader('access-control-allow-origin', '*')
            res.setHeader('cache-control', 'no-cache')
            res.setHeader('content-type', 'text/css')
            res.end(css)
          } catch (error) {
            next(error)
          }
        })
      },

      resolveId(id) {
        if (this.environment?.name !== 'client' || !isCrossOrigin()) return null
        if (isExternal(id, externals)) {
          resolvedExternals.add(id)
          return { id, external: true }
        }
        return null
      },

      load(id) {
        if (this.environment?.name !== 'client' || !isCrossOrigin()) return null
        if (resolvedExternals.has(id)) {
          return { code: 'export default {};' }
        }
        return null
      },
    },
    {
      // Must run AFTER vite:import-analysis which adds /@id/ prefixes.
      // Push via configResolved so it lands at the very end of the pipeline.
      name: 'spiceflow:federation-dev-externalize-setup',
      apply: 'serve',
      configResolved(resolvedConfig) {
        if (!isCrossOrigin()) return
        ;(resolvedConfig.plugins as Plugin[]).push(
          federationDevCleanupPlugin(resolvedConfig.base || '/'),
        )
      },
    },
  ]
}

// Late-running transform that cleans up client component modules for federation:
// strips /@id/ prefixes and HMR/Fast Refresh artifacts.
// Only affects "use client" modules in the client environment.
function federationDevCleanupPlugin(base: string): Plugin {
  return {
    name: 'spiceflow:federation-dev-cleanup',
    transform(code) {
      if (this.environment?.name !== 'client') return null

      let result = code

      // Strip /@id/ prefixes for externalized modules
      if (resolvedExternals.size > 0) {
        const escaped = [...resolvedExternals]
          .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
          .join('|')
        const prefix = base.endsWith('/') ? base : base + '/'
        const prefixRegex = new RegExp(
          `${prefix.replace(/[/]/g, '\\/')}@id\\/(${escaped})`,
          'g',
        )
        result = result.replace(
          prefixRegex,
          (_match, externalName: string) => externalName,
        )
      }

      // Only clean up HMR artifacts for "use client" modules (federation chunks)
      if (!result.includes('"use client"') && !result.includes("'use client'")) {
        return result !== code ? result : null
      }

      // Strip /@vite/client HMR setup
      result = result.replace(
        /import\s*\{[^}]*\}\s*from\s*["'][^"']*@vite\/client["'];?\s*/g,
        '',
      )
      result = result.replace(/import\.meta\.hot\s*=\s*[^;]+;?\s*/g, '')

      // Strip @vitejs/plugin-react's Fast Refresh wrapper
      result = result.replace(
        /import\s*\*\s*as\s+RefreshRuntime\s+from\s*["'][^"']*@react-refresh["'];?\s*/g,
        '',
      )
      result = result.replace(
        /import\s*\*\s*as\s+__vite_react_currentExports\s+from\s*["'][^"']*["'];?\s*/g,
        '',
      )
      result = result.replace(
        /const inWebWorker\s*=[\s\S]*?function \$RefreshSig\$\(\)\s*\{[^}]*\}\s*(\/\/# sourceMappingURL=.*)?$/,
        '',
      )

      // Stub $RefreshSig$/$RefreshReg$ as no-ops for inline calls
      if (result.includes('$RefreshSig$') || result.includes('$RefreshReg$')) {
        result =
          'var $RefreshSig$ = () => (x) => x, $RefreshReg$ = () => {};\n' +
          result
      }

      return result !== code ? result : null
    },
  }
}
