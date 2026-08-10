// RSC URL helpers, flight response utilities, and deployment skew detection.
//
// Each production build stamps a unique deployment id (build timestamp). The
// server sends it as `x-spiceflow-deployment-id` on every flight response. The
// client bootstrap stores the id from the HTML load. On soft navigation, if
// the header does not match the bootstrap id, the client hard-reloads so it
// never tries to import deleted content-hashed chunks from a previous deploy
// (e.g. Cloudflare Assets, which replace the whole asset set per deploy).

/** Response header carrying the build deployment id on flight payloads. */
export const DEPLOYMENT_ID_HEADER = 'x-spiceflow-deployment-id'

/** Global set by the SSR bootstrap script before the client entry loads. */
export const CLIENT_DEPLOYMENT_ID_GLOBAL = '__SPICEFLOW_DEPLOYMENT_ID__'

export function stripRscUrl(url: URL) {
  const next = new URL(url.href)
  if (next.pathname.endsWith('/index.rsc')) {
    next.pathname = next.pathname.slice(0, -9)
  } else if (next.pathname.endsWith('.rsc')) {
    next.pathname = next.pathname.slice(0, -4)
  }
  next.searchParams.delete('__rsc')
  return next
}

export function getDocumentPath(url: URL) {
  const next = stripRscUrl(url)
  return `${next.pathname}${next.search}${next.hash}`
}

export function getDocumentLocationFromResponse(args: {
  response: Response
  requestUrl: URL
}) {
  if (args.response.redirected && args.response.url) {
    return toSameOriginDocumentLocation({
      location: args.response.url,
      requestUrl: args.requestUrl,
    })
  }

  return getDocumentPath(args.requestUrl)
}

function toSameOriginDocumentLocation(args: {
  location: string
  requestUrl: URL
}) {
  const fallbackLocation = getDocumentPath(args.requestUrl)

  try {
    const targetUrl = new URL(args.location, args.requestUrl)
    if (targetUrl.origin !== args.requestUrl.origin) {
      return fallbackLocation
    }
    return `${targetUrl.pathname}${targetUrl.search}${targetUrl.hash}`
  } catch {
    return fallbackLocation
  }
}

export function isDocumentRequest(request: Request) {
  return request.headers.get('sec-fetch-dest') === 'document'
}

export function isRscRequest(url: URL) {
  return url.pathname.endsWith('.rsc') || url.searchParams.has('__rsc')
}

export function isFlightResponse(response: Response) {
  const contentType = response.headers.get('content-type') || ''
  return contentType.startsWith('text/x-component')
}

/** True when both ids are non-empty and differ — a new deploy is live. */
export function isDeploymentSkew(args: {
  clientDeploymentId: string
  serverDeploymentId: string | null
}): boolean {
  const client = args.clientDeploymentId
  const server = args.serverDeploymentId?.trim() || ''
  if (!client || !server) return false
  return client !== server
}

/**
 * Inline script prefix that stamps the deployment id on `globalThis` before
 * the client entry module runs. Empty string when id is unavailable (dev).
 */
export function deploymentIdBootstrapPrefix(deploymentId: string): string {
  if (!deploymentId) return ''
  return `self.${CLIENT_DEPLOYMENT_ID_GLOBAL}=${JSON.stringify(deploymentId)};`
}

export function readClientDeploymentId(
  globalObject: typeof globalThis = globalThis,
): string {
  const value = Reflect.get(globalObject, CLIENT_DEPLOYMENT_ID_GLOBAL)
  return typeof value === 'string' ? value : ''
}

// Wrap __vite_rsc_*_require__ with per-ID caching and an error handler.
// Cache guarantees same promise instance for repeated requires (React needs
// this: preloadModule sets .status/.value, requireModule reads them back).
export function wrapRequireWithFallback(
  original: ((id: string) => unknown) | undefined,
  onError: (id: string, cleanId: string, cause: unknown) => unknown,
): (id: string) => unknown {
  const cache = new Map<string, unknown>()
  return (id: string) => {
    if (cache.has(id)) return cache.get(id)
    const cleanId = id.split('$$cache=')[0]
    const result = (() => {
      if (!original) return onError(id, cleanId, undefined)
      let loaded: unknown
      try {
        loaded = original(id)
      } catch (error) {
        return onError(id, cleanId, error)
      }
      if (loaded && typeof (loaded as PromiseLike<unknown>).then === 'function') {
        return Promise.resolve(loaded).catch((error) => onError(id, cleanId, error))
      }
      return loaded
    })()
    cache.set(id, result)
    return result
  }
}

// Production-only recovery: hard-reload on missing client refs (stale JS after
// deploy). Uses sessionStorage to prevent infinite loops (60s window keyed by
// deployment + module ID).
const RECOVERY_STORAGE_KEY = '__spiceflow_module_recovery__'
const RECOVERY_WINDOW_MS = 60_000

export function recoveryReload(id: string, cleanId: string, err: unknown): never {
  const deploymentId = readClientDeploymentId()
  const recoveryId = `${deploymentId}:${cleanId}`

  let canReload = false
  try {
    const recovered = JSON.parse(
      sessionStorage.getItem(RECOVERY_STORAGE_KEY) || '{}',
    )
    const recoveredAt = Number(recovered[recoveryId])
    if (!recoveredAt || Date.now() - recoveredAt >= RECOVERY_WINDOW_MS) {
      recovered[recoveryId] = Date.now()
      sessionStorage.setItem(RECOVERY_STORAGE_KEY, JSON.stringify(recovered))
      canReload = true
    }
  } catch {
    // Storage unavailable — don't reload to avoid infinite loop
  }

  if (!canReload) throw err

  console.error('[spiceflow] Client module missing, reloading:', id, err)
  globalThis.location.replace(globalThis.location.href)
  // Never resolves — page is reloading
  return new Promise<never>(() => {}) as never
}
