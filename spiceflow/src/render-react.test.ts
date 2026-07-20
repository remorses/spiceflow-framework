// Tests for renderReact internals (headers, status, concurrency).
// Isolated in its own file with a hoisted vi.mock for #rsc-runtime so
// the runtime shim is mocked before Spiceflow imports it at module scope.
import { test, expect, vi } from 'vitest'

let lastPayload: any

vi.mock('#rsc-runtime', () => ({
  __spiceflowVitestMode: false,
  renderToReadableStream(value: any) {
    lastPayload = value
    return new ReadableStream({
      start(controller) {
        controller.close()
      },
    })
  },
  createTemporaryReferenceSet: () => ({}),
  decodeReply: async () => null,
  decodeAction: async () => () => null,
  decodeFormState: async () => undefined,
  loadServerAction: async () => undefined,
}))

import { Spiceflow } from './spiceflow.tsx'

function makeContext() {
  return {
    request: undefined,
    state: {},
    query: {},
    params: {},
    path: '/',
    response: new Response(null),
  }
}

test('renderReact passes layout params to layouts instead of page params', async () => {
  let pageProps: any
  let layoutProps: any

  const app = new Spiceflow()
  const Page = (props: any) => {
    pageProps = props
    return null
  }
  const Layout = (props: any) => {
    layoutProps = props
    return null
  }

  await (app as any).renderReact({
    request: new Request('http://localhost/layouts/parent/pages/child', {
      method: 'GET',
    }),
    context: makeContext(),
    reactRoutes: [
      {
        app,
        params: { pageId: 'child' },
        route: {
          id: 'page',
          kind: 'page',
          handler: Page,
        },
      },
      {
        app,
        params: { layoutId: 'parent' },
        route: {
          id: 'layout',
          kind: 'layout',
          handler: Layout,
        },
      },
    ],
  })

  expect(lastPayload.root.page).toBeNull()
  expect(lastPayload.root.layouts[0]?.element).toBeNull()
  expect(pageProps.params).toEqual({ pageId: 'child' })
  expect(layoutProps.params).toEqual({
    layoutId: 'parent',
  })
  expect(pageProps.response).toHaveProperty('headers')
  expect(pageProps.response).toHaveProperty('status', 200)
  expect(layoutProps.response).toHaveProperty('headers')
  expect(layoutProps.response).toHaveProperty('status', 200)
  expect(layoutProps.response).not.toBe(pageProps.response)
})

test('renderReact merges page response headers into the flight response', async () => {
  const app = new Spiceflow()
  const response = await (app as any).renderReact({
    request: new Request('http://localhost/headers', { method: 'GET' }),
    context: makeContext(),
    reactRoutes: [
      {
        app,
        params: {},
        route: {
          id: 'page',
          kind: 'page',
          handler: ({ response }: any) => {
            response.headers.set('cache-control', 'private, max-age=60')
            response.headers.append('set-cookie', 'a=1; Path=/')
            response.headers.append('set-cookie', 'b=2; Path=/')
            return null
          },
        },
      },
    ],
  })

  expect(response.headers.get('cache-control')).toBe('private, max-age=60')
  const getSetCookie = (
    response.headers as Headers & { getSetCookie?: () => string[] }
  ).getSetCookie
  expect(getSetCookie?.call(response.headers)).toEqual([
    'a=1; Path=/',
    'b=2; Path=/',
  ])
})

test('renderReact merges layout and page headers in route order', async () => {
  const app = new Spiceflow()
  const response = await (app as any).renderReact({
    request: new Request('http://localhost/headers', { method: 'GET' }),
    context: makeContext(),
    reactRoutes: [
      {
        app,
        params: { layoutId: 'outer' },
        route: {
          id: 'layout',
          kind: 'layout',
          handler: ({ children, response }: any) => {
            response.headers.set('cache-control', 'layout')
            response.headers.append('set-cookie', 'layout=1; Path=/')
            return children
          },
        },
      },
      {
        app,
        params: {},
        route: {
          id: 'page',
          kind: 'page',
          handler: ({ response }: any) => {
            response.headers.set('cache-control', 'page')
            response.headers.append('set-cookie', 'page=1; Path=/')
            return null
          },
        },
      },
    ],
  })

  expect(response.headers.get('cache-control')).toBe('page')
  const getSetCookie = (
    response.headers as Headers & { getSetCookie?: () => string[] }
  ).getSetCookie
  expect(getSetCookie?.call(response.headers)).toEqual([
    'layout=1; Path=/',
    'page=1; Path=/',
  ])
})

test('renderReact uses page response.status over layout response.status', async () => {
  const app = new Spiceflow()
  const response = await (app as any).renderReact({
    request: new Request('http://localhost/status-precedence', {
      method: 'GET',
    }),
    context: makeContext(),
    reactRoutes: [
      {
        app,
        params: {},
        route: {
          id: 'layout',
          kind: 'layout',
          handler: ({ children, response }: any) => {
            response.status = 418
            return children
          },
        },
      },
      {
        app,
        params: {},
        route: {
          id: 'page',
          kind: 'page',
          handler: ({ response }: any) => {
            response.status = 202
            return null
          },
        },
      },
    ],
  })

  expect(response.status).toBe(202)
})

test('renderReact falls back to nearest layout response.status when page does not set status', async () => {
  const app = new Spiceflow()
  const response = await (app as any).renderReact({
    request: new Request('http://localhost/layout-status', { method: 'GET' }),
    context: makeContext(),
    reactRoutes: [
      {
        app,
        params: {},
        route: {
          id: 'outer-layout',
          kind: 'layout',
          handler: ({ children, response }: any) => {
            response.status = 451
            return children
          },
        },
      },
      {
        app,
        params: {},
        route: {
          id: 'inner-layout',
          kind: 'layout',
          handler: ({ children, response }: any) => {
            response.status = 429
            return children
          },
        },
      },
      {
        app,
        params: {},
        route: {
          id: 'page',
          kind: 'page',
          handler: () => null,
        },
      },
    ],
  })

  // Nearest layout wins (last matched layout in render order)
  expect(response.status).toBe(429)
})

test('renderReact starts layouts and page concurrently', async () => {
  const app = new Spiceflow()
  const events: string[] = []

  const createDeferred = () => {
    let resolve!: () => void
    const promise = new Promise<void>((r) => {
      resolve = r
    })
    return { promise, resolve }
  }

  const layoutDeferred = createDeferred()
  const pageDeferred = createDeferred()

  const renderPromise = (app as any).renderReact({
    request: new Request('http://localhost/concurrent', { method: 'GET' }),
    context: makeContext(),
    reactRoutes: [
      {
        app,
        params: { layoutId: 'outer' },
        route: {
          id: 'layout',
          kind: 'layout',
          handler: async ({ children }: any) => {
            events.push('layout:start')
            await layoutDeferred.promise
            events.push('layout:end')
            return children
          },
        },
      },
      {
        app,
        params: {},
        route: {
          id: 'page',
          kind: 'page',
          handler: async () => {
            events.push('page:start')
            await pageDeferred.promise
            events.push('page:end')
            throw new Response(null, { status: 204 })
          },
        },
      },
    ],
  })

  await vi.waitFor(() => {
    expect(events).toEqual(['layout:start', 'page:start'])
  })

  layoutDeferred.resolve()
  await Promise.resolve()
  expect(events).toEqual(['layout:start', 'page:start', 'layout:end'])

  pageDeferred.resolve()
  const response = await renderPromise
  expect(events).toEqual([
    'layout:start',
    'page:start',
    'layout:end',
    'page:end',
  ])
  expect(response).toBeInstanceOf(Response)
  expect(response.status).toMatchInlineSnapshot(`200`)
})

test('renderReact uses loader response.status when page and layout do not set status', async () => {
  const app = new Spiceflow()
  const response = await (app as any).renderReact({
    request: new Request('http://localhost/loader-status', { method: 'GET' }),
    context: makeContext(),
    reactRoutes: [
      {
        app,
        params: {},
        route: {
          id: 'loader',
          kind: 'loader',
          handler: ({ response }: any) => {
            response.status = 404
            return { notFound: true }
          },
        },
      },
      {
        app,
        params: {},
        route: {
          id: 'page',
          kind: 'page',
          handler: () => null,
        },
      },
    ],
  })
  expect(response.status).toBe(404)
})

test('renderReact page response.status takes precedence over loader response.status', async () => {
  const app = new Spiceflow()
  const response = await (app as any).renderReact({
    request: new Request('http://localhost/loader-vs-page', { method: 'GET' }),
    context: makeContext(),
    reactRoutes: [
      {
        app,
        params: {},
        route: {
          id: 'loader',
          kind: 'loader',
          handler: ({ response }: any) => {
            response.status = 404
            return {}
          },
        },
      },
      {
        app,
        params: {},
        route: {
          id: 'page',
          kind: 'page',
          handler: ({ response }: any) => {
            response.status = 202
            return null
          },
        },
      },
    ],
  })
  expect(response.status).toBe(202)
})

test('wildcard layouts on parent and mounted child get unique flight ids', async () => {
  // Regression: route ids are generated per-app, so a parent .layout('/*')
  // and a mounted child's .layout('/*') both got id "layout-get--*". The
  // client's resolveLayoutElement finds layouts by id, so the duplicate id
  // made the child layout resolve to itself -> infinite recursion during SSR.
  const child = new Spiceflow()
    .layout('/*', ({ children }: any) => children)
    .page('/docs', () => null)
  const app = new Spiceflow()
    .layout('/*', ({ children }: any) => children)
    .page('/login', () => null)
    .use(child)

  const res = await app.handle(
    new Request('http://localhost/docs', {
      method: 'GET',
      headers: { accept: 'text/html' },
    }),
  )
  expect(res.status).toBe(200)

  const layouts = lastPayload.root.layouts as { id: string }[]
  // Parent wildcard layout must come first (outermost), child second.
  expect(layouts).toHaveLength(2)
  const ids = layouts.map((l) => l.id)
  expect(new Set(ids).size).toBe(ids.length)

  // The parent app's own pages must also render with a single layout entry
  // per registered layout and unique ids.
  const loginRes = await app.handle(
    new Request('http://localhost/login', {
      method: 'GET',
      headers: { accept: 'text/html' },
    }),
  )
  expect(loginRes.status).toBe(200)
  const loginIds = (lastPayload.root.layouts as { id: string }[]).map(
    (l) => l.id,
  )
  expect(new Set(loginIds).size).toBe(loginIds.length)
})

test('renderReact does not execute loader-only route sets', async () => {
  const app = new Spiceflow()
  let ranLoader = false

  const response = await (app as any).renderReact({
    request: new Request('http://localhost/loader-only', {
      method: 'GET',
      headers: { accept: 'text/html' },
    }),
    context: makeContext(),
    reactRoutes: [
      {
        app,
        params: {},
        route: {
          id: 'loader',
          kind: 'loader',
          handler: () => {
            ranLoader = true
            return { ok: true }
          },
        },
      },
    ],
  })

  expect(response.status).toBe(404)
  expect(await response.text()).toBe('Not Found')
  expect(ranLoader).toBe(false)
})
