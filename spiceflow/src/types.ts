// https://github.com/remorses/elysia/blob/main/src/types.ts#L6
import { StandardSchemaV1 } from './standard-schema.js'
import z from 'zod'

import type { OpenAPIV3 } from './openapi-types.js'

import { ZodTypeAny } from 'zod'
import type {
  SpiceflowContext,
  ErrorContext,
  MiddlewareContext,
} from './context.js'
import {
  SPICEFLOW_RESPONSE,
  ValidationError,
  RESPONSE_DATA,
  type TypedResponse,
} from './error.js'
import { AnySpiceflow, Spiceflow } from './spiceflow.js'

export type MaybeArray<T> = T | T[]
export type MaybePromise<T> = T | Promise<T>
export type MaybePromiseIterable<T> = T | Promise<T> | AsyncIterable<T>

export type ObjectValues<T extends object> = T[keyof T]

type RequiredPathParameterForSegment<
  Segment extends string,
  IsLast extends boolean,
> = Segment extends `:${infer Parameter}?`
  ? IsLast extends true
    ? never
    : `${Parameter}?`
  : Segment extends `:${infer Parameter}`
    ? Parameter
    : never

type OptionalPathParameterForSegment<
  Segment extends string,
  IsLast extends boolean,
> = Segment extends '*'
  ? '*'
  : Segment extends `:${infer Parameter}?`
    ? IsLast extends true
      ? Parameter
      : never
    : never

type RequiredPathParameter<Path extends string> =
  Path extends `${infer Segment}/${infer Rest}`
    ?
        | RequiredPathParameterForSegment<Segment, false>
        | RequiredPathParameter<Rest>
    : RequiredPathParameterForSegment<Path, true>

type OptionalPathParameter<Path extends string> =
  Path extends `${infer Segment}/${infer Rest}`
    ?
        | OptionalPathParameterForSegment<Segment, false>
        | OptionalPathParameter<Rest>
    : OptionalPathParameterForSegment<Path, true>

export type GetPathParameter<Path extends string> =
  | RequiredPathParameter<Path>
  | OptionalPathParameter<Path>

export type ResolvePath<Path extends string> = Prettify<
  {
    [Param in RequiredPathParameter<Path>]: string
  } & {
    [Param in OptionalPathParameter<Path>]?: string
  }
>

// https://twitter.com/mattpocockuk/status/1622730173446557697?s=20
export type Prettify<T> = {
  [K in keyof T]: T[K]
} & {}

export type Prettify2<T> = {
  [K in keyof T]: Prettify<T[K]>
} & {}

export type Partial2<T> = {
  [K in keyof T]?: Partial<T[K]>
}

export type NeverKey<T> = {
  [K in keyof T]?: T[K]
} & {}

type IsBothObject<A, B> =
  A extends Record<string | number | symbol, unknown>
    ? B extends Record<string | number | symbol, unknown>
      ? IsClass<A> extends false
        ? IsClass<B> extends false
          ? true
          : false
        : false
      : false
    : false

type IsClass<V> = V extends abstract new (...args: any) => any ? true : false

export type Reconcile<
  A extends Object,
  B extends Object,
  Override extends boolean = false,
  // Detect Stack limit, eg. circular dependency
  Stack extends number[] = [],
> = Stack['length'] extends 16
  ? A
  : Override extends true
    ? {
        [key in keyof A as key extends keyof B ? never : key]: A[key]
      } extends infer Collision
      ? {} extends Collision
        ? {
            [key in keyof B]: IsBothObject<
              // @ts-ignore trust me bro
              A[key],
              B[key]
            > extends true
              ? Reconcile<
                  // @ts-ignore trust me bro
                  A[key],
                  B[key],
                  Override,
                  [0, ...Stack]
                >
              : B[key]
          }
        : Prettify<
            Collision & {
              [key in keyof B]: B[key]
            }
          >
      : never
    : {
          [key in keyof B as key extends keyof A ? never : key]: B[key]
        } extends infer Collision
      ? {} extends Collision
        ? {
            [key in keyof A]: IsBothObject<
              A[key],
              // @ts-ignore trust me bro
              B[key]
            > extends true
              ? Reconcile<
                  // @ts-ignore trust me bro
                  A[key],
                  // @ts-ignore trust me bro
                  B[key],
                  Override,
                  [0, ...Stack]
                >
              : A[key]
          }
        : Prettify<
            {
              [key in keyof A]: A[key]
            } & Collision
          >
      : never

export interface SingletonBase {
  state: Record<string, unknown>
}

export interface DefinitionBase {
  type: Record<string, unknown>
  error: Record<string, Error>
}

export type RouteBase = Record<string, unknown>

export interface MetadataBase {
  schema: RouteSchema
  macro: BaseMacro
  macroFn: BaseMacroFn
  loaderData: object
}

export type RouteSchema = {
  request?: unknown
  query?: unknown
  params?: unknown
  response?: unknown
}

export type TypeSchema = StandardSchemaV1

export type TypeObject = StandardSchemaV1

export type UnwrapSchema<
  Schema extends TypeSchema | string | undefined,
  Definitions extends Record<string, unknown> = {},
> = Schema extends undefined
  ? unknown
  : Schema extends StandardSchemaV1
    ? StandardSchemaV1.InferOutput<Schema>
    : Schema extends ZodTypeAny
      ? z.infer<Schema>
      : Schema extends string
        ? Definitions extends Record<Schema, infer NamedSchema>
          ? NamedSchema
          : Definitions
        : unknown

export type GetRequestSchema<Schema extends InputSchema<any>> =
  'request' extends keyof Schema
    ? Schema['request']
    : undefined

export interface UnwrapRoute<
  in out Schema extends InputSchema<any>,
  in out Definitions extends DefinitionBase['type'] = {},
> {
  request: UnwrapSchema<GetRequestSchema<Schema>, Definitions>
  query: UnwrapSchema<Schema['query'], Definitions>
  params: UnwrapSchema<Schema['params'], Definitions>
  response: Schema['response'] extends TypeSchema | string
    ? {
        200: UnwrapSchema<Schema['response'], Definitions>
      }
    : Schema['response'] extends Record<number, TypeSchema | string>
      ? {
          [k in keyof Schema['response']]: UnwrapSchema<
            Schema['response'][k],
            Definitions
          >
        }
      : unknown | void
}

export type LifeCycleEvent =
  | 'start'
  | 'request'
  | 'parse'
  | 'transform'
  | 'beforeHandle'
  | 'afterHandle'
  | 'response'
  | 'error'
  | 'stop'

export type ContentType = MaybeArray<
  | (string & {})
  // | 'none'
  // | 'text'
  // | 'json'
  // | 'formdata'
  // | 'urlencoded'
  // | 'arrayBuffer'
  | 'text/plain'
  | 'application/json'
  | 'multipart/form-data'
  | 'application/x-www-form-urlencoded'
>

export type HTTPMethod =
  | (string & {})
  | 'ACL'
  | 'BIND'
  | 'CHECKOUT'
  | 'CONNECT'
  | 'COPY'
  | 'DELETE'
  | 'GET'
  | 'HEAD'
  | 'LINK'
  | 'LOCK'
  | 'M-SEARCH'
  | 'MERGE'
  | 'MKACTIVITY'
  | 'MKCALENDAR'
  | 'MKCOL'
  | 'MOVE'
  | 'NOTIFY'
  | 'OPTIONS'
  | 'PATCH'
  | 'POST'
  | 'PROPFIND'
  | 'PROPPATCH'
  | 'PURGE'
  | 'PUT'
  | 'REBIND'
  | 'REPORT'
  | 'SEARCH'
  | 'SOURCE'
  | 'SUBSCRIBE'
  | 'TRACE'
  | 'UNBIND'
  | 'UNLINK'
  | 'UNLOCK'
  | 'UNSUBSCRIBE'
  | 'ALL'
  | '*'

export interface InputSchema<Name extends string = string> {
  request?: TypeSchema | Name
  query?: TypeObject | Name
  params?: TypeObject | Name
  response?:
    | TypeSchema
    | Record<number, TypeSchema>
    | Name
    | Record<number, Name | TypeSchema>
}

export interface MergeSchema<
  in out A extends RouteSchema,
  in out B extends RouteSchema,
> {
  request: undefined extends GetRequestSchema<A>
    ? GetRequestSchema<B>
    : GetRequestSchema<A>
  query: undefined extends A['query'] ? B['query'] : A['query']
  params: undefined extends A['params'] ? B['params'] : A['params']
  response: {} extends A['response']
    ? {} extends B['response']
      ? {}
      : B['response']
    : {} extends B['response']
      ? A['response']
      : A['response'] & Omit<B['response'], keyof A['response']>
}

export type Handler<
  in out Route extends RouteSchema = {},
  in out Singleton extends SingletonBase = {
    state: {}
  },
  Path extends string = '',
> = (
  context: SpiceflowContext<Path, Route, Singleton>,
) => MaybePromise<
  {} extends Route['response']
    ? unknown
    : Route['response'][keyof Route['response']]
>

export type Replace<Original, Target, With> =
  IsAny<Target> extends true
    ? Original
    : Original extends Record<string, unknown>
      ? {
          [K in keyof Original]: Original[K] extends Target ? With : Original[K]
        }
      : Original extends Target
        ? With
        : Original

export type IsAny<T> = 0 extends 1 & T ? true : false

export type CoExist<Original, Target, With> =
  IsAny<Target> extends true
    ? Original
    : Original extends Record<string, unknown>
      ? {
          [K in keyof Original]: Original[K] extends Target
            ? Original[K] | With
            : Original[K]
        }
      : Original extends Target
        ? Original | With
        : Original

// Accepts plain {status, headers, body} objects and raw Response,
// but NOT TypedResponse (which carries phantom brands and must go
// through the typed union branch so tsc can validate status/data).
type ResponseLike = {
  status: number
  headers?: any
  body?: any
  readonly [RESPONSE_DATA]?: never
}

export type InlineHandler<
  This,
  Route extends RouteSchema = {},
  Singleton extends SingletonBase = {
    state: {}
  },
  Path extends string = '',
  MacroContext = {},
  LoaderData = {},
  RedirectPaths extends string = string,
> = (
  this: This,
  context: MacroContext extends Record<string | number | symbol, unknown>
    ? Prettify<MacroContext & SpiceflowContext<Path, Route, Singleton, LoaderData>>
    : SpiceflowContext<Path, Route, Singleton, LoaderData>,
) =>
  | ResponseLike
  | MaybePromiseIterable<
      {} extends Route['response']
        ? unknown
        :
            | (Route['response'] extends { 200: any }
                ? Route['response']
                : string | number | boolean | Object)
            | Route['response'][keyof Route['response']]
            | {
                [Status in keyof Route['response']]: {
                  _type: Record<Status, Route['response'][Status]>
                  [SPICEFLOW_RESPONSE]: Status
                }
              }[keyof Route['response']]
            | {
                [Status in keyof Route['response'] &
                  number]: TypedResponse<
                  Route['response'][Status],
                  Status
                >
              }[keyof Route['response'] & number]
    >

export type OptionalHandler<
  in out Route extends RouteSchema = {},
  in out Singleton extends SingletonBase = {
    state: {}
  },
  Path extends string = '',
> =
  Handler<Route, Singleton, Path> extends (
    context: infer Context,
  ) => infer Returned
    ? (context: Context) => Returned | MaybePromise<void>
    : never

export type AfterHandler<
  in out Route extends RouteSchema = {},
  in out Singleton extends SingletonBase = {
    state: {}
  },
  Path extends string = '',
> =
  Handler<Route, Singleton, Path> extends (
    context: infer Context,
  ) => infer Returned
    ? (
        context: Prettify<
          {
            response: Route['response']
          } & Context
        >,
      ) => Returned | MaybePromise<void>
    : never

export type MapResponse<
  in out Route extends RouteSchema = {},
  in out Singleton extends SingletonBase = {
    state: {}
  },
  Path extends string = '',
> = Handler<
  Omit<Route, 'response'> & {
    response: MaybePromise<Response | undefined | unknown>
  },
  Singleton & {
    derive: {
      response: Route['response']
    }
  },
  Path
>

export type VoidHandler<
  in out Route extends RouteSchema = {},
  in out Singleton extends SingletonBase = {
    state: {}
  },
> = (context: SpiceflowContext<'', Route, Singleton>) => MaybePromise<void>

export type TransformHandler<
  in out Route extends RouteSchema = {},
  in out Singleton extends SingletonBase = {
    state: {}
  },
  BasePath extends string = '',
> = {
  (
    context: Prettify<
      SpiceflowContext<
        BasePath,
        Route,
        Omit<Singleton, 'resolve'> & {
          resolve: {}
        }
      >
    >,
  ): MaybePromise<void>
}

export type BodyHandler<
  in out Route extends RouteSchema = {},
  in out Singleton extends SingletonBase = {
    state: {}
  },
  Path extends string = '',
> = (
  context: Prettify<
    {
      contentType: string
    } & SpiceflowContext<Path, Route, Singleton>
  >,

  contentType: string,
) => MaybePromise<any>

export type MiddlewareHandler<
  in out Route extends RouteSchema = {},
  in out Singleton extends SingletonBase = any,
> = (
  context: MiddlewareContext<Singleton>,
  next: () => Promise<Response>,
) => MaybePromise<Route['response'] | void>

export type AfterResponseHandler<
  in out Route extends RouteSchema = {},
  in out Singleton extends SingletonBase = {
    state: {}
  },
> = (
  context: Prettify<
    SpiceflowContext<'', Route, Singleton> & {
      response: Route['response']
    }
  >,
) => MaybePromise<void>

// export type GracefulHandler<
// 	in Instance extends AnySpiceflow,
// > = (data: Instance) => any

export type ErrorHandler<
  in out T extends Record<string, Error> = {},
  in out Route extends RouteSchema = {},
  in out Singleton extends SingletonBase = {
    state: {}
  },
> = (
  context: ErrorContext<
    '',
    Route,
    {
      state: Singleton['state']
    }
  > &
    (
      | Prettify<
          {
            request: Request
            code: 'UNKNOWN'
            error: Readonly<Error>
          } & Partial<Singleton['state']>
        >
      | Prettify<
          {
            request: Request
            code: 'VALIDATION'
            error: Readonly<ValidationError>
          } & Singleton['state']
        >
      // | Prettify<
      // 		{
      // 			request: Request
      // 			code: 'NOT_FOUND'
      // 			error: Readonly<NotFoundError>
      // 		} & NeverKey<Singleton['state']>
      //   >
      // Removed ParseError and InternalServerError from here
      | Prettify<
          {
            [K in keyof T]: {
              request: Request
              code: K
              error: Readonly<T[K]>
            }
          }[keyof T] &
            Partial<Singleton['state']>
        >
    ),
) => any | Promise<any>

export type Isolate<T> = {
  [P in keyof T]: T[P]
}

export type DocumentDecoration = Partial<OpenAPIV3.OperationObject> & {
  /**
   * Pass `true` to hide route from OpenAPI/swagger document
   * */
  hide?: boolean
  // 'x-fern-type-name'?: string
  'x-fern-sdk-group-name'?: string | string[]
  'x-fern-sdk-method-name'?: string
  'x-fern-webhook'?: boolean
}

export type LocalHook<
  LocalSchema extends InputSchema,
  Schema extends RouteSchema,
  Singleton extends SingletonBase,
  Errors extends Record<string, Error>,
  Extension extends BaseMacro,
  Path extends string = '',
  TypedRoute extends RouteSchema = Schema extends {
    params: Record<string, unknown>
  }
    ? Schema
    : Schema & {
        params: undefined extends Schema['params']
          ? ResolvePath<Path>
          : Schema['params']
      },
> = (LocalSchema extends {} ? LocalSchema : Isolate<LocalSchema>) &
  Extension & {
    detail?: DocumentDecoration
    bodyType?: ContentType
    type?: ContentType
  }

export type ComposedHandler = (
  context: SpiceflowContext,
) => MaybePromise<Response>

export type ValidationFunction = (
  value: unknown,
) => StandardSchemaV1.Result<any> | Promise<StandardSchemaV1.Result<any>>

export type InternalRoute = {
  method: HTTPMethod
  path: string
  type: ContentType
  handler: InlineHandler<any, any, any, any, any, any, any>
  hooks: LocalHook<any, any, any, any, any, any, any>
  validateBody?: ValidationFunction
  validateQuery?: ValidationFunction
  validateParams?: ValidationFunction
  kind?: NodeKind
  id: string
  // prefix: string
}

export type NodeKind =
  | 'page'
  | 'layout'
  | 'loader'
  | 'staticPage'
  | 'staticPageWithoutHandler'
  | 'staticGet'

export type AddPrefix<Prefix extends string, T> = {
  [K in keyof T as Prefix extends string ? `${Prefix}${K & string}` : K]: T[K]
}

export type AddPrefixCapitalize<Prefix extends string, T> = {
  [K in keyof T as `${Prefix}${Capitalize<K & string>}`]: T[K]
}

export type AddSuffix<Suffix extends string, T> = {
  [K in keyof T as `${K & string}${Suffix}`]: T[K]
}

export type AddSuffixCapitalize<Suffix extends string, T> = {
  [K in keyof T as `${K & string}${Capitalize<Suffix>}`]: T[K]
}

export type BaseMacro = Record<
  string,
  string | number | boolean | Object | undefined | null
>
export type BaseMacroFn = Record<string, (...a: any) => unknown>

type _CreateClient<
  Path extends string,
  Property extends Record<string, unknown> = {},
> = Path extends `${infer Start}/${infer Rest}`
  ? {
      [x in Start extends '' ? 'index' : Start]: _CreateClient<Rest, Property>
    }
  : {
      [x in Path extends '' ? 'index' : Path]: Property
    }

export type CreateClient<
  Path extends string,
  Property extends Record<string, unknown> = {},
> = Path extends `/${infer Rest}`
  ? _CreateClient<Rest, Property>
  : _CreateClient<Path, Property>

export type ComposeSpiceflowResponse<Response, Handle> = Handle extends (
  ...a: any[]
) => infer A
  ? _ComposeSpiceflowResponse<Response, Awaited<A>>
  : _ComposeSpiceflowResponse<Response, Awaited<Handle>>

type _ComposeSpiceflowResponse<Response, Handle> = Prettify<
  {} extends Response
    ? {
        200: Exclude<
          Handle,
          { [SPICEFLOW_RESPONSE]: any } | TypedResponse<any, any>
        >
      } & {
        [ErrorResponse in Extract<
          Handle,
          { response: any }
        > as ErrorResponse extends {
          [SPICEFLOW_RESPONSE]: infer Status extends number
        }
          ? Status
          : never]: ErrorResponse['response']
      } & {
        [TR in Extract<
          Handle,
          TypedResponse<any, any>
        > as TR extends TypedResponse<any, infer S> ? S : never]: TR extends TypedResponse<infer D, any> ? D : never
      }
    : Response
>

export type MergeSpiceflowInstances<
  Instances extends AnySpiceflow[] = [],
  Prefix extends string = '',
  Scoped extends boolean = false,
  Singleton extends SingletonBase = {
    state: {}
  },
  Definitions extends DefinitionBase = {
    type: {}
    error: {}
  },
  Metadata extends MetadataBase = {
    schema: {}
    macro: {}
    macroFn: {}
    loaderData: {}
  },
  Routes extends RouteBase = {},
> = Instances extends [
  infer Current extends AnySpiceflow,
  ...infer Rest extends AnySpiceflow[],
]
  ? Current['_types']['Scoped'] extends true
    ? MergeSpiceflowInstances<
        Rest,
        Prefix,
        Scoped,
        Singleton,
        Definitions,
        Metadata,
        Routes
      >
    : MergeSpiceflowInstances<
        Rest,
        Prefix,
        Scoped,
        Singleton & Current['_types']['Singleton'],
        Definitions & Current['_types']['Definitions'],
        Metadata & Current['_types']['Metadata'],
        Routes &
          (Prefix extends ``
            ? Current['_types']['ClientRoutes']
            : AddPrefix<Prefix, Current['_types']['ClientRoutes']>)
      >
  : Spiceflow<
      Prefix,
      Scoped,
      {
        state: Prettify<Singleton['state']>
      },
      {
        type: Prettify<Definitions['type']>
        error: Prettify<Definitions['error']>
      },
      {
        schema: Prettify<Metadata['schema']>
        macro: Prettify<Metadata['macro']>
        macroFn: Prettify<Metadata['macroFn']>
        loaderData: Metadata['loaderData']
      },
      Routes
    >

export type LifeCycleType = 'global' | 'local' | 'scoped'

export type UnionToIntersect<U> = (
  U extends unknown ? (arg: U) => 0 : never
) extends (arg: infer I) => 0
  ? I
  : never

export type ContextAppendType = 'append' | 'override'

export type HTTPHeaders = Record<string, string> & {
  // Authentication
  'www-authenticate'?: string
  authorization?: string
  'proxy-authenticate'?: string
  'proxy-authorization'?: string

  // Caching
  age?: string
  'cache-control'?: string
  'clear-site-data'?: string
  expires?: string
  'no-vary-search'?: string
  pragma?: string

  // Conditionals
  'last-modified'?: string
  etag?: string
  'if-match'?: string
  'if-none-match'?: string
  'if-modified-since'?: string
  'if-unmodified-since'?: string
  vary?: string

  // Connection management
  connection?: string
  'keep-alive'?: string

  // Content negotiation
  accept?: string
  'accept-encoding'?: string
  'accept-language'?: string

  // Controls
  expect?: string
  'max-forwards'?: string

  // Cokies
  cookie?: string
  'set-cookie'?: string | string[]

  // CORS
  'access-control-allow-origin'?: string
  'access-control-allow-credentials'?: string
  'access-control-allow-headers'?: string
  'access-control-allow-methods'?: string
  'access-control-expose-headers'?: string
  'access-control-max-age'?: string
  'access-control-request-headers'?: string
  'access-control-request-method'?: string
  origin?: string
  'timing-allow-origin'?: string

  // Downloads
  'content-disposition'?: string

  // Message body information
  'content-length'?: string
  'content-type'?: string
  'content-encoding'?: string
  'content-language'?: string
  'content-location'?: string

  // Proxies
  forwarded?: string
  via?: string

  // Redirects
  location?: string
  refresh?: string

  // Request context
  // from?: string
  // host?: string
  // referer?: string
  // 'user-agent'?: string

  // Response context
  allow?: string
  server?: 'spiceflow' | (string & {})

  // Range requests
  'accept-ranges'?: string
  range?: string
  'if-range'?: string
  'content-range'?: string

  // Security
  'content-security-policy'?: string
  'content-security-policy-report-only'?: string
  'cross-origin-embedder-policy'?: string
  'cross-origin-opener-policy'?: string
  'cross-origin-resource-policy'?: string
  'expect-ct'?: string
  'permission-policy'?: string
  'strict-transport-security'?: string
  'upgrade-insecure-requests'?: string
  'x-content-type-options'?: string
  'x-frame-options'?: string
  'x-xss-protection'?: string

  // Server-sent events
  'last-event-id'?: string
  'ping-from'?: string
  'ping-to'?: string
  'report-to'?: string

  // Transfer coding
  te?: string
  trailer?: string
  'transfer-encoding'?: string

  // Other
  'alt-svg'?: string
  'alt-used'?: string
  date?: string
  dnt?: string
  'early-data'?: string
  'large-allocation'?: string
  link?: string
  'retry-after'?: string
  'service-worker-allowed'?: string
  'source-map'?: string
  upgrade?: string

  // Non-standard
  'x-dns-prefetch-control'?: string
  'x-forwarded-for'?: string
  'x-forwarded-host'?: string
  'x-forwarded-proto'?: string
  'x-powered-by'?: 'spiceflow' | (string & {})
  'x-request-id'?: string
  'x-requested-with'?: string
  'x-robots-tag'?: string
  'x-ua-compatible'?: string
}

export type JoinPath<A extends string, B extends string> = `${A}${B extends ''
  ? B
  : B extends `/${string}`
    ? B
    : B}`

export type PartialWithRequired<T, K extends keyof T> = Partial<Omit<T, K>> &
  Pick<T, K>

export type GetPathsFromRoutes<Routes extends Record<string, unknown>> =
  Routes extends Record<infer K, any> ? (K extends string ? K : never) : never

// Prefix each path in a union with a base path.
// Excludes empty strings so '' doesn't create phantom base-path-only routes.
export type PrefixPaths<
  Base extends string,
  Paths extends string,
> = Base extends '' ? Paths : Paths extends '' ? never : `${Base}${Paths}`

// Re-key a query schemas record with prefixed paths
export type PrefixQuerySchemas<
  Base extends string,
  QS extends Record<string, unknown>,
> = Base extends '' ? QS : { [K in keyof QS & string as `${Base}${K}`]: QS[K] }

// Re-key a loader data record with prefixed paths
export type PrefixLoaderData<
  Base extends string,
  LD extends object,
> = Base extends '' ? LD : { [K in keyof LD & string as `${Base}${K}`]: LD[K] }

// True if a loader pattern matches a given path at the type level.
// Supports exact match, trailing /* wildcard, and :param segments.
// Recurses segment-by-segment for patterns with :param.
export type LoaderMatchesPath<
  Pattern extends string,
  Path extends string,
> = Pattern extends `${infer Prefix}/*`
  ? Prefix extends ''
    ? true
    : SegmentsMatch<Split<Prefix, '/'>, Split<Path, '/'>> extends true
      ? true
      : Path extends Prefix | `${Prefix}/${string}`
        ? true
        : false
  : SegmentsMatch<Split<Pattern, '/'>, Split<Path, '/'>>

// Split a string by delimiter
type Split<
  S extends string,
  D extends string,
> = S extends `${infer Head}${D}${infer Tail}` ? [Head, ...Split<Tail, D>] : [S]

// Match pattern segments against path segments one-by-one.
// :param matches any single non-empty segment, * matches any remaining segments.
// Used by both loader matching and route path matching in createSpiceflowFetch.
type SegmentsMatch<P extends string[], T extends string[]> = P extends [
  infer PH extends string,
  ...infer PR extends string[],
]
  ? PH extends '*'
    ? true
    : T extends [infer TH extends string, ...infer TR extends string[]]
      ? PH extends `:${string}`
        ? TH extends ''
          ? false
          : SegmentsMatch<PR, TR>
        : PH extends TH
          ? SegmentsMatch<PR, TR>
          : false
      : false
  : T extends []
    ? true
    : false

// Distribute U into contra-variant positions then infer the intersection.
// Standard distributive conditional type trick: U extends any triggers
// distribution over each union member.
type UnionToIntersection<U> = (U extends any ? (x: U) => void : never) extends (
  x: infer I,
) => void
  ? I
  : never

// Merge all matching loader return types for a given path (least → most specific)
export type MergedLoaderData<
  LoaderMap extends object,
  Path extends string,
> = IsAny<LoaderMap> extends true
  ? any
  : UnionToIntersection<
      {
        [K in keyof LoaderMap & string]: LoaderMatchesPath<K, Path> extends true
          ? LoaderMap[K]
          : never
      }[keyof LoaderMap & string]
    >

// Intersection of ALL loader return types (used when path is not a literal)
export type AllLoaderData<LoaderMap extends object> = IsAny<LoaderMap> extends true
  ? any
  : UnionToIntersection<LoaderMap[keyof LoaderMap]>

export type ExtractParamsFromPath<Path extends string> =
  Path extends `${string}:${infer Param}/${infer Rest}`
    ? { [K in Param]: string } & ExtractParamsFromPath<`/${Rest}`>
    : Path extends `${string}:${infer Param}`
      ? { [K in Param]: string }
      : Path extends `${string}*${infer StarRest}`
        ? { ['*']: string }
        : undefined

// Convert route patterns to template literal types that accept resolved paths.
// e.g. "/orgs/:orgId/*" → `/orgs/${string}/${string}`
//      "/users/:id"     → `/users/${string}`
type PatternToResolved<Path extends string> =
  Path extends `${infer Before}:${infer _Param}/${infer Rest}`
    ? `${Before}${string}/${PatternToResolved<Rest>}`
    : Path extends `${infer Before}:${infer _Param}`
      ? `${Before}${string}`
      : Path extends `${infer Before}*`
        ? `${Before}${string}`
        : Path

// Accepts both pattern paths ("/orgs/:orgId/*") and resolved paths ("/orgs/abc/projects").
// Always includes '/' so root links are valid even when the home route registers as ''.
export type AllHrefPaths<Paths extends string> = '/' | Paths | PatternToResolved<Paths>

declare const resolvedHrefSymbol: unique symbol
export type ResolvedHref = string & { readonly [resolvedHrefSymbol]: true }

export type MatchingPathPattern<
  Paths extends string,
  Path extends AllHrefPaths<Paths>,
> = Path extends Paths
  ? Extract<Paths, Path>
  : Paths extends any
    ? SegmentsMatch<Split<Paths, '/'>, Split<Path, '/'>> extends true
      ? Paths
      : never
    : never

type MergeParamsAndQuery<P, Q> = [P] extends [undefined]
  ? Q
  : P & Omit<Q, keyof P>

type PrimitivePathParam = string | number | boolean

// Segment-aware check for unresolved route params. Uses `/:` (segment boundary)
// instead of bare `:` to avoid false positives from colons in resolved values
// like ISO timestamps (/events/2026-05-06T12:00:00Z).
type HasUnresolvedParams<Path extends string> =
  string extends Path
    ? false
    : Path extends `${string}/:${string}` | `${string}/*${string}` | '*'
      ? true
      : false

// When Path is the wide `string` type (from a variable) or has no unresolved
// route segments (/:param or /*), params are optional.
export type PathParamsProp<Path extends string> =
  HasUnresolvedParams<Path> extends true
    ? [ExtractParamsFromPath<Path>] extends [undefined]
      ? { params?: Record<string, PrimitivePathParam> }
      : { params: ExtractParamsFromPath<Path> }
    : { params?: Record<string, PrimitivePathParam> }

// True when a path's query schema has at least one required key.
// {} extends T is true only when all keys are optional.
// Wrapped in [] to prevent never-distribution when Path is never.
export type PathHasRequiredQuery<QS extends object, Path> =
  [Path] extends [never]
    ? false
    : Path extends keyof QS
      ? unknown extends QS[Path]
        ? false
        : {} extends QS[Path]
          ? false
          : true
      : false

// Smart href validation: accept wide `string` (from variables), accept valid
// route literals, reject invalid string literals at compile time.
// ResolvedHref (from router.href()) is always accepted.
// Paths with required query params reject bare string literals so callers
// must use router.href() which enforces the query args.
export type ValidatedHref<Paths extends string, Path extends string, QS extends object = {}> =
  | ResolvedHref
  | (string extends Path
      ? string
      : Path extends AllHrefPaths<Paths>
        ? [PathHasRequiredQuery<QS, MatchingPathPattern<Paths, Path>>] extends [true]
          ? never
          : Path
        : never)

type HrefArgsInner<
  QS extends object,
  Path extends string,
  Params,
> = [Params] extends [undefined]
  ? Path extends keyof QS
    ? unknown extends QS[Path]
      ? [] | [allParams?: Record<string, PrimitivePathParam>]
      : {} extends QS[Path]
        ? [] | [allParams?: QS[Path]]
        : [allParams: QS[Path]]
    : [] | [allParams?: Record<string, PrimitivePathParam>]
  : Path extends keyof QS
    ? unknown extends QS[Path]
      ? [allParams: Params & Record<string, PrimitivePathParam>]
      : [allParams: MergeParamsAndQuery<Params, QS[Path]>]
    :
        | [allParams: Params]
        | [allParams: Params & Record<string, PrimitivePathParam>]

// Resolve a query schema for a path, looking up via MatchingPathPattern
// so resolved paths like `/users/123` find the schema from `/users/:id`.
type QueryForPath<
  Paths extends string,
  QS extends object,
  Path extends AllHrefPaths<Paths>,
> = MatchingPathPattern<Paths, Path> extends infer Pattern
  ? [Pattern] extends [never]
    ? unknown
    : Pattern extends keyof QS
      ? QS[Pattern]
      : unknown
  : unknown

export type HrefArgs<
  Paths extends string,
  QS extends object,
  Path extends AllHrefPaths<Paths>,
  Params extends ExtractParamsFromPath<Path>,
> = HasUnresolvedParams<Path> extends true
  ? HrefArgsInner<QS, Path, Params>
  : QueryForPath<Paths, QS, Path> extends infer Q
    ? unknown extends Q
      ? [] | [allParams?: Record<string, PrimitivePathParam>]
      : [Q] extends [never]
        ? [] | [allParams?: Record<string, PrimitivePathParam>]
        : {} extends Q
          ? [] | [allParams?: Q]
          : [allParams: Q]
    : [] | [allParams?: Record<string, PrimitivePathParam>]

export type HrefBuilder<
  Paths extends string,
  QS extends object,
> = <
  const Path extends AllHrefPaths<Paths>,
  const Params extends ExtractParamsFromPath<Path> = ExtractParamsFromPath<Path>,
>(
  path: Path,
  ...rest: HrefArgs<Paths, QS, Path, Params>
) => ResolvedHref
