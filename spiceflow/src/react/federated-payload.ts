import React from 'react'
import ReactDOM from 'react-dom'
import { EventSourceParserStream } from 'eventsource-parser/stream'
import { EsmIsland } from './esm-island.js'
import { RemoteIsland } from './remote-island.js'

const encoder = new TextEncoder()

function parseFlightChunk(value: string): string {
  const chunk = JSON.parse(value) as unknown
  if (typeof chunk !== 'string') {
    throw new Error('[decodeFederationPayload] Invalid flight chunk')
  }
  return chunk
}

export interface FederatedClientModuleInfo {
  chunks: string[]
  css: string[]
}

export interface FederatedPayloadMetadata {
  remoteId: string
  clientModules: Record<string, FederatedClientModuleInfo>
  cssLinks: string[]
}

// Incremental module announcement for streaming payloads. Client references
// discovered while the remote is still rendering arrive as `modules` events
// (always before the flight chunk that references them).
export interface FederationModulesPayload {
  clientModules: Record<string, FederatedClientModuleInfo>
  cssLinks: string[]
}

export interface ParsedFederatedFlightPayload {
  metadata: FederatedPayloadMetadata
  ssrHtml: string
  flightPayload: string
  flightChunks?: string[]
  remoteOrigin: string
}

export type FederationPayloadEvent =
  | {
      type: 'metadata'
      payload: FederatedPayloadMetadata
      remoteOrigin: string
    }
  | { type: 'ssr'; payload: string }
  | { type: 'modules'; payload: FederationModulesPayload }
  | { type: 'flight'; payload: string }
  | { type: 'done' }

interface DecodedFederationPayloadDetails<T = unknown> {
  value: T
  ssrHtml: string
  metadata: FederatedPayloadMetadata
  remoteOrigin: string
}

interface DecodeFederationOptions {
  // Auto-inject CSS into document.head. Defaults to true.
  // Set to false if you want to inject CSS into a custom target (e.g. Shadow DOM).
  injectCss?: boolean
}

interface FlightClientBrowser {
  createFromReadableStream<T>(
    stream: ReadableStream<Uint8Array>,
  ): PromiseLike<T>
  createFromFetch<T>(response: Promise<Response>): PromiseLike<T>
}

// Inject CSS links from federation metadata into document.head.
// Deduplicates by href so multiple calls with the same metadata are safe.
// Returns a promise that resolves when all newly injected stylesheets have
// loaded, so callers can await it to avoid a flash of unstyled content.
// Exported for consumers who want to call it manually (e.g. Shadow DOM).
export function injectFederationCss(
  metadata: Pick<FederatedPayloadMetadata, 'clientModules' | 'cssLinks'>,
  remoteOrigin: string,
): Promise<void> {
  if (typeof document === 'undefined') return Promise.resolve()
  const allCss = new Set<string>()
  for (const href of metadata.cssLinks ?? []) {
    allCss.add(resolveFederatedUrl(href, remoteOrigin))
  }
  for (const mod of Object.values(metadata.clientModules)) {
    for (const href of mod.css ?? []) {
      allCss.add(resolveFederatedUrl(href, remoteOrigin))
    }
  }
  const loadPromises: Promise<void>[] = []
  for (const href of allCss) {
    if (document.querySelector(`link[href="${CSS.escape(href)}"]`)) continue
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = href
    loadPromises.push(
      new Promise<void>((resolve) => {
        link.onload = () => resolve()
        link.onerror = () => resolve()
      }),
    )
    document.head.appendChild(link)
  }
  if (loadPromises.length === 0) return Promise.resolve()
  return Promise.all(loadPromises).then(() => undefined)
}

export function isJavaScriptContentType(contentType: string): boolean {
  return (
    contentType.includes('javascript') ||
    contentType.includes('ecmascript')
  )
}

export function resolveFederatedUrl(path: string, origin: string): string {
  const absolute = (() => {
    try {
      return new URL(path).toString()
    } catch {
      return null
    }
  })()
  if (absolute) return absolute
  if (origin) return new URL(path, origin).toString()
  if (typeof window !== 'undefined') {
    return new URL(path, window.location.origin).toString()
  }
  return path
}

function getResponseOrigin(response: Response): string {
  if (!response.url) return ''
  return new URL(response.url).origin
}

function getResponseContentType(response: Response): string {
  return (
    response.headers.get('content-type') ||
    response.headers.get('Content-Type') ||
    ''
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isJavaScriptIdentifier(value: string): boolean {
  return /^[$A-Z_a-z][$\w]*$/.test(value)
}

export async function* parseFederationPayload(
  response: Response,
  {
    signal,
  }: {
    signal?: AbortSignal
  } = {},
): AsyncGenerator<FederationPayloadEvent> {
  if (!response.ok) {
    throw new Error(
      `[decodeFederationPayload] Failed to read payload: ${response.status}`,
    )
  }

  const remoteOrigin = getResponseOrigin(response)

  const body = response.body
  if (!body) {
    return
  }

  const eventStream = body
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new EventSourceParserStream())
  const reader = eventStream.getReader()

  const abort = () => {
    void reader.cancel().catch(() => undefined)
  }

  if (signal) {
    if (signal.aborted) {
      abort()
      return
    }
    signal.addEventListener('abort', abort, { once: true })
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        return
      }

      const event = value
      if (!event) {
        continue
      }

      switch (event.event) {
        case 'metadata':
          yield {
            type: 'metadata',
            payload: JSON.parse(event.data) as FederatedPayloadMetadata,
            remoteOrigin,
          }
          break
        case 'ssr':
          yield {
            type: 'ssr',
            payload: JSON.parse(event.data).html as string,
          }
          break
        case 'modules':
          yield {
            type: 'modules',
            payload: JSON.parse(event.data) as FederationModulesPayload,
          }
          break
        case 'flight':
          yield { type: 'flight', payload: event.data }
          break
        case 'done':
          yield { type: 'done' }
          break
      }
    }
  } finally {
    if (signal) {
      signal.removeEventListener('abort', abort)
    }
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

async function collectFederationPayload(
  response: Response,
): Promise<ParsedFederatedFlightPayload> {
  let metadata: FederatedPayloadMetadata | null = null
  let ssrHtml = ''
  let remoteOrigin = ''
  const flightChunks: string[] = []

  for await (const event of parseFederationPayload(response)) {
    switch (event.type) {
      case 'metadata':
        metadata = event.payload
        remoteOrigin = event.remoteOrigin
        break
      case 'ssr':
        ssrHtml = event.payload
        break
      case 'modules':
        // Merge incremental module announcements into the metadata so
        // downstream consumers (RemoteIsland, decodeParsedFederationPayload)
        // see the complete module map.
        if (metadata) {
          Object.assign(metadata.clientModules, event.payload.clientModules)
          metadata.cssLinks = [
            ...new Set([...metadata.cssLinks, ...event.payload.cssLinks]),
          ]
        }
        break
      case 'flight':
        flightChunks.push(event.payload)
        break
    }
  }

  if (!metadata) {
    throw new Error('[decodeFederationPayload] No metadata event in response')
  }

  return {
    metadata,
    ssrHtml,
    flightPayload: flightChunks.map(parseFlightChunk).join(''),
    flightChunks,
    remoteOrigin,
  }
}

const remoteRegistry = new Map<string, Record<string, unknown>>()

// Bypasses bundler import() transformation (webpack, Vite, Rolldown).
// Without this, bundlers replace import() with their own module loading
// which can't handle HTTP URLs or runtime-computed specifiers.
function dynamicImport(url: string): Promise<any> {
  const importer = new Function('url', 'return import(url)') as (
    url: string,
  ) => Promise<any>
  return importer(url)
}

let requirePatched = false

function federationModuleError(id: string, cause?: unknown): Error {
  return new Error(
    `[federation] Failed to resolve client module "${id}". ` +
      `It was not registered from the remote's federation metadata ` +
      `(known remote modules: ${JSON.stringify([...remoteRegistry.keys()])}) ` +
      `and the host module registry could not load it either.`,
    cause === undefined ? undefined : { cause },
  )
}

// Patch the require globals so the Flight client resolves federation
// modules from remoteRegistry. Two globals matter:
//
// __vite_rsc_client_require__ — set by vite-rsc in Vite RSC hosts.
//   The Flight client calls __vite_rsc_require__ which dispatches to
//   __vite_rsc_client_require__ for client references.
//
// __vite_rsc_require__ — called directly by the embedded pre-built
//   Flight client in standalone mode (Next.js, plain SPA).
//
// Resolution order: host loader → remoteRegistry → descriptive error.
// The host loader MUST win for ids it can resolve. In same-site federation
// (host === remote, e.g. holocron chat) the remote's module ids are the
// host's own ids: after a federation decode populates remoteRegistry, a
// registry-first lookup would shadow the host loader and return the module
// namespace synchronously where the host flight client expects the host
// loader's promise — which broke client-side navigation on pages with an
// active chat session (blank page, `Uncaught undefined`). Host-first keeps
// host modules on the exact same code path as without federation.
//
// Remote-only ids reach the registry through the failure paths: a prod host
// loader throws synchronously ("client reference not found"), a dev host
// loader rejects asynchronously (404 on `import("/<hash>")`), and the
// standalone stub throws. All three fall back to remoteRegistry, and a
// registry miss produces a tagged federation error scoped to the referencing
// component instead of crashing the whole page.
// The wrapper MUST return the same value/promise instance for repeated
// requires of the same id. React's flight client requires each reference
// twice: preloadModule() instruments the returned promise (attaching
// .status/.value), then requireModule() reads those fields off the promise
// it gets back. Returning a fresh promise on the second call yields a
// thenable without .status, and React executes `throw moduleExports.reason`
// → `throw undefined`, which crashes the page with "Uncaught undefined".
function ensureRequirePatched() {
  if (requirePatched) return
  requirePatched = true
  const g = globalThis as any
  const wrapRequire = (fallback?: (id: string) => unknown) => {
    const cache = new Map<string, unknown>()
    return (id: string) => {
      if (cache.has(id)) return cache.get(id)
      const cleanId = id.split('$$cache=')[0]
      const fromRegistry = (cause?: unknown) => {
        const mod = remoteRegistry.get(cleanId)
        if (mod) return mod
        throw federationModuleError(cleanId, cause)
      }
      const result = (() => {
        if (!fallback) return fromRegistry()
        let loaded: unknown
        try {
          loaded = fallback(id)
        } catch (error) {
          return fromRegistry(error)
        }
        if (
          loaded &&
          typeof (loaded as PromiseLike<unknown>).then === 'function'
        ) {
          return Promise.resolve(loaded).catch((error) => fromRegistry(error))
        }
        return loaded
      })()
      cache.set(id, result)
      return result
    }
  }
  g.__vite_rsc_client_require__ = wrapRequire(g.__vite_rsc_client_require__)
  g.__vite_rsc_require__ = wrapRequire(g.__vite_rsc_require__)
}

// Load and register remote client modules. A failure to load one module must
// not abort the others (or the whole decode): the failed module surfaces as a
// scoped error when the Flight decoder resolves that specific reference, so
// the rest of the payload still renders.
export async function loadFederatedClientModules({
  clientModules,
  remoteOrigin,
}: {
  clientModules: Record<string, FederatedClientModuleInfo>
  remoteOrigin: string
}) {
  for (const [moduleId, info] of Object.entries(clientModules)) {
    const exportName = 'export_' + moduleId
    let fallback: Record<string, unknown> | undefined
    for (const chunkPath of info.chunks) {
      const chunkUrl = resolveFederatedUrl(chunkPath, remoteOrigin)
      // Shared dependency chunks are listed alongside the group chunk that
      // owns export_${id}. Import them for module graph/preload, but only
      // register when the export is present — otherwise a later shared chunk
      // overwrites the real client module and Flight resolves undefined.
      let mod: Record<string, unknown>
      try {
        mod = await dynamicImport(chunkUrl)
      } catch (error) {
        console.error(
          `[federation] Failed to load chunk "${chunkUrl}" for client module "${moduleId}"`,
          error,
        )
        continue
      }
      const exported = mod[exportName]
      if (isRecord(exported)) {
        remoteRegistry.set(moduleId, exported)
        continue
      }
      fallback = mod
    }
    if (!remoteRegistry.has(moduleId) && fallback) {
      remoteRegistry.set(moduleId, fallback)
    }
  }
}

// Allow external consumers (non-Vite-RSC apps) to inject a Flight client
// so decodeFederationPayload works without @vitejs/plugin-rsc/browser.
let overrideFlightClient: FlightClientBrowser | null = null

export function setFederationFlightClient(client: FlightClientBrowser) {
  overrideFlightClient = client
}

async function getFlightClientBrowser(): Promise<FlightClientBrowser> {
  if (overrideFlightClient) {
    return overrideFlightClient
  }

  const globalDecoder = globalThis.__spiceflow_createFromReadableStream
  if (globalDecoder) {
    return {
      createFromReadableStream: globalDecoder,
      createFromFetch: <T>(responsePromise: Promise<Response>) => {
        return Promise.resolve(responsePromise).then(async (response) => {
          if (!response.body) {
            throw new Error(
              '[decodeFederationPayload] Expected a response body for Flight decode',
            )
          }
          return globalDecoder<T>(response.body)
        })
      },
    }
  }

  throw new Error(
    '[federation] No Flight client available. In a standalone consumer, ' +
      'call setupFederationConsumer() before decoding federation payloads. ' +
      'In a Vite RSC host, the global decoder is set automatically by entry.client.',
  )
}

export async function decodeParsedFederationPayload<T = unknown>(
  parsed: ParsedFederatedFlightPayload,
): Promise<T> {
  if (typeof window === 'undefined') {
    throw new Error(
      '[decodeFederationPayload] This API is only available in the browser',
    )
  }

  await loadFederatedClientModules({
    clientModules: parsed.metadata.clientModules,
    remoteOrigin: parsed.remoteOrigin,
  })

  ensureRequirePatched()

  const { createFromFetch } = await getFlightClientBrowser()
  const chunks = parsed.flightChunks?.length
    ? parsed.flightChunks.map((chunk) => encoder.encode(parseFlightChunk(chunk)))
    : [encoder.encode(parsed.flightPayload)]

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk)
      }
      controller.close()
    },
  })

  const value = await createFromFetch<T>(
    Promise.resolve(
      new Response(stream, {
        headers: {
          'content-type': 'text/x-component;charset=utf-8',
        },
      }),
    ),
  )

  return value
}

async function readFederationPrelude(
  response: Response,
  {
    signal,
  }: {
    signal?: AbortSignal
  } = {},
) {
  const events = parseFederationPayload(response, { signal })

  try {
    const metadataEvent = await events.next()
    if (metadataEvent.done || metadataEvent.value.type !== 'metadata') {
      throw new Error('[decodeFederationPayload] No metadata event in response')
    }

    const { payload: metadata, remoteOrigin } = metadataEvent.value

    // Read until the ssr event (merging any early modules events into the
    // metadata). If a flight/done event arrives first, hand it back to the
    // caller as nextEvent.
    let ssrHtml = ''
    let nextEvent: FederationPayloadEvent | null = null
    while (true) {
      const event = await events.next()
      if (event.done) break
      if (event.value.type === 'modules') {
        Object.assign(metadata.clientModules, event.value.payload.clientModules)
        metadata.cssLinks = [
          ...new Set([...metadata.cssLinks, ...event.value.payload.cssLinks]),
        ]
        continue
      }
      if (event.value.type === 'ssr') {
        ssrHtml = event.value.payload
        break
      }
      nextEvent = event.value
      break
    }

    return {
      events,
      metadata,
      remoteOrigin,
      nextEvent,
      ssrHtml,
    }
  } catch (error) {
    await events.return(undefined).catch(() => undefined)
    throw error
  }
}

export async function decodeFederationPayloadDetails<T = unknown>(
  response: Response,
  options: DecodeFederationOptions = {},
): Promise<DecodedFederationPayloadDetails<T>> {
  if (typeof window === 'undefined') {
    throw new Error(
      '[decodeFederationPayload] This API is only available in the browser',
    )
  }

  const eventsAbortController = new AbortController()
  const { events, metadata, nextEvent, remoteOrigin, ssrHtml } =
    await readFederationPrelude(response, {
      signal: eventsAbortController.signal,
    })

  let eventsStopped = false
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined
  const stopEvents = async () => {
    if (eventsStopped) return
    eventsStopped = true
    eventsAbortController.abort()
    if (!events.return) return
    await events.return(undefined).catch(() => undefined)
  }
  const enqueueFlightChunk = (chunk: string) => {
    if (eventsStopped) return false

    const bytes = (() => {
      try {
        return encoder.encode(parseFlightChunk(chunk))
      } catch (error) {
        controllerRef?.error(error)
        throw error
      }
    })()

    try {
      controllerRef?.enqueue(bytes)
      return true
    } catch {
      return false
    }
  }

  try {
    // Start CSS injection before loading JS modules so the browser
    // fetches stylesheets in parallel with client component chunks.
    // We await the CSS promise later so components don't render
    // before styles are ready (prevents flash of unstyled content).
    const cssReady = options.injectCss !== false
      ? injectFederationCss(metadata, remoteOrigin)
      : undefined

    await loadFederatedClientModules({
      clientModules: metadata.clientModules,
      remoteOrigin,
    })

    await cssReady

    ensureRequirePatched()

    const flightStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controllerRef = controller
      },
      async cancel() {
        await stopEvents()
      },
    })

    // Incremental module announcements: load the newly announced chunks (and
    // inject their CSS) BEFORE enqueueing any subsequent flight chunk, so the
    // Flight decoder never resolves a client reference whose module was not
    // registered yet. The pump is sequential, so awaiting here provides that
    // ordering guarantee.
    const handleModulesEvent = async (payload: FederationModulesPayload) => {
      if (options.injectCss !== false) {
        void injectFederationCss(payload, remoteOrigin)
      }
      await loadFederatedClientModules({
        clientModules: payload.clientModules,
        remoteOrigin,
      })
    }

    const pump = (async () => {
      if (nextEvent?.type === 'flight') {
        if (!enqueueFlightChunk(nextEvent.payload)) {
          await stopEvents()
          return
        }
      }

      for await (const event of events) {
        if (eventsStopped) return

        if (event.type === 'modules') {
          await handleModulesEvent(event.payload)
          continue
        }
        if (event.type === 'flight') {
          if (!enqueueFlightChunk(event.payload)) {
            await stopEvents()
            return
          }
          continue
        }
        if (event.type === 'done') {
          break
        }
      }

      if (eventsStopped) return

      try {
        controllerRef?.close()
      } catch {}
    })().catch(async (error) => {
      if (eventsStopped) return

      try {
        controllerRef?.error(error)
      } catch {}

      await stopEvents()
    })

    const { createFromFetch } = await getFlightClientBrowser()
    const value = await createFromFetch<T>(
      Promise.resolve(
        new Response(flightStream, {
          headers: {
            'content-type': 'text/x-component;charset=utf-8',
          },
        }),
      ),
    )

    void pump

    return {
      value,
      ssrHtml,
      metadata,
      remoteOrigin,
    }
  } catch (error) {
    await stopEvents()
    throw error
  }
}

export async function decodeFederationPayload<T = unknown>(
  response: Response,
): Promise<T> {
  const decoded = await decodeFederationPayloadDetails<T>(response)
  return decoded.value
}

export async function RenderFederatedPayload({
  response,
  isolateStyles,
}: {
  response: Response
  isolateStyles?: boolean
}) {
  const contentType = getResponseContentType(response)
  if (isJavaScriptContentType(contentType)) {
    const src = response.url
    return React.createElement(EsmIsland, { src })
  }

  const parsed = await collectFederationPayload(response)

  const cssLinks = parsed.metadata.cssLinks ?? []

  if (isolateStyles) {
    for (const cssHref of cssLinks) {
      ReactDOM.preload(resolveFederatedUrl(cssHref, parsed.remoteOrigin), {
        as: 'style',
      })
    }
  } else {
    for (const cssHref of cssLinks) {
      ReactDOM.preinit(resolveFederatedUrl(cssHref, parsed.remoteOrigin), {
        as: 'style',
        precedence: 'spiceflow-federation',
      })
    }
  }

  return React.createElement(RemoteIsland, { parsed, isolateStyles })
}

// ---------------------------------------------------------------------------
// Standalone federation consumer setup
// ---------------------------------------------------------------------------
// Sets up everything needed for a non-Vite-RSC app (plain React SPA, Next.js,
// etc.) to consume federation payloads from a remote spiceflow server.
//
// Three things happen:
// 1. Module globals: stores the host's React/ReactDOM module namespaces on a
//    global so that blob-URL wrapper modules can re-export them. This ensures
//    remote federation chunks (loaded via dynamic import) share the same React
//    instance as the host app.
// 2. Import map: injects a <script type="importmap"> with blob URLs that map
//    bare specifiers ("react", "react-dom", etc.) to wrapper modules that read
//    from the global. Requires browser support for multiple import maps
//    (Chrome 133+, Firefox 136+, Safari 18.4+).
// 3. Flight client: wraps react-server-dom-webpack's createFromReadableStream
//    and createFromFetch so decodeFederationPayload works without
//    @vitejs/plugin-rsc/browser.

const GLOBAL_KEY = '__SPICEFLOW_FEDERATION__'

interface FederationConsumerOptions {
  // The react-server-dom-webpack/client.browser module. When omitted,
  // spiceflow auto-loads its embedded pre-built copy via a blob URL.
  // Only pass this if you need a specific version or custom build.
  reactServerDomWebpack?: {
    createFromReadableStream: (
      stream: ReadableStream<Uint8Array>,
      options?: any,
    ) => PromiseLike<any>
    createFromFetch: (
      response: Promise<Response>,
      options?: any,
    ) => PromiseLike<any>
  }
  // Map of bare specifiers to their module namespace objects. The host app
  // must pass its own bundled React modules so remote chunks use the same
  // instance. Typical entries:
  //   'react': import * as React from 'react'
  //   'react/jsx-runtime': import * as JsxRuntime from 'react/jsx-runtime'
  //   'react-dom': import * as ReactDOM from 'react-dom'
  //   'react-dom/client': import * as ReactDOMClient from 'react-dom/client'
  modules: Record<string, Record<string, unknown>>
}

const SETUP_PROMISE_KEY = '__SPICEFLOW_FEDERATION_SETUP__'

export async function setupFederationConsumer(
  options: FederationConsumerOptions,
) {
  const g = globalThis as any

  // SSR guard: blob URLs and import maps are browser-only.
  if (typeof document === 'undefined') return

  // Concurrent callers (React Strict Mode, HMR) await the same promise
  // so setup completes fully before any caller proceeds.
  if (g[SETUP_PROMISE_KEY]) return g[SETUP_PROMISE_KEY]

  const promise = setupFederationConsumerInner(options).catch((error) => {
    delete g[GLOBAL_KEY]
    delete g[SETUP_PROMISE_KEY]
    throw error
  })
  g[SETUP_PROMISE_KEY] = promise
  return promise
}

async function setupFederationConsumerInner(
  options: FederationConsumerOptions,
) {
  let { reactServerDomWebpack, modules } = options
  const g = globalThis as any

  const jsxRuntime = modules['react/jsx-runtime']
  const jsxDevRuntime = modules['react/jsx-dev-runtime']
  if (
    isRecord(jsxRuntime) &&
    isRecord(jsxDevRuntime) &&
    typeof jsxDevRuntime.jsxDEV !== 'function' &&
    typeof jsxRuntime.jsx === 'function'
  ) {
    modules = {
      ...modules,
      'react/jsx-dev-runtime': {
        ...jsxDevRuntime,
        jsxDEV: jsxRuntime.jsx,
      },
    }
  }

  // 1. Store modules on global for blob URL wrappers to read
  g[GLOBAL_KEY] = modules

  // 2. Create blob URL wrapper modules and inject import map.
  //
  // Why this is needed: the spiceflow remote's Vite build externalizes React
  // (react, react-dom, spiceflow/react) so client component chunks are small
  // and don't bundle their own copy of React. This means the built chunks
  // contain bare specifiers like `import "react"`. When the standalone
  // consumer dynamically imports those chunks from the remote origin, the
  // browser resolves bare specifiers via import maps since no bundler is
  // involved at that point.
  //
  // This import map does NOT affect the host app's bundled imports. In
  // Next.js, webpack/turbopack resolves imports at build time and ignores
  // import maps entirely. The map is only needed for remote chunks loaded at
  // runtime via dynamic import() from another origin.
  const imports: Record<string, string> = {}
  for (const [specifier, mod] of Object.entries(modules)) {
    const defaultExport = mod.default
    const defaultKeys = isRecord(defaultExport) ? Object.keys(defaultExport) : []
    const keys = [...new Set([...Object.keys(mod), ...defaultKeys])].filter(
      (k) => k !== '__esModule' && k !== 'default' && isJavaScriptIdentifier(k),
    )
    const ref = `globalThis[${JSON.stringify(GLOBAL_KEY)}][${JSON.stringify(specifier)}]`
    const lines = [
      `const __m = ${ref};`,
      ...keys.map(
        (k) =>
          `export const ${k} = __m[${JSON.stringify(k)}] ?? __m.default?.[${JSON.stringify(k)}];`,
      ),
      `export default __m.default !== undefined ? __m.default : __m;`,
    ]
    const blob = new Blob([lines.join('\n')], { type: 'text/javascript' })
    imports[specifier] = URL.createObjectURL(blob)
  }

  const script = document.createElement('script')
  script.type = 'importmap'
  script.textContent = JSON.stringify({ imports })
  document.head.appendChild(script)

  // 3. Auto-load Flight client from embedded source if not provided.
  // The embedded copy has __webpack_require__ replaced with
  // globalThis.__vite_rsc_require__ and a require() shim for React.
  if (!reactServerDomWebpack) {
    const { FLIGHT_CLIENT_SOURCE } = await import(
      './federation-flight-client-source.js'
    )
    // The Flight client's require("react") shim reads from this global
    g.__FEDERATION_MODULES__ = {
      react: modules['react'],
      'react-dom': modules['react-dom'],
    }
    // Ensure __vite_rsc_require__ exists with .u stub before the module
    // evaluates (it reads .u at the top level for chunk filename resolution)
    if (!g.__vite_rsc_require__) {
      const stub = ((id: string) => {
        throw new Error(`[federation] Module not found: ${id}`)
      }) as any
      stub.u = undefined
      g.__vite_rsc_require__ = stub
    }
    const blob = new Blob([FLIGHT_CLIENT_SOURCE], {
      type: 'text/javascript',
    })
    const url = URL.createObjectURL(blob)
    reactServerDomWebpack = await dynamicImport(url)
    URL.revokeObjectURL(url)
  }

  // 4. Set up Flight client
  const callServer = () => {
    throw new Error(
      'Server actions are not supported in standalone federation consumers',
    )
  }
  setFederationFlightClient({
    createFromReadableStream<T>(stream: ReadableStream<Uint8Array>) {
      return reactServerDomWebpack!.createFromReadableStream(stream, {
        callServer,
      })
    },
    createFromFetch<T>(response: Promise<Response>) {
      return reactServerDomWebpack!.createFromFetch(response, { callServer })
    },
  })

  // 5. Patch require globals for standalone mode
  ensureRequirePatched()
}
