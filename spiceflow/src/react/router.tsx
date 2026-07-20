import { createBrowserHistory, createMemoryHistory, type Location } from '../history.js'
import { useContext, useMemo } from 'react'
import { getBasePath } from '../base-path.js'
import type { AnySpiceflow } from '../spiceflow.js'
import type { FlightDataContextValue } from '#flight-data-context'
import type {
  AllHrefPaths,
  AllLoaderData,
  HrefBuilder,
  IsAny,
  MergedLoaderData,
  ResolvedHref,
  ValidatedHref,
} from '../types.js'
import { getRouterContext } from '#router-context'
import { FlightDataContext } from '#flight-data-context'
import { buildHref } from './loader-utils.js'

const isBrowser = typeof window !== 'undefined'

if (isBrowser) {
  globalThis.__SPICEFLOW_CLIENT_LOAD_COUNT__ =
    (globalThis.__SPICEFLOW_CLIENT_LOAD_COUNT__ ?? 0) + 1
}

const basePath = getBasePath()

const history = !isBrowser ? createMemoryHistory() : createBrowserHistory({})

// Cached scroll position updated by a passive scroll listener to avoid
// forced reflows when reading window.scrollY after DOM mutations.
let cachedScrollY = 0

if (isBrowser) {
  window.addEventListener(
    'scroll',
    () => {
      cachedScrollY = window.scrollY
    },
    { passive: true },
  )
}

const MAX_NAVIGATION_EVENTS = 100
const DEFAULT_MAX_SCROLL_ENTRIES = 200
const SCROLL_STATE_KEY = '__spiceflowScrollY'

type LoaderDataState = {
  data: Record<string, unknown>
  initialized: boolean
  locationSignature: string | null
  pendingLocationSignature: string | null
  pendingRequestId: number | null
  resolve: ((data: Record<string, unknown>) => void) | null
  ready: Promise<Record<string, unknown>>
}

type Deferred<T> = {
  ready: Promise<T>
  resolve: ((value: T) => void) | null
}

function createDeferred<T>() {
  let resolve: ((value: T) => void) | null = null
  const ready = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve
    void nextReject
  })
  return { ready, resolve }
}

function createLoaderDataState(): LoaderDataState {
  const { ready, resolve } = createDeferred<Record<string, unknown>>()
  return {
    data: {},
    initialized: false,
    locationSignature: null,
    pendingLocationSignature: null,
    pendingRequestId: null,
    resolve,
    ready,
  }
}

const loaderDataState = createLoaderDataState()

type NavigationMethod = 'push' | 'replace' | 'refresh'

type NavigationRequestedEvent = {
  id: number
  type: 'navigation-requested'
  requestId: number
  method: NavigationMethod
  location: Location
  scrollY: number
}

type NavigationCommittedEvent = {
  id: number
  type: 'navigation-committed'
  requestId: number | null
  action: 'POP' | 'PUSH' | 'REPLACE'
  location: Location
  previousLocation: Location
  previousScrollY: number
  savedScrollY: number | null
  source: 'navigate' | 'refresh'
}

export type RouterEvent = NavigationRequestedEvent | NavigationCommittedEvent

export type NavigationEvent = {
  id: number
  action: 'POP' | 'PUSH' | 'REPLACE' | 'LOADER_DATA'
  requestId: number | null
  location: Location
  previousLocation: Location
  previousScrollY: number
  savedScrollY: number | null
  source: 'navigate' | 'refresh'
}

export type ReadonlyURLSearchParams = Omit<
  URLSearchParams,
  'append' | 'delete' | 'set' | 'sort'
>

type LoaderDataReturn<LD extends object, Path extends string> = IsAny<LD> extends true
  ? any
  : string extends Path
    ? AllLoaderData<LD>
    : MergedLoaderData<LD, Path>

type AppTypes<App> = App extends { _types: infer Types } ? Types : AnySpiceflow['_types']

export type RouterPaths<App> = IsAny<
  AppTypes<App> extends { RoutePaths: infer Paths } ? Paths : string
> extends true
  ? string
  : AppTypes<App> extends { RoutePaths: infer Paths extends string }
    ? Paths | RegisteredKnownPaths
    : string

export type RouterQuerySchemas<App> = IsAny<
  AppTypes<App> extends { RoutePaths: infer Paths } ? Paths : string
> extends true
  ? Record<string, any>
  : AppTypes<App> extends { RouteQuerySchemas: infer Schemas extends object } ? Schemas : Record<string, any>

export type LoaderDataForPath<
  App,
  Path extends string,
> = IsAny<AppTypes<App> extends { RoutePaths: infer Paths } ? Paths : string> extends true
  ? any
  : LoaderDataReturn<
      AppTypes<App> extends { Metadata: { loaderData: infer LoaderData extends object } } ? LoaderData : {},
      Path
    >

export type RouterPathArg<App> =
  RouterPaths<App> | (string & {})

export function coerceLoaderData<
  App extends AnySpiceflow,
  Path extends string,
>(data: any): LoaderDataForPath<App, Path> {
  return data
}

// Object form with typed pathname (validates literals, accepts string variables).
type NavigationPathObject<App, P extends string> =
   Omit<Partial<import('../history.js').Path>, 'pathname'> & {
    pathname?: ValidatedHref<RouterPaths<App>, P, RouterQuerySchemas<App>>
  }

// Typed navigation target: validates string literals against route paths,
// accepts wide `string` variables, and keeps the history object form.
// Bare string paths with required query params are rejected; use router.href().
type NavigationTo<App> = {
  <const P extends string>(
    to: ValidatedHref<RouterPaths<App>, P, RouterQuerySchemas<App>> | NavigationPathObject<App, P>,
    state?: any,
  ): void
}

export type RouterBase<App = AnySpiceflow> = {
  readonly location: Location
  readonly pathname: string
  readonly searchParams: ReadonlyURLSearchParams

  href: HrefBuilder<RouterPaths<App>, RouterQuerySchemas<App>>

  push: NavigationTo<App>
  replace: NavigationTo<App>
  go(...args: Parameters<typeof history.go>): void
  back(...args: Parameters<typeof history.back>): void
  forward(...args: Parameters<typeof history.forward>): void
  block(...args: Parameters<typeof history.block>): ReturnType<typeof history.block>
  refresh(): void
  subscribe(cb: Subscriber): () => void

  getLoaderData<const Path extends RouterPathArg<App> = string>(
    path?: Path,
  ): Promise<LoaderDataForPath<App, Path>>

  /** @internal */
  __setLoaderData(data: Record<string, unknown> | undefined): void
}

type Subscriber = (event: NavigationEvent) => void

const subscribers = new Set<Subscriber>()
const navigationEvents: RouterEvent[] = []
const scrollPositions = new Map<string, number>()
let nextEventId = 0
let nextRequestId = 0
function cloneLocation(location: Location): Location {
  return {
    pathname: location.pathname,
    search: location.search,
    hash: location.hash,
    state: location.state,
    key: location.key,
  }
}

function getLoaderDataLocationSignature(location: Pick<Location, 'pathname' | 'search'>) {
  return `${location.pathname}${location.search}`
}

function getPendingRefreshForLocation(location: Pick<Location, 'pathname' | 'search'>) {
  if (
    loaderDataState.pendingLocationSignature !==
    getLoaderDataLocationSignature(location)
  ) {
    return null
  }
  if (loaderDataState.pendingRequestId == null) {
    return null
  }
  const pendingRequest = getLatestPendingNavigationRequest(navigationEvents)
  if (!pendingRequest) {
    return null
  }
  if (pendingRequest.requestId !== loaderDataState.pendingRequestId) {
    return null
  }
  return pendingRequest
}

function clearPendingRefresh(requestId: number | null) {
  if (requestId == null) {
    return
  }
  if (loaderDataState.pendingRequestId !== requestId) {
    return
  }
  loaderDataState.pendingRequestId = null
  loaderDataState.pendingLocationSignature = null
}

function appendNavigationEvent<TEvent extends RouterEvent>(
  event: Omit<TEvent, 'id'>,
): TEvent {
  const nextEvent = {
    ...event,
    id: ++nextEventId,
  } as TEvent
  navigationEvents.push(nextEvent)
  if (navigationEvents.length > MAX_NAVIGATION_EVENTS) {
    navigationEvents.shift()
  }
  return nextEvent
}

export function getLastCommittedNavigationEvent(
  routerEvents: readonly RouterEvent[],
): NavigationCommittedEvent | null {
  for (let index = routerEvents.length - 1; index >= 0; index -= 1) {
    const event = routerEvents[index]
    if (event?.type === 'navigation-committed') {
      return event
    }
  }
  return null
}

export function getLatestPendingNavigationRequest(
  routerEvents: readonly RouterEvent[],
): NavigationRequestedEvent | null {
  const committedRequestIds = new Set<number>()
  for (let index = routerEvents.length - 1; index >= 0; index -= 1) {
    const event = routerEvents[index]
    if (!event) {
      continue
    }
    if (event.type === 'navigation-committed') {
      if (event.requestId != null) {
        committedRequestIds.add(event.requestId)
      }
      continue
    }
    if (!committedRequestIds.has(event.requestId)) {
      return event
    }
  }
  return null
}

function getPreviousLocation(routerEvents: readonly RouterEvent[]): Location {
  const committedEvent = getLastCommittedNavigationEvent(routerEvents)
  if (committedEvent) {
    return cloneLocation(committedEvent.location)
  }

  const pendingRequest = getLatestPendingNavigationRequest(routerEvents)
  if (pendingRequest) {
    return cloneLocation(pendingRequest.location)
  }

  return cloneLocation(history.location)
}

function requestNavigation(method: NavigationMethod) {
  if (!isBrowser) {
    return null
  }

  saveScrollState(window.scrollY)

  return appendNavigationEvent<NavigationRequestedEvent>({
    type: 'navigation-requested',
    requestId: ++nextRequestId,
    method,
    location: cloneLocation(history.location),
    scrollY: window.scrollY,
  })
}

function trimScrollPositions(maxEntries: number) {
  while (scrollPositions.size > maxEntries) {
    const oldestKey = scrollPositions.keys().next().value
    if (oldestKey == null) {
      return
    }
    scrollPositions.delete(oldestKey)
  }
}

export function recordScrollPosition(args: {
  locationKey: string
  scrollY: number
}) {
  scrollPositions.delete(args.locationKey)
  scrollPositions.set(args.locationKey, args.scrollY)
  trimScrollPositions(DEFAULT_MAX_SCROLL_ENTRIES)
}

export function loadScrollPositions(args: {
  positions: Record<string, number>
  maxEntries?: number
}) {
  scrollPositions.clear()
  for (const [locationKey, scrollY] of Object.entries(args.positions)) {
    scrollPositions.set(locationKey, scrollY)
  }
  trimScrollPositions(args.maxEntries ?? DEFAULT_MAX_SCROLL_ENTRIES)
}

export function getScrollPositions({
  maxEntries = DEFAULT_MAX_SCROLL_ENTRIES,
}: { maxEntries?: number } = {}) {
  trimScrollPositions(maxEntries)
  return Object.fromEntries(scrollPositions)
}

export function saveScrollState(scrollY: number) {
  if (!isBrowser) return
  window.history.replaceState(
    { ...window.history.state, [SCROLL_STATE_KEY]: scrollY },
    '',
  )
}

export function getSavedScrollState() {
  if (!isBrowser) return null
  const scrollY = window.history.state?.[SCROLL_STATE_KEY]
  return typeof scrollY === 'number' ? scrollY : null
}

export function getLastNavigationEvent(): NavigationEvent | null {
  return getLastCommittedNavigationEvent(navigationEvents)
}

export function isHashOnlyLocationChange(args: {
  previousLocation: Location
  location: Location
}): boolean {
  const { previousLocation, location } = args
  return (
    previousLocation.pathname === location.pathname &&
    previousLocation.search === location.search &&
    previousLocation.hash !== location.hash
  )
}

if (isBrowser) {
  history.listen(({ action, location }) => {
    const pendingRequest =
      action === 'POP'
        ? null
        : getLatestPendingNavigationRequest(navigationEvents)
    const previousLocation = getPreviousLocation(navigationEvents)
    const event = appendNavigationEvent<NavigationCommittedEvent>({
      type: 'navigation-committed',
      requestId: pendingRequest?.requestId ?? null,
      action,
      location: cloneLocation(location),
      previousLocation,
      previousScrollY:
        action === 'POP' ? cachedScrollY : (pendingRequest?.scrollY ?? 0),
      savedScrollY: action === 'POP' ? getSavedScrollState() : null,
      source: pendingRequest?.method === 'refresh' ? 'refresh' : 'navigate',
    })

    recordScrollPosition({
      locationKey: previousLocation.key,
      scrollY: event.previousScrollY,
    })
    recordScrollPosition({
      locationKey: previousLocation.pathname + previousLocation.search,
      scrollY: event.previousScrollY,
    })

    for (const cb of subscribers) {
      cb(event)
    }

    // pushState/replaceState suppress the native hashchange event.
    // Dispatch it synthetically so code listening for hashchange (TOC trackers,
    // analytics, scroll-to-hash libs) works with client navigations.
    if (isHashOnlyLocationChange({ previousLocation, location })) {
      const base = window.location.origin + location.pathname + location.search
      window.dispatchEvent(
        new HashChangeEvent('hashchange', {
          oldURL: base + previousLocation.hash,
          newURL: base + location.hash,
        }),
      )
    }
  })
}

function getCurrentLocation(): Location {
  const serverContext = !isBrowser ? getRouterContext() : undefined
  if (serverContext) {
    return serverContext.location
  }
  return history.location
}

function useRouterDataContext(): FlightDataContextValue['routerData'] | null {
  if (!FlightDataContext) {
    return null
  }
  return useContext?.(FlightDataContext)?.routerData ?? null
}

function hasBasePrefix(path: string, base: string): boolean {
  if (path === base) return true
  const next = path.charAt(base.length)
  return path.startsWith(base) && (next === '/' || next === '?' || next === '#')
}

function stripBase(pathname: string): string {
  if (!basePath) return pathname
  if (hasBasePrefix(pathname, basePath)) {
    return pathname.slice(basePath.length) || '/'
  }
  return pathname
}

function isExternalUrl(url: string): boolean {
  return url.startsWith('http://') || url.startsWith('https://')
}

function prependBase(to: string | Partial<{ pathname: string }>): typeof to {
  if (!basePath) return to
  if (typeof to === 'string') {
    if (to.startsWith('/') && !to.startsWith('//') && !hasBasePrefix(to, basePath))
      return basePath + to
    return to
  }
  if (
    to.pathname &&
    to.pathname.startsWith('/') &&
    !to.pathname.startsWith('//') &&
    !hasBasePrefix(to.pathname, basePath)
  ) {
    return { ...to, pathname: basePath + to.pathname }
  }
  return to
}

// history.pushState / replaceState don't trigger the browser's native
// hash-scroll behaviour. When the new URL contains a #hash, manually
// scroll to the target element after a frame so React can commit any
// pending state updates first (needed for cross-page hash links where
// the target element doesn't exist yet at push time).
function scrollToHashElement() {
  if (!isBrowser) return
  const hash = history.location.hash
  if (!hash) return
  requestAnimationFrame(() => {
    try {
      const id = decodeURIComponent(hash.slice(1))
      document.getElementById(id)?.scrollIntoView()
    } catch {
      // bad hash encoding — ignore
    }
  })
}

// Typed router singleton. Import directly for type-safe routing:
//   import { router } from 'spiceflow/react'
//   router.href('/users/:id', { id: '42' })
export const router: RouterBase<RegisteredApp> = {
  get location() {
    return getCurrentLocation()
  },
  get pathname() {
    return stripBase(getCurrentLocation().pathname)
  },
  get searchParams(): ReadonlyURLSearchParams {
    return new URLSearchParams(getCurrentLocation().search)
  },
  href(path: string, allParams?: Record<string, any>) {
    return buildHref(path, allParams) as ResolvedHref
  },
  push(...args: Parameters<typeof history.push>) {
    if (typeof args[0] === 'string' && isExternalUrl(args[0])) {
      const parsed = new URL(args[0])
      if (!isBrowser || parsed.origin !== window.location.origin) {
        if (isBrowser) window.location.assign(args[0])
        return
      }
      args[0] = parsed.pathname + parsed.search + parsed.hash
    }
    args[0] = prependBase(args[0]) as typeof args[0]
    requestNavigation('push')
    history.push(...args)
    scrollToHashElement()
  },
  replace(...args: Parameters<typeof history.replace>) {
    if (typeof args[0] === 'string' && isExternalUrl(args[0])) {
      const parsed = new URL(args[0])
      if (!isBrowser || parsed.origin !== window.location.origin) {
        if (isBrowser) window.location.replace(args[0])
        return
      }
      args[0] = parsed.pathname + parsed.search + parsed.hash
    }
    args[0] = prependBase(args[0]) as typeof args[0]
    requestNavigation('replace')
    history.replace(...args)
    scrollToHashElement()
  },
  go: history.go,
  back: history.back,
  forward: history.forward,
  block: history.block,
  refresh() {
    const requestedNavigation = requestNavigation('refresh')
    if (!requestedNavigation) {
      return
    }
    clearPendingRefresh(loaderDataState.pendingRequestId)
    loaderDataState.pendingRequestId = requestedNavigation.requestId
    loaderDataState.pendingLocationSignature = getLoaderDataLocationSignature(
      history.location,
    )
    history.replace(history.location)
  },
  subscribe(cb: Subscriber) {
    if (!isBrowser) {
      return () => undefined
    }

    subscribers.add(cb)
    return () => {
      subscribers.delete(cb)
    }
  },
  getLoaderData(_path?: string): Promise<Record<string, unknown>> {
    if (!isBrowser) {
      const serverContext = getRouterContext()
      return Promise.resolve(serverContext?.loaderData ?? loaderDataState.data)
    }
    const locationSignature = getLoaderDataLocationSignature(history.location)
    if (
      loaderDataState.initialized &&
      loaderDataState.locationSignature === locationSignature &&
      !getPendingRefreshForLocation(history.location)
    ) {
      return Promise.resolve(loaderDataState.data)
    }
    return loaderDataState.ready
  },
  /** @internal */
  __setLoaderData(data: Record<string, unknown> | undefined) {
    loaderDataState.data = data ?? {}
    loaderDataState.initialized = true
    loaderDataState.locationSignature = getLoaderDataLocationSignature(
      history.location,
    )
    loaderDataState.pendingLocationSignature = null
    loaderDataState.pendingRequestId = null
    const resolve = loaderDataState.resolve
    const nextReady = createDeferred<Record<string, unknown>>()
    loaderDataState.resolve = nextReady.resolve
    loaderDataState.ready = nextReady.ready
    resolve?.(loaderDataState.data)
    const location = history.location
    const event: NavigationEvent = {
      id: ++nextEventId,
      action: 'LOADER_DATA',
      requestId: null,
      location,
      previousLocation: location,
      previousScrollY: cachedScrollY,
      savedScrollY: null,
      source: 'navigate',
    }
    for (const cb of subscribers) {
      cb(event)
    }
  },
}

export function useRouterState<_App extends AnySpiceflow = RegisteredApp>() {
  const routerData = useRouterDataContext()
  const location = routerData?.location ?? getCurrentLocation()
  return useMemo(
    () => ({
      ...location,
      pathname: stripBase(location.pathname),
      searchParams: new URLSearchParams(
        location.search,
      ) as ReadonlyURLSearchParams,
    }),
    [location],
  )
}

// Type registry for getRouter(). Augment this interface to get fully typed
// router without passing <typeof app> everywhere:
//
//   declare module 'spiceflow/react' {
//     interface SpiceflowRegister { app: typeof app }
//   }
//
// Then getRouter() returns a typed router automatically.
//
// Optionally add `knownPaths` to declare extra valid paths that are not part
// of `typeof app` (e.g. mounted sub-apps or external route tables):
//
//   declare module 'spiceflow/react' {
//     interface SpiceflowRegister {
//       app: typeof app
//       knownPaths: '/docs' | '/docs/:slug' | '/files/*'
//     }
//   }
export interface SpiceflowRegister {}

export type RegisteredApp = SpiceflowRegister extends {
  app: infer App
}
  ? App
  : AnySpiceflow

// Extra user-declared paths from SpiceflowRegister['knownPaths'].
// `never` is the union identity, so this is a no-op when not registered.
export type RegisteredKnownPaths = SpiceflowRegister extends {
  knownPaths: infer Paths extends string
}
  ? Paths
  : never

/** @deprecated Use `import { router } from 'spiceflow/react'` directly instead. */
export function getRouter(): RouterBase<RegisteredApp>
/** @deprecated Use `import { router } from 'spiceflow/react'` directly instead. */
export function getRouter<App extends AnySpiceflow>(): RouterBase<App>
export function getRouter(): any {
  return router
}
