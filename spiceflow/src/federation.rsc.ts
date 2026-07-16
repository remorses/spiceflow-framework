// Federation RSC entry point. Renders a Flight-serializable value to an SSE
// response containing metadata, optional SSR HTML, and streamed Flight rows.
// Reader aborts are wired through so cancelling the outer response also stops
// the underlying Flight stream instead of leaving it pending in the background.
import React from 'react'
import { renderToReadableStream } from '#rsc-runtime'
import { bindAbortToReader } from './client/shared.js'
import { getBasePath } from './base-path.js'
import { federationDevCssPath } from './federation-dev-externalize.js'

export { renderToReadableStream }

const encoder = new TextEncoder()

function decodeFlightChunks(chunks: Uint8Array[]): string[] {
  const decoder = new TextDecoder()
  const textChunks: string[] = []
  for (const chunk of chunks) {
    const text = decoder.decode(chunk, { stream: true })
    if (text) textChunks.push(text)
  }
  const rest = decoder.decode()
  if (rest) textChunks.push(rest)
  return textChunks
}

async function streamToString({
  stream,
  signal,
}: {
  stream: ReadableStream<Uint8Array>
  signal?: AbortSignal
}): Promise<string> {
  const reader = stream.getReader()
  const unbindAbort = bindAbortToReader({ reader, signal })
  const decoder = new TextDecoder()
  let result = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      result += decoder.decode(value, { stream: true })
    }
    result += decoder.decode()
    return result
  } finally {
    unbindAbort()
    reader.releaseLock()
  }
}

async function streamToChunks({
  stream,
  signal,
}: {
  stream: ReadableStream<Uint8Array>
  signal?: AbortSignal
}) {
  const reader = stream.getReader()
  const unbindAbort = bindAbortToReader({ reader, signal })
  const chunks: Uint8Array[] = []
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
    }
    return chunks
  } finally {
    unbindAbort()
    reader.releaseLock()
  }
}

async function renderFlightStreamToHtml({
  stream,
  signal,
}: {
  stream: ReadableStream<Uint8Array>
  signal?: AbortSignal
}) {
  const flightPayload = await streamToString({ stream, signal })
  const ssrModule = await import.meta.viteRsc.loadModule<
    typeof import('./react/entry.ssr.js')
  >('ssr', 'index')
  return await ssrModule.renderFlightToHtml(flightPayload)
}

export async function renderToStaticMarkup(value: React.ReactNode) {
  return await renderFlightStreamToHtml({
    stream: renderToReadableStream(value),
  })
}

function formatSSEEvent(event: string, data: string): string {
  return `event: ${event}\ndata: ${data}\n\n`
}

async function* streamFlightChunks(
  {
    stream,
    signal,
  }: {
    stream: ReadableStream<Uint8Array>
    signal?: AbortSignal
  },
): AsyncGenerator<string> {
  const reader = stream.getReader()
  const unbindAbort = bindAbortToReader({ reader, signal })
  const decoder = new TextDecoder()
  let finished = false

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        finished = true
        break
      }

      const chunk = decoder.decode(value, { stream: true })
      if (chunk) yield chunk
    }

    const rest = decoder.decode()
    if (rest) yield rest
  } finally {
    unbindAbort()
    if (!finished) {
      await reader.cancel().catch(() => undefined)
    }
    reader.releaseLock()
  }
}

interface FederationPayloadMetadata {
  remoteId: string
  clientModules: Record<string, { chunks: string[]; css: string[] }>
  cssLinks: string[]
}

// Incremental module announcement. Streaming payloads (async generators)
// discover client references lazily while rendering, long after the initial
// `metadata` event was sent. Each `modules` event announces the client
// modules discovered since the previous event, and is always emitted BEFORE
// the flight chunk that references them, so consumers can load the chunks
// before the Flight decoder resolves the reference.
interface FederationModulesPayload {
  clientModules: Record<string, { chunks: string[]; css: string[] }>
  cssLinks: string[]
}

type FederationPayloadEvent =
  | { type: 'metadata'; payload: FederationPayloadMetadata }
  | { type: 'ssr'; payload: string }
  | { type: 'modules'; payload: FederationModulesPayload }
  | { type: 'flight'; payload: string }
  | { type: 'done' }

function withBase(path: string): string {
  const base = getBasePath()
  if (!base || !path.startsWith('/')) return path
  if (path === base) return path
  const next = path.charAt(base.length)
  if (path.startsWith(base) && (next === '/' || next === '?' || next === '#')) {
    return path
  }
  return base + path
}

// vite-rsc merges the client entry (`index` chunk) into every client
// reference's deps for full-page hydration. After merge, group deps come
// first and entry-only deps follow the entry file (mergeAssetDeps). Federation
// hosts already have their own entry; loading the producer's re-bootstraps RSC.
//
// spiceflow client modules are grouped as `spiceflow-framework` via
// clientChunks so hosts share React/spiceflow through the import map.
function isFrameworkClientChunk(js: string): boolean {
  return js.includes('spiceflow-framework')
}

// Exact client entry chunk URL, resolved once from vite-rsc's assets
// manifest. `loadBootstrapScriptContent('index')` returns
// `import("<entry-url>")` in production builds, so we can extract the real
// filename instead of guessing with an `index-*.js` regex — a user file
// named `index.tsx` would otherwise be misclassified and silently dropped.
let clientEntryChunkPromise: Promise<string | null> | null = null
function resolveClientEntryChunk(): Promise<string | null> {
  if (clientEntryChunkPromise) return clientEntryChunkPromise
  clientEntryChunkPromise = (async () => {
    try {
      const content =
        await import.meta.viteRsc.loadBootstrapScriptContent('index')
      const match = content.match(/import\("([^"]+)"\)/)
      return match?.[1] ?? null
    } catch {
      // Not running inside a Vite RSC build (tests, vitest mode) — fall back
      // to the name heuristic in isClientEntryChunk.
      return null
    }
  })()
  return clientEntryChunkPromise
}

function isClientEntryChunk(js: string, entryChunkUrl: string | null): boolean {
  if (entryChunkUrl) return js === entryChunkUrl
  // Fallback heuristic when the entry name could not be determined.
  // Client entry is always named "index" by vite-rsc (loadBootstrapScriptContent('index')).
  return (
    /(?:^|\/)index-[^/?#]+\.js(?:[?#]|$)/.test(js) ||
    /(?:^|\/)index\.js(?:[?#]|$)/.test(js)
  )
}

function selectClientChunks(
  jsDeps: string[],
  entryChunkUrl: string | null,
): string[] {
  const chunks: string[] = []
  for (const js of jsDeps) {
    // Skip the client entry — federation hosts already have their own entry
    // and loading the remote's would re-bootstrap RSC. Also skip framework
    // chunks since hosts share React/spiceflow via the import map.
    //
    // We use `continue` (not `break`) because non-framework, non-entry
    // chunks can appear after the entry in deps. vite-rsc's mergeAssetDeps
    // puts group deps first, then the entry file, but custom entry chunks
    // (e.g. worker-entry) that contain export_${moduleId} may follow.
    // Breaking at the entry would silently drop those modules.
    if (isClientEntryChunk(js, entryChunkUrl)) continue
    if (isFrameworkClientChunk(js)) continue
    chunks.push(js)
  }
  return chunks
}

function mergeUnique(existing: string[], next: string[]): string[] {
  if (next.length === 0) return existing
  if (existing.length === 0) return next
  const seen = new Set(existing)
  const merged = existing.slice()
  for (const item of next) {
    if (seen.has(item)) continue
    seen.add(item)
    merged.push(item)
  }
  return merged
}

async function* encodeFederationPayloadEvents({
  value,
  signal,
}: {
  value: unknown
  signal?: AbortSignal
}): AsyncGenerator<FederationPayloadEvent> {
  const remoteId = 'r_' + Math.random().toString(36).slice(2, 10)

  const clientModules: Record<string, { chunks: string[]; css: string[] }> = {}
  const cssLinksSet = new Set<string>()

  // Resolve the exact client entry chunk BEFORE rendering starts —
  // onClientReference fires synchronously during Flight serialization.
  const entryChunkUrl = import.meta.hot
    ? null
    : await resolveClientEntryChunk()

  const flightStream = renderToReadableStream(
    value,
    undefined,
    {
      onClientReference(metadata: {
        id: string
        name: string
        deps: { js: string[]; css: string[] }
      }) {
        const devCss = import.meta.hot && metadata.deps.css.length === 0
          ? [
              `${federationDevCssPath}?module=${encodeURIComponent(metadata.id)}`,
            ]
          : []
        const cssDeps = mergeUnique(metadata.deps.css, devCss)
        for (const css of cssDeps) {
          cssLinksSet.add(withBase(css))
        }

        const chunks = (() => {
          if (metadata.deps.js.length > 0) {
            return [
              ...new Set(
                selectClientChunks(metadata.deps.js, entryChunkUrl).map(
                  withBase,
                ),
              ),
            ]
          }
          // No deps in the manifest. In dev, ids are importable paths
          // (`/src/counter.tsx`), so the id itself is the chunk. In
          // production, ids are opaque hashes that are NOT URLs — never
          // emit them as chunks (the consumer would 404 on `https://remote/<hash>`).
          if (import.meta.hot) return [withBase(metadata.id)]
          return []
        })()

        if (chunks.length === 0 && !import.meta.hot) {
          // The module's code only lives in the entry/framework chunks (or
          // the manifest had no deps). Cross-site consumers cannot load it;
          // same-site consumers resolve it through the host's own registry.
          // Still announce the module (with no chunks) so consumers get a
          // precise error instead of a silently missing reference.
          console.error(
            `[spiceflow federation] client module "${metadata.id}" (${metadata.name}) has no loadable chunks. ` +
              `Raw deps: ${JSON.stringify(metadata.deps.js)}. ` +
              `Cross-origin consumers will not be able to load this component.`,
          )
        }

        const css = cssDeps.map(withBase)
        const existing = clientModules[metadata.id]
        if (!existing) {
          clientModules[metadata.id] = { chunks, css }
          return
        }

        existing.chunks = mergeUnique(existing.chunks, chunks)
        existing.css = mergeUnique(existing.css, css)
      },
    },
  )

  if (React.isValidElement(value)) {
    const flightChunks = await streamToChunks({
      stream: flightStream,
      signal,
    })
    let ssrHtml = ''
    try {
      const ssrModule = await import.meta.viteRsc.loadModule<
        typeof import('./react/entry.ssr.js')
      >('ssr', 'index')
      ssrHtml = await ssrModule.renderFlightToHtml(flightChunks)
    } catch {
      // SSR HTML is best-effort — degrade to empty string (client decoding
      // still works, the user just sees a brief flash of empty content).
    }

    yield {
      type: 'metadata',
      payload: {
        remoteId,
        clientModules,
        cssLinks: [...cssLinksSet],
      },
    }
    yield { type: 'ssr', payload: ssrHtml }

    for (const chunk of decodeFlightChunks(flightChunks)) {
      yield { type: 'flight', payload: JSON.stringify(chunk) }
    }

    yield { type: 'done' }
    return
  }

  // Streaming payloads (async generators) render lazily: client references
  // are discovered while the consumer is already reading flight chunks.
  // Track what was announced so far and emit `modules` events just-in-time —
  // always BEFORE the flight chunk that references the new modules, since
  // onClientReference fires synchronously during Flight serialization,
  // before the serialized chunk is handed to our reader.
  const announcedModules = new Set<string>()
  const announcedCss = new Set<string>()

  const takeModulesIncrement = (): FederationModulesPayload | null => {
    let newModules: Record<string, { chunks: string[]; css: string[] }> | null =
      null
    for (const [id, info] of Object.entries(clientModules)) {
      if (announcedModules.has(id)) continue
      announcedModules.add(id)
      newModules ??= {}
      newModules[id] = { chunks: [...info.chunks], css: [...info.css] }
    }
    let newCss: string[] | null = null
    for (const css of cssLinksSet) {
      if (announcedCss.has(css)) continue
      announcedCss.add(css)
      newCss ??= []
      newCss.push(css)
    }
    if (!newModules && !newCss) return null
    return { clientModules: newModules ?? {}, cssLinks: newCss ?? [] }
  }

  // Snapshot the initial metadata (mutable clientModules keeps growing) and
  // mark everything in it as announced.
  const initialIncrement = takeModulesIncrement()
  yield {
    type: 'metadata',
    payload: {
      remoteId,
      clientModules: initialIncrement?.clientModules ?? {},
      cssLinks: initialIncrement?.cssLinks ?? [],
    },
  }
  yield { type: 'ssr', payload: '' }

  for await (const chunk of streamFlightChunks({
    stream: flightStream,
    signal,
  })) {
    const increment = takeModulesIncrement()
    if (increment) {
      yield { type: 'modules', payload: increment }
    }
    yield { type: 'flight', payload: JSON.stringify(chunk) }
  }

  const finalIncrement = takeModulesIncrement()
  if (finalIncrement) {
    yield { type: 'modules', payload: finalIncrement }
  }

  yield { type: 'done' }
}

/**
 * Renders any Flight-serializable value to a federation Response in SSE format.
 *
 * The response contains these events in order:
 * - `metadata` — remoteId, clientModules map, cssLinks
 * - `ssr` — pre-rendered HTML for immediate display when the top-level payload is a React element
 * - `modules` (zero or more) — incremental clientModules/cssLinks discovered
 *   while streaming; always emitted before the flight chunk that references them
 * - `flight` (one or more) — RSC Flight payload rows
 * - `done` — signals the end of the payload
 *
 * Call this from a route handler to expose a Flight payload for federation.
 * The returned Response has the correct content-type and CORS headers.
 */
export async function encodeFederationPayload(value: unknown): Promise<Response> {
  const abortController = new AbortController()
  const iterator = encodeFederationPayloadEvents({
    value,
    signal: abortController.signal,
  })[Symbol.asyncIterator]()
  let closed = false

  const cleanup = async () => {
    if (closed) return
    closed = true
    abortController.abort()
    if (!iterator.return) return
    await iterator.return(undefined).catch(() => undefined)
  }

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (closed) {
        controller.close()
        return
      }

      try {
        const next = await iterator.next()
        if (next.done) {
          await cleanup()
          controller.close()
          return
        }

        const data = (() => {
          switch (next.value.type) {
            case 'metadata':
              return JSON.stringify(next.value.payload)
            case 'ssr':
              return JSON.stringify({ html: next.value.payload })
            case 'modules':
              return JSON.stringify(next.value.payload)
            case 'flight':
              return next.value.payload
            case 'done':
              return ''
          }
        })()

        controller.enqueue(
          encoder.encode(formatSSEEvent(next.value.type, data)),
        )
      } catch (error) {
        await cleanup()
        controller.error(error)
      }
    },
    async cancel() {
      await cleanup()
    },
  })

  return new Response(body, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'content-encoding': 'none',
      'cache-control': 'no-cache',
      'access-control-allow-origin': '*',
    },
  })
}

export const renderFlightPayload = encodeFederationPayload
export const renderComponentPayload = encodeFederationPayload
