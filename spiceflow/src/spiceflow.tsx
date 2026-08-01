import type { ReactFormState } from 'react-dom/client'

import { copy } from './copy-anything.js'
import { loadGlobalCss } from '#load-global-css'
import { FlightDataContext } from '#flight-data-context'


import { SpiceflowFetchError } from './client/errors.js'
import { actionRequestStorage } from './action-context.js'
import { createRouterContextData, routerContextStorage, type RouterContextData } from './router-context.js'
import { coerceQueryWithSchema } from './query-coerce.js'
import { ValidationError } from './error.js'
import {
  ComposeSpiceflowResponse,
  CreateClient,
  DefinitionBase,
  ErrorHandler,
  GetRequestSchema,
  HrefBuilder,
  HTTPMethod,
  ValidationFunction,
  InlineHandler,
  InputSchema,
  InternalRoute,
  IsAny,
  JoinPath,
  LocalHook,
  MetadataBase,
  MiddlewareHandler,
  NodeKind,
  Reconcile,
  ResolvePath,
  RouteBase,
  RouteSchema,
  SingletonBase,
  TypeSchema,
  UnwrapRoute,
  PrefixPaths,
  PrefixQuerySchemas,
  PrefixLoaderData,
  MergedLoaderData,
  ResolvedHref,
} from './types.js'
import { buildHref } from './react/loader-utils.js'
import type { RegisteredApp } from './react/router.js'

import React, { createElement } from 'react'
import { ZodType } from 'zod'
import { isAsyncIterable, isResponse, isTruthy, redirect } from './utils.js'

import {
  DefaultNotFoundPage,
  FlightData,
  LayoutContent,
} from './react/components.js'
import { CollectedHead } from './react/head.js'
import {
  getErrorContext,
  isNotFoundError,
  isRedirectError,
  isRedirectStatus,
  contextToHeaders,
} from './react/errors.js'
import { formatServerError } from './react/format-server-error.js'
import { sanitizeErrorMessage } from './react/sanitize-error.js'
import {
  DEPLOYMENT_ID_HEADER,
  isDeploymentSkew,
  isDocumentRequest,
  isFlightResponse,
  isRscRequest,
  stripRscUrl,
} from './react/deployment.js'
import { getDeploymentId } from '#deployment-id'

import {
  __spiceflowVitestMode,
  createTemporaryReferenceSet,
  decodeAction,
  decodeFormState,
  decodeReply,
  loadServerAction,
  renderToReadableStream,
} from '#rsc-runtime'

const verboseLogs = process.env.SPICEFLOW_VERBOSE === '1'
import { TrieRouter } from './trie-router/router.js'
import { decodeURIComponent_ } from './trie-router/url.js'
import { Result } from './trie-router/utils.js'

import type { StandardSchemaV1 } from './standard-schema.js'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { handleForNode, listenForNode } from '#node-server'
import { renderSsr } from '#handle-ssr'
import { defaultWaitUntil } from '#wait-until'
import {
  SpiceflowContext,
  MiddlewareContext,
  ContextResponse,
} from './context.js'
import { isStaticMiddleware } from './static.js'
import {
  type SpiceflowTracer,
  type SpiceflowSpan,
  withSpan,
  recordError,
  finalizeRequestSpan,
  SPAN_KIND_SERVER,
  ATTR,
  noopSpan,
  noopTracer,
} from './instrumentation.js'
import {
  appendServerTimingHeader,
  createRequestTracing,
} from './server-timing.js'
import { cloudflareTracer } from '#cloudflare-tracer'

let globalIndex = 0

const spiceflowReportedErrors = new WeakMap<Request, Set<string>>()

function getErrorReportKey(error: unknown) {
  if (!(error instanceof Error)) return String(error)

  const digest = Reflect.get(error, 'digest')
  const status = Reflect.get(error, 'status')

  return `${error.name}:${error.message}:${typeof digest === 'string' ? digest : ''}:${typeof status === 'number' ? status : ''}`
}

function getReportedErrorKeys(request: Request) {
  const reportedErrors = spiceflowReportedErrors.get(request)
  if (reportedErrors) return reportedErrors

  const next = new Set<string>()
  spiceflowReportedErrors.set(request, next)
  return next
}

type AsyncResponse = Response | Promise<Response>

export type SpiceflowListenResult =
  | {
      port: number | undefined
      server: Bun.Server
      stop: () => Promise<void>
    }
  | {
      port: number
      server: unknown
      stop: () => Promise<void>
    }
  | {
      port: undefined
      server: undefined
      stop: () => Promise<void>
    }

async function noopStop() {}

function createNoopListenResult(): SpiceflowListenResult {
  return {
    port: undefined,
    server: undefined,
    stop: noopStop,
  }
}

function appendHeaders(target: Headers, source: Headers) {
  let changed = false
  const getSetCookie = (source as Headers & { getSetCookie?: () => string[] })
    .getSetCookie
  const setCookies = getSetCookie?.call(source) ?? []

  for (const cookie of setCookies) {
    target.append('set-cookie', cookie)
    changed = true
  }

  for (const [key, value] of source.entries()) {
    if (key.toLowerCase() === 'set-cookie' && setCookies.length > 0) continue
    if (key.toLowerCase() === 'set-cookie') {
      target.append(key, value)
    } else {
      target.set(key, value)
    }
    changed = true
  }

  return changed
}

// Wrap a redirect response for RSC fetches: return 200 with custom headers
// so the client can read the location without fetch() auto-following the 3xx.
function wrapRedirectForRsc(response: Response): Response {
  const location = response.headers.get('location')
  if (!location) return response
  const headers = new Headers(response.headers)
  headers.set('x-spiceflow-redirect', location)
  headers.set('x-spiceflow-redirect-status', String(response.status))
  headers.delete('location')
  return new Response(null, { status: 200, headers })
}

async function stampDeploymentIdHeader(
  response: Response,
  isRscFetch: boolean,
): Promise<Response> {
  if (response.headers.has(DEPLOYMENT_ID_HEADER)) return response
  if (!isRscFetch && !isFlightResponse(response)) return response
  const deploymentId = await getDeploymentId()
  if (!deploymentId) return response
  const headers = new Headers(response.headers)
  headers.set(DEPLOYMENT_ID_HEADER, deploymentId)
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

function mergeHeadersIntoResponse({
  response,
  source,
}: {
  response: Response
  source?: Headers
}) {
  if (!source) {
    return response
  }

  const headers = new Headers(response.headers)
  if (!appendHeaders(headers, source)) {
    return response
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

export type SpiceflowServerError =
  | ValidationError
  | SpiceflowFetchError<number, any>
  | Error

export type WaitUntil = (promise: Promise<any>) => void

type OnError = (x: {
  error: SpiceflowServerError
  request: Request
  path: string
}) => AsyncResponse

type MatchedRoute = {
  app: AnySpiceflow
  route: InternalRoute
  params: Record<string, string>
}

const notFoundHandler = (c) => {
  return new Response('Not Found', { status: 404 })
}

function createContextResponse(): ContextResponse {
  return {
    headers: new Headers(),
    status: 200,
  }
}

export class Spiceflow<
  const in out BasePath extends string = '',
  const in out Scoped extends boolean = true,
  const in out Singleton extends SingletonBase = {
    state: {}
  },
  const in out Definitions extends DefinitionBase = {
    type: {}
    error: {}
  },
  const in out Metadata extends MetadataBase = {
    schema: {}
    macro: {}
    macroFn: {}
    loaderData: {}
  },
  const out ClientRoutes extends RouteBase = {},
  const in out RoutePaths extends string = '',
  const in out RouteQuerySchemas extends object = {},
> {
  private id: number = globalIndex++
  private router: TrieRouter<InternalRoute> = new TrieRouter()
  private middlewares: Function[] = []
  private onErrorHandlers: OnError[] = []
  private routes: InternalRoute[] = []
  private defaultState: Record<any, any> = {}

  topLevelApp?: AnySpiceflow = this
  private waitUntilFn: WaitUntil
  tracer?: SpiceflowTracer
  serverTiming?: boolean

  _types = {
    Prefix: '' as BasePath,
    ClientRoutes: {} as ClientRoutes,
    RoutePaths: '' as RoutePaths,
    RouteQuerySchemas: {} as RouteQuerySchemas,
    Scoped: false as Scoped,
    Singleton: {} as Singleton,
    Definitions: {} as Definitions,
    Metadata: {} as Metadata,
  }

  /** @internal */
  basePath?: string = ''

  /** @internal */
  childrenApps: AnySpiceflow[] = []

  /** @internal */
  getAllRoutes() {
    let root = this.topLevelApp || this
    const allApps = bfs(root) || []
    const allRoutes = allApps.flatMap((x) => {
      const prefix = this.joinBasePaths(
        this.getAppAndParents(x).map((x) => x.basePath),
      )

      return x.routes.map((x) => {
        const joined = prefix + x.path
        // Normalize: strip trailing slash (same as match() and add()) but keep bare '/'
        const path = joined.replace(/\/$/, '') || '/'
        return { ...x, path }
      })
    })
    return allRoutes
  }
  private usedIds = new Set<string>()

  private generateRouteId(
    kind: NodeKind | undefined,
    method: string,
    path: string,
  ): string {
    const prefix = kind ? kind : 'api'
    const base = `${prefix}-${method.toLowerCase()}-${path.replace(/\//g, '-')}`
    let id = base
    let counter = 1

    while (this.usedIds.has(id)) {
      id = `${base}-${counter}`
      counter++
    }

    this.usedIds.add(id)
    return id
  }

  private add({
    method,
    path,
    hooks,
    handler,
    ...rest
  }: {
    method?: HTTPMethod
    path?: string
    hooks?: InternalRoute['hooks']
    handler?: InternalRoute['handler']
    kind?: InternalRoute['kind']
    [key: string]: unknown
  }) {
    const kind = rest.kind
    let bodySchema: TypeSchema = hooks?.request
    let validateBody = getValidateFunction(bodySchema)
    let validateQuery = getValidateFunction(hooks?.query)
    let validateParams = getValidateFunction(hooks?.params)

    if (typeof handler === 'function' && !handler.name) {
      Object.defineProperty(handler, 'name', {
        value: path,
        configurable: true,
      })
    }

    // remove trailing slash which can cause problems
    path = path?.replace(/\/$/, '') || '/'

    const id = this.generateRouteId(kind, method || '', path)

    let route: InternalRoute = {
      ...rest,
      id,
      type: hooks?.type || '',
      method: (method || '') as any,
      path: path || '',
      handler: handler!,
      hooks,
      validateBody,
      validateParams,
      validateQuery,
      kind,
    }
    this.router.add(method!, path, route)

    this.routes.push(route)
  }

  private getAllDecodedParams(
    _matchResult: Result<InternalRoute>,
    pathname: string,
    routeIndex,
  ): Record<string, string> {
    if (!_matchResult?.length || !_matchResult?.[0]?.[routeIndex]?.[1]) {
      return {}
    }

    const matches = _matchResult[0]
    const internalRoute = matches[routeIndex][0]

    const decoded: Record<string, string> =
      extractWildcardParam(pathname, internalRoute?.path) || {}

    const keys = Object.keys(matches[routeIndex][1])
    for (const key of keys) {
      const value = matches[routeIndex][1][key]
      if (value) {
        try {
          decoded[key] = /\%/.test(value) ? decodeURIComponent_(value) : value
        } catch {
          decoded[key] = value
        }
      }
    }

    return decoded
  }
  private match(method: string, path: string) {
    let root = this
    let foundApp: AnySpiceflow | undefined
    // remove trailing slash which can cause problems
    path = path.replace(/\/$/, '') || '/'

    // Collect matched routes from all apps so that more-specific child
    // routes are visible even when a less-specific parent route also matches.
    const allRoutes: MatchedRoute[] = []
    const allApps = bfs(this)
    for (const app of allApps) {
      app.topLevelApp = root
      let prefix = this.joinBasePaths(
        this.getAppAndParents(app).map((x) => x.basePath),
      ).replace(/\/$/, '')
      // Segment-aware prefix check: /api must not match /apiary
      if (prefix && !(path === prefix || path.startsWith(prefix + '/'))) {
        continue
      }
      let pathWithoutPrefix = path
      if (prefix) {
        pathWithoutPrefix = path.slice(prefix.length) || '/'
      }

      const matchedRoutesForMethod = app.router.match(method, pathWithoutPrefix)
      // The router can return [[]] when the path exists but has no handler
      // for the requested method (e.g. POST registered but OPTIONS requested).
      // Check the inner array length to detect actual matches.
      const matchedRoutes = hasActualRouteMatches(matchedRoutesForMethod)
        ? matchedRoutesForMethod
        : method === 'HEAD'
          ? app.router.match('GET', pathWithoutPrefix)
          : undefined
      if (!matchedRoutes || !hasActualRouteMatches(matchedRoutes)) {
        // Only claim this app as the scope for not-found when it has a
        // registered route on this path for some other method (e.g. POST
        // exists but OPTIONS was requested). This ensures the sub-app's
        // middlewares (like cors) run for preflight requests.
        const hasRouteForPath = app.routes.some((route) =>
          hasActualRouteMatches(app.router.match(route.method, pathWithoutPrefix)),
        )
        if (hasRouteForPath) foundApp = app
        continue
      }

      // Get all matched routes from this app
      const routes = matchedRoutes[0].map(([route, params], index) => ({
        app,
        route,
        params: this.getAllDecodedParams(
          matchedRoutes,
          pathWithoutPrefix,
          index,
        ),
      }))

      allRoutes.push(...routes)
    }

    return allRoutes.length
      ? allRoutes
      : [
          {
            app: foundApp || root,
            route: {
              hooks: {},
              handler: notFoundHandler,
              method,
              path,
            } as InternalRoute,
            params: {},
          },
        ]
  }

  state<const Name extends string | number | symbol, Value>(
    name: Name,
    value?: Value,
  ): Spiceflow<
    BasePath,
    Scoped,
    {
      state: Reconcile<
        Singleton['state'],
        {
          [name in Name]: Value
        }
      >
    },
    Definitions,
    Metadata,
    ClientRoutes,
    RoutePaths,
    RouteQuerySchemas
  > {
    this.defaultState[name] = value
    return this as any
  }

  /**
   * Create a new Router
   * @param options {@link RouterOptions} {@link Platform}
   */
  // Trusted origins for server action POST requests. Strings are compared with exact match,
  // RegExp patterns are tested against the Origin header. Used by the CSRF check in renderReact.
  allowedActionOrigins?: (string | RegExp)[]

  constructor(
    options: {
      name?: string
      scoped?: Scoped
      waitUntil?: WaitUntil
      basePath?: BasePath
      allowedActionOrigins?: (string | RegExp)[]
      tracer?: SpiceflowTracer
      serverTiming?: boolean
    } = {},
  ) {
    this.scoped = options.scoped
    this.allowedActionOrigins = options.allowedActionOrigins
    this.tracer = options.tracer ?? cloudflareTracer
    this.serverTiming = options.serverTiming ?? true

    this.waitUntilFn = options.waitUntil || defaultWaitUntil

    this.basePath = options.basePath || ''
    if (this.basePath === '/') {
      this.basePath = ''
    }
  }

  post<
    const Path extends string,
    const LocalSchema extends InputSchema<keyof Definitions['type'] & string>,
    const Schema extends UnwrapRoute<LocalSchema, Definitions['type']>,
    const Handle extends InlineHandler<
      this,
      Schema,
      Singleton,
      JoinPath<BasePath, Path>
    >,
  >(
    path: Path,
    handler: Handle,
    hook?: LocalHook<
      LocalSchema,
      Schema,
      Singleton,
      Definitions['error'],
      Metadata['macro'],
      JoinPath<BasePath, Path>
    >,
  ): Spiceflow<
    BasePath,
    Scoped,
    Singleton,
    Definitions,
    Metadata,
    ClientRoutes &
      CreateClient<
        JoinPath<BasePath, Path>,
        {
          post: {
            request: GetRequestSchema<Schema>
            params: undefined extends Schema['params']
              ? ResolvePath<Path>
              : Schema['params']
            query: Schema['query']
            response: ComposeSpiceflowResponse<Schema['response'], Handle>
          }
        }
      >,
    RoutePaths | JoinPath<BasePath, Path>,
    RouteQuerySchemas & Record<JoinPath<BasePath, Path>, Schema['query']>
  > {
    this.add({ method: 'POST', path, handler: handler, hooks: hook })

    return this as any
  }

  get<
    const Path extends string,
    const LocalSchema extends InputSchema<keyof Definitions['type'] & string>,
    const Schema extends UnwrapRoute<LocalSchema, Definitions['type']>,
    const Macro extends Metadata['macro'],
    const Handle extends InlineHandler<
      this,
      Schema,
      Singleton,
      JoinPath<BasePath, Path>
    >,
  >(
    path: Path,
    handler: Handle,
    hook?: LocalHook<
      LocalSchema,
      Schema,
      Singleton,
      Definitions['error'],
      Macro,
      JoinPath<BasePath, Path>
    >,
  ): Spiceflow<
    BasePath,
    Scoped,
    Singleton,
    Definitions,
    Metadata,
    ClientRoutes &
      CreateClient<
        JoinPath<BasePath, Path>,
        {
          get: {
            request: GetRequestSchema<Schema>
            params: undefined extends Schema['params']
              ? ResolvePath<Path>
              : Schema['params']
            query: Schema['query']

            response: ComposeSpiceflowResponse<Schema['response'], Handle>
          }
        }
      >,
    RoutePaths | JoinPath<BasePath, Path>,
    RouteQuerySchemas & Record<JoinPath<BasePath, Path>, Schema['query']>
  > {
    this.add({ method: 'GET', path, handler: handler, hooks: hook })
    return this as any
  }

  put<
    const Path extends string,
    const LocalSchema extends InputSchema<keyof Definitions['type'] & string>,
    const Schema extends UnwrapRoute<LocalSchema, Definitions['type']>,
    const Handle extends InlineHandler<
      this,
      Schema,
      Singleton,
      JoinPath<BasePath, Path>
    >,
  >(
    path: Path,
    handler: Handle,
    hook?: LocalHook<
      LocalSchema,
      Schema,
      Singleton,
      Definitions['error'],
      Metadata['macro'],
      JoinPath<BasePath, Path>
    >,
  ): Spiceflow<
    BasePath,
    Scoped,
    Singleton,
    Definitions,
    Metadata,
    ClientRoutes &
      CreateClient<
        JoinPath<BasePath, Path>,
        {
          put: {
            request: GetRequestSchema<Schema>
            params: undefined extends Schema['params']
              ? ResolvePath<Path>
              : Schema['params']
            query: Schema['query']

            response: ComposeSpiceflowResponse<Schema['response'], Handle>
          }
        }
      >,
    RoutePaths | JoinPath<BasePath, Path>,
    RouteQuerySchemas & Record<JoinPath<BasePath, Path>, Schema['query']>
  > {
    this.add({ method: 'PUT', path, handler: handler, hooks: hook })

    return this as any
  }

  route<
    const Path extends string,
    const LocalSchema extends InputSchema<keyof Definitions['type'] & string>,
    const Schema extends UnwrapRoute<LocalSchema, Definitions['type']>,
    const Handle extends InlineHandler<
      this,
      Schema,
      Singleton,
      JoinPath<BasePath, Path>
    >,
    Method extends HTTPMethod | HTTPMethod[] = '*',
  >(
    options: LocalHook<
      LocalSchema,
      Schema,
      Singleton,
      Definitions['error'],
      Metadata['macro'],
      JoinPath<BasePath, Path>
    > & {
      path: Path
      method?: Method
      handler: Handle
    },
  ): Spiceflow<
    BasePath,
    Scoped,
    Singleton,
    Definitions,
    Metadata,
    ClientRoutes &
      CreateClient<
        JoinPath<BasePath, Path>,
        {
          [M in Method extends readonly (infer E)[]
            ? Lowercase<E & string>
            : Lowercase<Method & string>]: {
            request: GetRequestSchema<Schema>
            params: undefined extends Schema['params']
              ? ResolvePath<Path>
              : Schema['params']
            query: Schema['query']
            response: ComposeSpiceflowResponse<Schema['response'], Handle>
          }
        }
      >,
    RoutePaths | JoinPath<BasePath, Path>,
    RouteQuerySchemas & Record<JoinPath<BasePath, Path>, Schema['query']>
  > {
    // If options.request is defined, disallow for GET and HEAD (methods that don't support a body)
    const methodsWithNoBody = ['GET', 'HEAD']
    const actualMethod = options.method ?? '*'
    const normalizedMethods: string[] = Array.isArray(actualMethod)
      ? actualMethod.flatMap((m) => {
          const method = typeof m === 'string' ? m.toUpperCase() : m
          return method === '*' ? [...METHODS] : [method]
        })
      : (() => {
          const method =
            typeof actualMethod === 'string'
              ? actualMethod.toUpperCase()
              : actualMethod
          return method === '*' ? [...METHODS] : [method as string]
        })()
    if (
      options.request &&
      normalizedMethods.some((m) => methodsWithNoBody.includes(m))
    ) {
      throw new Error(
        `Request schema ('request') is not allowed on routes with method GET or HEAD`,
      )
    }
    if (Array.isArray(actualMethod)) {
      actualMethod.map((method) => {
        if (method === '*') {
          for (const m of METHODS) {
            this.add({
              method: m,
              path: options.path,
              handler: options.handler,
              hooks: options,
            })
          }
        } else {
          this.add({
            method,
            path: options.path,
            handler: options.handler,
            hooks: options,
          })
        }
      })
    } else {
      if (actualMethod === '*') {
        for (const method of METHODS) {
          this.add({
            method,
            path: options.path,
            handler: options.handler,
            hooks: options,
          })
        }
      } else {
        this.add({
          method: actualMethod,
          path: options.path,
          handler: options.handler,
          hooks: options,
        })
      }
    }

    return this as any
  }

  patch<
    const Path extends string,
    const LocalSchema extends InputSchema<keyof Definitions['type'] & string>,
    const Schema extends UnwrapRoute<LocalSchema, Definitions['type']>,
    const Handle extends InlineHandler<
      this,
      Schema,
      Singleton,
      JoinPath<BasePath, Path>
    >,
  >(
    path: Path,
    handler: Handle,
    hook?: LocalHook<
      LocalSchema,
      Schema,
      Singleton,
      Definitions['error'],
      Metadata['macro'],
      JoinPath<BasePath, Path>
    >,
  ): Spiceflow<
    BasePath,
    Scoped,
    Singleton,
    Definitions,
    Metadata,
    ClientRoutes &
      CreateClient<
        JoinPath<BasePath, Path>,
        {
          patch: {
            request: GetRequestSchema<Schema>
            params: undefined extends Schema['params']
              ? ResolvePath<Path>
              : Schema['params']
            query: Schema['query']

            response: ComposeSpiceflowResponse<Schema['response'], Handle>
          }
        }
      >,
    RoutePaths | JoinPath<BasePath, Path>,
    RouteQuerySchemas & Record<JoinPath<BasePath, Path>, Schema['query']>
  > {
    this.add({ method: 'PATCH', path, handler: handler, hooks: hook })

    return this as any
  }

  delete<
    const Path extends string,
    const LocalSchema extends InputSchema<keyof Definitions['type'] & string>,
    const Schema extends UnwrapRoute<LocalSchema, Definitions['type']>,
    const Handle extends InlineHandler<
      this,
      Schema,
      Singleton,
      JoinPath<BasePath, Path>
    >,
  >(
    path: Path,
    handler: Handle,
    hook?: LocalHook<
      LocalSchema,
      Schema,
      Singleton,
      Definitions['error'],
      Metadata['macro'],
      JoinPath<BasePath, Path>
    >,
  ): Spiceflow<
    BasePath,
    Scoped,
    Singleton,
    Definitions,
    Metadata,
    ClientRoutes &
      CreateClient<
        JoinPath<BasePath, Path>,
        {
          delete: {
            request: GetRequestSchema<Schema>
            params: undefined extends Schema['params']
              ? ResolvePath<Path>
              : Schema['params']
            query: Schema['query']

            response: ComposeSpiceflowResponse<Schema['response'], Handle>
          }
        }
      >,
    RoutePaths | JoinPath<BasePath, Path>,
    RouteQuerySchemas & Record<JoinPath<BasePath, Path>, Schema['query']>
  > {
    this.add({ method: 'DELETE', path, handler: handler, hooks: hook })

    return this as any
  }

  options<
    const Path extends string,
    const LocalSchema extends InputSchema<keyof Definitions['type'] & string>,
    const Schema extends UnwrapRoute<LocalSchema, Definitions['type']>,
    const Handle extends InlineHandler<
      this,
      Schema,
      Singleton,
      JoinPath<BasePath, Path>
    >,
  >(
    path: Path,
    handler: Handle,
    hook?: LocalHook<
      LocalSchema,
      Schema,
      Singleton,
      Definitions['error'],
      Metadata['macro'],
      JoinPath<BasePath, Path>
    >,
  ): Spiceflow<
    BasePath,
    Scoped,
    Singleton,
    Definitions,
    Metadata,
    ClientRoutes &
      CreateClient<
        JoinPath<BasePath, Path>,
        {
          options: {
            request: GetRequestSchema<Schema>
            params: undefined extends Schema['params']
              ? ResolvePath<Path>
              : Schema['params']
            query: Schema['query']

            response: ComposeSpiceflowResponse<Schema['response'], Handle>
          }
        }
      >,
    RoutePaths | JoinPath<BasePath, Path>,
    RouteQuerySchemas & Record<JoinPath<BasePath, Path>, Schema['query']>
  > {
    this.add({ method: 'OPTIONS', path, handler: handler, hooks: hook })

    return this as any
  }

  all<
    const Path extends string,
    const LocalSchema extends InputSchema<keyof Definitions['type'] & string>,
    const Schema extends UnwrapRoute<LocalSchema, Definitions['type']>,
    const Handle extends InlineHandler<
      this,
      Schema,
      Singleton,
      JoinPath<BasePath, Path>
    >,
  >(
    path: Path,
    handler: Handle,
    hook?: LocalHook<
      LocalSchema,
      Schema,
      Singleton,
      Definitions['error'],
      Metadata['macro'],
      JoinPath<BasePath, Path>
    >,
  ): Spiceflow<
    BasePath,
    Scoped,
    Singleton,
    Definitions,
    Metadata,
    ClientRoutes &
      CreateClient<
        JoinPath<BasePath, Path>,
        {
          [method in string]: {
            request: GetRequestSchema<Schema>
            params: undefined extends Schema['params']
              ? ResolvePath<Path>
              : Schema['params']
            query: Schema['query']

            response: ComposeSpiceflowResponse<Schema['response'], Handle>
          }
        }
      >,
    RoutePaths | JoinPath<BasePath, Path>,
    RouteQuerySchemas & Record<JoinPath<BasePath, Path>, Schema['query']>
  > {
    for (const method of METHODS) {
      this.add({ method, path, handler: handler, hooks: hook })
    }

    return this as any
  }

  head<
    const Path extends string,
    const LocalSchema extends InputSchema<keyof Definitions['type'] & string>,
    const Schema extends UnwrapRoute<LocalSchema, Definitions['type']>,
    const Handle extends InlineHandler<
      this,
      Schema,
      Singleton,
      JoinPath<BasePath, Path>
    >,
  >(
    path: Path,
    handler: Handle,
    hook?: LocalHook<
      LocalSchema,
      Schema,
      Singleton,
      Definitions['error'],
      Metadata['macro'],
      JoinPath<BasePath, Path>
    >,
  ): Spiceflow<
    BasePath,
    Scoped,
    Singleton,
    Definitions,
    Metadata,
    ClientRoutes &
      CreateClient<
        JoinPath<BasePath, Path>,
        {
          head: {
            request: GetRequestSchema<Schema>
            params: undefined extends Schema['params']
              ? ResolvePath<Path>
              : Schema['params']
            query: Schema['query']

            response: ComposeSpiceflowResponse<Schema['response'], Handle>
          }
        }
      >,
    RoutePaths | JoinPath<BasePath, Path>,
    RouteQuerySchemas & Record<JoinPath<BasePath, Path>, Schema['query']>
  > {
    this.add({ method: 'HEAD', path, handler: handler, hooks: hook })

    return this as any
  }

  page<
    const Path extends string,
    const LocalSchema extends InputSchema<keyof Definitions['type'] & string>,
    const Schema extends UnwrapRoute<LocalSchema, Definitions['type']>,
  >(
    path: Path,
    handler: InlineHandler<
      this,
      Schema,
      Singleton,
      JoinPath<BasePath, Path>,
      {},
      MergedLoaderData<Metadata['loaderData'], JoinPath<BasePath, Path>>,
      RoutePaths | JoinPath<BasePath, Path>
    >,
  ): Spiceflow<
    BasePath,
    Scoped,
    Singleton,
    Definitions,
    Metadata,
    ClientRoutes,
    RoutePaths | JoinPath<BasePath, Path>,
    RouteQuerySchemas
  >
  page<
    const Path extends string,
    const LocalSchema extends InputSchema<keyof Definitions['type'] & string>,
    const Schema extends UnwrapRoute<LocalSchema, Definitions['type']>,
    const Handle extends InlineHandler<
      this,
      Schema,
      Singleton,
      JoinPath<BasePath, Path>,
      {},
      MergedLoaderData<Metadata['loaderData'], JoinPath<BasePath, Path>>,
      RoutePaths | JoinPath<BasePath, Path>
    >,
  >(
    options: LocalHook<
      LocalSchema,
      Schema,
      Singleton,
      Definitions['error'],
      Metadata['macro'],
      JoinPath<BasePath, Path>
    > & {
      path: Path
      handler: Handle
    },
  ): Spiceflow<
    BasePath,
    Scoped,
    Singleton,
    Definitions,
    Metadata,
    ClientRoutes,
    RoutePaths | JoinPath<BasePath, Path>,
    RouteQuerySchemas & Record<JoinPath<BasePath, Path>, Schema['query']>
  >
  page(pathOrOptions: any, handler?: any) {
    const path =
      typeof pathOrOptions === 'string' ? pathOrOptions : pathOrOptions.path
    const h =
      typeof pathOrOptions === 'string' ? handler : pathOrOptions.handler
    const hooks = typeof pathOrOptions === 'string' ? undefined : pathOrOptions

    const routeConfig = {
      path,
      handler: h,
      kind: 'page' as const,
      hooks,
    }
    this.add({ ...routeConfig, method: 'GET' })
    this.add({ ...routeConfig, method: 'POST' })
    return this as any
  }
  staticPage<
    const Path extends string,
    const LocalSchema extends InputSchema<keyof Definitions['type'] & string>,
    const Schema extends UnwrapRoute<LocalSchema, Definitions['type']>,
  >(
    path: Path,
    handler?: InlineHandler<
      this,
      Schema,
      Singleton,
      JoinPath<BasePath, Path>,
      {},
      MergedLoaderData<Metadata['loaderData'], JoinPath<BasePath, Path>>,
      RoutePaths | JoinPath<BasePath, Path>
    >,
  ): Spiceflow<
    BasePath,
    Scoped,
    Singleton,
    Definitions,
    Metadata,
    ClientRoutes,
    RoutePaths | JoinPath<BasePath, Path>,
    RouteQuerySchemas
  >
  staticPage<
    const Path extends string,
    const LocalSchema extends InputSchema<keyof Definitions['type'] & string>,
    const Schema extends UnwrapRoute<LocalSchema, Definitions['type']>,
    const Handle extends InlineHandler<
      this,
      Schema,
      Singleton,
      JoinPath<BasePath, Path>,
      {},
      MergedLoaderData<Metadata['loaderData'], JoinPath<BasePath, Path>>,
      RoutePaths | JoinPath<BasePath, Path>
    >,
  >(
    options: LocalHook<
      LocalSchema,
      Schema,
      Singleton,
      Definitions['error'],
      Metadata['macro'],
      JoinPath<BasePath, Path>
    > & {
      path: Path
      handler?: Handle
    },
  ): Spiceflow<
    BasePath,
    Scoped,
    Singleton,
    Definitions,
    Metadata,
    ClientRoutes,
    RoutePaths | JoinPath<BasePath, Path>,
    RouteQuerySchemas & Record<JoinPath<BasePath, Path>, Schema['query']>
  >
  staticPage(pathOrOptions: any, handler?: any) {
    const path =
      typeof pathOrOptions === 'string' ? pathOrOptions : pathOrOptions.path
    const h =
      typeof pathOrOptions === 'string' ? handler : pathOrOptions.handler
    const hooks = typeof pathOrOptions === 'string' ? undefined : pathOrOptions

    let kind: NodeKind = 'staticPage'
    if (!h) {
      kind = 'staticPageWithoutHandler'
    }
    const routeConfig = {
      path,
      handler: h,
      kind,
      hooks,
    }
    this.add({ ...routeConfig, method: 'GET' })
    return this as any
  }

  staticGet<
    const Path extends string,
    const LocalSchema extends InputSchema<keyof Definitions['type'] & string>,
    const Schema extends UnwrapRoute<LocalSchema, Definitions['type']>,
    const Macro extends Metadata['macro'],
    const Handle extends InlineHandler<
      this,
      Schema,
      Singleton,
      JoinPath<BasePath, Path>
    >,
  >(
    path: Path,
    handler: Handle,
    hook?: LocalHook<
      LocalSchema,
      Schema,
      Singleton,
      Definitions['error'],
      Macro,
      JoinPath<BasePath, Path>
    >,
  ): Spiceflow<
    BasePath,
    Scoped,
    Singleton,
    Definitions,
    Metadata,
    ClientRoutes,
    RoutePaths | JoinPath<BasePath, Path>,
    RouteQuerySchemas & Record<JoinPath<BasePath, Path>, Schema['query']>
  > {
    this.add({
      method: 'GET',
      path,
      handler: handler,
      hooks: hook,
      kind: 'staticGet',
    })
    return this as any
  }

  layout<
    const Path extends string,
    const LocalSchema extends InputSchema<keyof Definitions['type'] & string>,
    const Schema extends UnwrapRoute<LocalSchema, Definitions['type']>,
  >(
    path: Path,
    handler: InlineHandler<
      this,
      Schema,
      Singleton,
      JoinPath<BasePath, Path>,
      {},
      MergedLoaderData<Metadata['loaderData'], JoinPath<BasePath, Path>>,
      RoutePaths | JoinPath<BasePath, Path>
    >,
  ): Spiceflow<
    BasePath,
    Scoped,
    Singleton,
    Definitions,
    Metadata,
    ClientRoutes,
    RoutePaths,
    RouteQuerySchemas
  > {
    const routeConfig = {
      path,
      handler: handler,

      kind: 'layout' as const,
    }
    this.add({ ...routeConfig, method: 'GET' })
    this.add({ ...routeConfig, method: 'POST' })
    return this as any
  }

  loader<
    const Path extends string,
    const Handle extends (
      context: SpiceflowContext<
        JoinPath<BasePath, Path>,
        {},
        Singleton,
        {}
      >,
    ) => Record<string, unknown> | Promise<Record<string, unknown>>,
  >(
    path: Path,
    handler: Handle,
  ): Spiceflow<
    BasePath,
    Scoped,
    Singleton,
    Definitions,
    Metadata & {
      loaderData: Record<JoinPath<BasePath, Path>, Awaited<ReturnType<Handle>>>
    },
    ClientRoutes,
    RoutePaths,
    RouteQuerySchemas
  > {
    const routeConfig = {
      path,
      handler: handler as any,
      kind: 'loader' as const,
    }
    this.add({ ...routeConfig, method: 'GET' })
    this.add({ ...routeConfig, method: 'POST' })
    return this as any
  }

  private scoped?: Scoped = true as Scoped

  use<const NewSpiceflow extends AnySpiceflow>(
    instance: NewSpiceflow,
  ): IsAny<NewSpiceflow> extends true
    ? this
    : IsAny<NewSpiceflow['_types']['ClientRoutes']> extends true
      ? this
      : Spiceflow<
        BasePath,
        Scoped,
        Singleton,
        Definitions,
        Metadata & {
          loaderData: BasePath extends ``
            ? NewSpiceflow['_types']['Metadata']['loaderData']
            : PrefixLoaderData<
                BasePath,
                NewSpiceflow['_types']['Metadata']['loaderData']
              >
        },
        BasePath extends ``
          ? ClientRoutes & NewSpiceflow['_types']['ClientRoutes']
          : ClientRoutes &
              CreateClient<BasePath, NewSpiceflow['_types']['ClientRoutes']>,
        BasePath extends ``
          ? RoutePaths | NewSpiceflow['_types']['RoutePaths']
          :
              | RoutePaths
              | PrefixPaths<BasePath, NewSpiceflow['_types']['RoutePaths']>,
        BasePath extends ``
          ? RouteQuerySchemas & NewSpiceflow['_types']['RouteQuerySchemas']
          : RouteQuerySchemas &
              PrefixQuerySchemas<
                BasePath,
                NewSpiceflow['_types']['RouteQuerySchemas']
              >
      >
  use<const Schema extends RouteSchema>(
    path: string,
    handler: MiddlewareHandler<Schema, Singleton>,
  ): this
  use<const Schema extends RouteSchema>(
    handler: MiddlewareHandler<Schema, Singleton>,
  ): this

  use(appOrHandler: any, maybeHandler?: Function) {
    if (typeof appOrHandler === 'string' && typeof maybeHandler === 'function') {
      const pattern = appOrHandler
      const handler = maybeHandler
      const ownerApp: AnySpiceflow = this
      this.middlewares ??= []
      this.middlewares.push((context: any, next: any) => {
        const prefix = ownerApp.topLevelApp
          ? ownerApp.topLevelApp.joinBasePaths(
              ownerApp.topLevelApp.getAppAndParents(ownerApp).map((x: AnySpiceflow) => x.basePath),
            )
          : ''
        const fullPattern = prefix ? prefix + pattern : pattern
        if (!middlewarePathMatches(context.path, fullPattern)) return
        return handler(context, next)
      })
    } else if (appOrHandler instanceof Spiceflow) {
      appOrHandler.topLevelApp = this
      this.childrenApps.push(appOrHandler)
    } else if (typeof appOrHandler === 'function') {
      this.middlewares ??= []
      this.middlewares.push(appOrHandler)
    }
    return this
  }

  onError<const Schema extends RouteSchema>(
    handler: ErrorHandler<Definitions['error'], Schema, Singleton>,
  ): this {
    this.onErrorHandlers ??= []
    this.onErrorHandlers.push(handler as any)

    return this
  }

  private async resolveReactActionState({
    request,
    context,
    onErrorHandlers,
  }: {
    request: Request
    context: Partial<MiddlewareContext>
    onErrorHandlers: OnError[]
  }): Promise<ReactActionState | Response> {
    const emptyState: ReactActionState = {
      actionError: undefined,
      actionErrorDigest: undefined,
      returnValue: undefined,
      formState: undefined,
      temporaryReferences: undefined,
    }
    if (request.method !== 'POST') {
      return emptyState
    }

    // Skip origin check in development — tunnels, proxies, and different
    // ports constantly trigger false positives during local dev.
    const origin = request.headers.get('Origin')
    if (origin && !import.meta.hot) {
      const requestUrl = new URL(request.url)
      const root = this.topLevelApp || this
      const allowed = root.allowedActionOrigins
      const originUrl = URL.canParse(origin) ? new URL(origin) : null
      const isAllowed =
        (originUrl && originUrl.host === requestUrl.host) ||
        allowed?.some((rule) =>
          rule instanceof RegExp ? rule.test(origin) : origin === rule,
        )
      if (!isAllowed) {
        return new Response(
          `Forbidden: origin mismatch (request origin: "${origin}", server origin: "${requestUrl.origin}")`,
          { status: 403 },
        )
      }
    }

    const url = new URL(request.url)
    const actionId = url.searchParams.get('__rsc')
    const isCallServerRequest = Boolean(actionId)

    try {
      // After consuming the request body (formData/text), the original
      // ReadableStream is locked. Create a bodiless clone so
      // getActionRequest() returns a request whose body won't throw
      // "ReadableStream has been locked" if the action reads it (e.g.
      // to forward the request to an auth handler that only needs headers).
      const consumedRequest = new Request(request.url, {
        method: request.method,
        headers: request.headers,
        signal: request.signal,
      })

      if (actionId) {
        const temporaryReferences = createTemporaryReferenceSet()
        const contentType = request.headers.get('content-type')
        const body = contentType?.startsWith('multipart/form-data')
          ? await request.formData()
          : await request.text()
        const args = await decodeReply(body, { temporaryReferences })
        const action = await loadServerAction(actionId)

        return {
          actionError: undefined,
          actionErrorDigest: undefined,
          returnValue: await actionRequestStorage.run(consumedRequest, () =>
            action.apply(null, args),
          ),
          formState: undefined,
          temporaryReferences,
        }
      }

      const formData = await request.formData()
      const decodedAction = await decodeAction(formData)
      if (typeof decodedAction !== 'function') {
        return emptyState
      }

      return {
        actionError: undefined,
        actionErrorDigest: undefined,
        returnValue: undefined,
        formState: await decodeFormState(
          await actionRequestStorage.run(consumedRequest, () => decodedAction()),
          formData,
        ),
        temporaryReferences: undefined,
      }
    } catch (error) {
      // Redirect Responses thrown in callServer requests are encoded as action
      // errors with a __REACT_SERVER_ERROR__ digest so the client can detect
      // them and navigate via router.push(). Returning a raw 307 would cause
      // fetch() to follow the redirect (POST to new URL), which breaks on
      // Cloudflare Workers and other environments. Progressive enhancement
      // (no JS) forms still get the raw Response so the browser follows it.
      if (error instanceof Response && isRedirectStatus(error.status) && isCallServerRequest) {
        const headers = [...error.headers.entries()]
        const digest = `__REACT_SERVER_ERROR__:${JSON.stringify({ status: error.status, headers })}`
        const redirectError = new Error(digest)
        // Preserve non-location headers (e.g. set-cookie) from the redirect
        // Response so they can be sent on the actual HTTP flight response.
        const extraHeaders = new Headers(error.headers)
        extraHeaders.delete('location')
        return {
          actionError: redirectError,
          actionErrorDigest: digest,
          returnValue: undefined,
          formState: undefined,
          temporaryReferences: undefined,
          actionResponseHeaders: extraHeaders.keys().next().done ? undefined : extraHeaders,
        }
      }
      // Thrown Responses (redirect for progressive enhancement, notFound, etc.)
      // bypass the action payload — return them as HTTP responses.
      // For redirects from POST form actions, use 303 (See Other) so the browser
      // follows with a GET instead of re-POSTing to the target URL.
      if (error instanceof Response) {
        if (isRedirectStatus(error.status) && error.status === 307) {
          return new Response(null, {
            status: 303,
            headers: error.headers,
          })
        }
        return error
      }

      const actionError =
        error instanceof Error ? error : new Error(String(error))

      // Report action failures for both callServer requests and progressive
      // enhancement forms. callServer still needs the actionError payload so
      // the client error boundary can render it, so handler Responses only
      // take over the HTTP response for non-callServer submissions.
      const handlerResponse = await this.runErrorHandlers({
        context,
        onErrorHandlers,
        error: actionError,
        request,
      })
      if (handlerResponse && !isCallServerRequest) {
        return handlerResponse
      }

      return {
        actionError,
        actionErrorDigest: sanitizeErrorMessage(actionError.message),
        returnValue: undefined,
        formState: undefined,
        temporaryReferences: undefined,
      }
    }
  }

  async renderReact({
    request,
    context,
    reactRoutes,
    tracer,
  }: {
    request: Request
    context: SpiceflowContext<any, any, any>
    reactRoutes: ReactMatchedRoute[]
    tracer?: SpiceflowTracer
  }) {
    const [pageRoutes, nonPageRoutes] = partition(
      reactRoutes,
      (x) => x.route.kind === 'page' || x.route.kind === 'staticPage',
    )
    const [loaderRoutes, layoutRoutes] = partition(
      nonPageRoutes,
      (x) => x.route.kind === 'loader',
    )
    const pageRoute = pickBestRoute(pageRoutes)
    const hasLayoutRoute = layoutRoutes.some((x) => x.route.kind === 'layout')
    const hasRenderableRoute = !!pageRoute || hasLayoutRoute

    if (reactRoutes.length > 0 && !hasRenderableRoute) {
      return new Response('Not Found', { status: 404 })
    }

    // Only render the React 404 page for browser navigation requests (GET/HEAD
    // with sec-fetch-dest:document or Accept:text/html). API clients, curl, and
    // non-GET methods get plain text "Not Found" instead.
    const isSafeMethod = request.method === 'GET' || request.method === 'HEAD'
    const isBrowserNavigation =
      isDocumentRequest(request) ||
      request.headers.get('accept')?.includes('text/html')
    if (!pageRoute && !(isSafeMethod && isBrowserNavigation)) {
      return new Response('Not Found', { status: 404 })
    }

    const isNotFound = !pageRoute
    let baseResponse: ContextResponse | undefined
    const baseContext: SpiceflowContext<any, any, any> = {
      ...context,
      get response() {
        return (baseResponse ??= createContextResponse())
      },
    }

    const actionHandlers = [
      ...new Set(
        reactRoutes.flatMap((matchedRoute) => matchedRoute.app.onErrorHandlers),
      ),
    ]
    const actionState = await this.resolveReactActionState({
      request,
      context: baseContext,
      onErrorHandlers: actionHandlers,
    })
    if (actionState instanceof Response) {
      return actionState
    }
      try {
        return await routerContextStorage.run(
          createRouterContextData(request),
          async () => {
          // Execute loaders and merge their data directly. The trie router already
          // matched these loaders for this request — no need to re-match. Sort by
          // specificity so more specific loaders override less specific ones.
          loaderRoutes.sort(compareRouteSpecificity)
          let loaderError: Error | null = null
          const loaderResults = await Promise.all(
            loaderRoutes.map(async (loader) => {
              let handlerResponse: ContextResponse | undefined
              const loaderContext: SpiceflowContext<any, any, any> = {
                ...baseContext,
            params: loader.params,
            loaderData: {},
            get response() {
              return (handlerResponse ??= createContextResponse())
            },
          }
          try {
            if (!tracer) {
              const data = await loader.route.handler.call(
                loader.app,
                loaderContext,
              )
              if (data instanceof Response) throw data
              if (data == null)
                return {
                  data: null,
                  status: handlerResponse?.status,
                  headers: handlerResponse?.headers,
                }
              if (typeof data !== 'object' || Array.isArray(data)) {
                throw new Error(
                  `Loader "${loader.route.path}" must return a plain object, got ${Array.isArray(data) ? 'array' : typeof data}`,
                )
              }
              return {
                data,
                status: handlerResponse?.status,
                headers: handlerResponse?.headers,
              }
            }
            return await withSpan(
              tracer,
              `loader - ${loader.route.path}`,
              {},
              async (loaderSpan) => {
                if (loaderSpan) loaderContext.span = loaderSpan
                const data = await loader.route.handler.call(
                  loader.app,
                  loaderContext,
                )
                if (data instanceof Response) throw data
                if (data == null)
                  return {
                    data: null,
                    status: handlerResponse?.status,
                    headers: handlerResponse?.headers,
                  }
                if (typeof data !== 'object' || Array.isArray(data)) {
                  throw new Error(
                    `Loader "${loader.route.path}" must return a plain object, got ${Array.isArray(data) ? 'array' : typeof data}`,
                  )
                }
                return {
                  data,
                  status: handlerResponse?.status,
                  headers: handlerResponse?.headers,
                }
              },
            )
          } catch (error) {
            // Redirect/notFound Responses short-circuit the entire request
            if (error instanceof Response) throw error
            // Other errors are surfaced via error boundary during RSC render
            if (!loaderError)
              loaderError =
                error instanceof Error ? error : new Error(String(error))
            return {
              data: null,
              status: handlerResponse?.status,
              headers: handlerResponse?.headers,
            }
          }
            }),
          )
          const mergedLoaderData: Record<string, unknown> = {}
          let loaderStatus: number | undefined
          const loaderResponseHeaders = new Headers()
          for (const result of loaderResults) {
            if (result.data != null) Object.assign(mergedLoaderData, result.data)
            if (result.status && result.status !== 200) loaderStatus = result.status
            if (result.headers) appendHeaders(loaderResponseHeaders, result.headers)
          }
          const routerContext = routerContextStorage.getStore()
          if (routerContext) {
            routerContext.loaderData = mergedLoaderData
          }

          const executeHandler = async (
            route: ReactMatchedRoute,
            extra?: { id: string; children: React.ReactNode },
            activeSpan?: SpiceflowSpan,
          ): Promise<RouteResult> => {
            let handlerResponse: ContextResponse | undefined
            const handlerContext: SpiceflowContext<any, any, any> = {
              ...baseContext,
              params: route.params,
              loaderData: mergedLoaderData,
              ...(extra && { children: extra.children }),
              ...(activeSpan && { span: activeSpan }),
              get response() {
                return (handlerResponse ??= createContextResponse())
              },
            }
            try {
              const value = await route.route.handler.call(
                route.app,
                handlerContext,
              )
              if (value instanceof Error) {
                // Wrap in a component that throws during RSC rendering so error
                // boundaries can catch it and the __NO_HYDRATE shell renders.
                return {
                  kind: 'render',
                  element: <ThrowError error={value} />,
                  headers: handlerResponse?.headers,
                  status: handlerResponse?.status,
                }
              }
              if (isResponse(value)) {
                if (value.status === 404) {
                  return {
                    kind: 'throw-response',
                    response: value,
                    headers: handlerResponse?.headers,
                    status: handlerResponse?.status,
                  }
                }
                return {
                  kind: 'response',
                  response: value,
                  headers: handlerResponse?.headers,
                  status: handlerResponse?.status,
                }
              }
              return {
                kind: 'render',
                element: value,
                headers: handlerResponse?.headers,
                status: handlerResponse?.status,
              }
            } catch (error) {
              if (isResponse(error)) {
                return {
                  kind: 'throw-response',
                  response: error,
                  headers: handlerResponse?.headers,
                  status: handlerResponse?.status,
                }
              }
              return {
                kind: 'error',
                error,
                headers: handlerResponse?.headers,
                status: handlerResponse?.status,
              }
            }
          }

      const filteredLayouts = layoutRoutes.filter(
        (layout) => layout.route.kind === 'layout',
      )
      // Route ids are only unique per Spiceflow instance, so a parent
      // .layout('/*') and a mounted child's .layout('/*') share the same id.
      // The client resolves LayoutContent by finding its layout id in the
      // layouts array — duplicate ids make a layout resolve to itself,
      // causing infinite recursion during SSR. Uniquify per request.
      const seenLayoutIds = new Map<string, number>()
      const layoutIds = filteredLayouts.map((layout) => {
        const baseId = layout.route.id
        const count = seenLayoutIds.get(baseId) ?? 0
        seenLayoutIds.set(baseId, count + 1)
        return count === 0 ? baseId : `${baseId}~${count}`
      })
      const layoutResultsPromise = filteredLayouts.map(
        async (layout, layoutIndex) => {
          const id = layoutIds[layoutIndex]!
          // When no page matched, all layouts receive null children so any
          // layout in the chain can detect 404 and render a custom not-found UI.
          const children = isNotFound
            ? null
            : createElement(LayoutContent, { id })
          const result = !tracer
            ? await executeHandler(layout, { id, children })
            : await withSpan(
                tracer,
                `layout - ${layout.route.path}`,
                {},
                async (span) => {
                  const res = await executeHandler(
                    layout,
                    { id, children },
                    span,
                  )
                  if (res.kind === 'error' && span) {
                    recordError(span, res.error)
                  }
                  return res
                },
              )
          return { ...result, id }
        },
      )

      // Skip page handler when a loader failed — the error will be rendered
      // via <ThrowError> so the layout error boundary catches it.
      const pageResultPromise: Promise<RouteResult> = loaderError
        ? Promise.resolve({
            kind: 'render' as const,
            element: <ThrowError error={loaderError} />,
            headers: undefined,
            status: undefined,
          })
        : isNotFound
          ? Promise.resolve({
              kind: 'render' as const,
              element: <DefaultNotFoundPage />,
              headers: undefined,
              status: undefined,
            })
          : !tracer
            ? executeHandler(pageRoute)
            : withSpan(
                tracer,
                `page - ${pageRoute.route.path}`,
                {},
                async (span) => {
                  const res = await executeHandler(pageRoute, undefined, span)
                  if (res.kind === 'error' && span) {
                    recordError(span, res.error)
                  }
                  return res
                },
              )

      const [layoutResults, pageResult] = await Promise.all([
        Promise.all(layoutResultsPromise),
        pageResultPromise,
      ])

      const allResults = [...layoutResults, pageResult]
      const getReturnedResponse = (result: RouteResult) =>
        result.kind === 'response' ? result.response : undefined
      const getThrownResponse = (result: RouteResult) =>
        result.kind === 'throw-response' ? result.response : undefined
      const getRouteStatus = (result: RouteResult) => {
        const responseStatus = getThrownResponse(result)?.status
        if (responseStatus === 404) return 404
        if (result.status && result.status !== 200) return result.status
      }
      const findLastLayoutValue = <T,>(
        getValue: (result: (typeof layoutResults)[number]) => T | undefined,
      ) => {
        for (let i = layoutResults.length - 1; i >= 0; i--) {
          const value = getValue(layoutResults[i]!)
          if (value !== undefined) return value
        }
      }
      const renderRouteResult = (result: RouteResult): React.ReactNode => {
        if (result.kind === 'render') return result.element
        const response = getThrownResponse(result)
        if (response) return <ThrowResponse response={response} />
        if (result.kind === 'error') {
          throw result.error
        }
        throw new Error('Expected renderable route result')
      }

      const routeHeaders = new Headers()
      // Loader headers first (lowest priority), then layout/page headers override
      appendHeaders(routeHeaders, loaderResponseHeaders)
      for (const result of allResults) {
        if (result.headers) appendHeaders(routeHeaders, result.headers)
      }

      const getRedirectResponse = (result: RouteResult) => {
        const response = getReturnedResponse(result) ?? getThrownResponse(result)
        if (response && isRedirectStatus(response.status)) {
          return response
        }
      }

      const redirectResponse =
        getRedirectResponse(pageResult) ?? findLastLayoutValue(getRedirectResponse)
      if (redirectResponse) {
        return mergeHeadersIntoResponse({
          response: redirectResponse,
          source: routeHeaders,
        })
      }
      const pageResponse = getReturnedResponse(pageResult)
      const httpResponse =
        pageResponse ?? findLastLayoutValue(getReturnedResponse)
      if (httpResponse) {
        return mergeHeadersIntoResponse({
          response: httpResponse,
          source: routeHeaders,
        })
      }

      const firstError = allResults.find((result) => result.kind === 'error')
      if (firstError && firstError.kind === 'error') {
        throw firstError.error
      }

      // When isNotFound, all layouts get null children so their
      // ThrowResponse elements would be orphaned (root layout doesn't
      // include LayoutContent). Promote layout Response throws
      // (redirect/notFound) so they still take effect.
      if (isNotFound) {
        const layoutResponse = findLastLayoutValue(getThrownResponse)
        if (layoutResponse) {
          return mergeHeadersIntoResponse({
            response: layoutResponse,
            source: routeHeaders,
          })
        }
      }

      const layouts = layoutResults.map((layout) => ({
        id: layout.id,
        element: renderRouteResult(layout),
      }))

      const page = renderRouteResult(pageResult)

      // Global CSS: rscCssTransform auto-wraps component exports, but this entry
      // exports a Spiceflow instance so we call the RSC CSS loader manually.
      // The real loader lives behind #load-global-css so only the react-server
      // environment sees the vite-rsc static-analysis token.
      const globalCss = loadGlobalCss()
      let baseUrl = new URL('/', request.url).href
      if (baseUrl.endsWith('/')) {
        baseUrl = baseUrl.slice(0, -1)
      }

      const hasLoaderData = Object.keys(mergedLoaderData).length > 0
      let root: FlightData = {
        page,
        layouts,
        globalCss,
        ...(hasLoaderData && { loaderData: mergedLoaderData }),
        head: <CollectedHead baseUrl={baseUrl} />,
      }

      // In vitest mode, skip RSC Flight serialization and return the JSX
      // directly via SpiceflowTestResponse so tests can inspect page/layout
      // elements and loader data without needing a full RSC environment.
      if (__spiceflowVitestMode) {
        const pageHandlerStatus = getRouteStatus(pageResult)
        const layoutHandlerStatus = findLastLayoutValue(getRouteStatus)
        const status =
          pageHandlerStatus ?? layoutHandlerStatus ?? loaderStatus ?? (isNotFound ? 404 : 200)
        const headers = new Headers()
        appendHeaders(headers, routeHeaders)
        const deploymentId = await getDeploymentId()
        if (deploymentId) {
          headers.set(DEPLOYMENT_ID_HEADER, deploymentId)
        }
        // Compose layouts around the page from innermost to outermost,
        // replacing LayoutContent placeholders with the actual nested content.
        let element: React.ReactNode = root.page
        for (let i = root.layouts.length - 1; i >= 0; i--) {
          element = replaceLayoutContent(root.layouts[i]!.element, element)
        }
        // Capture the current router context so .text() can restore it
        // when rendering client components that call useLoaderData/getRouterContext.
        const routerContext = routerContextStorage.getStore()
        return new SpiceflowTestResponse({
          page: root.page,
          layouts: root.layouts,
          loaderData: mergedLoaderData,
          head: root.head,
          element,
          status,
          headers,
          routerContext,
        })
      }

      const payload =
        request.method === 'GET' || request.method === 'HEAD'
          ? ({ root } satisfies ServerPayload)
           : ({
              root,
              returnValue: actionState.returnValue,
              formState: actionState.formState,
              actionError: actionState.actionError,
              actionErrorDigest: actionState.actionErrorDigest,
            } satisfies ServerPayload)
      const buildRscResponse = async (serializeSpan?: SpiceflowSpan) => {
        const stream = renderToReadableStream<ServerPayload>(payload, {
          temporaryReferences: actionState.temporaryReferences,
          onError(error) {
            // TODO: for error reporting (Sentry-like), we need an error.handled
            // attribute to distinguish breaking errors from error-boundary-caught ones.
            // React's onError fires for both, but at this point we don't know if an
            // error boundary will catch it. Errors caught by boundaries are graceful
            // degradation (log-only), not incidents (notify). Same applies to loader
            // errors — they render through error boundaries, page still works.
            // When we build our own error reporting, add severity/handled classification
            // so non-breaking errors don't trigger notifications.
            if (serializeSpan) {
              recordError(serializeSpan, error)
            }
            if (error instanceof Response) {
              const headers = [...error.headers.entries()]
              return `__REACT_SERVER_ERROR__:${JSON.stringify({ status: error.status, headers })}`
            }
            formatServerError(error)
            if (verboseLogs) {
              console.error('[spiceflow:renderToReadableStream]', error)
            }
            return sanitizeErrorMessage(error?.digest || error?.message)
          },
          signal: request.signal,
        })

        const headers = new Headers({
          'content-type': 'text/x-component;charset=utf-8',
          'cache-control': 'no-store',
        })
        appendHeaders(headers, routeHeaders)
        if (actionState.actionResponseHeaders) {
          appendHeaders(headers, actionState.actionResponseHeaders)
        }
        // Deployment skew: client compares this to the bootstrap id and
        // hard-reloads when a new deploy is live (see entry.client.tsx).
        const deploymentId = await getDeploymentId()
        if (deploymentId) {
          headers.set(DEPLOYMENT_ID_HEADER, deploymentId)
        }

        const pageHandlerStatus = getRouteStatus(pageResult)
        const layoutHandlerStatus = findLastLayoutValue(getRouteStatus)
        const status =
          pageHandlerStatus ?? layoutHandlerStatus ?? loaderStatus ?? (isNotFound ? 404 : 200)

        return new Response(stream, { status, headers })
      }
          if (!tracer) return buildRscResponse()
          return withSpan(tracer, 'rsc.serialize', {}, buildRscResponse)
        },
      )
    } catch (error) {
      if (error instanceof Response) {
        return mergeHeadersIntoResponse({
          response: error,
          source: baseResponse?.headers,
        })
      }
      throw error
    }
  }

  handle = async (
    incomingRequest: Request,
    { state: customState }: { state?: Singleton['state'] } = {},
  ): Promise<Response> => {
    const request =
      incomingRequest instanceof SpiceflowRequest
        ? incomingRequest
        : new SpiceflowRequest(incomingRequest.url, incomingRequest)
    const u = request.parsedUrl

    let path = u.pathname
    // Strip .rsc suffix before route matching — the client appends it for RSC
    // data fetches, but routes are registered without it.
    if (path.endsWith('/index.rsc')) {
      path = path.slice(0, -9)
    } else if (path.endsWith('.rsc')) {
      path = path.slice(0, -4)
    }

    if (path !== u.pathname) {
      const normalizedUrl = new URL(request.url)
      normalizedUrl.pathname = path
      request.overrideUrl(normalizedUrl.toString())
    }

    // Stale client still on a previous deploy: skip action/page work and let
    // the browser hard-reload from the response header (entry.client).
    if (isRscRequest(u)) {
      const serverDeploymentId = await getDeploymentId()
      const clientDeploymentId = request.headers.get(DEPLOYMENT_ID_HEADER)
      if (
        isDeploymentSkew({
          clientDeploymentId: clientDeploymentId ?? '',
          serverDeploymentId,
        })
      ) {
        return new Response(null, {
          status: 204,
          headers: {
            [DEPLOYMENT_ID_HEADER]: serverDeploymentId,
            'cache-control': 'no-store',
          },
        })
      }
    }

    // Redirect browser document requests away from internal .rsc/__rsc URLs.
    // The client appends .rsc and __rsc for programmatic RSC fetches, but if a
    // user lands on one of these URLs directly (e.g. pasted link, bad redirect),
    // they'd see raw flight payload. Redirect them to the clean document URL.
    if (
      request.method === 'GET' &&
      isRscRequest(u) &&
      (isDocumentRequest(request) ||
        request.headers.get('accept')?.includes('text/html'))
    ) {
      const cleanUrl = stripRscUrl(u)
      return new Response(null, {
        status: 302,
        headers: { location: `${cleanUrl.pathname}${cleanUrl.search}` },
      })
    }

    // When a base path is set and the request is for bare `/`, redirect to
    // the base path so users see the app instead of a 404. Only the root app
    // redirects — sub-apps mounted via .use() must not hijack `/`.
    if (this.basePath && this.topLevelApp === this && (path === '/' || path === '')) {
      return new Response(null, {
        status: 302,
        headers: { location: this.basePath + '/' },
      })
    }

    const requestTracing = createRequestTracing({
      tracer: this.tracer,
      serverTiming: this.serverTiming,
    })
    const response = !requestTracing.tracer
      ? await this.executeRequest(request, u, path, customState, undefined, undefined)
      : await withSpan(
          requestTracing.tracer,
          request.method,
          {
            kind: SPAN_KIND_SERVER,
            attributes: {
              [ATTR.HTTP_REQUEST_METHOD]: request.method,
              [ATTR.URL_FULL]: request.url,
              [ATTR.URL_PATH]: path,
            },
          },
          async (rootSpan) => {
            return this.executeRequest(
              request,
              u,
              path,
              customState,
              rootSpan,
              requestTracing.tracer,
            )
          },
        )

    // For RSC fetches, wrap redirect responses as 200 + custom headers.
    // Without this, fetch() auto-follows 3xx redirects and cross-origin
    // redirects (e.g. OAuth to Google) fail with CORS errors.
    let finalResponse =
      isRscRequest(u) && isRedirectStatus(response.status)
        ? wrapRedirectForRsc(response)
        : response

    // Central stamp so middleware/redirect wrappers also carry the id when
    // the body is a flight payload (or the request was an RSC fetch).
    finalResponse = await stampDeploymentIdHeader(finalResponse, isRscRequest(u))

    return appendServerTimingHeader(
      finalResponse,
      requestTracing.getServerTimingHeader(),
    )
  }

  private executeRequest = async (
    request: SpiceflowRequest,
    u: URL,
    path: string,
    customState: any,
    rootSpan?: SpiceflowSpan,
    tracer?: SpiceflowTracer,
  ): Promise<Response> => {
    // Mutable ref — set after route resolution, read by waitUntil on error
    let onErrorHandlers: OnError[] = []
    let contextResponse: ContextResponse | undefined
    let _query: Record<string, any> | undefined
    const context: SpiceflowContext<any, any, any> = {
      redirect,
      state: customState || cloneDeep(this.defaultState),
      get query() {
        return (_query ??= parseQuery((u.search || '').slice(1)))
      },
      set query(v) {
        _query = v
      },
      request,
      path,
      params: {},
      loaderData: {},
      span: noopSpan,
      tracer: tracer ?? noopTracer,
      waitUntil: (promise) => {
        const wrappedPromise = promise.catch(async (error) => {
          const spiceflowError: SpiceflowServerError =
            error instanceof Error ? error : new Error(String(error))
          await this.runErrorHandlers({
            context,
            onErrorHandlers,
            error: spiceflowError,
            request,
          })
        })
        return this.waitUntilFn(wrappedPromise)
      },
      get response() {
        return (contextResponse ??= createContextResponse())
      },
    }

    const finalizeResponse = (response: Response, stripBody: boolean) => {
      return this.finalizeHeadResponse(
        response,
        stripBody,
        request.method === 'HEAD',
      )
    }

    return routerContextStorage.run(createRouterContextData(request), async () => {
      let routes = this.match(request.method, path)
      if (
        request.method === 'HEAD' &&
        routes.length === 1 &&
        routes[0]?.route?.handler === notFoundHandler
      ) {
        routes = this.match('GET', path)
      }
      const shouldStripHeadBody =
        request.method === 'HEAD' &&
        routes.every((matchedRoute) => matchedRoute.route.method !== 'HEAD')

      const resolved = this.resolveRoutes(request, routes)

      if (resolved.react) {
        const reactMatchedRoute = resolved.reactRoutes.find(
          (r) => r.route.kind === 'page' || r.route.kind === 'staticPage',
        )
        const reactRoute = reactMatchedRoute
          ? this.getFullRoutePath(reactMatchedRoute.route.path, reactMatchedRoute.app)
          : undefined
        if (rootSpan && reactRoute)
          rootSpan.updateName(`${request.method} ${reactRoute}`)

        const appsInScope = this.getAppsInScope(resolved.fallbackApp)
        onErrorHandlers = appsInScope.flatMap((x) => x.onErrorHandlers)

        const shouldSsr = !!renderSsr && !isRscRequest(u)
        let response = await this.runMiddlewareChain(
          appsInScope.flatMap((x) => x.middlewares),
          context,
          onErrorHandlers,
          async () => {
            let res = await this.renderReact({
              request,
              context,
              reactRoutes: resolved.reactRoutes,
              tracer,
            })
            if (
              shouldSsr &&
              renderSsr &&
              res.headers.get('content-type')?.startsWith('text/x-component')
            ) {
              res = tracer
                ? await withSpan(tracer, 'ssr.render', {}, () =>
                    renderSsr!(res, request),
                  )
                : await renderSsr(res, request)
            }
            return res
          },
          undefined,
          tracer,
        )

        const result = finalizeResponse(response, shouldStripHeadBody)
        finalizeRequestSpan(rootSpan, result, reactRoute)
        return result
      }

      const { route } = resolved
      const isRealRoute = route?.route?.handler !== notFoundHandler
      const routeTemplate = isRealRoute
        ? this.getFullRoutePath(route.route.path, route.app)
        : undefined
      if (rootSpan && routeTemplate)
        rootSpan.updateName(`${request.method} ${routeTemplate}`)

      const appsInScope = this.getAppsInScope(route.app)
      onErrorHandlers = appsInScope.flatMap((x) => x.onErrorHandlers)

      if (route?.route?.validateBody && request instanceof SpiceflowRequest) {
        request.validateBody = route?.route?.validateBody
      }
      context['params'] = route.params

      const scopedMiddlewares = appsInScope.flatMap((x) => x.middlewares)
      const middlewares = scopedMiddlewares.filter((x) => !isStaticMiddleware(x))
      const staticMiddlewares = scopedMiddlewares.filter((x) =>
        isStaticMiddleware(x),
      )
      const shouldTryStatic = routeShouldYieldToStatic(route.route)
      const middlewareChain = shouldTryStatic
        ? [...middlewares, ...staticMiddlewares]
        : middlewares

      let response = await this.runMiddlewareChain(
        middlewareChain,
        context,
        onErrorHandlers,
        async () => {
          // Pages skip query validation so missing params don't show error pages.
          // Coercion still runs (string→number etc.) but validation errors are swallowed.
          // API routes (.get, .post, etc.) still throw ValidationError on invalid query.
          const isPageRoute = route?.route?.kind === 'page' || route?.route?.kind === 'staticPage'
          context.query = await runValidation(
            coerceQueryWithSchema(context.query, route?.route?.hooks?.query),
            isPageRoute ? undefined : route?.route?.validateQuery,
          )
          context.params = await runValidation(
            context.params,
            route?.route?.validateParams,
          )

          if (!tracer) {
            const res = await route?.route?.handler.call(this, context)
            // Returning an Error from a handler is treated the same as throwing it:
            // routes through errorToResponse → onError handlers → status extraction.
            if (res instanceof Error) {
              throw res
            }
            if (isAsyncIterable(res)) {
              return this.handleStream({
                generator: res,
                request,
                onErrorHandlers,
                route: route?.route,
                context,
              })
            }
            return this.turnHandlerResultIntoResponse(res, route?.route, request)
          }
          const fullHandlerPath = route?.route?.path
            ? this.getFullRoutePath(route.route.path, route.app)
            : path
          return withSpan(
            tracer,
            `handler - ${fullHandlerPath}`,
            {},
            async (handlerSpan) => {
              const prevSpan = context.span
              if (handlerSpan) context.span = handlerSpan
              try {
                const res = await route?.route?.handler.call(this, context)
                // Returning an Error from a handler is treated the same as throwing it:
                // routes through errorToResponse → onError handlers → status extraction.
                if (res instanceof Error) {
                  throw res
                }
                if (isAsyncIterable(res)) {
                  return this.handleStream({
                    generator: res,
                    request,
                    onErrorHandlers,
                    route: route?.route,
                    context,
                  })
                }
                return this.turnHandlerResultIntoResponse(
                  res,
                  route?.route,
                  request,
                )
              } finally {
                context.span = prevSpan
              }
            },
          )
        },
        route?.route,
        tracer,
      )

      response = mergeHeadersIntoResponse({
        response,
        source: contextResponse?.headers,
      })

      // Respect context.response.status for plain-object/JSON handlers, but do
      // not override explicit statuses from returned/thrown Response objects.
      if (
        contextResponse?.status &&
        contextResponse.status !== 200 &&
        response.status === 200
      ) {
        response = new Response(response.body, {
          status: contextResponse.status,
          statusText: response.statusText,
          headers: response.headers,
        })
      }

      const result = finalizeResponse(response, shouldStripHeadBody)
      finalizeRequestSpan(rootSpan, result, routeTemplate)
      return result
    })
  }

  private resolveRoutes(
    request: Request,
    routes: MatchedRoute[],
  ):
    | {
        react: true
        reactRoutes: ReactMatchedRoute[]
        fallbackApp: AnySpiceflow
      }
    | { react: false; route: MatchedRoute } {
    const [nonReactRoutes, reactRoutes] = partition(
      routes,
      (x) => !x.route.kind || x.route.kind === 'staticGet',
    )
    const typedReactRoutes = reactRoutes.filter(isReactMatchedRoute)

    const isSafeMethod = request.method === 'GET' || request.method === 'HEAD'
    const isBrowserNavigation =
      isDocumentRequest(request) ||
      request.headers.get('accept')?.includes('text/html')
    const isUnmatchedRoute =
      nonReactRoutes.length === 1 &&
      nonReactRoutes[0]?.route?.handler === notFoundHandler
    const appHasReactPages = this.getAllRoutes().some(
      (r) => r.kind === 'page' || r.kind === 'staticPage',
    )
    const shouldRenderReact404 =
      isUnmatchedRoute &&
      !reactRoutes.length &&
      appHasReactPages &&
      isSafeMethod &&
      isBrowserNavigation
    const hasPageMatch = typedReactRoutes.some(
      (x) => x.route.kind === 'page' || x.route.kind === 'staticPage',
    )
    const hasLayoutMatch = typedReactRoutes.some((x) => x.route.kind === 'layout')
    const hasRealApiRoute = nonReactRoutes.some(
      (x) => x.route.handler !== notFoundHandler,
    )
    // Explicit .post()/.put()/.delete()/.patch() routes on the same path take
    // priority over the page's implicit POST handler (used for server actions).
    // Without this, a fetch POST to a page path always returns RSC HTML instead
    // of hitting the user-defined .post() handler.
    const shouldEnterReact = !!(
      (hasPageMatch && (isSafeMethod || !hasRealApiRoute)) ||
      (hasLayoutMatch && !hasRealApiRoute) ||
      shouldRenderReact404
    )

    if (shouldEnterReact) {
      return {
        react: true,
        reactRoutes: typedReactRoutes,
        fallbackApp: reactRoutes[0]?.app || nonReactRoutes[0]?.app || this,
      }
    }

    if (nonReactRoutes.length === 0) {
      return {
        react: false,
        route: createNotFoundMatchedRoute({
          app: reactRoutes[0]?.app || this,
          method: request.method,
          path: new URL(request.url).pathname,
        }),
      }
    }

    return { react: false, route: pickBestRoute(nonReactRoutes) }
  }

  private async runMiddlewareChain(
    middlewares: Function[],
    context: SpiceflowContext<any, any, any>,
    onErrorHandlers: OnError[],
    finalHandler: () => Promise<Response>,
    route?: InternalRoute,
    tracer?: SpiceflowTracer,
  ): Promise<Response> {
    let index = 0
    let handlerResponse: Response | undefined

    const next = async (): Promise<Response> => {
      try {
        if (index < middlewares.length) {
          const middleware = middlewares[index]
          index++
          const result = tracer
            ? await withSpan(
                tracer,
                `middleware - ${middleware.name || 'anonymous'}`,
                {},
                async (mwSpan) => {
                  const prevSpan = context.span
                  if (mwSpan) context.span = mwSpan
                  try {
                    return await middleware(context, next)
                  } finally {
                    context.span = prevSpan
                  }
                },
              )
            : await middleware(context, next)
          if (isResponse(result)) {
            handlerResponse = result
          }
          if (!result && index < middlewares.length) {
            return await next()
          }
          if (result) {
            return this.turnHandlerResultIntoResponse(
              result,
              route,
              context.request,
            )
          }
        }
        if (handlerResponse) {
          return handlerResponse
        }
        handlerResponse = await finalHandler()
        return handlerResponse
      } catch (err) {
        handlerResponse = await this.errorToResponse(
          err,
          context,
          onErrorHandlers,
        )
        return await next()
      }
    }

    return next()
  }

  private async errorToResponse(
    err: any,
    context: Partial<MiddlewareContext>,
    onErrorHandlers: OnError[],
  ): Promise<Response> {
    if (isResponse(err)) return err
    const errCtx = getErrorContext(err)
    const redirectInfo = isRedirectError(errCtx)
    if (redirectInfo) {
      return new Response(redirectInfo.location, {
        status: errCtx!.status,
        headers: contextToHeaders(errCtx!),
      })
    }
    if (isNotFoundError(errCtx)) {
      return new Response(JSON.stringify('not found'), { status: 404 })
    }
    const request = context.request!
    let res = await this.runErrorHandlers({
      context,
      onErrorHandlers,
      error: err,
      request,
    })
    if (isResponse(res)) return res

    // In dev mode, re-throw document/RSC errors so they reach Vite's error
    // middleware and show the overlay in the browser. Plain API requests should
    // keep returning JSON error bodies instead of Vite's HTML 500 page.
    const isBrowserNavigation =
      isDocumentRequest(request) ||
      request.headers.get('accept')?.includes('text/html')
    if (import.meta.hot && (isBrowserNavigation || isRscRequest(new URL(request.url)))) {
      throw err
    }

    let status = err?.status ?? err?.statusCode ?? 500
    if (typeof status !== 'number' || status < 100 || status > 599) {
      status = 500
    }
    return new Response(
      this.jsonSerialize(
        {
          ...err,
          message: err?.message || 'Internal Server Error',
          ...(err instanceof Error && err.stack ? { stack: err.stack } : {}),
        },
      ),
      { status, headers: { 'content-type': 'application/json' } },
    )
  }

  private finalizeHeadResponse(
    response: Response,
    stripBody: boolean,
    isHead: boolean,
  ) {
    // per HTTP spec, HEAD responses must never include a body
    if (!stripBody && !isHead) return response
    return new Response(null, {
      status: response.status,
      statusText: response.statusText,
      headers: new Headers(response.headers),
    })
  }

  protected jsonSerialize(
    value: any,
    indent = false,
  ): string {
    return JSON.stringify(value ?? null, null, indent ? 2 : undefined)
  }

  private async turnHandlerResultIntoResponse(
    result: any,
    route?: InternalRoute,
    request?: Request,
  ): Promise<Response> {
    // if user returns a promise, await it
    if (result instanceof Promise) {
      result = await result
    }

    if (isResponse(result)) {
      return result
    }

    if (route?.type) {
      if (route.type?.includes('multipart/form-data')) {
        if (!(result instanceof Response)) {
          throw new Error(
            `Invalid form data returned from route handler ${
              route.path
            } - expected Response but got ${
              result?.constructor?.name || typeof result
            }. FormData cannot be returned directly - it must be wrapped in a Response object with the appropriate content-type header.`,
          )
        }
      }
      if (route.type?.includes('application/x-www-form-urlencoded')) {
        if (!(result instanceof URLSearchParams)) {
          throw new Error(
            `Invalid URL encoded data returned from route handler ${
              route.path
            } - expected URLSearchParams but got ${
              result?.constructor?.name || typeof result
            }`,
          )
        }
        return new Response(result, {
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
          },
        })
      }

      if (route.type?.includes('text/plain')) {
        if (typeof result !== 'string') {
          throw new Error(
            `Invalid text returned from route handler ${
              route.path
            } - expected string but got ${
              result?.constructor?.name || typeof result
            }`,
          )
        }
        return new Response(result, {
          headers: {
            'content-type': 'text/plain',
          },
        })
      }
    }

    return new Response(this.jsonSerialize(result), {
      headers: {
        'content-type': 'application/json',
      },
    })
  }

  private async runErrorHandlers({
    context,
    onErrorHandlers = [] as OnError[],
    error: err,
    request,
  }: {
    context: Partial<MiddlewareContext>
    onErrorHandlers?: OnError[]
    error: SpiceflowServerError
    request: Request
  }) {
    const reportKey = getErrorReportKey(err)
    const reportedErrors = getReportedErrorKeys(request)
    if (reportedErrors.has(reportKey)) return

    reportedErrors.add(reportKey)

    if (onErrorHandlers.length === 0) {
      console.error(`Spiceflow unhandled error:`, err)
    } else {
      for (const errHandler of onErrorHandlers) {
        const reqUrl = new URL(request.url)
        const path = reqUrl.pathname + reqUrl.search
        const res = errHandler({ ...context, path, error: err, request })
        if (isResponse(res)) {
          return res
        }
        const errCtx = getErrorContext(err)
        const redirectInfo = isRedirectError(errCtx)
        if (redirectInfo) {
          return new Response(redirectInfo.location, {
            status: errCtx!.status,
            headers: contextToHeaders(errCtx!),
          })
        }
      }
    }
  }

  /** Prepend the basePath prefix for a route's owning app to get the full path template. */
  private getFullRoutePath(routePath: string, app?: AnySpiceflow): string {
    if (!app) return routePath
    const prefix = this.joinBasePaths(
      this.getAppAndParents(app).map((x) => x.basePath),
    )
    const joined = prefix + routePath
    return joined.replace(/\/$/, '') || '/'
  }

  private joinBasePaths(basePaths: (string | undefined)[]): string {
    // Filter out empty/undefined paths and remove consecutive duplicates
    const filteredPaths = basePaths
      .filter((path): path is string => path !== undefined && path !== '')
      .filter((path, index, arr) => index === 0 || path !== arr[index - 1])

    // Skip paths that are prefixes of the previous path (parent is prefix of child)
    const result: string[] = []
    for (let i = 0; i < filteredPaths.length; i++) {
      const currentPath = filteredPaths[i]
      const previousPath = result[result.length - 1]

      // Skip if the previous path is a prefix of the current path
      if (previousPath && currentPath.startsWith(previousPath)) {
        // Replace the previous path with the current path (which is longer)
        result[result.length - 1] = currentPath
      } else {
        result.push(currentPath)
      }
    }

    return result.join('')
  }

  private getAppAndParents(currentApp?: AnySpiceflow) {
    let root = this.topLevelApp || this

    if (!root.childrenApps.length) {
      return [root]
    }
    const parents: AnySpiceflow[] = []
    let current = currentApp

    const parentMap = new Map<number, AnySpiceflow>()
    bfsFind(root, (node) => {
      for (const child of node.childrenApps) {
        parentMap.set(child.id, node)
      }
    })

    // Traverse the parent map to get the parents
    while (current) {
      parents.unshift(current)
      current = parentMap.get(current.id)
    }

    return parents.filter((x) => x !== undefined)
  }

  private getAppsInScope(currentApp?: AnySpiceflow) {
    let root = this.topLevelApp || this
    if (!root.childrenApps.length) {
      return [root]
    }
    const withParents = this.getAppAndParents(currentApp)

    const wantedOrder = bfs(root)
    const scopeFalseApps = wantedOrder.filter((x) => x.scoped === false)
    let appsInScope = [] as AnySpiceflow[]
    for (const app of wantedOrder) {
      if (scopeFalseApps.includes(app)) {
        appsInScope.push(app)
        continue
      }
      if (withParents.includes(app)) {
        appsInScope.push(app)
        continue
      }
    }
    return appsInScope
  }

  async listen(
    port: number,
    hostname: string = '0.0.0.0',
  ): Promise<SpiceflowListenResult> {
    // In Vite dev, Vite owns the server — noop
    if (import.meta.hot) return createNoopListenResult()
    // During prerender, skip server startup — we only need the app instance.
    // Uses globalThis instead of process.env because bundlers replace
    // process.env.X with its build-time value (undefined), dead-code eliminating the check.
    if ((globalThis as any).__SPICEFLOW_PRERENDER)
      return createNoopListenResult()
    const handler = this.handle.bind(this)
    if (typeof Bun !== 'undefined') {
      const app = this
      const server = Bun.serve({
        port,
        development: (Bun.env.NODE_ENV ?? Bun.env.ENV) !== 'production',
        hostname,
        reusePort: true,
        error(error) {
          console.error(error)
          const message = error instanceof Error ? error.message : 'Internal Server Error'
          return new Response(
            app.jsonSerialize({ message, ...(error instanceof Error && error.stack ? { stack: error.stack } : {}) }),
            {
              status: 500,
            },
          )
        },
        fetch: handler,
      })

      const stop = async () => {
        server.stop()
      }

      process.on('beforeExit', () => {
        void stop()
      })

      const displayedHost =
        server.hostname === '0.0.0.0' ? 'localhost' : server.hostname
      console.log(`Listening on http://${displayedHost}:${server.port}`)

      return { port: server.port, server, stop }
    }

    // Deno native server — uses Deno.serve() with web standard Request/Response,
    // bypassing the node:http adapter for better performance.
    if (typeof Deno !== 'undefined' && typeof Deno.serve === 'function') {
      const server = Deno.serve({ port, hostname }, handler) as {
        shutdown: () => Promise<void>
      }

      return {
        port,
        server,
        stop: async () => {
          await server.shutdown()
        },
      }
    }

    return listenForNode(handler, port, hostname)
  }

  handleForNode = (
    req: IncomingMessage,
    res: ServerResponse,
    context: { state?: Singleton['state'] } = {},
  ) => {
    return handleForNode(this, req, res, context)
  }

  private async handleStream({
    onErrorHandlers,
    generator,
    request,
    route,
    context,
  }: {
    generator: Generator | AsyncGenerator
    onErrorHandlers: OnError[]
    request: Request
    route: InternalRoute
    context?: Partial<MiddlewareContext>
  }) {
    let init = generator.next()
    if (init instanceof Promise) init = await init

    if (init?.done) {
      return new Response(
        'event: message\ndata: ' +
          this.jsonSerialize(init.value) +
          '\n\n' +
          'event: done\n\n',
        {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            // fix for fly.io streaming
            // https://github.com/vercel/next.js/issues/9965#issuecomment-584319868
            'content-encoding': 'none',
          },
        },
      )
    }

    let self = this

    // Get an explicit async iterator so pull() can advance one step at a time.
    // Generators implement .next() directly, while other async iterables
    // (e.g. ReadableStream) need [Symbol.asyncIterator]() to produce one.
    const iterator: AsyncIterator<unknown> =
      typeof (generator as any).next === 'function'
        ? (generator as AsyncIterator<unknown>)
        : (generator as any)[Symbol.asyncIterator]()

    let end = false
    let ping: ReturnType<typeof setInterval> | undefined
    let onAbort: (() => void) | undefined

    // Idempotent cleanup: clears ping, removes abort listener, terminates iterator
    const cleanup = () => {
      if (end) return
      end = true
      if (ping) {
        clearInterval(ping)
        ping = undefined
      }
      if (onAbort) {
        request?.signal?.removeEventListener('abort', onAbort)
        onAbort = undefined
      }
      void iterator.return?.()
    }

    return new Response(
      new ReadableStream({
        start(controller) {
          ping = setInterval(() => {
            if (!end) {
              try {
                controller.enqueue(Buffer.from('\n'))
              } catch {
                cleanup()
              }
            }
          }, 10 * 1000)

          onAbort = () => {
            cleanup()
            try {
              controller.close()
            } catch {}
          }
          request?.signal?.addEventListener('abort', onAbort)

          // Enqueue the already-extracted init value (first generator
          // result, used above for done detection). Subsequent values
          // are produced on-demand by pull().
          if (init?.value !== undefined && init?.value !== null) {
            controller.enqueue(
              Buffer.from(
                'event: message\ndata: ' +
                  self.jsonSerialize(init.value) +
                  '\n\n',
              ),
            )
          }
        },

        async pull(controller) {
          if (end) {
            try {
              controller.close()
            } catch {}
            return
          }

          try {
            const { value: chunk, done } = await iterator.next()

            if (done || end) {
              cleanup()
              try {
                controller.close()
              } catch {}
              return
            }

            // null/undefined chunks are skipped; the runtime will
            // call pull() again since nothing was enqueued.
            if (chunk === undefined || chunk === null) return

            controller.enqueue(
              Buffer.from(
                'event: message\ndata: ' +
                  self.jsonSerialize(chunk) +
                  '\n\n',
              ),
            )
          } catch (error: any) {
            await self.runErrorHandlers({
              context: context ?? {},
              onErrorHandlers: onErrorHandlers,
              error,
              request,
            })
            try {
              controller.enqueue(
                Buffer.from(
                  'event: error\ndata: ' +
                    self.jsonSerialize(
                      {
                        ...error,
                        message: error.message || error.name || 'Error',
                      },
                    ) +
                    '\n\n',
                ),
              )
            } catch {}
            cleanup()
            try {
              controller.close()
            } catch {}
          }
        },

        cancel() {
          cleanup()
        },
      }),
      {
        headers: {
          'content-type': 'text/event-stream; charset=utf-8',
          // fix for fly.io streaming
          // https://github.com/vercel/next.js/issues/9965#issuecomment-584319868
          'content-encoding': 'none',
          'cache-control': 'no-cache',
        },
      },
    )
  }
  href: HrefBuilder<RoutePaths, RouteQuerySchemas> = (path, ...rest) => {
    return buildHref(path, rest[0] as object | undefined) as ResolvedHref
  }
}


const METHODS = [
  'ALL',
  'CONNECT',
  'DELETE',
  'GET',
  'HEAD',
  'OPTIONS',
  'PATCH',
  'POST',
  'PUT',
  'TRACE',
] as const

/** HTTP method string */
export type Method = (typeof METHODS)[number]

function isMethod(value: string): value is Method {
  return METHODS.some((method) => method === value)
}

function createNotFoundMatchedRoute({
  app,
  method,
  path,
}: {
  app: AnySpiceflow
  method: string
  path: string
}): MatchedRoute {
  return {
    app,
    route: {
      id: `__not_found__:${method}:${path}`,
      type: '',
      method: isMethod(method) ? method : 'GET',
      path,
      handler: notFoundHandler,
      hooks: {},
    },
    params: {},
  }
}

function bfsFind<T>(
  tree: AnySpiceflow,
  onNode: (node: AnySpiceflow) => T | undefined | void,
): T | undefined {
  const queue = [tree]

  while (queue.length > 0) {
    const node = queue.shift()!

    const result = onNode(node)
    if (result) {
      return result
    }
    queue.push(...node.childrenApps)
  }
  return
}

export class SpiceflowRequest<T = any> extends Request {
  validateBody?: ValidationFunction
  private _urlOverride?: string
  /** Original transport URL before Spiceflow normalizes .rsc pathnames for handlers. */
  private _originalUrl: string
  /** Lazily parsed URL, cached on first access so we only parse once */
  private _parsedUrl?: URL

  constructor(input: RequestInfo | URL, init?: RequestInit) {
    super(input, init)
    this._originalUrl = super.url
  }

  /** Raw incoming request URL, including transport-only `.rsc` pathnames when present. */
  get originalUrl(): string {
    return this._originalUrl
  }

  /**
   * App-facing request URL.
   *
   * For RSC transport requests, Spiceflow strips the `.rsc` pathname suffix before
   * user handlers run, but intentionally keeps the `__rsc` query param so middleware
   * and static serving can still detect Flight requests.
   */
  override get url(): string {
    return this._urlOverride ?? super.url
  }

  overrideUrl(url: string) {
    this._urlOverride = url
    this._parsedUrl = undefined
    return this
  }

  get parsedUrl(): URL {
    this._parsedUrl ??= new URL(this.url, 'http://localhost')
    return this._parsedUrl
  }
  private textPromise?: Promise<string>
  private jsonPromise?: Promise<T>

  async text(): Promise<string> {
    this.textPromise ??= super.text()
    return this.textPromise
  }

  async json(): Promise<T> {
    this.jsonPromise ??= this.text().then(async (text) => {
      const body = JSON.parse(text) as T
      return runValidation(body, this.validateBody)
    })
    return this.jsonPromise
  }
}

export function bfs(tree: AnySpiceflow) {
  const queue = [tree]
  let nodes: AnySpiceflow[] = []
  while (queue.length > 0) {
    const node = queue.shift()!
    if (node) {
      nodes.push(node)
    }
    // const result = onNode(node)

    if (node?.childrenApps?.length) {
      queue.push(...node.childrenApps)
    }
  }
  return nodes
}

type RouteResult =
  | {
      kind: 'render'
      element: React.ReactNode
      headers?: Headers
      status?: number
    }
  | {
      kind: 'response'
      response: Response
      headers?: Headers
      status?: number
    }
  | {
      kind: 'throw-response'
      response: Response
      headers?: Headers
      status?: number
    }
  | {
      kind: 'error'
      error: unknown
      headers?: Headers
      status?: number
    }

type ReactRoute = InternalRoute & {
  kind: 'page' | 'staticPage' | 'layout' | 'loader'
  handler: (this: AnySpiceflow, context: SpiceflowContext<any, any, any>) => any
}

type ReactMatchedRoute = {
  route: ReactRoute
  app: AnySpiceflow
  params: Record<string, string>
}

type ReactActionState = {
  actionError: Error | undefined
  actionErrorDigest: string | undefined
  returnValue: unknown | undefined
  formState: ReactFormState | undefined
  temporaryReferences:
    | ReturnType<(typeof import('#rsc-runtime'))['createTemporaryReferenceSet']>
    | undefined
  // Extra headers from redirect responses (e.g. set-cookie) that should be
  // merged into the flight HTTP response even though the redirect itself is
  // encoded in the action error digest for client-side navigation.
  actionResponseHeaders?: Headers
}

function isReactMatchedRoute(route: {
  route: InternalRoute
  app: AnySpiceflow
  params: Record<string, string>
}): route is ReactMatchedRoute {
  return !!route.route.kind
}

function ThrowResponse({ response }: { response: Response }): never {
  throw response
}

function ThrowError({ error }: { error: Error }): never {
  throw error
}

export type AnySpiceflow = Spiceflow<any, any, any, any, any, any, any, any>

export function isZodSchema(value: unknown): value is ZodType {
  return (
    value instanceof ZodType ||
    (typeof value === 'object' &&
      value !== null &&
      'parse' in value &&
      'safeParse' in value &&
      'optional' in value &&
      'nullable' in value)
  )
}

import type * as z from 'zod'

/** `true` ⇒ the value was created by Zod 4, `false` ⇒ Zod 3 */
export function isZod4(schema: any): schema is z.ZodObject {
  return '_zod' in schema // ⇦ only v4 adds this marker
}

function getValidateFunction(
  schema: TypeSchema,
): ValidationFunction | undefined {
  if (!schema) {
    return
  }
  try {
    return schema['~standard'].validate
  } catch (error) {
    console.log(`not a standard schema: ${schema}`)
    return undefined
  }
}

async function runValidation(value: any, validate?: ValidationFunction) {
  if (!validate) return value

  let result = validate(value)
  if (result instanceof Promise) {
    result = await result
  }

  if (result.issues && result.issues.length > 0) {
    const errorMessages = result.issues
      .map((issue) => {
        let pathString = ''
        if (issue.path && issue.path.length > 0) {
          pathString = issue.path.join('.') + ': '
        }
        return pathString + issue.message
      })
      .join('\\n')
    throw new ValidationError(errorMessages || 'Validation failed')
  }
  if ('value' in result) {
    return result.value
  }
  return value
}

function parseQuery(queryString: string) {
  // Create a URLSearchParams instance
  const params = new URLSearchParams(queryString)

  // Convert to an object with arrays for repeated keys
  const paramsObject = {}
  for (const [key, value] of params) {
    // If the key already exists, convert to an array or push to the existing array
    if (Object.prototype.hasOwnProperty.call(paramsObject, key)) {
      paramsObject[key] = Array.isArray(paramsObject[key])
        ? [...paramsObject[key], value]
        : [paramsObject[key], value]
    } else {
      paramsObject[key] = value // Set the value if it's the first occurrence
    }
  }
  return paramsObject
}

// TODO support things after *, like /files/*/path/to/file.txt
export function extractWildcardParam(
  url: string,
  patternUrl: string,
): { '*'?: string } | null {
  // Check if pattern contains wildcard
  if (!patternUrl.includes('*')) {
    return null
  }

  // Split pattern and url into segments
  const patternParts = patternUrl.split('/').filter(Boolean)
  const urlParts = url.split('/').filter(Boolean)

  // Find wildcard index in pattern
  const wildcardIndex = patternParts.indexOf('*')
  if (wildcardIndex === -1) {
    return null
  }

  const suffixLength = patternParts.length - wildcardIndex - 1
  const endIndex =
    suffixLength > 0 ? urlParts.length - suffixLength : urlParts.length
  const wildcardSegments = urlParts.slice(wildcardIndex, endIndex)
  if (!wildcardSegments.length) {
    return null
  }

  // Join segments with / to get full wildcard path, then decode like named params
  const raw = wildcardSegments.join('/')
  let decoded: string
  try {
    decoded = /\%/.test(raw) ? decodeURIComponent_(raw) : raw
  } catch {
    decoded = raw
  }
  return {
    '*': decoded,
  }
}

export function cloneDeep(x) {
  return copy(x)
}

function getRouteSpecificity(route: InternalRoute) {
  const parts = route.path.split('/').filter(Boolean)
  const wildcardCount = parts.filter((p) => p === '*').length
  const regexParamCount = parts.filter((p) => /^:[^{}]+\{.+\}$/.test(p)).length
  const namedParamCount = parts.filter(
    (p) => p.startsWith(':') && !/^:[^{}]+\{.+\}$/.test(p),
  ).length
  const staticSegmentCount =
    parts.length - wildcardCount - regexParamCount - namedParamCount
  const segmentCount = parts.length
  return {
    wildcardCount,
    namedParamCount,
    regexParamCount,
    staticSegmentCount,
    segmentCount,
  }
}

function pickBestRoute<T extends { route: InternalRoute; app?: AnySpiceflow }>(
  routes: T[],
): T {
  if (routes.length <= 1) return routes[0]
  let best = routes[0]
  let bestSpec = getRouteSpecificity(best.route)
  for (let i = 1; i < routes.length; i++) {
    const spec = getRouteSpecificity(routes[i].route)
    // 1. Fewer wildcards wins (static/named > wildcard)
    if (spec.wildcardCount < bestSpec.wildcardCount) {
      best = routes[i]
      bestSpec = spec
      continue
    }
    if (spec.wildcardCount > bestSpec.wildcardCount) continue
    // 2. More static segments wins
    if (spec.staticSegmentCount > bestSpec.staticSegmentCount) {
      best = routes[i]
      bestSpec = spec
      continue
    }
    if (spec.staticSegmentCount < bestSpec.staticSegmentCount) continue
    // 3. More regex params wins (regex > generic param)
    if (spec.regexParamCount > bestSpec.regexParamCount) {
      best = routes[i]
      bestSpec = spec
      continue
    }
    if (spec.regexParamCount < bestSpec.regexParamCount) continue
    // 4. Fewer plain named params wins (static and regex > :param)
    if (spec.namedParamCount < bestSpec.namedParamCount) {
      best = routes[i]
      bestSpec = spec
      continue
    }
    if (spec.namedParamCount > bestSpec.namedParamCount) continue
    // 5. More segments wins (longer match)
    if (spec.segmentCount > bestSpec.segmentCount) {
      best = routes[i]
      bestSpec = spec
      continue
    }
    if (spec.segmentCount < bestSpec.segmentCount) continue
    // 6. Same pattern shape: within the same app instance last registered
    //    wins (route override). Across different apps first match wins
    //    (parent / earlier .use() takes priority, matching Express/Hono).
    if (best.app && routes[i].app && best.app === routes[i].app) {
      best = routes[i]
      bestSpec = spec
    }
  }
  return best
}

// The trie router returns [[]] when a path node exists but has no handler
// for the requested method. Check the inner array to detect real matches.
function hasActualRouteMatches(result: any): boolean {
  return Boolean(result?.[0]?.length)
}

function middlewarePathMatches(requestPath: string, pattern: string): boolean {
  const normalizedPath = requestPath.replace(/\/$/, '') || '/'
  if (pattern.endsWith('/*')) {
    const prefix = pattern.slice(0, -2) || '/'
    if (prefix === '/') return true
    return normalizedPath === prefix || normalizedPath.startsWith(prefix + '/')
  }
  return normalizedPath === pattern
}

function routeShouldYieldToStatic(route: InternalRoute) {
  return (
    route.handler === notFoundHandler ||
    route.path === '/*' ||
    route.path === '*'
  )
}

function partition<T>(arr: T[], predicate: (item: T) => boolean): [T[], T[]] {
  return arr.reduce(
    (acc, item) => {
      acc[predicate(item) ? 0 : 1].push(item)
      return acc
    },
    [[], []] as [T[], T[]],
  )
}

// Sort comparator: least specific first, most specific last.
// Uses the same specificity logic as pickBestRoute so merge ordering
// is consistent: Object.assign spreads least-specific first, most-specific wins.
function compareRouteSpecificity(
  a: { route: InternalRoute },
  b: { route: InternalRoute },
): number {
  const sa = getRouteSpecificity(a.route)
  const sb = getRouteSpecificity(b.route)
  // More wildcards = less specific (sort first)
  if (sa.wildcardCount !== sb.wildcardCount)
    return sb.wildcardCount - sa.wildcardCount
  // Fewer static segments = less specific
  if (sa.staticSegmentCount !== sb.staticSegmentCount)
    return sa.staticSegmentCount - sb.staticSegmentCount
  // Fewer regex params = less specific
  if (sa.regexParamCount !== sb.regexParamCount)
    return sa.regexParamCount - sb.regexParamCount
  // More named params = less specific
  if (sa.namedParamCount !== sb.namedParamCount)
    return sb.namedParamCount - sa.namedParamCount
  // Fewer segments = less specific
  return sa.segmentCount - sb.segmentCount
}

export interface ServerPayload {
  root: FlightData
  formState?: ReactFormState
  returnValue?: unknown
  actionError?: Error
  actionErrorDigest?: string
}

// Vitest-only response that carries the route JSX directly instead of a Flight
// stream. Returned by renderReact when the spiceflow-vitest condition is active.
// All JSX getters (page, layouts, element) wrap content in FlightDataContext.Provider
// so client components using useLoaderData/useFlightData work in inline snapshots.
// Call res.text() for the full composed HTML (layouts + page).
export class SpiceflowTestResponse extends globalThis.Response {
  readonly page: React.ReactNode
  readonly layouts: Array<{ id: string; element: React.ReactNode }>
  readonly loaderData: Record<string, unknown>
  readonly head: React.ReactNode
  /** Full composed tree: layouts wrapping the page, with LayoutContent resolved. */
  readonly element: React.ReactNode
  /** @internal */
  private _routerContext: RouterContextData | undefined

  constructor({
    page,
    layouts,
    loaderData,
    head,
    element,
    status,
    headers,
    routerContext,
  }: {
    page: React.ReactNode
    layouts: Array<{ id: string; element: React.ReactNode }>
    loaderData: Record<string, unknown>
    head: React.ReactNode
    element: React.ReactNode
    status: number
    headers: Headers
    routerContext: RouterContextData | undefined
  }) {
    super(null, { status, headers })
    this.page = page
    this.layouts = layouts
    this.loaderData = loaderData
    this.head = head
    this.element = element
    this._routerContext = routerContext
  }

  /**
   * Render to HTML with full context (FlightDataContext + router context).
   * Without arguments, renders the full composed page (layouts + page).
   * With a node argument, renders that specific node (e.g. a single layout).
   *
   * ```ts
   * await res.text()                        // full page with layouts
   * await res.text(res.page)                // page only
   * await res.text(res.layouts[0].element)  // single layout
   * ```
   */
  async text(node?: React.ReactNode): Promise<string> {
    node ??= this.element
    const { renderToStaticMarkup } = await import('react-dom/server')

    // Wrap in FlightDataContext.Provider with a resolved thenable so
    // React.use() reads it synchronously (no suspend in renderToStaticMarkup).
    let wrapped = node
    if (FlightDataContext && this._routerContext) {
      const resolvedPayload = {
        status: 'fulfilled' as const,
        value: {
          root: {
            page: this.page,
            layouts: this.layouts,
            loaderData: this.loaderData,
            head: this.head,
          },
        },
        then() {},
      }
      wrapped = React.createElement(
        FlightDataContext.Provider,
        { value: { payload: resolvedPayload as any, routerData: this._routerContext } },
        node,
      )
    }

    // Restore the router context so useLoaderData/getRouterContext work
    // via the AsyncLocalStorage server path too.
    if (this._routerContext) {
      this._routerContext.loaderData = this.loaderData
      return routerContextStorage.run(this._routerContext, () =>
        renderToStaticMarkup(wrapped),
      )
    }
    return renderToStaticMarkup(wrapped)
  }
}

// Walk a React element tree and replace LayoutContent nodes with the given
// replacement. Used to compose layouts around the page for SpiceflowTestResponse,
// and exported for tests that need to render individual layout elements.
export function replaceLayoutContent(
  node: React.ReactNode,
  replacement: React.ReactNode,
): React.ReactNode {
  if (!React.isValidElement(node)) return node
  if (node.type === LayoutContent) return replacement

  const { children } = node.props as { children?: React.ReactNode }
  if (children == null) return node

  if (Array.isArray(children)) {
    let changed = false
    const mapped = children.map((child: React.ReactNode) => {
      const result = replaceLayoutContent(child, replacement)
      if (result !== child) changed = true
      return result
    })
    return changed ? React.cloneElement(node, {}, ...mapped) : node
  }

  const replaced = replaceLayoutContent(children, replacement)
  if (replaced !== children) {
    return React.cloneElement(node, {}, replaced)
  }
  return node
}
