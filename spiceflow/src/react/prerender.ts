// Prerender plugin: generates .rsc Flight data files at build time for
// staticPage() routes, and plain response files for staticGet() routes.
// Uses buildApp with order:"post" so it runs AFTER @vitejs/plugin-rsc
// writes the real assets manifest — no stub needed.
import fs from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Plugin } from 'vite'
import { formatDuration, logger } from '../logger.js'
import { resolveBuiltEntry } from '../trace-dependencies.js'
import { DEPLOYMENT_ID_HEADER } from './deployment.js'

type MaybePromise<T> = Promise<T> | T

export type PrerenderFn = () => MaybePromise<string[]>

export type PrerenderManifest = {
  entries: PrerenderEntry[]
}

type PrerenderEntry = {
  route: string
  html?: string
  data?: string
  file?: string
}

export function prerenderPlugin(): Plugin[] {
  let ssrOutDir = 'dist/ssr'
  let clientOutDir = 'dist/client'
  let isCloudflare = false

  return [
    {
      name: prerenderPlugin.name + ':build',
      enforce: 'post',
      apply: 'build',
      configResolved(config) {
        ssrOutDir = path.resolve(
          config.root,
          config.environments.ssr?.build?.outDir ?? 'dist/ssr',
        )
        clientOutDir = path.resolve(
          config.root,
          config.environments.client?.build?.outDir ?? 'dist/client',
        )
        isCloudflare = config.plugins.some((p: any) =>
          p.name?.startsWith('vite-plugin-cloudflare:'),
        )
      },
      // order:"post" runs AFTER all other buildApp hooks — including
      // @vitejs/plugin-rsc which writes __vite_rsc_assets_manifest.js
      // at the end of its buildApp. The real manifest exists by the time
      // this handler fires, so prerendered Flight streams include correct
      // CSS/JS resource hints.
      buildApp: {
        order: 'post',
        async handler() {
          if (isCloudflare) return
          await processPrerender({ ssrOutDir, clientOutDir })
        },
      },
    },
    {
      name: prerenderPlugin.name + ':preview',
      apply: (_config, env) => !!env.isPreview,
      configurePreviewServer(server) {
        const outDir = path.resolve(
          server.config.root,
          server.config.environments.client.build.outDir,
        )

        server.middlewares.use((req, _res, next) => {
          // rewrite `/abc` to `/abc.html` since Vite "mpa" mode doesn't support this
          const url = new URL(req.url!, 'https://test.local')
          const htmlFile = urlPathToHtmlPath(url.pathname)
          if (fs.existsSync(path.join(outDir, htmlFile))) {
            req.url = htmlFile
          }
          next()
        })
      },
    },
  ]
}

function urlPathToHtmlPath(pathname: string) {
  return pathname + (pathname.endsWith('/') ? 'index.html' : '.html')
}

async function throwPrerenderError({
  response,
  routePath,
}: {
  response: Response
  routePath: string
}) {
  logger.error(`failed to prerender ${routePath}`)
  const body = (await response.text()).trim().replace(/\s+/g, ' ')
  const details = body ? `\n${body}` : ''
  throw new Error(
    `Failed to prerender ${routePath}: ${response.status} ${response.statusText}${details}`,
  )
}

async function processPrerender(dirs: {
  ssrOutDir: string
  clientOutDir: string
}) {
  const start = performance.now()
  const prev = globalThis.__SPICEFLOW_PRERENDER
  globalThis.__SPICEFLOW_PRERENDER = true
  try {
    logger.info('prerendering static routes...')
    const entryPath = await resolveBuiltEntry(dirs.ssrOutDir)
    const entry: typeof import('./entry.ssr.tsx') = await import(
      path.resolve(entryPath)
    )

    const routes = await entry.getPrerenderRoutes()
    const manifest: PrerenderManifest = { entries: [] }
    let deploymentId = ''
    if (routes.length === 0) {
      await writeFile(
        path.join(dirs.clientOutDir, '__prerender.json'),
        JSON.stringify(manifest, null, 2),
      )
      logger.success(
        `prerendered 0 static routes in ${formatDuration(performance.now() - start)}`,
      )
      return
    }
    for (const route of routes) {
      const prerenderHeaders = {
        'x-react-server-render-mode': 'prerender',
      }

      if (route.kind === 'staticGet') {
        // staticGet: run the handler and write the raw response body to disk.
        // The route path should include a file extension (e.g. /api/data.json)
        // so serveStatic can resolve the MIME type.
        const url = new URL(route.path, 'https://prerender.local')
        const response = await entry.fetchHandler(
          new Request(url, { headers: prerenderHeaders }),
        )
        if (!response.ok) {
          await throwPrerenderError({
            response,
            routePath: route.path,
          })
        }
        const outFile = route.path
        const outPath = path.join(dirs.clientOutDir, outFile)
        await mkdir(path.dirname(outPath), { recursive: true })
        const buf = Buffer.from(await response.arrayBuffer())
        await writeFile(outPath, buf)

        manifest.entries.push({
          route: route.path,
          file: outFile,
        })
        continue
      }

      // Fetch RSC Flight data — __rsc makes fetchHandler return the raw
      // Flight stream without SSR rendering.
      const rscUrl = new URL(route.path, 'https://prerender.local')
      rscUrl.searchParams.set('__rsc', '')
      const rscResponse = await entry.fetchHandler(
        new Request(rscUrl, { headers: prerenderHeaders }),
      )
      if (!rscResponse.ok) {
        await throwPrerenderError({
          response: rscResponse,
          routePath: route.path,
        })
      }
      if (!deploymentId) {
        deploymentId = rscResponse.headers.get(DEPLOYMENT_ID_HEADER) || ''
      }

      // Fetch full HTML — without __rsc, fetchHandler SSR-renders the
      // Flight stream into a complete HTML document.
      const htmlUrl = new URL(route.path, 'https://prerender.local')
      const htmlResponse = await entry.fetchHandler(
        new Request(htmlUrl, { headers: prerenderHeaders }),
      )
      if (!htmlResponse.ok) {
        await throwPrerenderError({
          response: htmlResponse,
          routePath: route.path,
        })
      }

      const isRoot = route.path === '/'
      const dataFile = isRoot ? '/index.rsc' : route.path + '.rsc'
      const htmlFile = isRoot ? '/index.html' : route.path + '.html'

      const dataPath = path.join(dirs.clientOutDir, dataFile)
      await mkdir(path.dirname(dataPath), { recursive: true })
      await writeFile(dataPath, await rscResponse.text())

      const htmlPath = path.join(dirs.clientOutDir, htmlFile)
      await mkdir(path.dirname(htmlPath), { recursive: true })
      await writeFile(htmlPath, await htmlResponse.text())

      manifest.entries.push({
        route: route.path,
        html: htmlFile,
        data: dataFile,
      })
    }
    await writeFile(
      path.join(dirs.clientOutDir, '__prerender.json'),
      JSON.stringify(manifest, null, 2),
    )
    // Static hosts that serve prerendered *.rsc without the Worker need the
    // deployment header on those files (Cloudflare Pages _headers format).
    const rscDataFiles = manifest.entries
      .map((e) => e.data)
      .filter((d): d is string => Boolean(d))
    if (deploymentId && rscDataFiles.length > 0) {
      const headersBody = rscDataFiles
        .map(
          (file) =>
            `${file}\n  ${DEPLOYMENT_ID_HEADER}: ${deploymentId}\n`,
        )
        .join('\n')
      const headersPath = path.join(dirs.clientOutDir, '_headers')
      const existingHeaders = await readFile(headersPath, 'utf8').catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return ''
          throw error
        },
      )
      await writeFile(
        headersPath,
        existingHeaders
          ? `${existingHeaders.trimEnd()}\n\n${headersBody}`
          : headersBody,
      )
    }
    logger.success(
      `prerendered ${routes.length} static routes in ${formatDuration(performance.now() - start)}`,
    )
  } finally {
    if (prev === undefined) delete globalThis.__SPICEFLOW_PRERENDER
    else globalThis.__SPICEFLOW_PRERENDER = prev
  }
}
