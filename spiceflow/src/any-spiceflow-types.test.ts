// Regression tests for ergonomic `AnySpiceflow` fallbacks across public typed APIs.
import { rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { expect, test } from 'vitest'
import ts from 'typescript'

import { createSpiceflowFetch } from './client/index.ts'
import { getRouter, Link, redirect, useLoaderData, useRouterState } from './react/index.ts'
import type { LinkProps } from './react/index.ts'
import { AnySpiceflow, Spiceflow } from './spiceflow.tsx'
import type { AllHrefPaths, IsAny } from './types.ts'

function getDiagnosticsForSnippet(source: string) {
  const srcDir = dirname(new URL(import.meta.url).pathname)
  const tsconfigPath = join(srcDir, '..', 'tsconfig.json')
  const snippetPath = join(srcDir, '__tmp-redirect-register-check.ts')

  writeFileSync(snippetPath, source)

  try {
    const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile)
    const parsedConfig = ts.parseJsonConfigFileContent(
      configFile.config,
      ts.sys,
      dirname(tsconfigPath),
      { noEmit: true },
      tsconfigPath,
    )
    const program = ts.createProgram({
      rootNames: [snippetPath],
      options: parsedConfig.options,
    })

    return ts
      .getPreEmitDiagnostics(program)
      .filter((diagnostic) => diagnostic.file?.fileName === snippetPath)
      .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
  } finally {
    rmSync(snippetPath)
  }
}

test('SpiceflowRegister: router import is typed via register pattern', () => {
  // Tests the register mechanism by importing the typed `router` export directly.
  // In real apps, users add `declare module 'spiceflow/react' { ... }` once
  // and then import { router } everywhere without generics.
  // Here we use the explicit generic to prove the overload works without
  // polluting other tests with a module augmentation.
  const app = new Spiceflow()
    .page('/login', async () => 'login')
    .page('/dashboard', async () => 'dashboard')
    .loader('/users/:id', async ({ params }) => ({ user: { id: params.id } }))
    .page('/users/:id', async () => 'user')
    .page('/settings', async () => 'settings')
    .page('/orgs/:orgId/projects/:projectId', async () => 'project')

  const typedRouter = getRouter<typeof app>()

  // Path validation works
  // @ts-expect-error - invalid path rejected
  typedRouter.href('/nonexistent')

  // @ts-expect-error - missing required params rejected
  typedRouter.href('/users/:id')

  // @ts-expect-error - wrong param key rejected
  typedRouter.href('/users/:id', { slug: '1' })

  // Valid paths accepted
  expect(typedRouter.href('/login')).toBe('/login')
  expect(typedRouter.href('/dashboard')).toBe('/dashboard')
  expect(typedRouter.href('/settings')).toBe('/settings')
  expect(typedRouter.href('/users/:id', { id: '42' })).toBe('/users/42')
  expect(
    typedRouter.href('/orgs/:orgId/projects/:projectId', { orgId: 'a', projectId: 'b' }),
  ).toBe('/orgs/a/projects/b')
})

test('AnySpiceflow falls back to ergonomic any types', () => {
  const app = new Spiceflow()
    .get('/api/typed', () => ({ ok: true }))
    .loader('/*', async () => ({ session: { user: { name: 'Tommy' } } }))
    .page('/', async () => 'home')
  const anyApp: AnySpiceflow = app

  // No-generic versions use RegisteredApp which falls back to AnySpiceflow
  const fetchClient = createSpiceflowFetch('http://localhost:3000')
  const fetchFromApp = createSpiceflowFetch(anyApp)
  const routerApi = getRouter()

  function assertFetchFallbackTypes() {
    const result = fetchClient('/runtime-route', {
      method: 'POST',
      body: { arbitrary: true },
      query: { search: 'hello' },
      params: { id: '1' },
    })
    const resultIsAny: IsAny<Awaited<typeof result>> = true
    void resultIsAny

    async function readResult() {
      const value = await result
      value.deep.property
    }

    readResult
  }

  function assertFetchFromAppFallbackTypes() {
    const result = fetchFromApp('/runtime-route', {
      method: 'PATCH',
      body: { nested: { okay: true } },
      query: { page: 1 },
      params: { slug: 'docs' },
    })
    const resultIsAny: IsAny<Awaited<typeof result>> = true
    void resultIsAny

    async function readResult() {
      const value = await result
      value.anything.at.all
    }

    readResult
  }

  function GlobalLoaderDataComponent() {
    const data = useLoaderData()
    const dataIsAny: IsAny<typeof data> = true
    void dataIsAny
    data.session.user.name
    return null
  }

  function PathLoaderDataComponent() {
    const data = useLoaderData('/runtime-route')
    const dataIsAny: IsAny<typeof data> = true
    void dataIsAny
    data.session.user.name
    return null
  }

  function UntypedRouterStateComponent() {
    const state = useRouterState()
    state.pathname.toUpperCase()
    return null
  }

  async function assertGetLoaderDataFallbackTypes() {
    const data = await routerApi.getLoaderData()
    const dataIsAny: IsAny<typeof data> = true
    void dataIsAny
    data.session.user.name
  }

  async function assertGetLoaderDataWithPathFallbackTypes() {
    const data = await routerApi.getLoaderData('/runtime-route')
    const dataIsAny: IsAny<typeof data> = true
    void dataIsAny
    data.session.user.name
  }

  assertFetchFallbackTypes
  assertFetchFromAppFallbackTypes
  GlobalLoaderDataComponent
  PathLoaderDataComponent
  UntypedRouterStateComponent
  assertGetLoaderDataFallbackTypes
  assertGetLoaderDataWithPathFallbackTypes

  expect(routerApi.href('/runtime-route', { slug: 'docs', page: 1 })).toBe(
    '/runtime-route?slug=docs&page=1',
  )
  expect(anyApp.href('/runtime-route', { slug: 'docs', page: 1 })).toBe(
    '/runtime-route?slug=docs&page=1',
  )
})

test('strict app router types stay narrow', () => {
  const app = new Spiceflow()
    .loader('/users/:id', async ({ params }) => ({ user: { id: params.id } }))
    .page({
      path: '/users/:id',
      query: z.object({ tab: z.string().optional() }),
      handler: async () => 'user',
    })

  const noLoaderApp = new Spiceflow().page({
    path: '/plain',
    query: z.object({ mode: z.string().optional() }),
    handler: async () => 'plain',
  })

  const strictRouter = getRouter<typeof app>()
  const noLoaderRouter = getRouter<typeof noLoaderApp>()

  expect(strictRouter.href('/users/:id', { id: '1', tab: 'profile' })).toBe(
    '/users/1?tab=profile',
  )
  expect(noLoaderRouter.href('/plain', { mode: 'preview' })).toBe(
    '/plain?mode=preview',
  )

  // @ts-expect-error - wrong route param key must stay rejected
  strictRouter.href('/users/:id', { slug: '1' })

  // @ts-expect-error - invalid query key must stay rejected for typed routes
  noLoaderRouter.href('/plain', { wrong: 'x' })

  // @ts-expect-error - invalid route literal must stay rejected for typed routes
  noLoaderRouter.href('/missing')

  function StrictLoaderDataComponent() {
    const data = useLoaderData<typeof app>('/users/:id')
    data.user.id
    // @ts-expect-error - typed loader data must not widen to any
    data.user.missing
    return null
  }

  function NoLoaderDataComponent() {
    const data = useLoaderData<typeof noLoaderApp>('/plain')
    // @ts-expect-error - no-loader routes must not widen to any
    data.anything
    return null
  }

  function StrictRouterStateComponent() {
    const state = useRouterState<typeof app>()
    state.searchParams.get('tab')
    // @ts-expect-error - router state searchParams must stay readonly
    state.searchParams.set('tab', 'profile')
    return null
  }

  async function assertStrictGetLoaderData() {
    const data = await strictRouter.getLoaderData('/users/:id')
    data.user.id
    // @ts-expect-error - typed loader data must not widen to any
    data.user.missing

    strictRouter.refresh()
  }

  async function assertNoLoaderGetLoaderData() {
    const data = await noLoaderRouter.getLoaderData('/plain')
    // @ts-expect-error - no-loader routes must not widen to any
    data.anything
  }

  function assertUntypedRouterStillAllowsArbitraryPaths() {
    // Explicit AnySpiceflow to bypass the register and get untyped behavior
    const untypedRouter = getRouter<AnySpiceflow>()
    untypedRouter.href('/anything-at-runtime', { whatever: true })
    void untypedRouter.getLoaderData('/anything-at-runtime')
  }

  StrictLoaderDataComponent
  NoLoaderDataComponent
  StrictRouterStateComponent
  assertStrictGetLoaderData
  assertNoLoaderGetLoaderData
  assertUntypedRouterStillAllowsArbitraryPaths
})

test('getRouter().href() inside handlers for typed redirect', () => {
  // Using getRouter<typeof app> INSIDE handler closures creates a circular
  // type reference: the handler's return type is part of `typeof app`, but
  // the handler also references `typeof app` via getRouter.
  //
  // Result: TypeScript resolves the circularity by widening RoutePaths to
  // `string`, so PATH VALIDATION IS LOST (any string accepted). However,
  // PARAM ENFORCEMENT IS PRESERVED for paths with :param patterns because
  // template literal extraction still works on concrete string literals.
  const app = new Spiceflow()
    .page('/login', async () => 'login')
    .page('/dashboard', async () => {
      // Redirect inside handler to a path defined BEFORE this one
      const router = getRouter<typeof app>()
      const url = router.href('/login')
      return redirect(url)
    })
    .loader('/users/:id', async ({ params }) => {
      // Use getRouter inside a loader to redirect to a path defined AFTER
      const router = getRouter<typeof app>()
      const url = router.href('/settings')
      if (!params.id) throw redirect(url)
      return { user: { id: params.id } }
    })
    .page('/users/:id', async () => 'user')
    .page('/settings', async () => 'settings')
    .page('/orgs/:orgId/projects/:projectId', async () => {
      // Redirect to a parameterized sibling path from inside a handler
      const router = getRouter<typeof app>()
      const url = router.href('/users/:id', { id: '123' })
      return redirect(url)
    })

  const router = getRouter<typeof app>()

  // Runtime assertions still pass
  expect(router.href('/login')).toBe('/login')
  expect(router.href('/settings')).toBe('/settings')
  expect(router.href('/users/:id', { id: '42' })).toBe('/users/42')
  expect(router.href('/orgs/:orgId/projects/:projectId', { orgId: 'a', projectId: 'b' })).toBe(
    '/orgs/a/projects/b',
  )

  // PATH VALIDATION IS LOST due to circular type — these are accepted:
  router.href('/nonexistent') // would be rejected without circularity
  router.href('/totally/bogus/path') // would be rejected without circularity

  // PARAM ENFORCEMENT IS PRESERVED — template literal extraction still works:
  // @ts-expect-error - missing required params is still caught
  router.href('/users/:id')

  // @ts-expect-error - wrong param key is still caught
  router.href('/users/:id', { slug: '1' })
})

test('getRouter() with pre-declared type avoids circular widening', () => {
  // Workaround: define the app without getRouter in handlers, then use the
  // type externally. This avoids circular inference and preserves full path validation.
  const app = new Spiceflow()
    .page('/login', async () => 'login')
    .page('/dashboard', async () => 'dashboard')
    .loader('/users/:id', async ({ params }) => ({ user: { id: params.id } }))
    .page('/users/:id', async () => 'user')
    .page('/settings', async () => 'settings')
    .page('/orgs/:orgId/projects/:projectId', async () => 'project')

  type App = typeof app
  const router = getRouter<App>()

  // PATH VALIDATION IS PRESERVED — no circularity
  // @ts-expect-error - invalid path correctly rejected
  router.href('/nonexistent')

  // @ts-expect-error - missing required params correctly rejected
  router.href('/users/:id')

  // @ts-expect-error - wrong param key correctly rejected
  router.href('/users/:id', { slug: '1' })

  // Valid paths work fine
  expect(router.href('/login')).toBe('/login')
  expect(router.href('/settings')).toBe('/settings')
  expect(router.href('/users/:id', { id: '42' })).toBe('/users/42')
})

test('router.href() type-safe query params', () => {
  const app = new Spiceflow()
    .get('/search', () => 'results', {
      query: z.object({ q: z.string(), page: z.coerce.number() }),
    })
    .get('/users/:id', ({ params }) => params.id, {
      query: z.object({ fields: z.string() }),
    })
    .get('/free', () => 'ok')
    .page('/login', async () => 'login')

  type App = typeof app
  const router = getRouter<App>()

  // Query params on static path — typed
  expect(router.href('/search', { q: 'hello', page: 1 })).toBe('/search?q=hello&page=1')

  // Mixed path + query params
  expect(router.href('/users/:id', { id: '42', fields: 'name' })).toBe('/users/42?fields=name')

  // No query schema — accepts arbitrary query at runtime
  expect(router.href('/free', { anything: 'works' })).toBe('/free?anything=works')

  // Path without query — no params needed
  expect(router.href('/login')).toBe('/login')

  // @ts-expect-error - invalid query key rejected
  router.href('/search', { invalid: 'x' })

  // @ts-expect-error - missing required query param 'page'
  router.href('/search', { q: 'hello' })

  // router.push accepts the ResolvedHref from router.href with query params
  router.push(router.href('/search', { q: 'hello', page: 1 }))
  router.push(router.href('/users/:id', { id: '42', fields: 'name' }))
  router.replace(router.href('/search', { q: 'test', page: 1 }))
})

test('overlapping loaders merge into typed router data', () => {
  const app = new Spiceflow()
    .loader('/*', async () => ({ session: { user: { name: 'Ada' } } }))
    .loader('/users/:id', async ({ params }) => ({ profile: { id: params.id } }))
    .page('/users/:id', async () => 'user')

  const router = getRouter<typeof app>()

  function MergedLoaderDataComponent() {
    const data = useLoaderData<typeof app>('/users/:id')
    data.session.user.name
    data.profile.id
    // @ts-expect-error - merged loader data must stay narrow
    data.profile.slug
    return null
  }

  async function assertMergedGetLoaderData() {
    const data = await router.getLoaderData('/users/:id')
    data.session.user.name
    data.profile.id
    // @ts-expect-error - merged loader data must stay narrow
    data.session.user.email
  }

  MergedLoaderDataComponent
  assertMergedGetLoaderData
})

test('Link: unregistered app accepts any string href', () => {
  // Without SpiceflowRegister, Link falls back to string (any path works)
  const a: LinkProps = { href: '/anything' }
  const b: LinkProps = { href: '/with/params', params: { id: '1' } }
  const c: LinkProps = { href: '/plain' }
  const d: LinkProps = {}
  void [a, b, c, d]
})

test('Link: typed app validates href paths and requires params', () => {
  const app = new Spiceflow()
    .page('/login', async () => 'login')
    .page('/dashboard', async () => 'dashboard')
    .page('/users/:id', async () => 'user')
    .page('/orgs/:orgId/projects/:projectId', async () => 'project')

  type App = typeof app
  type Paths = App['_types']['RoutePaths']

  type QS = App['_types']['RouteQuerySchemas']

  // Helper to check LinkProps assignability via function call (catches missing props)
  function expectLink<P extends AllHrefPaths<Paths>>(_props: LinkProps<App, Paths, QS, P>) {}

  // Valid static paths
  expectLink({ href: '/login' as const })
  expectLink({ href: '/dashboard' as const })

  // Valid parameterized paths with required params
  expectLink({ href: '/users/:id' as const, params: { id: '42' } })
  expectLink({ href: '/orgs/:orgId/projects/:projectId' as const, params: { orgId: 'a', projectId: 'b' } })

  // @ts-expect-error - invalid path rejected
  expectLink({ href: '/nonexistent' as const })

  // @ts-expect-error - missing required params rejected
  expectLink({ href: '/users/:id' as const })

  // @ts-expect-error - wrong param key rejected
  expectLink({ href: '/users/:id' as const, params: { slug: '1' } })
})

test('Link: resolved paths do not require params', () => {
  const app = new Spiceflow()
    .layout('/*', async ({ children }) => children)
    .page('/dash/projects/:projectId', async () => 'project')
    .page('/files/*', async () => 'files')
    .page('/login', async () => 'login')

  type App = typeof app
  type Paths = App['_types']['RoutePaths']
  type QS = App['_types']['RouteQuerySchemas']

  function expectLink<P extends string>(_props: LinkProps<App, Paths, QS, P>) {}

  // Static path — no params needed
  expectLink({ href: '/login' as const })

  // Resolved path — params already baked into the string, should NOT require params
  expectLink({ href: '/dash/projects/abc123' as const })

  // Resolved wildcard path — no params needed
  expectLink({ href: '/files/a/b.txt' as const })

  // Pattern path — params still required
  expectLink({ href: '/dash/projects/:projectId' as const, params: { projectId: 'abc' } })

  // Wildcard pattern — params still required
  expectLink({ href: '/files/*' as const, params: { '*': 'some/path' } })

  // @ts-expect-error - pattern path missing params
  expectLink({ href: '/dash/projects/:projectId' as const })

  // @ts-expect-error - wildcard pattern missing params
  expectLink({ href: '/files/*' as const })
})

test('Link: string variables accepted, invalid literals rejected', () => {
  const app = new Spiceflow()
    .page('/dash/projects/:projectId', async () => 'project')
    .page('/events/:stamp', async () => 'event')
    .page('/login', async () => 'login')

  type App = typeof app
  type Paths = App['_types']['RoutePaths']
  type QS = App['_types']['RouteQuerySchemas']
  const r = getRouter<App>()

  function expectLink<P extends string>(_props: LinkProps<App, Paths, QS, P>) {}

  // String variable — wide `string` type, accepted without params
  const dynamicHref: string = '/dash/projects/abc123'
  expectLink({ href: dynamicHref })

  // Template literal producing string — accepted
  const id = 'abc' as string
  expectLink({ href: `/dash/projects/${id}` })

  // Valid literal — accepted
  expectLink({ href: '/login' as const })

  // ResolvedHref from router.href() — accepted
  expectLink({ href: r.href('/login') })

  // Resolved path with colon in value (ISO timestamp) — no false positive
  expectLink({ href: '/events/2026-05-06T12:00:00Z' as const })

  // @ts-expect-error - invalid literal rejected
  expectLink({ href: '/nonexistent' as const })
})

test('router.push/replace: string variables accepted, invalid literals rejected', () => {
  const app = new Spiceflow()
    .page('/dash/projects/:projectId', async () => 'project')
    .page('/login', async () => 'login')

  type App = typeof app
  const r = getRouter<App>()

  // String variable — wide string, accepted
  const dynamicPath: string = '/dash/projects/abc123'
  r.push(dynamicPath)
  r.replace(dynamicPath)

  // Template literal — accepted (matches resolved pattern)
  const id = 'abc' as string
  r.push(`/dash/projects/${id}`)
  r.replace(`/dash/projects/${id}`)

  // Valid literal — accepted
  r.push('/login')
  r.replace('/login')

  // ResolvedHref from router.href() — accepted
  const href = r.href('/login')
  r.push(href)
  r.replace(href)

  // Object form with valid literal — accepted
  r.push({ pathname: '/login', search: '?foo=1' })

  // Object form with string variable — accepted
  r.push({ pathname: dynamicPath })

  // @ts-expect-error - invalid literal rejected
  r.push('/nonexistent')

  // @ts-expect-error - invalid literal rejected
  r.replace('/nonexistent')

  // @ts-expect-error - invalid literal rejected in object form too
  r.push({ pathname: '/nonexistent' as const })
})

test('required query params enforced on href, Link, router.push, and fetch', () => {
  const app = new Spiceflow()
    .page({
      path: '/search',
      query: z.object({ q: z.string(), page: z.coerce.number() }),
      handler: async ({ query }) => `Results for: ${query.q} page ${query.page}`,
    })
    .page({
      path: '/filter',
      query: z.object({ category: z.string(), limit: z.number().optional() }),
      handler: async ({ query }) => `Filter: ${query.category}`,
    })
    .page('/about', async () => 'About')
    .get('/api/items', () => 'items', {
      query: z.object({ sort: z.string() }),
    })

  type App = typeof app
  type Paths = App['_types']['RoutePaths']
  type QS = App['_types']['RouteQuerySchemas']
  const r = getRouter<App>()
  const f = createSpiceflowFetch(app)

  function expectLink<P extends string>(_props: LinkProps<App, Paths, QS, P>) {}

  // ── href: required query params are required ──

  // @ts-expect-error - /search requires { q, page }, missing both
  r.href('/search')

  // @ts-expect-error - /search requires { q, page }, missing page
  r.href('/search', { q: 'hello' })

  // @ts-expect-error - /api/items requires { sort }, missing
  r.href('/api/items')

  // valid: all required query params provided
  r.href('/search', { q: 'hello', page: 1 })
  r.href('/api/items', { sort: 'date' })

  // /filter has one required (category) and one optional (limit)
  // @ts-expect-error - /filter requires { category }, missing
  r.href('/filter')

  // valid: required provided, optional omitted
  r.href('/filter', { category: 'books' })

  // valid: both provided
  r.href('/filter', { category: 'books', limit: 10 })

  // /about has no query schema — no params needed
  r.href('/about')

  // ── Link: bare string href rejected for paths with required query ──

  // @ts-expect-error - /search has required query, must use router.href()
  expectLink({ href: '/search' as const })

  // @ts-expect-error - /api/items has required query, must use router.href()
  expectLink({ href: '/api/items' as const })

  // valid: using ResolvedHref from router.href()
  expectLink({ href: r.href('/search', { q: 'hello', page: 1 }) })
  expectLink({ href: r.href('/api/items', { sort: 'date' }) })

  // /about has no query — bare string accepted
  expectLink({ href: '/about' as const })

  // /filter has required query — bare string rejected
  // @ts-expect-error - /filter has required query param category
  expectLink({ href: '/filter' as const })

  // valid: resolved href
  expectLink({ href: r.href('/filter', { category: 'books' }) })

  // ── router.push: bare string rejected for paths with required query ──

  // @ts-expect-error - /search has required query, must use router.href()
  r.push('/search')

  // @ts-expect-error - /api/items has required query
  r.push('/api/items')

  // valid: using ResolvedHref
  r.push(r.href('/search', { q: 'hello', page: 1 }))
  r.push(r.href('/api/items', { sort: 'date' }))

  // /about has no query — bare string accepted
  r.push('/about')

  // ── router.replace: same enforcement as push ──

  // @ts-expect-error - /search has required query
  r.replace('/search')

  // valid
  r.replace(r.href('/search', { q: 'hello', page: 1 }))

  // ── fetch: required query enforced in options ──

  // @ts-expect-error - /api/items requires { sort } query
  void f('/api/items')

  // valid: query provided
  void f('/api/items', { query: { sort: 'date' } })

  // /about has no query — no options needed
  void f('/about')
})

test('AnySpiceflow child does not poison parent ClientRoutes via .use()', () => {
  // Parent with a real typed route
  const parent = new Spiceflow().get('/api/projects', () => ({
    projects: [] as { id: string }[],
  }))

  // Child typed as AnySpiceflow (simulates a dynamically-built app like Holocron)
  const child: AnySpiceflow = new Spiceflow().get('/docs', () => 'docs')

  // Mount the AnySpiceflow child — must NOT collapse parent types to any
  const composed = parent.use(child)

  const f = createSpiceflowFetch(composed)

  async function assertTypedResponse() {
    const result = await f('/api/projects')
    // If ClientRoutes was poisoned to any, this would be true (any is assignable to true)
    const resultIsAny: IsAny<typeof result> = false
    void resultIsAny

    // Narrow past the error union to verify the data shape is preserved
    if (result instanceof Error) return
    result.projects[0].id
    // @ts-expect-error - typed response must stay narrow, not any
    result.projects[0].nonexistent
  }

  assertTypedResponse
})

test('root "/" is always valid in href, Link, and push even when home route is ""', () => {
  const app = new Spiceflow()
    .page('', async () => 'home')
    .page('/login', async () => 'login')
    .page('/dash', async () => 'dash')

  type App = typeof app
  type Paths = App['_types']['RoutePaths']
  type QS = App['_types']['RouteQuerySchemas']
  const r = getRouter<App>()

  function expectLink<P extends string>(_props: LinkProps<App, Paths, QS, P>) {}

  // '/' is always valid in href
  expect(r.href('/')).toBe('/')

  // '/' is valid in Link
  expectLink({ href: '/' as const })

  // '/' is valid in push/replace
  r.push('/')
  r.replace('/')

  // named routes still work
  expect(r.href('/login')).toBe('/login')
  expectLink({ href: '/login' as const })
  r.push('/login')

  // @ts-expect-error - invalid path still rejected
  r.href('/nonexistent')

  // @ts-expect-error - invalid literal still rejected in Link
  expectLink({ href: '/nonexistent' as const })

  // @ts-expect-error - invalid literal still rejected in push
  r.push('/nonexistent')
})

test('root "/" is valid even without a "" route', () => {
  const app = new Spiceflow()
    .page('/about', async () => 'about')
    .page('/contact', async () => 'contact')

  type App = typeof app
  const r = getRouter<App>()

  // '/' is always valid regardless of whether a '' route exists
  expect(r.href('/')).toBe('/')
  r.push('/')

  // @ts-expect-error - other invalid paths still rejected
  r.href('/nonexistent')
})

test('exported and context redirect accept plain strings', () => {
  const diagnostics = getDiagnosticsForSnippet(`
import { Spiceflow } from './spiceflow.tsx'
import { redirect } from './react/index.ts'

const app = new Spiceflow()
  .page('/login', async () => 'login')
  .page('/users/:id', async ({ redirect: routeRedirect }) => {
    routeRedirect('/login')
    routeRedirect('/users/:id', { params: { id: '42' } })
    routeRedirect('/users/:id')
    routeRedirect('/users/:id', { params: { slug: '1' } })
    routeRedirect('/missing')

    return 'user'
  })

declare module './react/router.js' {
  interface SpiceflowRegister {
    app: typeof app
  }
}

redirect('/login')
redirect('/users/:id', { params: { id: '42' } })
const id = '42'
redirect(\`/users/\${id}\`)
redirect('https://example.com')
redirect('/users/:id')
redirect('/users/:id', { params: { slug: '1' } })
redirect('/missing')
`)

  expect(diagnostics).toEqual([])
})
