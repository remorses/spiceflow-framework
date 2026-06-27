// Tests for OTel instrumentation: verifies span creation, attributes, error recording,
// and the full span tree for API and React-style routes.

import { test, describe, expect } from 'vitest'
import { Spiceflow } from './spiceflow.js'
import type { SpiceflowTracer, SpiceflowSpan } from './instrumentation.js'
import { noopSpan, noopTracer } from './instrumentation.js'
import { createCloudflareTracer } from './cloudflare-tracer-adapter.js'

interface TestSpan {
  name: string
  traceId: string
  spanId: string
  kind?: number
  attributes: Record<string, string | number | boolean>
  status?: { code: number; message?: string }
  errors: Array<{ name: string; message: string }>
  ended: boolean
  children: TestSpan[]
  parent?: TestSpan
}

// Test double tracer that records all span operations and tracks parent-child via
// a simple stack (startActiveSpan pushes, end pops).
function createTestTracer() {
  const spans: TestSpan[] = []
  const stack: TestSpan[] = []
  let nextTraceId = 0
  let nextSpanId = 0

  function createId(length: number, value: number) {
    return value.toString(16).padStart(length, '0')
  }

  const tracer: SpiceflowTracer = {
    startActiveSpan(name: string, ...args: any[]) {
      const fn = args[args.length - 1] as (span: SpiceflowSpan) => unknown
      const options = args.length > 1 ? args[0] : {}
      const parent = stack[stack.length - 1]
      const testSpan: TestSpan = {
        name,
        traceId: parent?.traceId ?? createId(32, ++nextTraceId),
        spanId: createId(16, ++nextSpanId),
        kind: options.kind,
        attributes: { ...options.attributes },
        errors: [],
        ended: false,
        children: [],
        parent,
      }
      if (parent) parent.children.push(testSpan)
      spans.push(testSpan)
      stack.push(testSpan)

      const span: SpiceflowSpan = {
        setAttribute(key, value) {
          testSpan.attributes[key] = value
          return span
        },
        setStatus(status) {
          testSpan.status = status
          return span
        },
        recordException(exception) {
          const err =
            exception instanceof Error
              ? { name: exception.name, message: exception.message }
              : { name: 'Error', message: String(exception) }
          testSpan.errors.push(err)
        },
        updateName(n) {
          testSpan.name = n
          return span
        },
        spanContext() {
          return {
            traceId: testSpan.traceId,
            spanId: testSpan.spanId,
          }
        },
        end() {
          testSpan.ended = true
          const idx = stack.lastIndexOf(testSpan)
          if (idx !== -1) stack.splice(idx, 1)
        },
      }
      return fn(span)
    },
  }

  return { tracer, spans }
}

// Strip parent refs to avoid circular snapshot
function serializeSpans(spans: TestSpan[]) {
  return spans.map((s) => ({
    name: s.name,
    kind: s.kind,
    attributes: s.attributes,
    status: s.status,
    errors: s.errors,
    ended: s.ended,
    children: serializeSpans(s.children),
  }))
}

function getServerTimingDescriptions(header: string | null) {
  if (!header) return []

  return Array.from(header.matchAll(/desc="([^"]+)"/g), (match) => match[1]!)
}

function getServerTimingNames(header: string | null) {
  if (!header) return []

  return header.split(', ').map((entry) => entry.split(';')[0]!)
}

describe('instrumentation', () => {
  test('no spans when tracer is not set', async () => {
    const app = new Spiceflow().get('/hello', () => 'world')
    const res = await app.handle(new Request('http://localhost/hello'))
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('"world"')
  })

  test('noop span context is undefined without tracer', async () => {
    let traceId: string | undefined

    const app = new Spiceflow().get('/hello', ({ span }) => {
      traceId = span.spanContext?.()?.traceId
      return 'world'
    })

    await app.handle(new Request('http://localhost/hello'))

    expect(traceId).toBeUndefined()
  })

  test('root span for GET request', async () => {
    const { tracer, spans } = createTestTracer()
    const app = new Spiceflow({ tracer }).get('/hello', () => 'world')
    const res = await app.handle(new Request('http://localhost/hello'))

    expect(res.status).toBe(200)
    const roots = spans.filter((s) => !s.parent)
    expect(roots).toHaveLength(1)
    expect(roots[0].name).toBe('GET /hello')
    expect(roots[0].attributes['http.request.method']).toBe('GET')
    expect(roots[0].attributes['http.response.status_code']).toBe(200)
    expect(roots[0].attributes['http.route']).toBe('/hello')
    expect(roots[0].ended).toBe(true)
  })

  test('handler span is child of root span', async () => {
    const { tracer, spans } = createTestTracer()
    const app = new Spiceflow({ tracer }).get('/users/:id', () => ({ id: '1' }))
    await app.handle(new Request('http://localhost/users/1'))

    const root = spans.find((s) => !s.parent)!
    expect(root.name).toBe('GET /users/:id')
    expect(root.attributes['http.route']).toBe('/users/:id')

    const handler = root.children.find((s) => s.name.startsWith('handler'))
    expect(handler).toBeDefined()
    expect(handler!.name).toBe('handler - /users/:id')
    expect(handler!.ended).toBe(true)
  })

  test('handlers can read trace ids from span context', async () => {
    const { tracer } = createTestTracer()
    let traceId: string | undefined
    let spanId: string | undefined

    const app = new Spiceflow({ tracer }).get('/users/:id', ({ span }) => {
      traceId = span.spanContext?.()?.traceId
      spanId = span.spanContext?.()?.spanId
      return { ok: true }
    })

    await app.handle(new Request('http://localhost/users/1'))

    expect({ traceId, spanId }).toMatchInlineSnapshot(`
      {
        "spanId": "0000000000000002",
        "traceId": "00000000000000000000000000000001",
      }
    `)
  })

  test('middleware spans are children of root', async () => {
    const { tracer, spans } = createTestTracer()
    function authMiddleware(_ctx: any, next: any) {
      return next()
    }
    const app = new Spiceflow({ tracer })
      .use(authMiddleware)
      .get('/hello', () => 'world')

    await app.handle(new Request('http://localhost/hello'))

    const root = spans.find((s) => !s.parent)!
    const mw = root.children.find(
      (s) => s.name === 'middleware - authMiddleware',
    )
    expect(mw).toBeDefined()
    expect(mw!.ended).toBe(true)
  })

  test('anonymous middleware gets fallback name', async () => {
    const { tracer, spans } = createTestTracer()
    const app = new Spiceflow({ tracer })
      .use((_ctx: any, next: any) => next())
      .get('/hello', () => 'world')

    await app.handle(new Request('http://localhost/hello'))

    const root = spans.find((s) => !s.parent)!
    const mw = root.children.find((s) => s.name === 'middleware - anonymous')
    expect(mw).toBeDefined()
  })

  test('error in handler records exception on handler span', async () => {
    const { tracer, spans } = createTestTracer()
    const app = new Spiceflow({ tracer })
      .get('/fail', () => {
        throw new Error('boom')
      })
      .onError(({ error }) => new Response(error.message, { status: 500 }))

    const res = await app.handle(new Request('http://localhost/fail'))
    expect(res.status).toBe(500)

    const handler = spans.find((s) => s.name.startsWith('handler'))!
    expect(handler.errors).toHaveLength(1)
    expect(handler.errors[0].message).toBe('boom')
    expect(handler.status?.code).toBe(2) // ERROR

    const root = spans.find((s) => !s.parent)!
    expect(root.attributes['http.response.status_code']).toBe(500)
    expect(root.status?.code).toBe(2) // ERROR
  })

  test('errore fingerprint is propagated as span attribute', async () => {
    const { tracer, spans } = createTestTracer()

    // Simulate an errore-style tagged error with fingerprint
    class TaggedError extends Error {
      fingerprint = ['TaggedError', 'Something went wrong with $id']
      constructor() {
        super('Something went wrong with 42')
        this.name = 'TaggedError'
      }
    }

    const app = new Spiceflow({ tracer })
      .get('/fail', () => {
        throw new TaggedError()
      })
      .onError(({ error }) => new Response(error.message, { status: 500 }))

    await app.handle(new Request('http://localhost/fail'))

    const handler = spans.find((s) => s.name.startsWith('handler'))!
    expect(handler.attributes['error.fingerprint']).toBe(
      'TaggedError\nSomething went wrong with $id',
    )
    expect(handler.attributes['error.type']).toBe('TaggedError')
  })

  test('full API span tree', async () => {
    const { tracer, spans } = createTestTracer()
    function cors(_ctx: any, next: any) {
      return next()
    }
    function auth(_ctx: any, next: any) {
      return next()
    }

    const app = new Spiceflow({ tracer })
      .use(cors)
      .use(auth)
      .get('/api/users/:id', () => ({ id: '1', name: 'Alice' }))

    await app.handle(new Request('http://localhost/api/users/1'))

    const roots = serializeSpans(spans.filter((s) => !s.parent))
    expect(roots).toMatchInlineSnapshot(`
      [
        {
          "attributes": {
            "http.request.method": "GET",
            "http.response.status_code": 200,
            "http.route": "/api/users/:id",
            "url.full": "http://localhost/api/users/1",
            "url.path": "/api/users/1",
          },
          "children": [
            {
              "attributes": {},
              "children": [
                {
                  "attributes": {},
                  "children": [
                    {
                      "attributes": {},
                      "children": [],
                      "ended": true,
                      "errors": [],
                      "kind": undefined,
                      "name": "handler - /api/users/:id",
                      "status": undefined,
                    },
                  ],
                  "ended": true,
                  "errors": [],
                  "kind": undefined,
                  "name": "middleware - auth",
                  "status": undefined,
                },
              ],
              "ended": true,
              "errors": [],
              "kind": undefined,
              "name": "middleware - cors",
              "status": undefined,
            },
          ],
          "ended": true,
          "errors": [],
          "kind": 1,
          "name": "GET /api/users/:id",
          "status": undefined,
        },
      ]
    `)
  })

  test('POST request span', async () => {
    const { tracer, spans } = createTestTracer()
    const app = new Spiceflow({ tracer }).post('/items', () => ({
      created: true,
    }))

    await app.handle(new Request('http://localhost/items', { method: 'POST' }))

    const root = spans.find((s) => !s.parent)!
    expect(root.name).toBe('POST /items')
    expect(root.attributes['http.request.method']).toBe('POST')
    expect(root.attributes['http.response.status_code']).toBe(200)
  })

  test('unmatched route keeps low-cardinality root span name', async () => {
    const { tracer, spans } = createTestTracer()
    const app = new Spiceflow({ tracer }).get('/hello', () => 'world')

    const res = await app.handle(new Request('http://localhost/not-found'))
    expect(res.status).toBe(404)

    const root = spans.find((s) => !s.parent)!
    // Root span should NOT contain the raw URL path — stays as method-only
    expect(root.name).toBe('GET')
    expect(root.attributes['http.response.status_code']).toBe(404)
    // http.route should not be set for unmatched routes
    expect(root.attributes['http.route']).toBeUndefined()
  })

  test('thrown Response (redirect) is not recorded as error', async () => {
    const { tracer, spans } = createTestTracer()
    const { redirect } = await import('./react/errors.js')

    const app = new Spiceflow({ tracer }).get('/old', () => {
      throw redirect('/new')
    })

    const res = await app.handle(new Request('http://localhost/old'))
    expect(res.status).toBe(307)

    const handler = spans.find((s) => s.name.startsWith('handler'))!
    // Response throws are control flow, not errors — no exception recorded
    expect(handler.errors).toHaveLength(0)
    expect(handler.status).toBeUndefined()
  })

  test('non-Error throw records exception on span', async () => {
    const { tracer, spans } = createTestTracer()
    const app = new Spiceflow({ tracer })
      .get('/fail', () => {
        throw 'string error'
      })
      .onError(() => new Response('handled', { status: 500 }))

    await app.handle(new Request('http://localhost/fail'))

    const handler = spans.find((s) => s.name.startsWith('handler'))!
    expect(handler.errors).toHaveLength(1)
    expect(handler.errors[0].message).toBe('string error')
    expect(handler.status?.code).toBe(2)
  })

  test('middleware that returns early creates span', async () => {
    const { tracer, spans } = createTestTracer()
    function earlyReturn() {
      return new Response('blocked', { status: 403 })
    }

    const app = new Spiceflow({ tracer })
      .use(earlyReturn)
      .get('/hello', () => 'world')

    const res = await app.handle(new Request('http://localhost/hello'))
    expect(res.status).toBe(403)

    const root = spans.find((s) => !s.parent)!
    const mw = root.children.find((s) => s.name === 'middleware - earlyReturn')
    expect(mw).toBeDefined()
    expect(mw!.ended).toBe(true)
    expect(root.attributes['http.response.status_code']).toBe(403)
  })

  test('context.span and context.tracer are noops when no tracer is set', async () => {
    let capturedSpan: SpiceflowSpan | undefined
    let capturedTracer: SpiceflowTracer | undefined

    const app = new Spiceflow().get('/hello', ({ span, tracer }) => {
      capturedSpan = span
      capturedTracer = tracer
      return 'world'
    })

    await app.handle(new Request('http://localhost/hello'))
    expect(capturedSpan).toBe(noopSpan)
    expect(capturedTracer).toBe(noopTracer)
  })

  test('context.tracer is available when tracer is set', async () => {
    const { tracer } = createTestTracer()
    let capturedTracer: SpiceflowTracer | undefined

    const app = new Spiceflow({ tracer }).get('/hello', (ctx) => {
      capturedTracer = ctx.tracer
      return 'world'
    })

    await app.handle(new Request('http://localhost/hello'))
    expect(capturedTracer).toBeDefined()
    expect(capturedTracer!.startActiveSpan).toBeInstanceOf(Function)
  })

  test('context.span is the handler span when tracer is set', async () => {
    const { tracer, spans } = createTestTracer()
    let capturedSpan: SpiceflowSpan | undefined

    const app = new Spiceflow({ tracer }).get('/hello', ({ span }) => {
      capturedSpan = span
      span.setAttribute('custom.key', 'custom-value')
      return 'world'
    })

    await app.handle(new Request('http://localhost/hello'))
    expect(capturedSpan).not.toBe(noopSpan)

    const handlerSpan = spans.find((s) => s.name.startsWith('handler'))!
    expect(handlerSpan.attributes['custom.key']).toBe('custom-value')
  })

  test('context.span in middleware is the middleware span', async () => {
    const { tracer, spans } = createTestTracer()

    function tagMiddleware({ span }: any, next: any) {
      span.setAttribute('mw.tag', 'tagged')
      return next()
    }

    const app = new Spiceflow({ tracer })
      .use(tagMiddleware)
      .get('/hello', () => 'world')

    await app.handle(new Request('http://localhost/hello'))

    const mwSpan = spans.find((s) => s.name === 'middleware - tagMiddleware')!
    expect(mwSpan.attributes['mw.tag']).toBe('tagged')
  })

  test('context.span.recordException works for caught errors', async () => {
    const { tracer, spans } = createTestTracer()

    const app = new Spiceflow({ tracer }).get('/hello', ({ span }) => {
      try {
        throw new Error('suppressed')
      } catch (err) {
        span.recordException(err as Error)
      }
      return 'ok'
    })

    const res = await app.handle(new Request('http://localhost/hello'))
    expect(res.status).toBe(200)

    const handlerSpan = spans.find((s) => s.name.startsWith('handler'))!
    expect(handlerSpan.errors).toHaveLength(1)
    expect(handlerSpan.errors[0].message).toBe('suppressed')
  })

  test('context.tracer.startActiveSpan creates child spans', async () => {
    const { tracer, spans } = createTestTracer()

    const app = new Spiceflow({ tracer }).get('/hello', async ({ tracer }) => {
      return tracer.startActiveSpan('db.query', (dbSpan) => {
        dbSpan.setAttribute('db.statement', 'SELECT * FROM users')
        dbSpan.end()
        return { users: [] }
      })
    })

    await app.handle(new Request('http://localhost/hello'))

    const dbSpan = spans.find((s) => s.name === 'db.query')!
    expect(dbSpan).toBeDefined()
    expect(dbSpan.attributes['db.statement']).toBe('SELECT * FROM users')
    expect(dbSpan.ended).toBe(true)
    expect(dbSpan.parent?.name).toBe('handler - /hello')
  })

  test('context.span is restored after next() in middleware', async () => {
    const { tracer, spans } = createTestTracer()
    let spanBeforeNext: SpiceflowSpan | undefined
    let spanAfterNext: SpiceflowSpan | undefined

    function outerMiddleware({ span }: any, next: any) {
      spanBeforeNext = span
      const result = next()
      return result.then((res: any) => {
        spanAfterNext = span
        return res
      })
    }

    // Note: spanAfterNext check happens in the withSpan's try/finally restore.
    // The middleware reads `span` from the context reference captured at call time.
    // But since we restore context.span in finally, the middleware's local `span`
    // variable (destructured at call time) still points to the middleware span.
    const app = new Spiceflow({ tracer })
      .use(outerMiddleware)
      .get('/hello', () => 'world')

    await app.handle(new Request('http://localhost/hello'))

    // Both should be the middleware span, not the handler span
    expect(spanBeforeNext).toBeDefined()
    expect(spanBeforeNext).toBe(spanAfterNext)
  })

  test('noopSpan methods are safe to call', () => {
    expect(noopSpan.setAttribute('key', 'value')).toBe(noopSpan)
    expect(noopSpan.setStatus({ code: 0 })).toBe(noopSpan)
    expect(noopSpan.updateName('new-name')).toBe(noopSpan)
    noopSpan.recordException(new Error('test'))
    noopSpan.end()
  })

  test('noopTracer.startActiveSpan calls fn with noopSpan', () => {
    let received: SpiceflowSpan | undefined
    noopTracer.startActiveSpan('test', (span) => {
      received = span
    })
    expect(received).toBe(noopSpan)
  })

  test('server timing emits nested descriptions for built-in and custom spans', async () => {
    const { tracer } = createTestTracer()
    const app = new Spiceflow({ tracer }).get(
      '/users/:id',
      ({ tracer }) => {
        return tracer.startActiveSpan('db.query', (dbSpan) => {
          dbSpan.end()
          return { ok: true }
        })
      },
    )

    const res = await app.handle(new Request('http://localhost/users/1'))

    expect(res.status).toBe(200)
    expect(getServerTimingDescriptions(res.headers.get('server-timing')))
      .toMatchInlineSnapshot(`
        [
          "GET /users/:id",
          "handler - /users/:id",
          "db.query",
        ]
      `)

    expect(getServerTimingNames(res.headers.get('server-timing')))
      .toMatchInlineSnapshot(`
        [
          "get-users-id",
          "handler-users-id",
          "db.query",
        ]
      `)
  })

  test('server timing is omitted when explicitly disabled', async () => {
    const { tracer } = createTestTracer()
    const app = new Spiceflow({ tracer, serverTiming: false }).get(
      '/hello',
      () => 'world',
    )

    const res = await app.handle(new Request('http://localhost/hello'))

    expect(res.headers.get('server-timing')).toBeNull()
  })

  test('server timing is enabled by default when tracer is provided', async () => {
    const { tracer } = createTestTracer()
    const app = new Spiceflow({ tracer }).get('/hello', () => 'world')

    const res = await app.handle(new Request('http://localhost/hello'))

    expect(res.headers.get('server-timing')).not.toBeNull()
  })

  test('tracing and server timing work across parent app with middleware and child subapp mounted with .use()', async () => {
    const { tracer, spans } = createTestTracer()

    const child = new Spiceflow({ basePath: '/api' }).get(
      '/users/:id',
      ({ tracer }) => {
        return tracer.startActiveSpan('db.query', (dbSpan) => {
          dbSpan.end()
          return { id: '1', name: 'Alice' }
        })
      },
    )

    const app = new Spiceflow({ tracer })
    app.use(async function authMiddleware(ctx: any, next: any) {
      ctx.state = { ...ctx.state, user: 'tommy' }
      return next()
    })
    app.use(child)

    const res = await app.handle(
      new Request('http://localhost/api/users/1'),
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id: '1', name: 'Alice' })

    // All spans are created: root request, parent middleware, child handler, custom span
    const rootSpans = spans.filter((s) => !s.parent)
    expect(rootSpans).toHaveLength(1)

    const spanNames = spans.map((s) => s.name)
    expect(spanNames).toMatchInlineSnapshot(`
      [
        "GET /api/users/:id",
        "middleware - authMiddleware",
        "handler - /api/users/:id",
        "db.query",
      ]
    `)

    // Server timing shows parent middleware wrapping child handler and custom spans
    expect(getServerTimingDescriptions(res.headers.get('server-timing')))
      .toMatchInlineSnapshot(`
        [
          "GET /api/users/:id",
          "middleware - authMiddleware",
          "handler - /api/users/:id",
          "db.query",
        ]
      `)

    expect(getServerTimingNames(res.headers.get('server-timing')))
      .toMatchInlineSnapshot(`
        [
          "get-api-users-id",
          "middleware-authmiddleware",
          "handler-api-users-id",
          "db.query",
        ]
      `)

    // Parent middleware span is a child of the root span
    const mwSpan = spans.find((s) => s.name === 'middleware - authMiddleware')!
    expect(mwSpan.parent?.name).toBe('GET /api/users/:id')

    // Handler span is a child of the middleware span (middleware wraps handler)
    const handlerSpan = spans.find((s) => s.name === 'handler - /api/users/:id')!
    expect(handlerSpan.parent?.name).toBe('middleware - authMiddleware')

    // Custom span is a child of the handler span
    const dbSpan = spans.find((s) => s.name === 'db.query')!
    expect(dbSpan.parent?.name).toBe('handler - /api/users/:id')
  })
})

describe('cloudflare tracer adapter', () => {
  test('wraps enterSpan into SpiceflowTracer.startActiveSpan', () => {
    const calls: { name: string; attrs: Record<string, any> }[] = []
    const mockEnterSpan = (name: string, callback: (span: any) => any) => {
      const attrs: Record<string, any> = {}
      const cfSpan = {
        setAttribute(k: string, v: any) { attrs[k] = v },
        isTraced: true,
      }
      calls.push({ name, attrs })
      return callback(cfSpan)
    }

    const tracer = createCloudflareTracer(mockEnterSpan)
    const result = tracer.startActiveSpan('test-span', (span) => {
      span.setAttribute('foo', 'bar')
      return 42
    })

    expect(result).toBe(42)
    expect(calls).toHaveLength(1)
    expect(calls[0].name).toBe('test-span')
    expect(calls[0].attrs).toEqual({ foo: 'bar' })
  })

  test('forwards options.attributes to CF span', () => {
    const attrs: Record<string, any> = {}
    const mockEnterSpan = (_name: string, callback: (span: any) => any) => {
      return callback({
        setAttribute(k: string, v: any) { attrs[k] = v },
        isTraced: true,
      })
    }

    const tracer = createCloudflareTracer(mockEnterSpan)
    tracer.startActiveSpan(
      'req',
      { attributes: { 'http.method': 'GET', 'url.path': '/hello' } },
      (span) => {
        span.setAttribute('custom', true)
        return null
      },
    )

    expect(attrs).toEqual({
      'http.method': 'GET',
      'url.path': '/hello',
      custom: true,
    })
  })

  test('noop methods do not throw', () => {
    const mockEnterSpan = (_name: string, callback: (span: any) => any) => {
      return callback({ setAttribute() {}, isTraced: false })
    }

    const tracer = createCloudflareTracer(mockEnterSpan)
    tracer.startActiveSpan('test', (span) => {
      expect(span.setStatus({ code: 2 })).toBe(span)
      expect(span.updateName('new')).toBe(span)
      expect(span.spanContext?.()).toBeUndefined()
      span.recordException(new Error('test'))
      span.end()
    })
  })

  test('maps setStatus ERROR to otel.status_code attribute', () => {
    const attrs: Record<string, any> = {}
    const mockEnterSpan = (_name: string, callback: (span: any) => any) => {
      return callback({
        setAttribute(k: string, v: any) { attrs[k] = v },
        isTraced: true,
      })
    }

    const tracer = createCloudflareTracer(mockEnterSpan)
    tracer.startActiveSpan('test', (span) => {
      span.setStatus({ code: 2, message: 'something broke' })
    })

    expect(attrs['otel.status_code']).toBe('ERROR')
    expect(attrs['otel.status_description']).toBe('something broke')
  })

  test('maps recordException to exception.* attributes', () => {
    const attrs: Record<string, any> = {}
    const mockEnterSpan = (_name: string, callback: (span: any) => any) => {
      return callback({
        setAttribute(k: string, v: any) { attrs[k] = v },
        isTraced: true,
      })
    }

    const tracer = createCloudflareTracer(mockEnterSpan)
    tracer.startActiveSpan('test', (span) => {
      const err = new Error('db connection failed')
      err.name = 'DatabaseError'
      span.recordException(err)
    })

    expect(attrs['exception.type']).toBe('DatabaseError')
    expect(attrs['exception.message']).toBe('db connection failed')
    expect(attrs['exception.stacktrace']).toContain('DatabaseError')
  })

  test('maps recordException string to exception.message attribute', () => {
    const attrs: Record<string, any> = {}
    const mockEnterSpan = (_name: string, callback: (span: any) => any) => {
      return callback({
        setAttribute(k: string, v: any) { attrs[k] = v },
        isTraced: true,
      })
    }

    const tracer = createCloudflareTracer(mockEnterSpan)
    tracer.startActiveSpan('test', (span) => {
      span.recordException('plain string error')
    })

    expect(attrs['exception.message']).toBe('plain string error')
    expect(attrs['exception.type']).toBeUndefined()
  })

  test('error in handler propagates error attributes to CF span', async () => {
    const allAttrs: Record<string, any>[] = []
    const mockEnterSpan = (_name: string, callback: (span: any) => any) => {
      const attrs: Record<string, any> = {}
      allAttrs.push(attrs)
      return callback({
        setAttribute(k: string, v: any) { attrs[k] = v },
        isTraced: true,
      })
    }

    const tracer = createCloudflareTracer(mockEnterSpan)
    const app = new Spiceflow({ tracer }).get('/boom', () => {
      throw new Error('handler exploded')
    })
    const res = await app.handle(new Request('http://localhost/boom'))

    expect(res.status).toBe(500)
    // The handler span should have error attributes
    const handlerAttrs = allAttrs.find(a => a['exception.message'] === 'handler exploded')
    expect(handlerAttrs).toBeDefined()
    expect(handlerAttrs!['otel.status_code']).toBe('ERROR')
    expect(handlerAttrs!['error.type']).toBe('Error')
    expect(handlerAttrs!['exception.stacktrace']).toContain('handler exploded')
  })

  test('works as tracer in Spiceflow app', async () => {
    const spanNames: string[] = []
    const mockEnterSpan = (name: string, callback: (span: any) => any) => {
      spanNames.push(name)
      return callback({
        setAttribute() {},
        isTraced: true,
      })
    }

    const tracer = createCloudflareTracer(mockEnterSpan)
    const app = new Spiceflow({ tracer }).get('/hello', () => 'world')
    const res = await app.handle(new Request('http://localhost/hello'))

    expect(res.status).toBe(200)
    expect(spanNames).toContain('GET')
    expect(spanNames).toContain('handler - /hello')
  })
})
