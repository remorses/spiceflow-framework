// Browser entry point. Hydrates the React tree from the RSC payload
// embedded in the HTML, sets up client-side navigation and server action calls.
import React from 'react'
import ReactDomClient from 'react-dom/client'
import {
  __actionAbortControllers as actionAbortControllers,
  __FlightDataContext as FlightDataContext,
  __getDocumentLocationFromResponse as getDocumentLocationFromResponse,
  __getErrorContext as getErrorContext,
  __getLastNavigationEvent as getLastNavigationEvent,
  __getSavedScrollState as getSavedScrollState,
  __getScrollPositions as getScrollPositions,
  __isFlightResponse as isFlightResponse,
  __isRedirectError as isRedirectError,
  __recordScrollPosition as recordScrollPosition,
  __saveScrollState as saveScrollState,
  __stripRscUrl as stripRscUrl,
  isHashOnlyLocationChange,
  router,
  type NavigationEvent,
} from 'spiceflow/react'
import type { Location } from '../history.js'
import {
  createFromReadableStream,
  createFromFetch,
  createTemporaryReferenceSet,
  encodeReply,
  setServerCallback,
} from '@vitejs/plugin-rsc/browser'
import { FiberProvider } from 'its-fine'
import {
  DefaultGlobalErrorPage,
  DefaultNotFoundPage,
  ErrorBoundary,
  LayoutContent,
  NotFoundBoundary,
} from './components.js'
import {
  __brandActionError as brandActionError,
  __ToastRenderer as ToastRenderer,
} from 'spiceflow/react'
import type { ServerPayload } from '../spiceflow.js'
import {
  DEPLOYMENT_ID_HEADER,
  getDocumentPath,
  isDeploymentSkew,
  readClientDeploymentId,
  recoveryReload,
  wrapRequireWithFallback,
} from './deployment.js'

const MAX_SCROLL_ENTRIES = 200

function getScrollKey(location: { pathname: string; search: string; key?: string }) {
  return location.key || location.pathname + location.search
}

function DefaultScrollRestoration({
  payload,
}: {
  payload: Promise<ServerPayload>
}) {
  const lastHandledNavigationIdRef = React.useRef(0)

  React.useEffect(() => {
    window.history.scrollRestoration = 'manual'
    return () => {
      window.history.scrollRestoration = 'auto'
    }
  }, [])

  React.useEffect(() => {
    function onScroll() {
      const event = getLastNavigationEvent()
      if (event?.action === 'POP' && event.id !== lastHandledNavigationIdRef.current) return
      const location = router.location
      recordScrollPosition({
        locationKey: getScrollKey(location),
        scrollY: window.scrollY,
      })
      recordScrollPosition({
        locationKey: location.pathname + location.search,
        scrollY: window.scrollY,
      })
    }

    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  React.useLayoutEffect(() => {
    const event = getLastNavigationEvent()
    if (!event) return
    if (event.id === lastHandledNavigationIdRef.current) return
    lastHandledNavigationIdRef.current = event.id

    if (event.source === 'refresh') return

    const savedPositions = getScrollPositions({ maxEntries: MAX_SCROLL_ENTRIES })

    if (event.action === 'POP') {
      const savedY = [
        event.savedScrollY,
        getSavedScrollState(),
        savedPositions[getScrollKey(event.location)],
        savedPositions[event.location.pathname + event.location.search],
      ]
        .find((scrollY) => typeof scrollY === 'number')
      if (typeof savedY === 'number') {
        window.scrollTo(0, savedY)
        return
      }
    }

    if (event.location.hash) {
      try {
        const id = decodeURIComponent(event.location.hash.slice(1))
        const el = document.getElementById(id)
        if (el) {
          el.scrollIntoView()
          return
        }
      } catch {
        // bad hash encoding, fall through to scroll to top
      }
    }

    window.scrollTo(0, 0)
  }, [payload])

  React.useEffect(() => {
    function onPageHide() {
      const location = router.location
      saveScrollState(window.scrollY)
      recordScrollPosition({
        locationKey: getScrollKey(location),
        scrollY: window.scrollY,
      })
      recordScrollPosition({
        locationKey: location.pathname + location.search,
        scrollY: window.scrollY,
      })
      window.history.scrollRestoration = 'auto'
    }

    function onPageShow(e: PageTransitionEvent) {
      if (e.persisted) {
        window.history.scrollRestoration = 'manual'
      }
    }

    window.addEventListener('pagehide', onPageHide)
    window.addEventListener('pageshow', onPageShow)
    return () => {
      window.removeEventListener('pagehide', onPageHide)
      window.removeEventListener('pageshow', onPageShow)
    }
  }, [])

  return null
}

// Reads the RSC flight payload that the server injected as <script> tags via
// transform.ts. Chunks already pushed before this module runs are drained,
// then future pushes are forwarded live. Stream closes on DOMContentLoaded.
const rscStream = new ReadableStream<Uint8Array>({
  start(controller) {
    if (typeof window === 'undefined') return
    const encoder = new TextEncoder()
    const enqueue = (chunk: string | Uint8Array) => {
      controller.enqueue(
        typeof chunk === 'string' ? encoder.encode(chunk) : chunk,
      )
    }

    const flightData = Reflect.get(window, '__FLIGHT_DATA')
    const chunks = Array.isArray(flightData) ? flightData : []
    if (!Array.isArray(flightData)) {
      Reflect.set(window, '__FLIGHT_DATA', chunks)
    }
    chunks.forEach(enqueue)
    Reflect.set(chunks, 'push', enqueue)

    if (document.readyState !== 'loading') {
      controller.close()
    } else {
      document.addEventListener('DOMContentLoaded', () => controller.close())
    }
  },
})

function hardNavigate(location: string) {
  window.location.replace(location)
}

function never() {
  return new Promise<never>(() => undefined)
}

async function fetchFlightResponse(args: {
  url: URL
  init?: RequestInit
  kind: 'navigation' | 'action'
}) {
  const clientDeploymentId = readClientDeploymentId()
  const headers = new Headers(args.init?.headers)
  // Let the server short-circuit actions before running new-deploy code
  // against an old client (see spiceflow handle skew check).
  if (clientDeploymentId) {
    headers.set(DEPLOYMENT_ID_HEADER, clientDeploymentId)
  }
  const response = await fetch(args.url, {
    ...args.init,
    headers,
    cache: 'no-store',
  })

  // New deploy live while this tab still has the old client bootstrap.
  // Hard-reload the target document URL so we never import deleted chunks.
  if (
    isDeploymentSkew({
      clientDeploymentId,
      serverDeploymentId: response.headers.get(DEPLOYMENT_ID_HEADER),
    })
  ) {
    hardNavigate(getDocumentPath(args.url))
    return never()
  }

  // The server wraps redirects for RSC requests as 200 + x-spiceflow-redirect
  // header to prevent fetch() from auto-following cross-origin redirects
  // (which would fail with CORS errors, e.g. OAuth to Google).
  const wrappedRedirect = response.headers.get('x-spiceflow-redirect')
  if (wrappedRedirect) {
    // Resolve relative redirects against the document URL, not the .rsc URL,
    // to avoid leaking .rsc into browser URLs (e.g. redirect('?done=1')
    // would resolve against /foo.rsc → /foo.rsc?done=1 instead of /foo?done=1).
    const documentUrl = stripRscUrl(args.url)
    const redirectLocation = new URL(wrappedRedirect, documentUrl).toString()
    const isSameOriginRedirect =
      new URL(redirectLocation).origin === window.location.origin
    if (args.kind === 'navigation' && isSameOriginRedirect) {
      router.replace(redirectLocation)
      return never()
    }
    hardNavigate(redirectLocation)
    return never()
  }

  const locationHeader = response.headers.get('location')
  const isRedirectResponse = response.status >= 300 && response.status <= 399
  if (locationHeader && isRedirectResponse) {
    const redirectLocation = new URL(locationHeader, args.url).toString()
    const isSameOriginRedirect =
      new URL(redirectLocation).origin === window.location.origin
    if (args.kind === 'navigation' && isSameOriginRedirect) {
      router.replace(redirectLocation)
      return never()
    }
    hardNavigate(redirectLocation)
    return never()
  }

  // fetch() auto-follows same-origin redirects (e.g. .get() returning 302).
  // Detect this via response.redirected and do a client-side navigation to
  // preserve SPA state instead of falling through to hardNavigate.
  if (response.redirected) {
    const redirectLocation = getDocumentLocationFromResponse({
      response,
      requestUrl: args.url,
    })
    const isSameOriginRedirect =
      response.url && new URL(response.url, args.url).origin === args.url.origin
    if (args.kind === 'navigation' && isSameOriginRedirect) {
      router.replace(redirectLocation)
      return never()
    }
    hardNavigate(redirectLocation)
    return never()
  }

  if (!isFlightResponse(response)) {
    // Non-flight responses can't be deserialized — hard navigate for navigations,
    // throw for actions. Flight responses (even with 404/500 status) are kept so
    // the error flows through React error boundaries without a full page reload.
    if (args.kind === 'navigation') {
      hardNavigate(
        getDocumentLocationFromResponse({
          response,
          requestUrl: args.url,
        }),
      )
      return never()
    }
  }

  if (args.kind === 'action' && !isFlightResponse(response)) {
    throw new Error(
      `Expected action response to be text/x-component but got ${response.status}`,
    )
  }

  return response
}

// Expose createFromReadableStream globally for federation RemoteIsland components
// that need to decode Flight payloads from remote servers in the browser.
globalThis.__spiceflow_createFromReadableStream = createFromReadableStream

function getErrorDigest(error: Error): string | undefined {
  const digest = Reflect.get(error, 'digest')
  if (typeof digest !== 'string') return undefined
  if (!digest) return undefined
  return digest
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  if (value == null || typeof value !== 'object') return false
  return typeof Reflect.get(value, Symbol.asyncIterator) === 'function'
}

// React prod replaces error.message with a generic string for security but
// keeps error.digest (set by our onError callback). Restore the original
// message so user code can read it. Works for errors thrown mid-stream
// (async generators) and for directly thrown action errors.
function restoreErrorDigest(err: unknown): never {
  if (err instanceof Error) {
    const digest = getErrorDigest(err)
    if (digest) err.message = digest
  }
  throw err
}

// Wraps async generator return values so errors thrown mid-stream get their
// message restored from digest before reaching user code.
function wrapReturnValueErrors(value: unknown): unknown {
  if (isAsyncIterable(value)) {
    const orig = value
    return {
      [Symbol.asyncIterator]() {
        const it = orig[Symbol.asyncIterator]()
        const wrapped = {
          async next() {
            try {
              return await it.next()
            } catch (err) {
              restoreErrorDigest(err)
            }
          },
          async return(v?: unknown) {
            try {
              return await (it.return?.(v) ?? { done: true, value: undefined })
            } catch (err) {
              restoreErrorDigest(err)
            }
          },
          async throw(e?: unknown) {
            try {
              return await (it.throw?.(e) ?? Promise.reject(e))
            } catch (err) {
              restoreErrorDigest(err)
            }
          },
          [Symbol.asyncIterator]() {
            return this
          },
        }
        return wrapped
      },
    }
  }
  return value
}

// Production-only: wrap client require so missing refs hard-reload instead of
// crashing. Stores original loader on a global so federation can unwrap it.
function patchRequireWithRecovery() {
  if (import.meta.hot) return
  const g = globalThis as any
  const orig = g.__vite_rsc_client_require__
  if (!orig) return
  g.__vite_rsc_client_require_original__ = orig
  g.__vite_rsc_client_require__ = wrapRequireWithFallback(orig, recoveryReload)
}

async function main() {
  patchRequireWithRecovery()

  let pendingPayload: PayloadArgs | undefined
  type PayloadArgs = {
    payload: Promise<ServerPayload>
    location?: Location
  }
  type BrowserState = {
    payload: Promise<ServerPayload>
    location: Location
  }
  let setPayload: (v: PayloadArgs) => void = () => undefined
  // Direct setter without startTransition — used by callServer for form actions
  // so the payload update stays in React's form action transition instead of
  // creating a nested one (which would commit client state independently and
  // cause a flash of stale content).
  let setPayloadDirect: (v: PayloadArgs) => void = () => undefined
  let currentNavigationAbort = new AbortController()
  let currentNavigationRequestId: number | null = null

  const applyPayload = (args: PayloadArgs) => {
    pendingPayload = args
    setPayload(args)
  }

  const handleNavigation = async (event: NavigationEvent) => {
    if (event.action === 'LOADER_DATA') return
    if (
      isHashOnlyLocationChange({
        previousLocation: event.previousLocation,
        location: event.location,
      })
    ) {
      return
    }
    currentNavigationAbort.abort()
    const navigationAbort = new AbortController()
    currentNavigationAbort = navigationAbort
    currentNavigationRequestId = event.requestId ?? null
    const url = new URL(window.location.href)
    url.pathname = url.pathname === '/' ? '/index.rsc' : url.pathname + '.rsc'
    url.searchParams.set('__rsc', '')
    const payload = createFromFetch<ServerPayload>(
      fetchFlightResponse({
        url,
        kind: 'navigation',
        init: { signal: navigationAbort.signal },
      }),
    )
    if (navigationAbort.signal.aborted) return
    Promise.resolve(payload)
      .then((resolved) => {
        if (currentNavigationAbort !== navigationAbort) return
        if (currentNavigationRequestId !== (event.requestId ?? null)) return
        router.__setLoaderData(resolved.root?.loaderData)
        currentNavigationRequestId = null
      })
      .catch(() => {
        if (currentNavigationRequestId !== (event.requestId ?? null)) return
        currentNavigationRequestId = null
      })
    applyPayload({
      payload,
      location: event.location,
    })
  }

  // Install the navigation subscription before hydration so an early Link click
  // cannot update the URL without also fetching the next flight payload.
  router.subscribe(handleNavigation)

  // bfcache lifecycle: abort in-flight fetches on pagehide so the browser can
  // freeze the page, and refresh stale RSC data when restored from bfcache.
  // Both navigation and action fetches must be aborted; any open fetch()
  // prevents the browser from putting the page in bfcache.
  window.addEventListener('pagehide', () => {
    currentNavigationAbort.abort()
    for (const controller of actionAbortControllers.values()) {
      controller.abort()
    }
  })
  window.addEventListener('pageshow', (e: PageTransitionEvent) => {
    if (e.persisted) {
      router.refresh()
    }
  })

  const callServer = async (id: string, args: unknown[]) => {
    const isFormAction =
      args.length > 0 && args[args.length - 1] instanceof FormData
    // Temporary references track non-serializable values (DOM nodes, React elements) passed
    // as action args. Same set is shared with createFromFetch so they round-trip correctly.
    const temporaryReferences = createTemporaryReferenceSet()
    const actionAbort = new AbortController()
    actionAbortControllers.set(id, actionAbort)

    try {
      const url = new URL(window.location.href)
      url.searchParams.set('__rsc', id)

      // Await the fetch here so abort errors propagate before we touch React state.
      // fetchFlightResponse already awaits fetch() internally, so there's no streaming
      // loss — the response body still streams through createFromFetch.
      const response = await fetchFlightResponse({
        url,
        kind: 'action',
        init: {
          method: 'POST',
          body: await encodeReply(args, { temporaryReferences }),
          signal: actionAbort.signal,
        },
      })

      const payloadPromise = createFromFetch<ServerPayload>(
        Promise.resolve(response),
        { temporaryReferences },
      )

      if (isFormAction) {
        setPayloadDirect({
          payload: payloadPromise,
        })
      }
      const payload = await payloadPromise

      if (payload.actionError) {
        // React prod strips both error.message and error.digest for Error values
        // serialized in the flight payload (not thrown during rendering).
        // Restore both from the separately-serialized plain string.
        if (payload.actionErrorDigest) {
          if (payload.actionError instanceof Error) {
            Reflect.set(payload.actionError, 'digest', payload.actionErrorDigest)
            payload.actionError.message = payload.actionErrorDigest
          }
        }
        // Redirect errors from throw redirect() in server actions: navigate
        // to the target URL instead of throwing to the caller.
        // Resolve the action promise after scheduling the navigation.
        // Returning a never-settling promise keeps React form actions stuck in
        // the pending state, which prevents wrapped client form actions from
        // committing the follow-up navigation payload even though the URL
        // changed.
        const errorCtx = getErrorContext(payload.actionError)
        const redirectInfo = isRedirectError(errorCtx)
        if (redirectInfo) {
          const target = new URL(redirectInfo.location, window.location.href)
          if (target.origin !== window.location.origin) {
            window.location.assign(target.href)
          } else {
            const nextHref = `${target.pathname}${target.search}${target.hash}`
            queueMicrotask(() => {
              router.push(nextHref)
              router.refresh()
            })
          }
          return undefined
        }
        // Re-render the page tree with the latest payload before surfacing the
        // action error so ErrorBoundary fallbacks and server-rendered UI stay in
        // sync with the response.
        setPayloadDirect({
          payload: Promise.resolve(payload),
        })
        // Brand the error so the unhandledrejection listener can
        // recognize it and show a toast instead of crashing the page when the
        // caller forgot to catch.
        brandActionError(payload.actionError)
        throw payload.actionError
      }

      router.__setLoaderData(payload.root?.loaderData)

      // Always re-render the page tree after a successful server action so
      // mutations are visible immediately. Uses setPayloadDirect (raw
      // setState, no startTransition) so the update joins whatever transition
      // is already active — e.g. React's form action transition. A nested
      // startTransition would create an independent transition that commits
      // separately from the caller's setState calls, causing a flash of stale
      // content.
      setPayloadDirect({
        payload: Promise.resolve(payload),
      })

      return wrapReturnValueErrors(payload.returnValue)
    } finally {
      // Only clean up if this call's controller is still the active one.
      // A newer concurrent call to the same action may have overwritten it.
      if (actionAbortControllers.get(id) === actionAbort) {
        actionAbortControllers.delete(id)
      }
    }
  }
  setServerCallback(callServer)

  const initialPayload = createFromReadableStream<ServerPayload>(rscStream)
  // Seed the loader data store from the initial RSC payload so getLoaderData()
  // resolves for top-level await in client modules.
  // Wrap in Promise.resolve because createFromReadableStream returns a thenable
  // (not a full Promise), so .then() doesn't return something with .catch().
  Promise.resolve(initialPayload)
    .then((payload) => {
      router.__setLoaderData(payload.root?.loaderData)
    })
    .catch(() => {})

  function BrowserRoot() {
    const [{ payload, location }, setPayload_] = React.useState<BrowserState>({
      payload: initialPayload,
      location: router.location,
    })
    const [_isPending, startTransition] = React.useTransition()
    const flightData = React.useMemo(
      () => ({ payload, routerData: { location, loaderData: {} } }),
      [location, payload],
    )
    const commitPayload = React.useCallback((next: PayloadArgs) => {
      setPayload_((current) => ({
        payload: next.payload,
        location: next.location ?? current.location,
      }))
    }, [])

    React.useEffect(() => {
      setPayload = (v) => startTransition(() => commitPayload(v))
      setPayloadDirect = commitPayload
      if (!pendingPayload) return
      const nextPayload = pendingPayload
      pendingPayload = undefined
      setPayload(nextPayload)
    }, [commitPayload, startTransition])

    return (
      <FiberProvider>
        <ErrorBoundary errorComponent={DefaultGlobalErrorPage}>
          <NotFoundBoundary component={DefaultNotFoundPage}>
            <FlightDataContext.Provider value={flightData}>
              <DefaultScrollRestoration payload={payload} />
              <LayoutContent />
            </FlightDataContext.Provider>
          </NotFoundBoundary>
        </ErrorBoundary>
        <ToastRenderer />
      </FiberProvider>
    )
  }

  // Collect React 19 root error handlers from globalThis. Observability SDKs
  // (e.g. Strada) set these before hydration via setReactErrorHandlers() to
  // receive all React render errors globally, even when the user has their
  // own ErrorBoundary.
  const rootErrorHandlers = {
    ...(globalThis.__spiceflow_onCaughtError && { onCaughtError: globalThis.__spiceflow_onCaughtError }),
    ...(globalThis.__spiceflow_onUncaughtError && { onUncaughtError: globalThis.__spiceflow_onUncaughtError }),
    ...(globalThis.__spiceflow_onRecoverableError && { onRecoverableError: globalThis.__spiceflow_onRecoverableError }),
  }

  // When SSR fails, the server injects self.__NO_HYDRATE=1 in the bootstrap script.
  // In that case use createRoot (CSR from scratch) instead of hydrateRoot which would
  // throw hydration mismatch errors against the error shell HTML.
  if (Reflect.has(globalThis, '__NO_HYDRATE')) {
    ReactDomClient.createRoot(document, rootErrorHandlers).render(<BrowserRoot />)
  } else {
    ReactDomClient.hydrateRoot(document, <BrowserRoot />, {
      formState: (await initialPayload).formState,
      ...rootErrorHandlers,
    })
  }

  if (import.meta.hot) {
    // Debounce rapid HMR events (e.g. save + format save) to avoid firing
    // multiple RSC fetches in quick succession. On Cloudflare Workers this
    // race condition causes "hanging Promise was canceled" errors because
    // promises from the old request context resolve in the new one.
    let hmrTimer: ReturnType<typeof setTimeout> | undefined
    import.meta.hot.on('rsc:update', (e: { file: string }) => {
      console.log('[rsc:update]', e.file)
      clearTimeout(hmrTimer)
      hmrTimer = setTimeout(
        () => router.refresh(),
        80,
      )
    })
  }
}

if (import.meta.hot) {
  window.onerror = (_event, _source, _lineno, _colno, err) => {
    const ErrorOverlay = customElements.get('vite-error-overlay')
    if (!ErrorOverlay) return
    const overlay = Reflect.construct(ErrorOverlay, [err])
    if (!(overlay instanceof HTMLElement)) return
    document.body.appendChild(overlay)
  }
}

void main()
