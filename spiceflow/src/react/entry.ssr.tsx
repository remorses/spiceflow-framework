// SSR entry point. Receives RSC flight stream from the RSC environment,
// SSR-renders it to HTML, and injects the RSC payload inline for client hydration.
import { isbot } from './isbot.js'

import React from 'react'
import ReactDOMServer from 'react-dom/server.edge'
import { createFromReadableStream } from '@vitejs/plugin-rsc/ssr'

import { ServerPayload } from '../spiceflow.js'
import {
  DefaultGlobalErrorPage,
  DefaultNotFoundPage,
  ErrorBoundary,
  LayoutContent,
  NotFoundBoundary,
} from './components.js'
import { FlightDataContext } from './context.js'
import {
  getErrorContext,
  isNotFoundError,
  isRedirectError,
  contextHeaders,
  contextToHeaders,
  type ReactServerErrorContext,
} from './errors.js'
import { formatServerError } from './format-server-error.js'
import { sanitizeErrorMessage } from './sanitize-error.js'
import { injectRSCPayload } from './transform.js'
import { createRouterContextData } from '../router-context.js'
import { deploymentIdBootstrapPrefix } from './deployment.js'

const verboseLogs = process.env.SPICEFLOW_VERBOSE === '1'

let deploymentIdPromise: Promise<string> | undefined

function getBootstrapDeploymentId(): Promise<string> {
  const load = async () => {
    if (import.meta.hot) return ''
    try {
      const { default: id } = await import('virtual:spiceflow-deployment-id')
      return typeof id === 'string' ? id : ''
    } catch {
      return ''
    }
  }
  if (import.meta.hot) return load()
  deploymentIdPromise ??= load()
  return deploymentIdPromise
}

const importMapPromise = import('virtual:spiceflow-import-map')
  .then((module) => ({
    importMapJson: module.default || '',
    modulePreloadUrls: module.modulePreloadUrls || [],
  }))
  .catch(() => ({ importMapJson: '', modulePreloadUrls: [] }))

let bootstrapScriptContentPromise: Promise<string> | undefined

function getBootstrapScriptContent() {
  const load = () => import.meta.viteRsc.loadBootstrapScriptContent('index')
  if (import.meta.hot) {
    return load()
  }
  bootstrapScriptContentPromise ??= load()
  return bootstrapScriptContentPromise
}

async function importRscEnvironment(): Promise<
  typeof import('./entry.rsc.js')
> {
  return import.meta.viteRsc.loadModule<typeof import('./entry.rsc.js')>(
    'rsc',
    'index',
  )
}

export async function fetchHandler(request: Request) {
  try {
    const url = new URL(request.url)
    const rscEntry = await importRscEnvironment()
    const response = await rscEntry.handler(request)

    if (!response.headers.get('content-type')?.startsWith('text/x-component')) {
      return response
    }

    if (url.searchParams.has('__rsc')) {
      return response
    }

    const htmlResponse = await renderHtml({ response, request })

    return htmlResponse
  } catch (err) {
    // In dev mode, re-throw so Vite's SSR middleware (catch → next(e)) can
    // forward the error to the error overlay via WebSocket.
    if (import.meta.hot) throw err
    console.error('[fetchHandler] unexpected error', err)
    return new Response('', { status: 500 })
  }
}

export async function renderHtml({
  response,
  request,
  prerender,
}: {
  prerender?: boolean
  request: Request
  response: Response
}) {
  // GET/HEAD requests only need one SSR-side decode. POST/form submissions still
  // split a second SSR copy to extract formState before hydrateRoot runs.
  const needsFormState = request.method !== 'GET' && request.method !== 'HEAD'
  const [flightForSsrOrForm, flightStream2] = response.body!.tee()
  const [flightForFormState, flightForSsr] = needsFormState
    ? flightForSsrOrForm.tee()
    : [undefined, flightForSsrOrForm]

  const [rawBootstrapScriptContent, importMap, deploymentId] = await Promise.all([
    getBootstrapScriptContent(),
    importMapPromise,
    getBootstrapDeploymentId(),
  ])
  // Stamp the build deployment id before the client entry runs so soft
  // navigations can detect a new deploy and hard-reload (see entry.client).
  const bootstrapScriptContent =
    deploymentIdBootstrapPrefix(deploymentId) + rawBootstrapScriptContent
  const { importMapJson, modulePreloadUrls } = importMap

  // Keep the first SSR-side createFromReadableStream call inside ReactDOMServer
  // render context so React can register preinit/preload hints for client refs.
  let payloadPromise: Promise<ServerPayload> | undefined
  const ssrRouterData = createRouterContextData(request)

  // Tree structure must match BrowserRoot in entry.client.tsx exactly so
  // React's useId() generates identical IDs during SSR and hydration.
  // FiberProvider (from its-fine) uses React fiber internals that crash in
  // SSR, so we use a no-op wrapper that occupies the same tree position.
  function SsrFiberProvider({ children }: { children: React.ReactNode }) {
    return <>{children}</>
  }

  // Placeholder for DefaultScrollRestoration which returns null but occupies
  // a sibling slot before LayoutContent in BrowserRoot. Without this, useId()
  // tree positions shift between SSR and hydration.
  function SsrScrollRestorationPlaceholder() {
    return null
  }

  // Placeholder for the toast renderer, which is a sibling of <ErrorBoundary>
  // inside <FiberProvider>. Must match tree structure for useId().
  function SsrToastRendererPlaceholder() {
    return null
  }

  function SsrRoot() {
    payloadPromise ??= createFromReadableStream<ServerPayload>(flightForSsr)
    const payload = React.use(payloadPromise!)
    ssrRouterData.loaderData = payload.root?.loaderData ?? {}
    const flightData = {
      payload: payloadPromise!,
      routerData: ssrRouterData,
    }
    return (
      <SsrFiberProvider>
        <ErrorBoundary errorComponent={DefaultGlobalErrorPage}>
          <NotFoundBoundary component={DefaultNotFoundPage}>
            <FlightDataContext.Provider value={flightData}>
              <SsrScrollRestorationPlaceholder />
              <LayoutContent />
            </FlightDataContext.Provider>
          </NotFoundBoundary>
        </ErrorBoundary>
        <SsrToastRendererPlaceholder />
      </SsrFiberProvider>
    )
  }

  let htmlStream: ReadableStream & { allReady: Promise<void> }
  // Preserve the status from the flight response (e.g. 404 for not-found pages)
  let status = response.status
  // When a page throws redirect/notFound, the error flows through the RSC
  // flight stream as a digest string. During SSR, it can surface through
  // onError (inside implicit Suspense from flight lazy chunks) instead of
  // rejecting renderToReadableStream. Capture it here so both paths — the
  // catch block and the onError callback — can short-circuit the response.
  let ssrErrorCtx: ReactServerErrorContext | undefined

  function shouldReplaceCtx(next: ReactServerErrorContext) {
    if (!ssrErrorCtx) return true
    // Redirect takes priority over notFound when multiple errors fire
    return Boolean(isRedirectError(next)) && !isRedirectError(ssrErrorCtx)
  }

  function handleErrorContext(ctx: ReactServerErrorContext) {
    if (isRedirectError(ctx)) {
      const mergedHeaders = new Headers(response.headers)
      for (const [k, v] of contextToHeaders(ctx)) {
        mergedHeaders.append(k, v)
      }
      // Override content-type so fetchHandler doesn't mistake this for a
      // flight response and try to SSR-render the null body.
      mergedHeaders.set('content-type', 'text/html;charset=utf-8')
      return new Response(null, { status: ctx.status, headers: mergedHeaders })
    }
    if (isNotFoundError(ctx)) {
      status = 404
    }
  }

  // Parse the import map JSON so React can emit it natively in <head>.
  // This ensures the import map appears before the bootstrap script even
  // when the React tree has no <html><head> shell (e.g. custom entry pages
  // that return <div> content directly). React's renderToReadableStream
  // emits the import map in the preamble, before bootstrapScriptContent.
  const parsedImportMap = importMapJson
    ? (() => {
        try {
          return JSON.parse(importMapJson)
        } catch {
          return undefined
        }
      })()
    : undefined

  try {
    const renderOptions = {
      bootstrapScriptContent,
      importMap: parsedImportMap,
      signal: request.signal,
      onError(e) {
        // Always log during prerender so build errors are visible instead of
        // being swallowed as a generic "500 Internal Server Error" HTML shell
        if (globalThis.__SPICEFLOW_PRERENDER) {
          console.error('[spiceflow:prerender:onError]', e)
        }
        const ctx = getErrorContext(e)
        if (ctx) {
          if (shouldReplaceCtx(ctx)) ssrErrorCtx = ctx
        } else {
          formatServerError(e)
          if (verboseLogs) {
            console.error('[entry.ssr.tsx:renderToReadableStream]', e)
          }
        }
        if (e && typeof e === 'object') {
          const digest = Reflect.get(e, 'digest')
          if (typeof digest === 'string') return sanitizeErrorMessage(digest)
        }
        if (e instanceof Error) return sanitizeErrorMessage(e.message)
        return sanitizeErrorMessage(String(e))
      },
    }

    if (flightForFormState) {
      const formStatePayload =
        await createFromReadableStream<ServerPayload>(flightForFormState)
      htmlStream = await ReactDOMServer.renderToReadableStream(<SsrRoot />, {
        ...renderOptions,
        formState: formStatePayload.formState,
      })
    } else {
      htmlStream = await ReactDOMServer.renderToReadableStream(
        <SsrRoot />,
        renderOptions,
      )
    }
    if (prerender || isbot(request.headers.get('user-agent') || '')) {
      await htmlStream.allReady
    } else {
      // Race allReady against a short timeout to catch redirect/notFound
      // errors from Suspense boundaries without blocking normal streaming.
      let timerId: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<void>((r) => {
        timerId = setTimeout(r, 50)
      })
      await Promise.race([
        htmlStream.allReady.finally(() => {
          if (timerId) clearTimeout(timerId)
        }),
        timeout,
      ])
    }

    if (ssrErrorCtx) {
      const res = handleErrorContext(ssrErrorCtx)
      if (res) return res
    }
  } catch (e) {
    // Always log during prerender so build errors are visible
    if (globalThis.__SPICEFLOW_PRERENDER) {
      console.error('[spiceflow:prerender:catch]', e)
    }
    // Client disconnects surface as abort errors when we race allReady.
    // Don't convert these to 500 error shells — just rethrow.
    if (e instanceof Error && e.name === 'AbortError') throw e
    if (request.signal.aborted) throw e

    status = 500
    const errCtx = getErrorContext(e)
    if (errCtx) {
      const res = handleErrorContext(errCtx)
      if (res) return res
    }

    const errorMessage = e instanceof Error ? e.message : String(e)
    const errorStack = e instanceof Error ? e.stack : undefined
    const isDev = !!import.meta.hot

    const errorRoot = (
      <html>
        <head>
          <meta charSet="utf-8" />
        </head>
        <body>
          <noscript>{status} Internal Server Error</noscript>
          {isDev && (
            <pre style={{ color: 'red', whiteSpace: 'pre-wrap', padding: '1rem', fontFamily: 'monospace' }}>
              {errorStack || errorMessage}
            </pre>
          )}
        </body>
      </html>
    )

    // Prepend self.__NO_HYDRATE=1 so the browser entry uses createRoot instead of hydrateRoot,
    // avoiding hydration mismatch errors against this error shell HTML.
    htmlStream = await ReactDOMServer.renderToReadableStream(errorRoot, {
      bootstrapScriptContent: `self.__NO_HYDRATE=1;${bootstrapScriptContent}`,
      importMap: parsedImportMap,
      signal: request.signal,
    })
  }

  return new Response(
    htmlStream.pipeThrough(
      injectRSCPayload({
        rscStream: flightStream2,
        // Import map is now handled by React's native importMap option
        // (emitted in the preamble before the bootstrap script). The
        // injectRSCPayload transform still handles modulepreload links
        // as a performance optimization when <head> is present.
        modulePreloadUrls,
      }),
    ),
    {
      status,
      headers: {
        ...Object.fromEntries(response.headers),
        'content-type': 'text/html;charset=utf-8',
      },
    },
  )
}

export async function prerender(request: Request) {
  const reactServer = await importRscEnvironment()
  const response = await reactServer.handler(request)
  const responseClone = response.clone()
  const htmlRes = await renderHtml({ response, request, prerender: true })
  const html = await htmlRes.text()
  return { rscResponse: responseClone, response, html }
}

export async function getPrerenderRoutes() {
  let rsc = await importRscEnvironment()
  const app = rsc.app
  return app
    .getAllRoutes()
    .filter(
      (route) =>
        route.kind === 'staticPage' ||
        route.kind === 'staticPageWithoutHandler' ||
        route.kind === 'staticGet',
    )
    .filter((x) => x.method === 'GET')
}

// Federation: decode a Flight payload and render it to an HTML string.
// Called from the RSC environment via loadModule('ssr', 'index').
export async function renderFlightToHtml(
  flightPayload: string | Uint8Array[],
): Promise<string> {
  const stream = new ReadableStream({
    start(controller) {
      if (typeof flightPayload === 'string') {
        controller.enqueue(new TextEncoder().encode(flightPayload))
      } else {
        for (const chunk of flightPayload) {
          controller.enqueue(chunk)
        }
      }
      controller.close()
    },
  })

  const tree: React.ReactNode = await createFromReadableStream(stream)
  const htmlStream = await ReactDOMServer.renderToReadableStream(
    React.createElement(React.Fragment, null, tree),
  )
  await htmlStream.allReady

  const reader = htmlStream.getReader()
  const decoder = new TextDecoder()
  let html = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    html += decoder.decode(value, { stream: true })
  }
  html += decoder.decode()

  return html
}
