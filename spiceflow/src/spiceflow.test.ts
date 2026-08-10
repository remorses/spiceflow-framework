import { test, describe, expect } from 'vitest'

import {
  bfs,
  cloneDeep,
  extractWildcardParam,
  Spiceflow,
  SpiceflowRequest,
} from './spiceflow.tsx'
import { z } from 'zod'
import { createSpiceflowFetch } from './client/fetch.ts'

async function expectJsonErrorResponse({
  response,
  status,
  message,
  extra = {},
}: {
  response: Response
  status: number
  message: string
  extra?: Record<string, unknown>
}) {
  expect(response.status).toBe(status)
  const body = await response.json()
  expect(body).toMatchObject({
    ...extra,
    message,
    stack: expect.any(String),
  })
  expect(body.stack).toContain(`Error: ${message}`)
}

test('works', async () => {
  const res = await new Spiceflow()
    .post('/xxx', () => 'hi')
    .handle(new Request('http://localhost/xxx', { method: 'POST' }))
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual('hi')
})

test('staticGet() works as a normal GET handler at runtime', async () => {
  const app = new Spiceflow().staticGet('/api/manifest.json', () => ({
    name: 'my-app',
    version: '1.0.0',
  }))

  const res = await app.handle(
    new Request('http://localhost/api/manifest.json'),
  )
  expect(res.status).toBe(200)
  expect(await res.json()).toMatchInlineSnapshot(`
    {
      "name": "my-app",
      "version": "1.0.0",
    }
  `)
})

test('staticGet() returns string response', async () => {
  const app = new Spiceflow().staticGet('/robots.txt', () =>
    new Response('User-agent: *\nDisallow:', {
      headers: { 'content-type': 'text/plain' },
    }),
  )

  const res = await app.handle(new Request('http://localhost/robots.txt'))
  expect(res.status).toBe(200)
  expect(await res.text()).toBe('User-agent: *\nDisallow:')
})

test('listen() returns stop() that shuts down the server', async () => {
  const listener = await new Spiceflow()
    .get('/hello', () => 'Hello, World!')
    .listen(0, '127.0.0.1')

  expect(listener.stop).toEqual(expect.any(Function))

  const port = listener.port
  if (port === undefined) {
    throw new Error('listen() did not return a port in the node test runtime')
  }

  const stop: () => Promise<void> = listener.stop
  const url = `http://127.0.0.1:${port}/hello`

  try {
    const response = await fetch(url)
    expect(response.status).toBe(200)
    expect(await response.json()).toBe('Hello, World!')
  } finally {
    await stop()
  }

  const stoppedFetch = await fetch(url).catch((error) => error)
  expect(stoppedFetch).toBeInstanceOf(TypeError)
})

test('listen() returns noop stop() during prerender', async () => {
  Reflect.set(globalThis, '__SPICEFLOW_PRERENDER', true)

  try {
    const listener = await new Spiceflow()
      .get('/hello', () => 'Hello')
      .listen(0)
    const stop: () => Promise<void> = listener.stop

    expect(listener).toEqual(
      expect.objectContaining({
        port: undefined,
        server: undefined,
        stop: expect.any(Function),
      }),
    )

    await stop()
  } finally {
    Reflect.deleteProperty(globalThis, '__SPICEFLOW_PRERENDER')
  }
})

test('* param is a path without front slash', async () => {
  const app = new Spiceflow().post('/upload/*', ({ params }) => {
    return params['*']
  })

  {
    // /upload/ with trailing slash matches /upload/* (trie router matches /* for parent path too)
    // wildcard param is undefined since there's nothing after /upload
    const res = await app.handle(
      new Request('http://localhost/upload/', {
        method: 'POST',
      }),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toBeNull()
  }
  {
    const res = await app.handle(
      new Request('http://localhost/upload/some/nested/key.txt', {
        method: 'POST',
      }),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(`some/nested/key.txt`)
  }
})

test('* param in .route() does not contain leading slash', async () => {
  const app = new Spiceflow().route({
    method: 'GET',
    path: '/repos/:owner/:repo/:branch/file/*',
    handler: async ({ params }) => {
      const { owner, repo, branch, '*': filePath } = params
      return { owner, repo, branch, filePath }
    },
  })

  const res = await app.handle(
    new Request(
      'http://localhost/repos/user/myrepo/main/file/src/components/Button.tsx',
      {
        method: 'GET',
      },
    ),
  )
  expect(res.status).toBe(200)
  const result = await res.json()
  expect(result).toMatchInlineSnapshot(`
    {
      "branch": "main",
      "filePath": "src/components/Button.tsx",
      "owner": "user",
      "repo": "myrepo",
    }
  `)
  expect(result.filePath).not.toMatch(/^\//)
})

// test('should error if passing .request option to .route with method GET', () => {
//   new Spiceflow().route({
//     method: 'GET',
//     path: '/abc',
//     handler: () => 'ok',
//     // @ts-expect-error .request is not allowed for GET routes
//     request: z.object({
//       abc: z.string(),
//     }),
//   })
// })

test('* method listens on all HTTP methods', async () => {
  const app = new Spiceflow().route({
    method: '*',
    path: '/wildcard',
    handler: ({ request }) => ({ method: request.method }),
  })

  // Test different HTTP methods
  const methods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']

  for (const method of methods) {
    const res = await app.handle(
      new Request('http://localhost/wildcard', { method }),
    )
    expect(res.status).toBe(200)
    const result = await res.json()
    expect(result).toEqual({ method })
  }
})

test('route without method defaults to * (all methods)', async () => {
  const app = new Spiceflow().route({
    path: '/default',
    handler: ({ request }) => ({ method: request.method }),
  })

  // Test different HTTP methods
  const methods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH']

  for (const method of methods) {
    const res = await app.handle(
      new Request('http://localhost/default', { method }),
    )
    expect(res.status).toBe(200)
    const result = await res.json()
    expect(result).toEqual({ method })
  }
})

test('this works to reference app in handler', async () => {
  const res = await new Spiceflow()
    .route({
      method: 'POST',
      path: '/another',
      handler() {
        return 'ok'
      },
    })
    .route({
      method: 'POST',
      path: '/href',
      handler() {
        return this.href('/another')
      },
    })
    .handle(new Request('http://localhost/href', { method: 'POST' }))
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual('/another')
})

test('routes works', async () => {
  const res = await new Spiceflow()
    .route({
      method: 'POST',
      path: '/xxx',
      handler: () => 'hi',
    })
    .handle(new Request('http://localhost/xxx', { method: 'POST' }))
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual('hi')
})

describe('cloneDeep', () => {
  test('works on promises', async () => {
    const obj = {
      promise: Promise.resolve({ value: 'hi' }),
    }
    const res = cloneDeep(obj)
    expect(res.promise).toBeInstanceOf(Promise)
    expect(await res.promise).toEqual({ value: 'hi' })
    // expect(await res.promise).not.toBe(await obj.promise)
    expect(res).toMatchInlineSnapshot(`
      {
        "promise": Promise {},
      }
    `)
  })
})

test('returns plain JSON for object responses', async () => {
  const app = new Spiceflow()
    .post('/json', () => {
      return {
        date: new Date('2025-01-20T18:01:57.852Z').toISOString(),
        name: 'test',
        count: 42,
      }
    })

  const res = await app.handle(
    new Request('http://localhost/json', { method: 'POST' }),
  )
  expect(res.status).toBe(200)
  expect(await res.json()).toMatchInlineSnapshot(`
    {
      "count": 42,
      "date": "2025-01-20T18:01:57.852Z",
      "name": "test",
    }
  `)
})

test('superjson via response helper and fetch client onResponse', async () => {
  const superjson = await import('superjson')

  function superjsonResponse(data: any): Response {
    const { json, meta } = superjson.default.serialize(data)
    if (meta) (json as any).__superjsonMeta = meta
    return new Response(JSON.stringify(json), {
      headers: { 'content-type': 'application/superjson' },
    })
  }

  const app = new Spiceflow().get('/date', () =>
    superjsonResponse({
      date: new Date('2025-01-20T18:01:57.852Z'),
      name: 'test',
    }),
  )

  const f = createSpiceflowFetch<typeof app>(app, {
    onResponse: async (response) => {
      if (!response.headers.get('content-type')?.includes('application/superjson')) {
        return undefined
      }
      const data = await response.json()
      if (!data?.__superjsonMeta) return data
      const { __superjsonMeta, ...rest } = data
      return superjson.default.deserialize({ json: rest, meta: __superjsonMeta })
    },
  })

  const result = await f('/date')
  expect((result as any).date).toBeInstanceOf(Date)
  expect(result).toEqual({
    date: new Date('2025-01-20T18:01:57.852Z'),
    name: 'test',
  })
})

test('dynamic route', async () => {
  const res = await new Spiceflow()
    .post('/ids/:id', () => 'hi')
    .handle(new Request('http://localhost/ids/xxx', { method: 'POST' }))
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual('hi')
})
test('handler returns url encoded data', async () => {
  const params = new URLSearchParams()
  params.append('name', 'test')
  params.append('value', '123')

  const res = await new Spiceflow()
    .post('/form', () => params, {
      type: 'application/x-www-form-urlencoded',
    })
    .handle(
      new Request('http://localhost/form', {
        method: 'POST',
      }),
    )

  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toBe(
    'application/x-www-form-urlencoded',
  )
  const text = await res.text()
  const responseParams = new URLSearchParams(text)
  expect(responseParams.get('name')).toBe('test')
  expect(responseParams.get('value')).toBe('123')
})
test('GET dynamic route', async () => {
  const res = await new Spiceflow()
    .get('/ids/:id', () => 'hi')
    .post('/ids/:id', ({ params: { id } }) => id)
    .handle(new Request('http://localhost/ids/xxx', { method: 'GET' }))
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual('hi')
})

test('onError does not fire on 404', async () => {
  let errorFired = false
  const app = new Spiceflow()
    .get('/test', () => 'Hello')
    .onError(() => {
      errorFired = true
      return new Response('Error', { status: 500 })
    })

  const res = await app.handle(
    new Request('http://localhost/non-existent', { method: 'GET' }),
  )

  expect(res.status).toBe(404)
  expect(errorFired).toBe(false)
  expect(await res.text()).toBe('Not Found')
})

test('onError fires on validation errors', async () => {
  let errorMessage = ''
  const app = new Spiceflow()
    .post(
      '/test',
      async ({ request }) => {
        await request.json()
        return 'Success'
      },
      {
        request: z.object({
          name: z.string(),
        }),
      },
    )
    .onError(({ error }) => {
      errorMessage = error.message
      return new Response('Error', { status: 400 })
    })

  const res = await app.handle(
    new Request('http://localhost/test', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 1 }), // Invalid type for 'name'
    }),
  )

  expect(res.status).toBe(400)
  expect(errorMessage).toMatchInlineSnapshot(
    `"name: Invalid input: expected string, received number"`,
  )
  expect(await res.text()).toMatchInlineSnapshot(`"Error"`)
})

test('onError reports the same Error only once', async () => {
  let errorCount = 0
  const app = new Spiceflow().onError(() => {
    errorCount++
  })
  const error = new Error('boom')
  const request = new Request('http://localhost/test')
  const runErrorHandlers = Reflect.get(app, 'runErrorHandlers')
  const onErrorHandlers = Reflect.get(app, 'onErrorHandlers')

  if (typeof runErrorHandlers !== 'function') {
    throw new Error('runErrorHandlers is unavailable')
  }
  if (!Array.isArray(onErrorHandlers)) {
    throw new Error('onErrorHandlers is unavailable')
  }

  await runErrorHandlers.call(app, {
    context: {},
    onErrorHandlers,
    error,
    request,
  })
  await runErrorHandlers.call(app, {
    context: {},
    onErrorHandlers,
    error,
    request,
  })

  expect(errorCount).toBe(1)
})

test('HEAD uses GET route metadata but does not add body', async () => {
  const app = new Spiceflow().get('/ids/:id', () => {
    return {
      message: 'hi',
      length: 10,
    }
  })

  const res = await app.handle(
    new Request('http://localhost/ids/xxx', { method: 'HEAD' }),
  )
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toBe('application/json')
  expect(await res.text()).toBe('')

  // Compare with GET to ensure HEAD is using GET route
  const getRes = await app.handle(
    new Request('http://localhost/ids/xxx', { method: 'GET' }),
  )
  expect(getRes.status).toBe(200)
  expect(await getRes.json()).toEqual({ message: 'hi', length: 10 })
})

test('HEAD keeps GET error status instead of forcing 200', async () => {
  const app = new Spiceflow()
    .get('/boom', () => {
      throw Object.assign(new Error('boom'), { status: 418 })
    })
    .onError(() => {})

  const res = await app.handle(
    new Request('http://localhost/boom', { method: 'HEAD' }),
  )

  expect(res.status).toBe(418)
  expect(await res.text()).toBe('')
})

test('GET with query, untyped', async () => {
  const res = await new Spiceflow()
    .get('/query', ({ query }) => {
      return query.id
    })
    .handle(new Request('http://localhost/query?id=hi', { method: 'GET' }))
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual('hi')
})

test('GET with query, zod, fails validation', async () => {
  const res = await new Spiceflow()
    .get(
      '/query',
      ({ query }) => {
        return query.id
      },
      {
        query: z.object({
          id: z.number(),
        }),
      },
    )
    .onError(() => {})
    .handle(new Request('http://localhost/query?id=hi', { method: 'GET' }))
  expect(res.status).toBe(422)
})

test('GET with query and zod', async () => {
  const res = await new Spiceflow()
    .get(
      '/query',
      ({ query }) => {
        return query.id
        // @ts-expect-error
        void query.sdfsd
      },
      {
        query: z.object({
          id: z.string(),
        }),
      },
    )
    .handle(new Request('http://localhost/query?id=hi', { method: 'GET' }))
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual('hi')
})

test('GET with repeated empty query values preserves all values', async () => {
  const res = await new Spiceflow()
    .get('/query', ({ query }) => query.tag)
    .handle(
      new Request('http://localhost/query?tag=&tag=two', { method: 'GET' }),
    )

  expect(res.status).toBe(200)
  expect(await res.json()).toEqual(['', 'two'])
})

test('query coercion: z.number() without z.coerce', async () => {
  const res = await new Spiceflow()
    .get('/query', ({ query }) => query, {
      query: z.object({
        page: z.number(),
      }),
    })
    .handle(new Request('http://localhost/query?page=42', { method: 'GET' }))
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ page: 42 })
})

test('query coercion: z.number().optional() without z.coerce', async () => {
  const res = await new Spiceflow()
    .get('/query', ({ query }) => query, {
      query: z.object({
        page: z.number().optional(),
      }),
    })
    .handle(new Request('http://localhost/query?page=7', { method: 'GET' }))
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ page: 7 })
})

test('query coercion: z.boolean()', async () => {
  const res = await new Spiceflow()
    .get('/query', ({ query }) => query, {
      query: z.object({
        active: z.boolean(),
      }),
    })
    .handle(
      new Request('http://localhost/query?active=true', { method: 'GET' }),
    )
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ active: true })
})

test('query coercion: z.array(z.string()) with single value', async () => {
  const res = await new Spiceflow()
    .get('/query', ({ query }) => query, {
      query: z.object({
        tag: z.array(z.string()),
      }),
    })
    .handle(
      new Request('http://localhost/query?tag=react', { method: 'GET' }),
    )
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ tag: ['react'] })
})

test('query coercion: z.array(z.string()) with multiple values', async () => {
  const res = await new Spiceflow()
    .get('/query', ({ query }) => query, {
      query: z.object({
        tag: z.array(z.string()),
      }),
    })
    .handle(
      new Request('http://localhost/query?tag=react&tag=typescript', {
        method: 'GET',
      }),
    )
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ tag: ['react', 'typescript'] })
})

test('query coercion: z.array(z.number()) coerces each item', async () => {
  const res = await new Spiceflow()
    .get('/query', ({ query }) => query, {
      query: z.object({
        ids: z.array(z.number()),
      }),
    })
    .handle(
      new Request('http://localhost/query?ids=1&ids=2&ids=3', {
        method: 'GET',
      }),
    )
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ ids: [1, 2, 3] })
})

test('query coercion: z.string() still works unchanged', async () => {
  const res = await new Spiceflow()
    .get('/query', ({ query }) => query, {
      query: z.object({
        name: z.string(),
      }),
    })
    .handle(
      new Request('http://localhost/query?name=hello', { method: 'GET' }),
    )
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ name: 'hello' })
})

test('query coercion: z.coerce.number() still works (regression)', async () => {
  const res = await new Spiceflow()
    .get('/query', ({ query }) => query, {
      query: z.object({
        page: z.coerce.number(),
      }),
    })
    .handle(new Request('http://localhost/query?page=5', { method: 'GET' }))
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ page: 5 })
})

test('query coercion: invalid number stays string and fails validation', async () => {
  const res = await new Spiceflow()
    .get('/query', ({ query }) => query, {
      query: z.object({
        page: z.number(),
      }),
    })
    .onError(() => {})
    .handle(
      new Request('http://localhost/query?page=abc', { method: 'GET' }),
    )
  expect(res.status).toBe(422)
})

test('query coercion: invalid boolean stays string and fails validation', async () => {
  const res = await new Spiceflow()
    .get('/query', ({ query }) => query, {
      query: z.object({
        active: z.boolean(),
      }),
    })
    .onError(() => {})
    .handle(
      new Request('http://localhost/query?active=yes', { method: 'GET' }),
    )
  expect(res.status).toBe(422)
})

test('query coercion: missing required query param fails validation', async () => {
  const res = await new Spiceflow()
    .get('/query', ({ query }) => query, {
      query: z.object({
        page: z.number(),
      }),
    })
    .onError(() => {})
    .handle(new Request('http://localhost/query', { method: 'GET' }))
  expect(res.status).toBe(422)
})

test('query coercion: repeated scalar key fails validation', async () => {
  const res = await new Spiceflow()
    .get('/query', ({ query }) => query, {
      query: z.object({
        id: z.string(),
      }),
    })
    .onError(() => {})
    .handle(
      new Request('http://localhost/query?id=a&id=b', { method: 'GET' }),
    )
  expect(res.status).toBe(422)
})

test('query coercion: z.number().nullable() coerces number', async () => {
  const res = await new Spiceflow()
    .get('/query', ({ query }) => query, {
      query: z.object({
        page: z.number().nullable(),
      }),
    })
    .handle(new Request('http://localhost/query?page=3', { method: 'GET' }))
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ page: 3 })
})

test('query type safety: handler query is typed from schema', async () => {
  new Spiceflow().get(
    '/q',
    ({ query }) => {
      // number fields are typed as number
      const page: number = query.page
      // string fields are typed as string
      const name: string = query.name
      // optional fields are typed as optional
      const limit: number | undefined = query.limit
      // @ts-expect-error - unknown key
      void query.unknown
      // @ts-expect-error - page is number, not string
      const bad: string = query.page
      void page
      void name
      void limit
      void bad
    },
    {
      query: z.object({
        page: z.number(),
        name: z.string(),
        limit: z.number().optional(),
      }),
    },
  )
})

test('query type safety: array fields are typed as arrays', async () => {
  new Spiceflow().get(
    '/q',
    ({ query }) => {
      const tags: string[] = query.tags
      const ids: number[] = query.ids
      // @ts-expect-error - tags is string[], not string
      const bad: string = query.tags
      void tags
      void ids
      void bad
    },
    {
      query: z.object({
        tags: z.array(z.string()),
        ids: z.array(z.number()),
      }),
    },
  )
})

test('query type safety: route object API query is typed', async () => {
  new Spiceflow().route({
    method: 'GET',
    path: '/q',
    query: z.object({
      q: z.string(),
      page: z.number().optional(),
      active: z.boolean(),
    }),
    handler({ query }) {
      const q: string = query.q
      const page: number | undefined = query.page
      const active: boolean = query.active
      // @ts-expect-error - unknown key
      void query.missing
      void q
      void page
      void active
    },
  })
})

test('query type safety: page object API query is typed', async () => {
  new Spiceflow().page({
    path: '/search',
    query: z.object({
      q: z.string(),
      sort: z.enum(['date', 'name']).optional(),
    }),
    handler: async ({ query }) => {
      const q: string = query.q
      const sort: 'date' | 'name' | undefined = query.sort
      // @ts-expect-error - unknown key
      void query.missing
      void q
      void sort
      return null
    },
  })
})

test('API route with required query DOES error at runtime when params missing', async () => {
  const app = new Spiceflow().get(
    '/api/search',
    ({ query }) => ({ q: query.q }),
    { query: z.object({ q: z.string() }) },
  )

  // Missing required query — API routes should return 422
  const res = await app.handle(new Request('http://localhost/api/search'))
  expect(res.status).toBe(422)

  // With valid query — works fine
  const res2 = await app.handle(
    new Request('http://localhost/api/search?q=hello'),
  )
  expect(res2.status).toBe(200)
  expect(await res2.json()).toEqual({ q: 'hello' })
})

test('GET dynamic route, params are typed', async () => {
  const res = await new Spiceflow()
    .get('/ids/:id', ({ params }) => {
      let id = params.id
      // @ts-expect-error
      params.sdfsd
      return id
    })
    .handle(new Request('http://localhost/ids/hi', { method: 'GET' }))
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual('hi')
})

test('GET wildcard path param is typed as optional', async () => {
  const res = await new Spiceflow()
    .get('/files/*', ({ params }) => {
      // @ts-expect-error
      params['*'].toUpperCase()
      return params['*'] ?? 'none'
    })
    .handle(
      new Request('http://localhost/files/path/to/file.txt', { method: 'GET' }),
    )

  expect(res.status).toBe(200)
  expect(await res.json()).toEqual('path/to/file.txt')
})

test('URL-encoded named params are decoded', async () => {
  const app = new Spiceflow().get('/users/:name', ({ params }) => {
    return params.name
  })

  const res = await app.handle(
    new Request('http://localhost/users/hello%20world', { method: 'GET' }),
  )
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual('hello world')
})

test('URL-encoded wildcard param is decoded', async () => {
  const app = new Spiceflow().get('/files/*', ({ params }) => {
    return params['*']
  })

  const res = await app.handle(
    new Request('http://localhost/files/my%20doc/file%20name.txt', {
      method: 'GET',
    }),
  )
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual('my doc/file name.txt')
})

test('malformed percent encoding in params passes through unchanged', async () => {
  const app = new Spiceflow().get('/users/:name', ({ params }) => {
    return params.name
  })

  const res = await app.handle(
    new Request('http://localhost/users/bad%ZZvalue', { method: 'GET' }),
  )
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual('bad%ZZvalue')
})

test('malformed percent encoding in wildcard params passes through unchanged', async () => {
  const app = new Spiceflow().get('/files/*', ({ params }) => params['*'])

  const res = await app.handle(
    new Request('http://localhost/files/bad%ZZvalue/file.txt'),
  )
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual('bad%ZZvalue/file.txt')
})

test('encoded percent values are only decoded once', async () => {
  const app = new Spiceflow().get('/users/:name', ({ params }) => params.name)

  const res = await app.handle(new Request('http://localhost/users/%2520'))
  expect(await res.json()).toEqual('%20')
})

test('GET trailing optional path param is typed as optional', async () => {
  const res = await new Spiceflow()
    .get('/users/:id?', ({ params }) => {
      // @ts-expect-error
      params.id.toUpperCase()
      return params.id ?? 'none'
    })
    .handle(new Request('http://localhost/users/123', { method: 'GET' }))

  expect(res.status).toBe(200)
  expect(await res.json()).toEqual('123')
})

test('GET non-trailing ? stays in the param key type', async () => {
  const res = await new Spiceflow()
    .get('/users/:id?/details', ({ params }) => {
      // @ts-expect-error
      params.id
      return params['id?']
    })
    .handle(
      new Request('http://localhost/users/123/details', { method: 'GET' }),
    )

  expect(res.status).toBe(200)
  expect(await res.json()).toEqual('123')
})

test('GET dynamic route with .route(), params are typed', async () => {
  const res = await new Spiceflow()
    .route({
      handler: ({ params }) => {
        let id = params.id
        // @ts-expect-error
        params.sdfsd
        return id
      },
      method: 'GET',
      path: '/ids/:id',
    })
    .handle(new Request('http://localhost/ids/hi', { method: 'GET' }))
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual('hi')
})

test('GET dynamic route, params are typed with schema', async () => {
  const res = await new Spiceflow()
    .get('/ids/:id', ({ params }) => {
      let id = params.id
      // @ts-expect-error
      params.sdfsd
      return id
    })
    .handle(new Request('http://localhost/ids/hi', { method: 'GET' }))
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual('hi')
})
test('GET route with param and wildcard, both are captured', async () => {
  const res = await new Spiceflow()
    .state('id', '')
    .use(({ state }) => {
      state.id = '123'
    })
    .onError(({ error }) => {
      expect(error).toBe(undefined)
      throw error
      // return new Response('root', { status: 500 })
    })
    .get('/files/:id/*', ({ params, state }) => {
      expect(params.id).toBe('123')
      expect(state.id).toBe('123')
      // expect(params['*']).toBe('path/to/file.txt')
      expect(params).toMatchInlineSnapshot(`
        {
          "*": "path/to/file.txt",
          "id": "123",
        }
      `)
      return params
    })
    .handle(
      new Request('http://localhost/files/123/path/to/file.txt', {
        method: 'GET',
      }),
    )
  expect(res.status).toBe(200)
  expect(await res.json()).toMatchInlineSnapshot(
    {
      id: '123',
      '*': 'path/to/file.txt',
    },
    `
    {
      "*": "path/to/file.txt",
      "id": "123",
    }
  `,
  )
})

test('extractWildcardParam correctly extracts wildcard segments', () => {
  expect(extractWildcardParam('/files/123/path/to/file.txt', '/files/:id/*'))
    .toMatchInlineSnapshot(`
    {
      "*": "path/to/file.txt",
    }
  `)

  expect(extractWildcardParam('/files/path/to/file.txt', '/files/*'))
    .toMatchInlineSnapshot(`
    {
      "*": "path/to/file.txt",
    }
  `)

  expect(
    extractWildcardParam('/files/123', '/files/:id'),
  ).toMatchInlineSnapshot('null')

  expect(
    extractWildcardParam('/files/123/', '/files/:id/*'),
  ).toMatchInlineSnapshot(`null`)

  expect(extractWildcardParam('/files/123/deep/path/', '/files/:id/*/'))
    .toMatchInlineSnapshot(`
    {
      "*": "deep/path",
    }
  `)

  expect(extractWildcardParam('/files/123/path/to/file.txt', '/files/:id/*'))
    .toMatchInlineSnapshot(`
    {
      "*": "path/to/file.txt",
    }
  `)

  expect(extractWildcardParam('/files/123/path/to/file.txt', '/files/:id/*'))
    .toMatchInlineSnapshot(`
    {
      "*": "path/to/file.txt",
    }
  `)
})

test('extractWildcardParam only captures the middle wildcard segment', () => {
  expect(extractWildcardParam('/layout/foo/page', '/layout/*/page'))
    .toMatchInlineSnapshot(`
    {
      "*": "foo",
    }
  `)
})

test('specific wildcard route wins over root catch-all', async () => {
  const app = new Spiceflow()
    .get('/*', ({ params }) => ({ route: 'catch-all', params }))
    .get('/files/:id/*', ({ params }) => ({ route: 'file', params }))

  const res = await app.handle(
    new Request('http://localhost/files/123/path/to/file.txt', {
      method: 'GET',
    }),
  )

  expect(res.status).toBe(200)
  expect(await res.json()).toMatchInlineSnapshot(`
    {
      "params": {
        "*": "path/to/file.txt",
        "id": "123",
      },
      "route": "file",
    }
  `)
})

test('named wildcard *filePath does NOT work, use bare * instead', async () => {
  // Frameworks like Express support *filePath as a named wildcard param,
  // but spiceflow's trie router only recognizes bare `*`. Using `*filePath`
  // makes the segment a literal string match, so the route never matches.
  const app = new Spiceflow().get('/files/*filePath', ({ params }) => {
    return params
  })

  const res = await app.handle(
    new Request('http://localhost/files/path/to/file.txt'),
  )
  // Route does not match — returns 404
  expect(res.status).toBe(404)
})

test('regex constrained route is more specific than a generic param route', async () => {
  const app = new Spiceflow()
    .get('/:id{[0-9]+}', () => 'digits')
    .get('/:id', () => 'generic')

  const res = await app.handle(new Request('http://localhost/123'))

  expect(res.status).toBe(200)
  expect(await res.json()).toBe('digits')
})



test('api routes can set response headers through context.response', async () => {
  const app = new Spiceflow().get('/headers', ({ response }) => {
    response.headers.set('x-api-header', 'ok')
    response.headers.append('set-cookie', 'api-cookie=1; Path=/')
    return { ok: true }
  })

  const response = await app.handle(new Request('http://localhost/headers'))

  expect(response.headers.get('x-api-header')).toBe('ok')
  expect((await response.json())?.ok).toBe(true)
  const getSetCookie = Reflect.get(response.headers, 'getSetCookie')
  expect(getSetCookie?.call(response.headers)).toEqual(['api-cookie=1; Path=/'])
})

test('api routes can set response status through context.response', async () => {
  const app = new Spiceflow().get('/status', ({ response }) => {
    response.status = 201
    return { ok: true }
  })

  const response = await app.handle(new Request('http://localhost/status'))

  expect(response.status).toBe(201)
  expect(await response.json()).toEqual({ ok: true })
})

test('returned Response status takes precedence over context.response.status in api routes', async () => {
  const app = new Spiceflow().get('/response-wins', ({ response }) => {
    response.status = 418
    return new Response('accepted', { status: 202 })
  })

  const response = await app.handle(
    new Request('http://localhost/response-wins'),
  )

  expect(response.status).toBe(202)
  expect(await response.text()).toBe('accepted')
})

test('missing route is not found', async () => {
  const res = await new Spiceflow()
    .get('/ids/:id', () => 'hi')
    .handle(new Request('http://localhost/zxxx', { method: 'GET' }))
  expect(res.status).toBe(404)
})



test('state works', async () => {
  const res = await new Spiceflow()
    .state('id', '')
    .use(({ state, request }) => {
      state.id = 'xxx'
    })
    .get('/get', ({ state: state }) => {
      expect(state.id).toBe('xxx')
    })
    .handle(new Request('http://localhost/get'))
  expect(res.status).toBe(200)
})

test('body is parsed as json', async () => {
  let body
  const res = await new Spiceflow()
    .state('id', '')

    .post('/post', async (c) => {
      body = await c.request.json()
      // console.log({request})
      return body
    })
    .handle(
      new Request('http://localhost/post', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({ name: 'John' }),
      }),
    )
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ name: 'John' })
})

test('validate body works, request success', async () => {
  const res = await new Spiceflow()

    .post(
      '/post',
      async ({ request }) => {
        // console.log({request})
        let body = await request.json()
        expect(body).toEqual({ name: 'John' })
        return 'ok'
      },
      {
        request: z.object({
          name: z.string(),
        }),
      },
    )
    .handle(
      new Request('http://localhost/post', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({ name: 'John' }),
      }),
    )
  expect(res.status).toBe(200)
  expect(await res.text()).toMatchInlineSnapshot(`""ok""`)
})

test('validate body works, request fails', async () => {
  const res = await new Spiceflow()
    .post(
      '/post',
      async ({ request, redirect }) => {
        // console.log({request})
        let body = await request.json()
        expect(body).toEqual({ name: 'John' })
      },
      {
        request: z.object({
          name: z.string(),
          requiredField: z.string(),
        }),
      },
    )
    .onError(() => {})
    .handle(
      new Request('http://localhost/post', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({ name: 'John' }),
      }),
    )
  await expectJsonErrorResponse({
    response: res,
    status: 422,
    message: 'requiredField: Invalid input: expected string, received undefined',
    extra: {
      code: 'VALIDATION',
      status: 422,
    },
  })
})

test('run use', async () => {
  const res = await new Spiceflow()
    .use(({ request }) => {
      expect(request.method).toBe('HEAD')
      return new Response('ok', { status: 401 })
    })
    .use(({ request }) => {
      expect(request.method).toBe('HEAD')
      return 'second one'
    })
    .head('/ids/:id', () => 'hi')
    .handle(new Request('http://localhost/ids/zxxx', { method: 'HEAD' }))
  expect(res.status).toBe(401)
  expect(await res.text()).toBe('')
})

test('run use', async () => {
  const res = await new Spiceflow()
    .use(({ request }) => {
      expect(request.method).toBe('HEAD')
      return new Response('ok', { status: 401 })
    })
    .use(({ request }) => {
      expect(request.method).toBe('HEAD')
      return 'second one'
    })
    .head('/ids/:id', () => 'hi')
    .handle(new Request('http://localhost/ids/zxxx', { method: 'HEAD' }))
  expect(res.status).toBe(401)
  expect(await res.text()).toBe('')
})

test('basPath works', async () => {
  const res = await new Spiceflow({ basePath: '/one' })
    .get('/ids/:id', () => 'hi')
    .handle(new Request('http://localhost/one/ids/xxx', { method: 'GET' }))
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual('hi')
})

test('basPath works with use', async () => {
  let app = new Spiceflow({ basePath: '/one' }).use(
    new Spiceflow({})
      .get('/two', () => 'hi')
      .use(new Spiceflow({ basePath: '/three' }).get('/four', () => 'hi')),
  )
  {
    const res = await app.handle(
      new Request('http://localhost/one/two', { method: 'GET' }),
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual('hi')
  }
  {
    const res = await app.handle(
      new Request('http://localhost/one/three/four', { method: 'GET' }),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual('hi')
  }
})

test('getRouteAndParents', async () => {
  let app = new Spiceflow({ basePath: '/one' })
    .get('/ids/:id', () => 'hi')
    .use(
      new Spiceflow({ basePath: '/two' }).use(
        new Spiceflow({ basePath: '/three' }).get('/four', () => 'hi'),
      ),
    )

  let routers = bfs(app)
  let last = routers[routers.length - 1]

  expect(app['getAppAndParents'](last).map((x) => x.basePath))
    .toMatchInlineSnapshot(`
			[
			  "/one",
			  "/two",
			  "/three",
			]
		`)
})

test('getAppsInScope include all parent apps', async () => {
  let app = new Spiceflow({ basePath: '/one' })
    .get('/ids/:id', () => 'hi')
    .use(
      new Spiceflow({ basePath: '/two' }).use(
        new Spiceflow({ basePath: '/three' }).use(
          new Spiceflow({ basePath: '/four' })
            .get('/five', () => 'hi')
            .use(({ request }) => {}),
        ),
      ),
    )

  let routers = bfs(app)
  let secondLast = routers[routers.length - 2]

  expect(app['getAppsInScope'](secondLast).map((x) => x.basePath))
    .toMatchInlineSnapshot(`
			[
			  "/one",
			  "/two",
			  "/three",
			]
		`)
})

test('getAppsInScope include all parent apps and non scoped apps', async () => {
  let app = new Spiceflow({ basePath: '/one' })
    .get('/ids/:id', () => 'hi')
    .use(
      new Spiceflow({ basePath: '/two' }).use(
        new Spiceflow({ basePath: '/three' }).use(
          new Spiceflow({ basePath: '/four', scoped: false })
            .get('/five', () => 'hi')
            .use(({ request }) => {}),
        ),
      ),
    )

  let routers = bfs(app)
  let secondLast = routers[routers.length - 2]

  expect(app['getAppsInScope'](secondLast).map((x) => x.basePath))
    .toMatchInlineSnapshot(`
			[
			  "/one",
			  "/two",
			  "/three",
			  "/four",
			]
		`)
})

test('use with 2 basPath works', async () => {
  let oneOnReq = false
  let twoOnReq = false
  let onReqCalled: string[] = []
  const app = await new Spiceflow()
    .use(({ request }) => {
      onReqCalled.push('root')
    })
    .use(
      new Spiceflow({ basePath: '/one' })

        .use(({ request }) => {
          oneOnReq = true
          onReqCalled.push('one')
        })
        .get('/ids/:id', ({ params }) => params.id),
    )
    .use(
      new Spiceflow({ basePath: '/two' })
        .use((c) => {
          twoOnReq = true
          onReqCalled.push('two')
        })
        .get('/ids/:id', ({ params }) => params.id, {}),
    )

  {
    const res = await app.handle(new Request('http://localhost/one/ids/one'))
    expect(res.status).toBe(200)

    expect(await res.json()).toEqual('one')
  }
  expect(onReqCalled).toEqual(['root', 'one'])
  {
    const res = await app.handle(new Request('http://localhost/two/ids/two'))
    expect(res.status).toBe(200)

    expect(await res.json()).toEqual('two')
  }
  expect(oneOnReq).toBe(true)
  expect(twoOnReq).toBe(true)
})

test('use with nested basPath works', async () => {
  const app = await new Spiceflow({ basePath: '/zero' })
    .use(
      new Spiceflow({ basePath: '/one' }).get(
        '/ids/:id',
        ({ params }) => params.id,
      ),
    )
    .use(
      new Spiceflow({ basePath: '/two' }).use(
        new Spiceflow({ basePath: '/nested' }).get(
          '/ids/:id',
          ({ params }) => params.id,
        ),
      ),
    )
  {
    const res = await app.handle(
      new Request('http://localhost/zero/one/ids/one'),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual('one')
  }

  {
    const res = await app.handle(
      new Request('http://localhost/zero/two/nested/ids/nested'),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual('nested')
  }
})

test('does not append subapp basePath if it is the same as parent app', async () => {
  const app = new Spiceflow({ basePath: '/api' })
    .use(new Spiceflow({ basePath: '/api' }).get('/users', () => 'users'))
    .use(
      new Spiceflow({ basePath: '/api' }).use(
        new Spiceflow({ basePath: '/v1' }).get('/posts', () => 'posts'),
      ),
    )

  // Test that /api/users works (not /api/api/users)
  {
    const res = await app.handle(
      new Request('http://localhost/api/users', { method: 'GET' }),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual('users')
  }

  // Test that /api/v1/posts works (not /api/api/v1/posts)
  {
    const res = await app.handle(
      new Request('http://localhost/api/v1/posts', { method: 'GET' }),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual('posts')
  }

  // Test that getAllRoutes() doesn't contain duplicate basePaths
  const allRoutes = app.getAllRoutes()
  expect(allRoutes.map((route) => route.path)).toMatchInlineSnapshot(`
    [
      "/api/users",
      "/api/v1/posts",
    ]
  `)
})

test('does not append subapp basePath if parent is prefix of subapp path', async () => {
  const app = new Spiceflow({ basePath: '/api' })
    .use(new Spiceflow({ basePath: '/api/sub' }).get('/users', () => 'users'))
    .use(
      new Spiceflow({ basePath: '/api' }).use(
        new Spiceflow({ basePath: '/api/v2' }).get('/posts', () => 'posts'),
      ),
    )

  // Test that /api/sub/users works (not /api/api/sub/users)
  {
    const res = await app.handle(
      new Request('http://localhost/api/sub/users', { method: 'GET' }),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual('users')
  }

  // Test that /api/v2/posts works (not /api/api/v2/posts)
  {
    const res = await app.handle(
      new Request('http://localhost/api/v2/posts', { method: 'GET' }),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual('posts')
  }

  // Test that getAllRoutes() contains the correct paths
  const allRoutes = app.getAllRoutes()
  expect(allRoutes.map((route) => route.path)).toMatchInlineSnapshot(`
    [
      "/api/sub/users",
      "/api/v2/posts",
    ]
  `)
})

test('errors inside basPath works', async () => {
  let onErrorTriggered: string[] = []
  let onReqTriggered: string[] = []
  let handlerCalledNTimes = 0
  const app = await new Spiceflow({ basePath: '/zero' })
    .onError(({ error }) => {
      onErrorTriggered.push('root')
      // return new Response('root', { status: 500 })
    })
    .use(({ request }) => {
      onReqTriggered.push('root')
      // return new Response('root', { status: 500 })
    })

    .use(
      new Spiceflow({ basePath: '/two' })
        .onError(({ error }) => {
          onErrorTriggered.push('two')
          // return new Response('two', { status: 500 })
        })
        .use(({ request }) => {
          onReqTriggered.push('two')
          // return new Response('two', { status: 500 })
        })
        .use(
          new Spiceflow({ basePath: '/nested' })
            .onError(({ error }) => {
              onErrorTriggered.push('nested')
              // return new Response('nested', { status: 500 })
            })
            .use(({ request }) => {
              onReqTriggered.push('nested')
              // return new Response('nested', { status: 500 })
            })
            .get('/ids/:id', ({ params }) => {
              handlerCalledNTimes++
              throw new Error('error message')
            }),
        ),
    )

  {
    const res = await app.handle(
      new Request('http://localhost/zero/two/nested/ids/nested'),
    )
    expect(handlerCalledNTimes).toBe(1)
    expect(onErrorTriggered).toEqual(['root', 'two', 'nested'])
    expect(onReqTriggered).toEqual(['root', 'two', 'nested'])
    await expectJsonErrorResponse({
      response: res,
      status: 500,
      message: 'error message',
    })
    // expect(await res.json()).toEqual('nested'))
  }
})

test('basepath with root route', async () => {
  let handlerCalled = false
  const app = new Spiceflow({ basePath: '/api' }).get('/', ({ request }) => {
    handlerCalled = true
    return new Response('Root route of API')
  })

  const res = await app.handle(new Request('http://localhost/api'))
  expect(handlerCalled).toBe(true)
  expect(res.status).toBe(200)
  expect(await res.text()).toBe('Root route of API')

  // Test that non-root paths are not matched
  handlerCalled = false
  const res2 = await app.handle(new Request('http://localhost/api/other'))
  expect(handlerCalled).toBe(false)
  expect(res2.status).toBe(404)
})

describe('Trailing slashes and base paths', () => {
  test('App without trailing slash, request with trailing slash', async () => {
    const app = new Spiceflow({ basePath: '/api' }).get(
      '/users',
      () => new Response('Users list'),
    )

    const res = await app.handle(new Request('http://localhost/api/users/'))
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('Users list')
  })

  test('App with trailing slash, request without trailing slash', async () => {
    const app = new Spiceflow({ basePath: '/api/' }).get(
      '/users/',
      () => new Response('Users list'),
    )

    const res = await app.handle(new Request('http://localhost/api/users'))
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('Users list')
  })

  test('Nested routes with and without trailing slashes', async () => {
    const app = new Spiceflow({ basePath: '/api' }).use(
      new Spiceflow()
        .get('/products', () => new Response('Products list'))
        .get('/categories/', () => new Response('Categories list')),
    )

    const resProducts = await app.handle(
      new Request('http://localhost/api/products/'),
    )
    expect(resProducts.status).toBe(200)
    expect(await resProducts.text()).toBe('Products list')

    const resCategories = await app.handle(
      new Request('http://localhost/api/categories'),
    )
    expect(resCategories.status).toBe(200)
    expect(await resCategories.text()).toBe('Categories list')
  })
})

test('async generators handle non-ASCII characters correctly', async () => {
  const app = new Spiceflow()
    .get('/cyrillic', async function* () {
      yield 'Привет' // Hello in Russian
      yield 'Κόσμος' // World in Greek
    })
    .get('/mixed-scripts', async function* () {
      // Mix of Cyrillic and Greek letters that look like Latin
      yield { text: 'РΡ' } // Cyrillic and Greek P
      yield { text: 'ΟО' } // Greek and Cyrillic O
      yield { text: 'КΚ' } // Cyrillic and Greek K
    })

  const f = createSpiceflowFetch(app)

  const cyrillicData = await f('/cyrillic') as AsyncIterable<any>
  let cyrillicText = ''
  for await (const chunk of cyrillicData) {
    cyrillicText += chunk
  }
  expect(cyrillicText).toBe('ПриветΚόσμος')

  const mixedData = await f('/mixed-scripts') as AsyncIterable<any>
  const mixedResults: unknown[] = []
  for await (const chunk of mixedData) {
    mixedResults.push(chunk)
  }
  expect(mixedResults).toEqual([{ text: 'РΡ' }, { text: 'ΟО' }, { text: 'КΚ' }])
})

test('can pass additional props to request schema', async () => {
  const app = new Spiceflow().post('/user', ({ request }) => request.json(), {
    request: z
      .object({
        name: z.string(),
        age: z.number(),
        email: z.string().email(),
      })
      .passthrough(),
  })

  const res = await app.handle(
    new Request('http://localhost/user', {
      method: 'POST',

      body: JSON.stringify({
        name: 'John',
        age: 25,
        email: 'john@example.com',
        additionalProp: 'extra data',
      }),
    }),
  )

  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({
    name: 'John',
    age: 25,
    email: 'john@example.com',
    additionalProp: 'extra data',
  })
})

describe('href', () => {
  test('handles simple paths without parameters', () => {
    const app = new Spiceflow()
      .get('/users', () => 'users')
      .get('/posts', () => 'posts')
      .get('/posts/*', () => 'posts')

    expect(app.href('/users')).toBe('/users')
    expect(app.href('/posts')).toBe('/posts')
    // @ts-expect-error
    app.href('/posts/*')
    expect(app.href('/posts/*', { '*': 'some/key' })).toBe('/posts/some/key')
  })

  test('href with .route works for static and wildcard paths', () => {
    const app = new Spiceflow()
      .route({
        path: '/users',
        handler: () => 'users',
      })
      .route({
        method: 'POST',
        path: '/posts',
        handler: () => 'posts',
      })
      .route({
        method: 'GET',
        path: '/files/*',
        handler: () => 'files',
      })

    expect(app.href('/users')).toBe('/users')
    expect(app.href('/posts')).toBe('/posts')
    // @ts-expect-error
    app.href('/files/*')
    // @ts-expect-error
    app.href('/nonexistent', {})
    // @ts-expect-error
    app.href('/nonexistent')
    expect(app.href('/files/*', { '*': 'a/b.txt' })).toBe('/files/a/b.txt')
  })

  test('handles paths with required parameters', () => {
    const app = new Spiceflow()
      .get('/users/:id', ({ params }) => params.id)
      .get('/posts/:postId/comments/:commentId', ({ params }) => params)

    expect(app.href('/users/:id', { id: '123' })).toBe('/users/123')
    // @ts-expect-error - path prefix doesn't match any route
    app.href('/nonusers/:id', { id: '123' })
    // /users/:nonid matches the resolved template `/users/${string}` so it's accepted
    app.href('/users/:nonid', { nonid: '123' })
    expect(
      app.href('/posts/:postId/comments/:commentId', {
        postId: 'abc',
        commentId: '456',
      }),
    ).toBe('/posts/abc/comments/456')
  })

  test('handles numeric parameter values', () => {
    const app = new Spiceflow().get('/users/:id', ({ params }) => params.id)

    expect(app.href('/users/:id', { id: '123' })).toBe('/users/123')
    expect(app.href('/users/:id', { id: '0' })).toBe('/users/0')
  })

  test('handles empty parameters object', () => {
    const app = new Spiceflow().get('/static', () => 'static')

    expect(app.href('/static')).toBe('/static')
  })

  test('all HTTP methods are available in href', async () => {
    // Create app with all routes first so TypeScript knows about all paths
    const app = new Spiceflow()
      .get('/api/users', () => 'get users')
      .post('/api/users', () => 'create user')
      .put('/api/users/:id', () => 'update user')
      .patch('/api/users/:id', () => 'patch user')
      .delete('/api/users/:id', () => 'delete user')
      .head('/api/status', () => 'status')
      .options('/api/cors', () => 'cors')
      .route({
        method: 'GET',
        path: '/api/custom',
        handler: () => 'custom route',
      })

    // All routes should be accessible via href outside handlers
    expect(app.href('/api/users')).toBe('/api/users')
    expect(app.href('/api/users/:id', { id: '123' })).toBe('/api/users/123')
    expect(app.href('/api/status')).toBe('/api/status')
    expect(app.href('/api/cors')).toBe('/api/cors')
    expect(app.href('/api/custom')).toBe('/api/custom')

    // Test that href works inside a route handler by creating a separate test
    const testApp = new Spiceflow()
      .get('/target', () => 'target')
      .get('/source', function () {
        // Should be able to call href from inside handler
        return this.href('/target')
      })

    const res = await testApp.handle(
      new Request('http://localhost/source', { method: 'GET' }),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toBe('/target')
  })

  test('paths not in app cause TypeScript errors', () => {
    const app = new Spiceflow()
      .get('/api/users', () => 'users')
      .post('/api/posts', () => 'posts')
      .put('/api/settings/:id', () => 'settings')

    // Valid paths work
    expect(app.href('/api/users')).toBe('/api/users')
    expect(app.href('/api/posts')).toBe('/api/posts')
    expect(app.href('/api/settings/:id', { id: '1' })).toBe('/api/settings/1')

    // Invalid paths should cause TypeScript errors
    // @ts-expect-error - Path not defined in app
    app.href('/api/nonexistent')

    // @ts-expect-error - Path not defined in app
    app.href('/completely/different/path')

    // @ts-expect-error - Path not defined in app
    app.href('/api/users/invalid')

    // /api/settings/:wrongParam matches `/api/settings/${string}` so it's accepted
    app.href('/api/settings/:wrongParam', { wrongParam: '1' })
  })

  test('root "/" is always valid even when home route registers as ""', () => {
    const app = new Spiceflow()
      .page('', async () => 'home')
      .page('/login', async () => 'login')

    // '/' is always accepted as a valid href path
    expect(app.href('/')).toBe('/')

    // '' is normalized to '/' at runtime
    expect(app.href('')).toBe('/')

    // other paths still work
    expect(app.href('/login')).toBe('/login')

    // @ts-expect-error - invalid path still rejected
    app.href('/nonexistent')
  })

  test('buildHref normalizes empty string to /', () => {
    const { buildHref } = require('./react/loader-utils.ts')
    expect(buildHref('', undefined)).toBe('/')
    expect(buildHref('', {})).toBe('/')
    expect(buildHref('', { q: 'hello' })).toBe('/?q=hello')
    expect(buildHref('/about', undefined)).toBe('/about')
  })

  test('href works with all method shorthand functions', () => {
    const app = new Spiceflow()
      .get('/get-route', () => 'get')
      .post('/post-route', () => 'post')
      .put('/put-route', () => 'put')
      .patch('/patch-route', () => 'patch')
      .delete('/delete-route', () => 'delete')
      .head('/head-route', () => 'head')
      .options('/options-route', () => 'options')
      .all('/all-route', () => 'all')

    // All method shortcuts should make paths available in href
    expect(app.href('/get-route')).toBe('/get-route')
    expect(app.href('/post-route')).toBe('/post-route')
    expect(app.href('/put-route')).toBe('/put-route')
    expect(app.href('/patch-route')).toBe('/patch-route')
    expect(app.href('/delete-route')).toBe('/delete-route')
    expect(app.href('/head-route')).toBe('/head-route')
    expect(app.href('/options-route')).toBe('/options-route')
    expect(app.href('/all-route')).toBe('/all-route')

    // Invalid routes should fail
    // @ts-expect-error - Path not defined
    app.href('/invalid-route')
  })

  test('href works inside route handlers', async () => {
    const app = new Spiceflow()
      .get('/target', () => 'target reached')
      .post('/redirect-test', function () {
        // Should be able to reference other routes in the same app
        return this.href('/target')
      })

    const res = await app.handle(
      new Request('http://localhost/redirect-test', { method: 'POST' }),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toBe('/target')
  })

  test('href appends query params', () => {
    const app = new Spiceflow()
      .get('/search', () => 'results', {
        query: z.object({ q: z.string(), page: z.coerce.number() }),
      })
      .get('/users/:id', ({ params }) => params.id, {
        query: z.object({ fields: z.string() }),
      })

    expect(app.href('/search', { q: 'hello', page: 1 })).toBe(
      '/search?q=hello&page=1',
    )
    expect(app.href('/users/:id', { id: '42', fields: 'name' })).toBe(
      '/users/42?fields=name',
    )

    // @ts-expect-error - invalid query key 'invalid' not in schema
    app.href('/search', { invalid: 'x' })

    app.href('/users/:id', { id: '1', nonexistent: 'x', fields: 'name' })
  })

  test('href with query params and no path params', () => {
    const app = new Spiceflow().get('/items', () => 'items', {
      query: z.object({ sort: z.string(), limit: z.coerce.number() }),
    })

    expect(app.href('/items', { sort: 'date', limit: 10 })).toBe(
      '/items?sort=date&limit=10',
    )

    // @ts-expect-error - wrong query key
    app.href('/items', { order: 'asc' })
  })

  test('href without query still works for routes without query schema', () => {
    const app = new Spiceflow()
      .get('/simple', () => 'simple')
      .get('/with-optional-query', () => 'q', {
        query: z.object({ x: z.string().optional() }),
      })

    expect(app.href('/simple')).toBe('/simple')
    expect(app.href('/with-optional-query')).toBe('/with-optional-query')
  })

  test('href with .route and query', () => {
    const app = new Spiceflow().route({
      method: 'GET',
      path: '/api/search',
      query: z.object({ term: z.string() }),
      handler: () => 'search',
    })

    expect(app.href('/api/search', { term: 'test' })).toBe(
      '/api/search?term=test',
    )

    // @ts-expect-error - invalid query key for .route-based route
    app.href('/api/search', { wrong: 'x' })
  })

  test('href skips undefined/null query values', () => {
    const app = new Spiceflow().get('/filter', () => 'filter', {
      query: z.object({ a: z.string(), b: z.string().optional() }),
    })

    expect(app.href('/filter', { a: 'yes', b: undefined })).toBe(
      '/filter?a=yes',
    )
  })

  test('href query with basePath', () => {
    const app = new Spiceflow({ basePath: '/api' }).get(
      '/search',
      () => 'search',
      {
        query: z.object({ q: z.string() }),
      },
    )

    expect(app.href('/api/search', { q: 'hello' })).toBe('/api/search?q=hello')

    // @ts-expect-error - invalid query key with basePath
    app.href('/api/search', { wrong: 'x' })
  })

  test('href query with all HTTP method shorthands', () => {
    const app = new Spiceflow()
      .put('/put-q', () => 'put', {
        query: z.object({ x: z.string() }),
      })
      .patch('/patch-q', () => 'patch', {
        query: z.object({ y: z.coerce.number() }),
      })
      .delete('/del-q', () => 'del', {
        query: z.object({ confirm: z.boolean() }),
      })

    expect(app.href('/put-q', { x: 'val' })).toBe('/put-q?x=val')
    expect(app.href('/patch-q', { y: 5 })).toBe('/patch-q?y=5')
    expect(app.href('/del-q', { confirm: true })).toBe('/del-q?confirm=true')

    // @ts-expect-error - wrong query key on put
    app.href('/put-q', { wrong: 'x' })

    // @ts-expect-error - wrong query key on patch
    app.href('/patch-q', { wrong: 1 })

    // @ts-expect-error - wrong query key on delete
    app.href('/del-q', { wrong: true })
  })

  test('href routes without query schema accept arbitrary query at runtime', () => {
    const app = new Spiceflow().get('/no-schema', () => 'ok')

    expect(app.href('/no-schema', { anything: 'works' })).toBe(
      '/no-schema?anything=works',
    )
  })

  test('href works with .page() routes', () => {
    const app = new Spiceflow()
      .page('/', async () => 'Home')
      .page('/about', async () => 'About')
      .page('/users/:id', async ({ params }) => params.id)

    expect(app.href('/')).toBe('/')
    expect(app.href('/about')).toBe('/about')
    expect(app.href('/users/:id', { id: '42' })).toBe('/users/42')
    // @ts-expect-error - invalid path
    app.href('/nonexistent')
  })

  test('href works inside route handler via app closure, including later routes', async () => {
    const app = new Spiceflow()
      .get('/about', () => {
        return app.href('/users/:id', { id: '42' })
      })
      .get('/users/:id', ({ params }) => params.id)

    const res = await app.handle(new Request('http://localhost/about'))
    expect(await res.json()).toBe('/users/42')
  })

  test('href works inside route handler via this for earlier routes', async () => {
    const app = new Spiceflow()
      .get('/users/:id', ({ params }) => params.id)
      .get('/about', function () {
        return this.href('/users/:id', { id: '42' })
      })

    const res = await app.handle(new Request('http://localhost/about'))
    expect(await res.json()).toBe('/users/42')
  })

  test('href works with .staticPage() routes', () => {
    const app = new Spiceflow().staticPage('/docs').staticPage('/changelog')

    expect(app.href('/docs')).toBe('/docs')
    expect(app.href('/changelog')).toBe('/changelog')
    // @ts-expect-error - invalid path
    app.href('/nonexistent')
  })

  test('page() object API with query schema', () => {
    const app = new Spiceflow().page({
      path: '/search',
      query: z.object({ q: z.string(), page: z.number().optional() }),
      handler: async ({ query }) => {
        return `Results for: ${query.q}`
      },
    })

    expect(app.href('/search', { q: 'hello' })).toBe('/search?q=hello')
    expect(app.href('/search', { q: 'hello', page: 2 })).toBe(
      '/search?q=hello&page=2',
    )
    // @ts-expect-error - invalid query param
    app.href('/search', { wrong: 'x' })
  })

  test('page() object API with params and query', () => {
    const app = new Spiceflow().page({
      path: '/users/:id',
      query: z.object({ tab: z.string().optional() }),
      handler: async ({ params, query }) => {
        return `User ${params.id}, tab: ${query.tab}`
      },
    })

    expect(app.href('/users/:id', { id: '42' })).toBe('/users/42')
    expect(app.href('/users/:id', { id: '42', tab: 'profile' })).toBe(
      '/users/42?tab=profile',
    )
  })

  test('page() positional API still works without query', () => {
    const app = new Spiceflow().page('/about', async () => 'About')

    expect(app.href('/about')).toBe('/about')
  })

  test('staticPage() object API with query schema', () => {
    const app = new Spiceflow().staticPage({
      path: '/docs',
      query: z.object({ section: z.string().optional() }),
      handler: async ({ query }) => {
        return `Docs: ${query.section}`
      },
    })

    expect(app.href('/docs', { section: 'api' })).toBe('/docs?section=api')
    // @ts-expect-error - invalid query param
    app.href('/docs', { wrong: 'x' })
  })

  test('href requires required query params', () => {
    const app = new Spiceflow()
      .get('/search', () => 'results', {
        query: z.object({ q: z.string(), page: z.coerce.number() }),
      })
      .get('/filter', () => 'filtered', {
        query: z.object({ category: z.string(), limit: z.number().optional() }),
      })
      .get('/list', () => 'list', {
        query: z.object({ sort: z.string().optional() }),
      })
      .get('/plain', () => 'plain')

    // @ts-expect-error - /search requires { q, page }, missing both
    app.href('/search')

    // @ts-expect-error - /search requires { q, page }, missing page
    app.href('/search', { q: 'hello' })

    // valid: all required provided
    expect(app.href('/search', { q: 'hello', page: 1 })).toBe(
      '/search?q=hello&page=1',
    )

    // @ts-expect-error - /filter requires { category }
    app.href('/filter')

    // valid: required provided, optional omitted
    expect(app.href('/filter', { category: 'books' })).toBe(
      '/filter?category=books',
    )

    // valid: both provided
    expect(app.href('/filter', { category: 'books', limit: 10 })).toBe(
      '/filter?category=books&limit=10',
    )

    // /list has all optional query — no args required
    expect(app.href('/list')).toBe('/list')
    expect(app.href('/list', { sort: 'date' })).toBe('/list?sort=date')

    // /plain has no query schema — no args required
    expect(app.href('/plain')).toBe('/plain')
  })

  test('href requires required query for resolved dynamic paths', () => {
    const app = new Spiceflow()
      .get('/users/:id', ({ params }) => params.id, {
        query: z.object({ tab: z.string() }),
      })
      .get('/items/:itemId', () => 'item', {
        query: z.object({ expand: z.string().optional() }),
      })

    // Pattern path — query required alongside params
    expect(app.href('/users/:id', { id: '42', tab: 'profile' })).toBe(
      '/users/42?tab=profile',
    )

    // Resolved path `/users/123` — still requires query because the
    // matching pattern `/users/:id` has a required query schema.
    // @ts-expect-error - resolved path still needs required query
    app.href('/users/123')

    // valid: resolved path with query
    expect(app.href('/users/123', { tab: 'settings' })).toBe(
      '/users/123?tab=settings',
    )

    // Resolved path with all-optional query — no args required
    expect(app.href('/items/abc')).toBe('/items/abc')
    expect(app.href('/items/abc', { expand: 'details' })).toBe(
      '/items/abc?expand=details',
    )
  })

  test('href with wildcard page route accepts template literal with interpolated params', () => {
    const app = new Spiceflow()
      .page('/orgs/:orgId/*', async ({ params }) => `Org ${params.orgId}`)

    // Pattern-based call works
    expect(app.href('/orgs/:orgId/*', { orgId: 'abc', '*': 'projects' })).toBe(
      '/orgs/abc/projects',
    )

    // Template literal with interpolated param — should also work
    const orgId = 'abc'
    expect(app.href(`/orgs/${orgId}/projects`)).toBe('/orgs/abc/projects')
  })

  test('href with wildcard accepts various template literal paths', () => {
    const app = new Spiceflow()
      .get('/files/*', () => 'files')

    // Pattern call
    expect(app.href('/files/*', { '*': 'docs/readme.md' })).toBe(
      '/files/docs/readme.md',
    )

    // Template literal — resolved path without params
    expect(app.href(`/files/docs/readme.md`)).toBe('/files/docs/readme.md')

    // Template literal with slot
    const folder = 'docs'
    expect(app.href(`/files/${folder}/readme.md`)).toBe('/files/docs/readme.md')
  })

  test('href with nested layouts and wildcard pages', () => {
    const app = new Spiceflow()
      .layout('/*', ({ children }) => children)
      .layout('/orgs/:orgId/*', ({ children }) => children)
      .page('/orgs/:orgId/projects', async ({ params }) => `Projects for ${params.orgId}`)
      .page('/orgs/:orgId/projects/:projectId/*', async ({ params }) => `Project ${params.projectId}`)

    // Direct page paths work normally
    expect(app.href('/orgs/:orgId/projects', { orgId: 'acme' })).toBe(
      '/orgs/acme/projects',
    )
    expect(
      app.href('/orgs/:orgId/projects/:projectId/*', {
        orgId: 'acme',
        projectId: 'p1',
        '*': 'settings',
      }),
    ).toBe('/orgs/acme/projects/p1/settings')

    // Template literal with all params resolved
    const orgId = 'acme'
    const projectId = 'p1'
    expect(app.href(`/orgs/${orgId}/projects`)).toBe('/orgs/acme/projects')
    expect(app.href(`/orgs/${orgId}/projects/${projectId}/settings`)).toBe(
      '/orgs/acme/projects/p1/settings',
    )
  })

  test('href template literal type-checks against wildcard route patterns', () => {
    const app = new Spiceflow()
      .page('/orgs/:orgId/*', async ({ params }) => `Org ${params.orgId}`)
      .page('/users/:userId', async ({ params }) => `User ${params.userId}`)

    // These should be valid — they match /orgs/:orgId/* pattern
    const orgId = 'abc'
    app.href(`/orgs/${orgId}/anything/here`)

    // This should NOT match any route — /settings is not a registered path
    // @ts-expect-error - no route matches /settings/*
    app.href('/settings/foo')
  })
})



test('composition with .use() works with state and onError - child app gets same state, errors caught by root', async () => {
  let rootErrorCalled = false
  let childErrorCalled = false
  let errorMessage = ''

  const childApp = new Spiceflow()
    .state('counter', 0)
    .onError(({ error }) => {
      childErrorCalled = true
      return new Response('Child error<', { status: 500 })
    })
    .use(({ state }) => {
      state.counter += 10
    })
    .get('/success', ({ state }) => ({ counter: state.counter }))
    .get('/error', ({ state }) => {
      state.counter += 5
      throw new Error('Child error occurred')
    })

  const rootApp = new Spiceflow()
    .state('counter', 100)
    .onError(({ error }) => {
      rootErrorCalled = true
      errorMessage = error.message
      return new Response('Root error handler', { status: 400 })
    })
    .use(({ state }) => {
      state.counter += 1
    })
    .use(childApp)

  // State starts from root app (100), then root middleware (+1), then child middleware (+10)
  const successRes = await rootApp.handle(
    new Request('http://localhost/success', { method: 'GET' }),
  )
  expect(successRes.status).toBe(200)
  expect(await successRes.json()).toEqual({ counter: 111 }) // 100 + 1 + 10

  // Test error case - root onError should catch child errors
  const errorRes = await rootApp.handle(
    new Request('http://localhost/error', { method: 'GET' }),
  )
  expect(errorRes.status).toBe(400)
  expect(await errorRes.text()).toBe('Root error handler')
  expect(rootErrorCalled).toBe(true)
  expect(childErrorCalled).toBe(false) // Child error handler should not be called
  expect(errorMessage).toBe('Child error occurred')
})

test('onError receives path parameter', async () => {
  let capturedPath = ''
  let capturedError: any = null

  const app = new Spiceflow()
    .get('/test/path/:id', ({ params }) => {
      throw new Error('Test error')
    })
    .post('/another/route', () => {
      throw new Error('Another error')
    })
    .onError(({ error, path }) => {
      capturedPath = path
      capturedError = error
      return new Response('Error handled', { status: 500 })
    })

  // Test GET request
  const getRes = await app.handle(
    new Request('http://localhost/test/path/123?foo=bar', { method: 'GET' }),
  )
  expect(getRes.status).toBe(500)
  expect(capturedPath).toBe('/test/path/123?foo=bar')
  expect(capturedError.message).toBe('Test error')

  // Test POST request
  const postRes = await app.handle(
    new Request('http://localhost/another/route', { method: 'POST' }),
  )
  expect(postRes.status).toBe(500)
  expect(capturedPath).toBe('/another/route')
  expect(capturedError.message).toBe('Another error')
})

test('error status validation', async () => {
  // Test invalid status codes are normalized to 500
  const testCases = [
    { status: 'invalid', expected: 500 }, // non-number status
    { status: 99, expected: 500 }, // too low
    { status: 600, expected: 500 }, // too high
    { status: 404, expected: 404 }, // valid status
    { status: undefined, expected: 500 }, // undefined defaults to 500
  ]

  for (const { status, expected } of testCases) {
    const app = new Spiceflow()
      .get('/test', () => {
        const error: any = new Error('Test error')
        error.status = status
        throw error
      })
      .onError(() => {})

    const res = await app.handle(
      new Request('http://localhost/test', { method: 'GET' }),
    )
    expect(res.status).toBe(expected)
  }
})

test('error statusCode fallback', async () => {
  // Test that statusCode is used when status is not present
  const testCases = [
    { statusCode: 422, expected: 422 }, // valid statusCode
    { statusCode: 'invalid', expected: 500 }, // invalid statusCode
    { status: 400, statusCode: 422, expected: 400 }, // status takes precedence
  ]

  for (const { statusCode, expected, status } of testCases) {
    const app = new Spiceflow()
      .get('/test', () => {
        const error: any = new Error('Test error')
        if (status !== undefined) error.status = status
        if (statusCode !== undefined) error.statusCode = statusCode
        throw error
      })
      .onError(() => {})

    const res = await app.handle(
      new Request('http://localhost/test', { method: 'GET' }),
    )
    expect(res.status).toBe(expected)
  }
})

test('returning Error from handler behaves like throwing it', async () => {
  const app = new Spiceflow()
    .get('/test', () => {
      return new Error('something went wrong')
    })
    .onError(() => {})

  const res = await app.handle(
    new Request('http://localhost/test', { method: 'GET' }),
  )
  await expectJsonErrorResponse({
    response: res,
    status: 500,
    message: 'something went wrong',
  })
})

test('returning Error with status property uses that status', async () => {
  const app = new Spiceflow()
    .get('/test', () => {
      return Object.assign(new Error('bad request'), { status: 400 })
    })
    .onError(() => {})

  const res = await app.handle(
    new Request('http://localhost/test', { method: 'GET' }),
  )
  await expectJsonErrorResponse({
    response: res,
    status: 400,
    message: 'bad request',
    extra: { status: 400 },
  })
})

test('returning Error triggers onError handlers', async () => {
  let capturedError: any = null
  const app = new Spiceflow()
    .get('/test', () => {
      return Object.assign(new Error('oops'), { status: 422 })
    })
    .onError(({ error }) => {
      capturedError = error
      return new Response('handled', { status: 422 })
    })

  const res = await app.handle(
    new Request('http://localhost/test', { method: 'GET' }),
  )
  expect(res.status).toBe(422)
  expect(await res.text()).toBe('handled')
  expect(capturedError).toBeInstanceOf(Error)
  expect(capturedError.message).toBe('oops')
})

test('throwing Error from handler gives status 500 with message', async () => {
  const app = new Spiceflow()
    .get('/test', () => {
      throw new Error('something went wrong')
    })
    .onError(() => {})

  const res = await app.handle(
    new Request('http://localhost/test', { method: 'GET' }),
  )
  await expectJsonErrorResponse({
    response: res,
    status: 500,
    message: 'something went wrong',
  })
})

test('throwing Error with status property uses that status', async () => {
  const app = new Spiceflow()
    .get('/test', () => {
      throw Object.assign(new Error('bad request'), { status: 400 })
    })
    .onError(() => {})

  const res = await app.handle(
    new Request('http://localhost/test', { method: 'GET' }),
  )
  await expectJsonErrorResponse({
    response: res,
    status: 400,
    message: 'bad request',
    extra: { status: 400 },
  })
})

test('route override - same method and path, second route wins', async () => {
  const app = new Spiceflow()
    .get('/test', () => 'first handler')
    .get('/test', () => 'second handler')

  const res = await app.handle(
    new Request('http://localhost/test', { method: 'GET' }),
  )
  expect(res.status).toBe(200)
  expect(await res.json()).toMatchInlineSnapshot(`"second handler"`)
})

test('route override - different methods on same path work independently', async () => {
  const app = new Spiceflow()
    .get('/test', () => 'get handler')
    .post('/test', () => 'post handler')
    .get('/test', () => 'get override')

  const getRes = await app.handle(
    new Request('http://localhost/test', { method: 'GET' }),
  )
  expect(getRes.status).toBe(200)
  expect(await getRes.json()).toMatchInlineSnapshot(`"get override"`)

  const postRes = await app.handle(
    new Request('http://localhost/test', { method: 'POST' }),
  )
  expect(postRes.status).toBe(200)
  expect(await postRes.json()).toMatchInlineSnapshot(`"post handler"`)
})

test('route override with .use() - parent app routes take precedence over child app routes', async () => {
  const childApp = new Spiceflow()
    .get('/shared', () => 'child handler')
    .get('/child-only', () => 'child only')

  const parentApp = new Spiceflow()
    .get('/shared', () => 'parent handler')
    .get('/parent-only', () => 'parent only')
    .use(childApp)

  // Parent app route takes precedence over child app route
  const sharedRes = await parentApp.handle(
    new Request('http://localhost/shared', { method: 'GET' }),
  )
  expect(sharedRes.status).toBe(200)
  expect(await sharedRes.json()).toMatchInlineSnapshot(`"parent handler"`)

  // Parent-only route works as expected
  const parentOnlyRes = await parentApp.handle(
    new Request('http://localhost/parent-only', { method: 'GET' }),
  )
  expect(parentOnlyRes.status).toBe(200)
  expect(await parentOnlyRes.json()).toMatchInlineSnapshot(`"parent only"`)

  // Child-only route works as expected
  const childOnlyRes = await parentApp.handle(
    new Request('http://localhost/child-only', { method: 'GET' }),
  )
  expect(childOnlyRes.status).toBe(200)
  expect(await childOnlyRes.json()).toMatchInlineSnapshot(`"child only"`)
})

test('route override with .use() - parent app routes always win, regardless of order', async () => {
  const firstChildApp = new Spiceflow().get('/shared', () => 'first child')

  const secondChildApp = new Spiceflow().get('/shared', () => 'second child')

  const parentApp = new Spiceflow()
    .get('/shared', () => 'parent')
    .use(firstChildApp)
    .use(secondChildApp)

  // Parent route always wins, regardless of child apps
  const res = await parentApp.handle(
    new Request('http://localhost/shared', { method: 'GET' }),
  )
  expect(res.status).toBe(200)
  expect(await res.json()).toMatchInlineSnapshot(`"parent"`)
})

test('route override with nested .use() - first matching parent route wins', async () => {
  const deepestApp = new Spiceflow().get('/test', () => 'deepest')

  const middleApp = new Spiceflow().get('/test', () => 'middle').use(deepestApp)

  const rootApp = new Spiceflow().get('/test', () => 'root').use(middleApp)

  // Root app route wins over all nested routes
  const res = await rootApp.handle(
    new Request('http://localhost/test', { method: 'GET' }),
  )
  expect(res.status).toBe(200)
  expect(await res.json()).toMatchInlineSnapshot(`"root"`)
})

test('route override with .use() - child routes are accessible when no parent route exists', async () => {
  const firstChildApp = new Spiceflow().get(
    '/child1-route',
    () => 'first child',
  )

  const secondChildApp = new Spiceflow()
    .get('/child2-route', () => 'second child')
    .get('/shared-child', () => 'second child shared')

  const thirdChildApp = new Spiceflow().get(
    '/shared-child',
    () => 'third child shared',
  )

  const parentApp = new Spiceflow()
    .get('/parent-only', () => 'parent')
    .use(firstChildApp)
    .use(secondChildApp)
    .use(thirdChildApp)

  // First child route works
  const child1Res = await parentApp.handle(
    new Request('http://localhost/child1-route', { method: 'GET' }),
  )
  expect(child1Res.status).toBe(200)
  expect(await child1Res.json()).toMatchInlineSnapshot(`"first child"`)

  // Second child route works
  const child2Res = await parentApp.handle(
    new Request('http://localhost/child2-route', { method: 'GET' }),
  )
  expect(child2Res.status).toBe(200)
  expect(await child2Res.json()).toMatchInlineSnapshot(`"second child"`)

  // For conflicting child routes, first one wins (since no parent route exists)
  const sharedChildRes = await parentApp.handle(
    new Request('http://localhost/shared-child', { method: 'GET' }),
  )
  expect(sharedChildRes.status).toBe(200)
  expect(await sharedChildRes.json()).toMatchInlineSnapshot(
    `"second child shared"`,
  )
})

// Unlike Express/Hono where registration order alone determines priority,
// Spiceflow uses specificity-based ranking: a child's exact route beats a
// parent's wildcard even though the parent was registered first.
test('child app specific routes beat parent wildcard routes', async () => {
  const childApp = new Spiceflow()
    .get('/api/hello', () => 'child hello')
    .get('/api/shared', () => 'child shared')

  const app = new Spiceflow()
    .get('/*', () => 'catchall')
    .get('/api/shared', () => 'parent shared')
    .layout('/*', ({ children }) => children)
    .page('/', async () => 'Home')
    .use(childApp)

  // Child's specific route beats parent's wildcard
  const helloRes = await app.handle(
    new Request('http://localhost/api/hello', { method: 'GET' }),
  )
  expect(helloRes.status).toBe(200)
  expect(await helloRes.json()).toBe('child hello')

  // Parent's same-specificity route wins over child's (registration order)
  const sharedRes = await app.handle(
    new Request('http://localhost/api/shared', { method: 'GET' }),
  )
  expect(sharedRes.status).toBe(200)
  expect(await sharedRes.json()).toBe('parent shared')
})



test('/* as not-found handler - registered first', async () => {
  const app = new Spiceflow()
    // Register catch-all first
    .get('/*', () => ({ message: 'Not found', path: 'catch-all' }))
    // Then register specific routes
    .get('/', () => ({ message: 'Home' }))
    .get('/users', () => ({ message: 'Users list' }))
    .get('/users/:id', ({ params }) => ({ message: 'User', id: params.id }))
    .post('/api/data', () => ({ message: 'Data posted' }))

  // Specific routes should still work (not be caught by /*)
  const homeRes = await app.handle(
    new Request('http://localhost/', { method: 'GET' }),
  )
  expect(homeRes.status).toBe(200)
  expect(await homeRes.json()).toEqual({ message: 'Home' })

  const usersRes = await app.handle(
    new Request('http://localhost/users', { method: 'GET' }),
  )
  expect(usersRes.status).toBe(200)
  expect(await usersRes.json()).toEqual({ message: 'Users list' })

  const userRes = await app.handle(
    new Request('http://localhost/users/123', { method: 'GET' }),
  )
  expect(userRes.status).toBe(200)
  expect(await userRes.json()).toEqual({ message: 'User', id: '123' })

  const apiRes = await app.handle(
    new Request('http://localhost/api/data', { method: 'POST' }),
  )
  expect(apiRes.status).toBe(200)
  expect(await apiRes.json()).toEqual({ message: 'Data posted' })

  // Non-existent routes should be caught by /*
  const notFoundRes = await app.handle(
    new Request('http://localhost/non-existent', { method: 'GET' }),
  )
  expect(notFoundRes.status).toBe(200)
  expect(await notFoundRes.json()).toEqual({
    message: 'Not found',
    path: 'catch-all',
  })

  const deepNotFoundRes = await app.handle(
    new Request('http://localhost/some/deep/path', { method: 'GET' }),
  )
  expect(deepNotFoundRes.status).toBe(200)
  expect(await deepNotFoundRes.json()).toEqual({
    message: 'Not found',
    path: 'catch-all',
  })

  // Wrong method should still return 404 (not caught by GET /*)
  const wrongMethodRes = await app.handle(
    new Request('http://localhost/users', { method: 'DELETE' }),
  )
  expect(wrongMethodRes.status).toBe(404)
})

test('/* as not-found handler - registered last', async () => {
  const app = new Spiceflow()
    // Register specific routes first
    .get('/', () => ({ message: 'Home' }))
    .get('/users', () => ({ message: 'Users list' }))
    .get('/users/:id', ({ params }) => ({ message: 'User', id: params.id }))
    .post('/api/data', () => ({ message: 'Data posted' }))
    // Register catch-all last
    .get('/*', () => ({ message: 'Not found', path: 'catch-all' }))

  // Specific routes should still work
  const homeRes = await app.handle(
    new Request('http://localhost/', { method: 'GET' }),
  )
  expect(homeRes.status).toBe(200)
  expect(await homeRes.json()).toEqual({ message: 'Home' })

  const usersRes = await app.handle(
    new Request('http://localhost/users', { method: 'GET' }),
  )
  expect(usersRes.status).toBe(200)
  expect(await usersRes.json()).toEqual({ message: 'Users list' })

  const userRes = await app.handle(
    new Request('http://localhost/users/123', { method: 'GET' }),
  )
  expect(userRes.status).toBe(200)
  expect(await userRes.json()).toEqual({ message: 'User', id: '123' })

  // Non-existent routes should be caught by /*
  const notFoundRes = await app.handle(
    new Request('http://localhost/non-existent', { method: 'GET' }),
  )
  expect(notFoundRes.status).toBe(200)
  expect(await notFoundRes.json()).toEqual({
    message: 'Not found',
    path: 'catch-all',
  })

  const deepNotFoundRes = await app.handle(
    new Request('http://localhost/some/deep/path', { method: 'GET' }),
  )
  expect(deepNotFoundRes.status).toBe(200)
  expect(await deepNotFoundRes.json()).toEqual({
    message: 'Not found',
    path: 'catch-all',
  })
})

test('/* with all methods as not-found handler', async () => {
  const app = new Spiceflow()
    .get('/api/users', () => ({ message: 'GET users' }))
    .post('/api/users', () => ({ message: 'POST users' }))
    // Catch-all for any method and any path
    .all('/*', () => ({ message: 'Custom 404', method: 'any' }))

  // Specific routes work
  const getUsersRes = await app.handle(
    new Request('http://localhost/api/users', { method: 'GET' }),
  )
  expect(getUsersRes.status).toBe(200)
  expect(await getUsersRes.json()).toEqual({ message: 'GET users' })

  const postUsersRes = await app.handle(
    new Request('http://localhost/api/users', { method: 'POST' }),
  )
  expect(postUsersRes.status).toBe(200)
  expect(await postUsersRes.json()).toEqual({ message: 'POST users' })

  // Non-existent paths are caught
  const notFoundGetRes = await app.handle(
    new Request('http://localhost/not-found', { method: 'GET' }),
  )
  expect(notFoundGetRes.status).toBe(200)
  expect(await notFoundGetRes.json()).toEqual({
    message: 'Custom 404',
    method: 'any',
  })

  // Different methods on non-existent paths are also caught
  const notFoundPostRes = await app.handle(
    new Request('http://localhost/not-found', { method: 'POST' }),
  )
  expect(notFoundPostRes.status).toBe(200)
  expect(await notFoundPostRes.json()).toEqual({
    message: 'Custom 404',
    method: 'any',
  })

  const notFoundDeleteRes = await app.handle(
    new Request('http://localhost/not-found', { method: 'DELETE' }),
  )
  expect(notFoundDeleteRes.status).toBe(200)
  expect(await notFoundDeleteRes.json()).toEqual({
    message: 'Custom 404',
    method: 'any',
  })

  // With trie router, ALL /* catches any method on any path, including DELETE on /api/users
  const wrongMethodRes = await app.handle(
    new Request('http://localhost/api/users', { method: 'DELETE' }),
  )
  expect(wrongMethodRes.status).toBe(200)
  expect(await wrongMethodRes.json()).toEqual({
    message: 'Custom 404',
    method: 'any',
  })
})

test('/* priority - more specific routes always win', async () => {
  const app = new Spiceflow()
    .get('/*', () => 'catch-all')
    .get('/users/*', () => 'users-catch-all')
    .get('/users/special/*', () => 'special-users-catch-all')
    .get('/users/special/exact', () => 'exact-match')

  // Most specific route wins
  const exactRes = await app.handle(
    new Request('http://localhost/users/special/exact', { method: 'GET' }),
  )
  expect(exactRes.status).toBe(200)
  expect(await exactRes.json()).toBe('exact-match')

  // Next most specific catch-all wins
  const specialCatchRes = await app.handle(
    new Request('http://localhost/users/special/something', { method: 'GET' }),
  )
  expect(specialCatchRes.status).toBe(200)
  expect(await specialCatchRes.json()).toBe('special-users-catch-all')

  // Users catch-all for other users paths
  const usersCatchRes = await app.handle(
    new Request('http://localhost/users/other', { method: 'GET' }),
  )
  expect(usersCatchRes.status).toBe(200)
  expect(await usersCatchRes.json()).toBe('users-catch-all')

  // General catch-all for everything else
  const generalCatchRes = await app.handle(
    new Request('http://localhost/something-else', { method: 'GET' }),
  )
  expect(generalCatchRes.status).toBe(200)
  expect(await generalCatchRes.json()).toBe('catch-all')
})

test(':param beats wildcard regardless of registration order', async () => {
  // wildcard registered first
  const app1 = new Spiceflow()
    .get('/users/*', () => 'wildcard')
    .get('/users/:id', () => 'param')

  const res1 = await app1.handle(
    new Request('http://localhost/users/123', { method: 'GET' }),
  )
  expect(res1.status).toBe(200)
  expect(await res1.json()).toBe('param')

  // :param registered first
  const app2 = new Spiceflow()
    .get('/users/:id', () => 'param')
    .get('/users/*', () => 'wildcard')

  const res2 = await app2.handle(
    new Request('http://localhost/users/456', { method: 'GET' }),
  )
  expect(res2.status).toBe(200)
  expect(await res2.json()).toBe('param')
})

describe('path param edge cases with special characters', () => {
  // hono trie router does not support prefix matching — returns 404 instead
  test('prefix before param like /v/on-:event returns 404 on trie router', async () => {
    const app = new Spiceflow().route({
      method: 'GET',
      path: '/v/on-:event',
      handler: ({ params }) => params,
    })
    const res = await app.handle(
      new Request('http://localhost/v/on-click', { method: 'GET' }),
    )
    expect(res.status).toBe(404)
  })

  test('suffix after param like /v/:id.patch treats dot as part of param name', async () => {
    const app = new Spiceflow().route({
      method: 'GET',
      path: '/v/:id.patch',
      handler: ({ params }) => params,
    })
    // the param name becomes "id.patch", not "id" with suffix ".patch"
    const res = await app.handle(
      new Request('http://localhost/v/123', { method: 'GET' }),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchInlineSnapshot(`
      {
        "id.patch": "123",
      }
    `)
  })

  test('/v/:id.patch does NOT match /v/123.patch as id=123', async () => {
    const app = new Spiceflow().route({
      method: 'GET',
      path: '/v/:id.patch',
      handler: ({ params }) => params,
    })
    // requesting /v/123.patch — the param "id.patch" gets value "123.patch"
    const res = await app.handle(
      new Request('http://localhost/v/123.patch', { method: 'GET' }),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchInlineSnapshot(`
      {
        "id.patch": "123.patch",
      }
    `)
  })

  test('param with dash suffix like /v/:id-details treats dash as part of param name', async () => {
    const app = new Spiceflow().route({
      method: 'GET',
      path: '/v/:id-details',
      handler: ({ params }) => params,
    })
    const res = await app.handle(
      new Request('http://localhost/v/abc', { method: 'GET' }),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchInlineSnapshot(`
      {
        "id-details": "abc",
      }
    `)
  })

  test('param with underscore suffix like /v/:id_info treats underscore as part of param name', async () => {
    const app = new Spiceflow().route({
      method: 'GET',
      path: '/v/:id_info',
      handler: ({ params }) => params,
    })
    const res = await app.handle(
      new Request('http://localhost/v/xyz', { method: 'GET' }),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchInlineSnapshot(`
      {
        "id_info": "xyz",
      }
    `)
  })

  test('param with colon-like path /v/:id:format treats entire thing as one param', async () => {
    const app = new Spiceflow().route({
      method: 'GET',
      path: '/v/:id:format',
      handler: ({ params }) => params,
    })
    const res = await app.handle(
      new Request('http://localhost/v/test', { method: 'GET' }),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    // second colon is part of the param name since @medley/router splits on / or $
    expect(body).toMatchInlineSnapshot(`
      {
        "id:format": "test",
      }
    `)
  })

  // hono trie router does not support prefix matching — returns 404 instead
  test('multiple prefixed params in one segment like /v/pre-:a-mid-:b returns 404 on trie router', async () => {
    const app = new Spiceflow().route({
      method: 'GET',
      path: '/v/pre-:a-mid-:b',
      handler: ({ params }) => params,
    })
    const res = await app.handle(
      new Request('http://localhost/v/pre-hello-mid-world', { method: 'GET' }),
    )
    expect(res.status).toBe(404)
  })

  test('param with semicolon like /v/:id;type is one param name', async () => {
    const app = new Spiceflow().route({
      method: 'GET',
      path: '/v/:id;type',
      handler: ({ params }) => params,
    })
    const res = await app.handle(
      new Request('http://localhost/v/foo', { method: 'GET' }),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchInlineSnapshot(`
      {
        "id;type": "foo",
      }
    `)
  })

  test('param with comma like /v/:a,:b is one param name', async () => {
    const app = new Spiceflow().route({
      method: 'GET',
      path: '/v/:a,:b',
      handler: ({ params }) => params,
    })
    const res = await app.handle(
      new Request('http://localhost/v/hello', { method: 'GET' }),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchInlineSnapshot(`
      {
        "a,:b": "hello",
      }
    `)
  })

  // hono trie router does not support prefix matching — returns 404 instead
  test('version prefix like /api/v:version returns 404 on trie router', async () => {
    const app = new Spiceflow().route({
      method: 'GET',
      path: '/api/v:version',
      handler: ({ params }) => params,
    })
    const res = await app.handle(
      new Request('http://localhost/api/v2', { method: 'GET' }),
    )
    expect(res.status).toBe(404)
  })

  test('dot in static path works fine', async () => {
    const app = new Spiceflow().route({
      method: 'GET',
      path: '/v/:id/download.tar.gz',
      handler: ({ params }) => params,
    })
    const res = await app.handle(
      new Request('http://localhost/v/abc/download.tar.gz', { method: 'GET' }),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchInlineSnapshot(`
      {
        "id": "abc",
      }
    `)
  })

  test('param captures dots in value since it matches until next slash', async () => {
    const app = new Spiceflow().route({
      method: 'GET',
      path: '/v/:id',
      handler: ({ params }) => params,
    })
    const res = await app.handle(
      new Request('http://localhost/v/file.tar.gz', { method: 'GET' }),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchInlineSnapshot(`
      {
        "id": "file.tar.gz",
      }
    `)
  })
})

describe('use preserves type safety', () => {
  test('href sees API routes from mounted subapp', () => {
    const child = new Spiceflow()
      .get('/users', () => [])
      .get('/users/:id', () => ({}))

    const app = new Spiceflow().get('/health', () => 'ok').use(child)

    expect(app.href('/health')).toBe('/health')
    expect(app.href('/users')).toBe('/users')
    expect(app.href('/users/:id', { id: '42' })).toBe('/users/42')
    // @ts-expect-error - route doesn't exist on parent or child
    app.href('/nonexistent')
  })

  test('href sees routes from subapp with basePath', () => {
    const child = new Spiceflow({ basePath: '/api' })
      .get('/users', () => [])
      .get('/items/:id', () => ({}))

    const app = new Spiceflow().get('/health', () => 'ok').use(child)

    expect(app.href('/health')).toBe('/health')
    expect(app.href('/api/users')).toBe('/api/users')
    expect(app.href('/api/items/:id', { id: '99' })).toBe('/api/items/99')
    // @ts-expect-error - unprefixed path shouldn't work
    app.href('/users')
    // @ts-expect-error - nonexistent child route
    app.href('/api/nonexistent')
  })

  test('href sees page routes from mounted subapp', () => {
    const child = new Spiceflow()
      .page('/dashboard', async () => 'Dashboard')
      .page('/settings', async () => 'Settings')

    const app = new Spiceflow().page('/', async () => 'Home').use(child)

    expect(app.href('/')).toBe('/')
    expect(app.href('/dashboard')).toBe('/dashboard')
    expect(app.href('/settings')).toBe('/settings')
    // @ts-expect-error - nonexistent page
    app.href('/nonexistent')
  })

  test('href sees page routes from subapp with basePath', () => {
    const child = new Spiceflow({ basePath: '/app' })
      .page('/dashboard', async () => 'Dashboard')
      .page('/profile/:id', async ({ params }) => params.id)

    const app = new Spiceflow().page('/', async () => 'Home').use(child)

    expect(app.href('/')).toBe('/')
    expect(app.href('/app/dashboard')).toBe('/app/dashboard')
    expect(app.href('/app/profile/:id', { id: '42' })).toBe('/app/profile/42')
    // @ts-expect-error - unprefixed path
    app.href('/dashboard')
    // @ts-expect-error - nonexistent
    app.href('/app/nonexistent')
  })

  test('href sees query schemas from mounted subapp', () => {
    const child = new Spiceflow({ basePath: '/api' }).get(
      '/search',
      ({ query }) => query,
      {
        query: z.object({ q: z.string(), limit: z.coerce.number().optional() }),
      },
    )

    const app = new Spiceflow().get('/health', () => 'ok').use(child)

    expect(app.href('/api/search', { q: 'hello', limit: 10 })).toBe(
      '/api/search?q=hello&limit=10',
    )
    // @ts-expect-error - invalid query key
    app.href('/api/search', { wrong: 'x' })
  })

  test('href sees page query schemas from mounted subapp', () => {
    const child = new Spiceflow({ basePath: '/app' }).page({
      path: '/search',
      query: z.object({ q: z.string() }),
      handler: async ({ query }) => `Results: ${query.q}`,
    })

    const app = new Spiceflow().page('/', async () => 'Home').use(child)

    expect(app.href('/app/search', { q: 'test' })).toBe('/app/search?q=test')
    // @ts-expect-error - invalid query key
    app.href('/app/search', { wrong: 'x' })
  })

  test('href sees staticPage routes from mounted subapp', () => {
    const child = new Spiceflow({ basePath: '/docs' })
      .staticPage('/intro')
      .staticPage('/changelog')

    const app = new Spiceflow().page('/', async () => 'Home').use(child)

    expect(app.href('/')).toBe('/')
    expect(app.href('/docs/intro')).toBe('/docs/intro')
    expect(app.href('/docs/changelog')).toBe('/docs/changelog')
    // @ts-expect-error - nonexistent
    app.href('/docs/nonexistent')
  })

  test('href works with .staticGet() routes', () => {
    const app = new Spiceflow()
      .staticGet('/api/manifest.json', () => ({ name: 'app' }))
      .staticGet('/sitemap.xml', () => '<sitemap/>')

    expect(app.href('/api/manifest.json')).toBe('/api/manifest.json')
    expect(app.href('/sitemap.xml')).toBe('/sitemap.xml')
    // @ts-expect-error - invalid path
    app.href('/nonexistent')
  })

  test('client sees routes from mounted subapp', async () => {
    const child = new Spiceflow({ basePath: '/api' })
      .get('/items', () => [1, 2, 3])
      .post('/items', () => ({ created: true }))

    const app = new Spiceflow().get('/health', () => 'ok').use(child)

    const f = createSpiceflowFetch(app)
    const getRes = await f('/api/items')
    expect(getRes).toEqual([1, 2, 3])

    const postRes = await f('/api/items', { method: 'POST' })
    expect(postRes).toEqual({ created: true })
  })

  test('fetch client sees routes from mounted subapp', async () => {
    const child = new Spiceflow({ basePath: '/v2' })
      .get('/status', () => ({ ok: true }))
      .post('/echo', async ({ request }) => await request.json(), {
        request: z.object({ msg: z.string() }),
      })

    const app = new Spiceflow().get('/health', () => 'ok').use(child)

    const f = createSpiceflowFetch(app)

    const status = await f('/v2/status')
    if (status instanceof Error) throw status
    expect(status).toEqual({ ok: true })

    const echo = await f('/v2/echo', {
      method: 'POST',
      body: { msg: 'hello' },
    })
    if (echo instanceof Error) throw echo
    expect(echo).toEqual({ msg: 'hello' })
  })

  test('deeply nested use chains preserve type safety', () => {
    const grandchild = new Spiceflow().get('/data', () => 'data')
    const child = new Spiceflow().get('/items', () => []).use(grandchild)
    const app = new Spiceflow().get('/health', () => 'ok').use(child)

    expect(app.href('/health')).toBe('/health')
    expect(app.href('/items')).toBe('/items')
    expect(app.href('/data')).toBe('/data')
    // @ts-expect-error - nonexistent
    app.href('/nonexistent')
  })

  test('deeply nested use with basePaths prefixes RoutePaths correctly', () => {
    const grandchild = new Spiceflow({ basePath: '/v1' }).get(
      '/data',
      () => 'data',
    )
    const child = new Spiceflow({ basePath: '/api' }).use(grandchild)
    const app = new Spiceflow().get('/health', () => 'ok').use(child)

    expect(app.href('/health')).toBe('/health')
    // child basePath + grandchild basePath + route = /api/v1/data
    expect(app.href('/api/v1/data')).toBe('/api/v1/data')
    // @ts-expect-error - unprefixed grandchild path should not work
    app.href('/v1/data')
    // @ts-expect-error - nonexistent
    app.href('/api/nonexistent')
  })

  test('fetch client rejects unknown paths', () => {
    const app = new Spiceflow()
      .get('/health', () => 'ok')
      .get('/users/:id', () => ({}))
      .post('/items', () => ({ created: true }))

    const f = createSpiceflowFetch(app)

    // Known routes are accepted
    void f('/health')
    void f('/users/:id', { params: { id: '1' } })
    void f('/items', { method: 'POST' })

    // @ts-expect-error - unknown path rejected
    void f('/nonexistent')
    // @ts-expect-error - unknown path rejected
    void f('/users')
  })

  test('fetch client rejects unknown paths from mounted subapp', () => {
    const child = new Spiceflow({ basePath: '/api' }).get('/data', () => 'data')

    const app = new Spiceflow().get('/health', () => 'ok').use(child)

    const f = createSpiceflowFetch(app)

    // Known routes accepted
    void f('/health')
    void f('/api/data')

    // @ts-expect-error - unknown path rejected
    void f('/api/nonexistent')
    // @ts-expect-error - unknown path rejected
    void f('/data')
  })

  test('basePath alone is not a valid href when child has no root route', () => {
    const child = new Spiceflow({ basePath: '/api' }).get('/data', () => 'data')
    const app = new Spiceflow().use(child)

    expect(app.href('/api/data')).toBe('/api/data')
    // @ts-expect-error - /api alone is not a route, child has no handler at '/'
    app.href('/api')
  })

  test('multiple subapps merged together', () => {
    const auth = new Spiceflow({ basePath: '/auth' })
      .post('/login', () => ({ token: 'x' }))
      .post('/logout', () => 'ok')

    const users = new Spiceflow({ basePath: '/users' }).get('/:id', () => ({}))

    const app = new Spiceflow()
      .get('/health', () => 'ok')
      .use(auth)
      .use(users)

    expect(app.href('/health')).toBe('/health')
    expect(app.href('/auth/login')).toBe('/auth/login')
    expect(app.href('/auth/logout')).toBe('/auth/logout')
    expect(app.href('/users/:id', { id: '5' })).toBe('/users/5')
    // @ts-expect-error - nonexistent
    app.href('/nonexistent')
  })

  test('page routes excluded from fetch client ClientRoutes', () => {
    const child = new Spiceflow({ basePath: '/app' })
      .page('/dashboard', async () => 'Dashboard')
      .get('/api/data', () => ({ items: [] }))

    const app = new Spiceflow().use(child)
    const f = createSpiceflowFetch(app)

    // API route works with typed result
    void f('/app/api/data')

    // fetch client accepts any string path (falls back to untyped),
    // so page paths aren't rejected — but they resolve to fallback types,
    // not the page handler's return type
  })

  test('layout paths excluded from href', () => {
    const child = new Spiceflow({ basePath: '/app' })
      .layout('/', ({ children }) => children)
      .page('/dashboard', async () => 'Dashboard')

    const app = new Spiceflow().get('/health', () => 'ok').use(child)

    // API and page routes work
    expect(app.href('/health')).toBe('/health')
    expect(app.href('/app/dashboard')).toBe('/app/dashboard')

    // @ts-expect-error - layout path not in RoutePaths
    app.href('/app/')
  })

  test('layout paths excluded from fetch client', () => {
    const child = new Spiceflow({ basePath: '/app' })
      .layout('/', ({ children }) => children)
      .get('/api/data', () => 'data')

    const app = new Spiceflow().use(child)

    const f = createSpiceflowFetch(app)
    void f('/app/api/data')

    // layout doesn't add to ClientRoutes — no navigable endpoint to access
  })
})

test('.page() without Vite plugin throws a clear error', async () => {
  const app = new Spiceflow().page('/', () => 'hello').onError(() => {})
  const res = await app.handle(
    new Request('http://localhost/', {
      method: 'GET',
      headers: { accept: 'text/html' },
    }),
  )
  await expectJsonErrorResponse({
    response: res,
    status: 500,
    message:
      '[spiceflow] RSC runtime is only available in the react-server environment. This error means renderReact was called outside of a Vite RSC build. Spiceflow .page and .layout methods require using the Vite plugin. See example application: https://github.com/remorses/spiceflow/blob/main/example-nodejs/vite.config.ts',
  })
})

test('.layout() without Vite plugin throws a clear error', async () => {
  const app = new Spiceflow()
    .layout('/', ({ children }) => children)
    .page('/', () => 'hello')
    .onError(() => {})
  const res = await app.handle(
    new Request('http://localhost/', {
      method: 'GET',
      headers: { accept: 'text/html' },
    }),
  )
  await expectJsonErrorResponse({
    response: res,
    status: 500,
    message:
      '[spiceflow] RSC runtime is only available in the react-server environment. This error means renderReact was called outside of a Vite RSC build. Spiceflow .page and .layout methods require using the Vite plugin. See example application: https://github.com/remorses/spiceflow/blob/main/example-nodejs/vite.config.ts',
  })
})

describe('.use() with page and layout routes', () => {
  test('getAllRoutes includes page routes from sub-app with basePath', () => {
    const subApp = new Spiceflow({ basePath: '/admin' })
      .page('/dashboard', async () => 'Dashboard')
      .page('/settings', async () => 'Settings')

    const app = new Spiceflow().use(subApp)

    const allRoutes = app.getAllRoutes()
    const pageRoutes = allRoutes.filter((r) => r.kind === 'page')
    const pagePaths = [...new Set(pageRoutes.map((r) => r.path))].sort()

    expect(pagePaths).toMatchInlineSnapshot(`
      [
        "/admin/dashboard",
        "/admin/settings",
      ]
    `)
  })

  test('getAllRoutes includes staticGet routes from sub-app with basePath', () => {
    const subApp = new Spiceflow({ basePath: '/api' })
      .staticGet('/manifest.json', () => ({ name: 'app' }))
      .staticGet('/config.json', () => ({ debug: false }))

    const app = new Spiceflow().use(subApp)

    const allRoutes = app.getAllRoutes()
    const staticGetRoutes = allRoutes.filter((r) => r.kind === 'staticGet')
    const paths = [...new Set(staticGetRoutes.map((r) => r.path))].sort()

    expect(paths).toMatchInlineSnapshot(`
      [
        "/api/config.json",
        "/api/manifest.json",
      ]
    `)
  })

  test('getAllRoutes includes layout routes from sub-app with basePath', () => {
    const subApp = new Spiceflow({ basePath: '/admin' })
      .layout('/', ({ children }) => children)
      .page('/dashboard', async () => 'Dashboard')

    const app = new Spiceflow().use(subApp)

    const allRoutes = app.getAllRoutes()
    const layoutRoutes = allRoutes.filter((r) => r.kind === 'layout')
    const layoutPaths = [...new Set(layoutRoutes.map((r) => r.path))].sort()

    expect(layoutPaths).toMatchInlineSnapshot(`
      [
        "/admin",
      ]
    `)
  })

  test('getAllRoutes with nested .use() and multiple basePaths', () => {
    const deepApp = new Spiceflow({ basePath: '/v1' }).page(
      '/users',
      async () => 'Users',
    )

    const midApp = new Spiceflow({ basePath: '/api' })
      .layout('/', ({ children }) => children)
      .use(deepApp)

    const app = new Spiceflow().use(midApp)

    const allRoutes = app.getAllRoutes()
    const reactRoutes = allRoutes.filter(
      (r) => r.kind === 'page' || r.kind === 'layout',
    )
    const paths = [
      ...new Set(reactRoutes.map((r) => `${r.kind}:${r.path}`)),
    ].sort()

    expect(paths).toMatchInlineSnapshot(`
      [
        "layout:/api",
        "page:/api/v1/users",
      ]
    `)
  })

  test('page in sub-app with basePath enters React path (returns RSC error, not 404)', async () => {
    const subApp = new Spiceflow({ basePath: '/admin' }).page(
      '/dashboard',
      async () => 'Dashboard',
    )

    const app = new Spiceflow().use(subApp).onError(() => {})

    const res = await app.handle(
      new Request('http://localhost/admin/dashboard', {
        method: 'GET',
        headers: { accept: 'text/html' },
      }),
    )
    // 500 = route matched and entered React render path (RSC runtime not available outside Vite)
    // 404 would mean the route was not found
    expect(res.status).toBe(500)
    const text = await res.text()
    expect(text).toContain('RSC runtime is only available')
  })

  test('layout + page in sub-app with basePath enters React path', async () => {
    const subApp = new Spiceflow({ basePath: '/admin' })
      .layout('/', ({ children }) => children)
      .page('/dashboard', async () => 'Dashboard')

    const app = new Spiceflow().use(subApp).onError(() => {})

    const res = await app.handle(
      new Request('http://localhost/admin/dashboard', {
        method: 'GET',
        headers: { accept: 'text/html' },
      }),
    )
    expect(res.status).toBe(500)
    const text = await res.text()
    expect(text).toContain('RSC runtime is only available')
  })

  test('page in sub-app with parent basePath and sub basePath', async () => {
    const subApp = new Spiceflow({ basePath: '/v1' }).page(
      '/users',
      async () => 'Users',
    )

    const app = new Spiceflow({ basePath: '/api' }).use(subApp).onError(() => {})

    const res = await app.handle(
      new Request('http://localhost/api/v1/users', {
        method: 'GET',
        headers: { accept: 'text/html' },
      }),
    )
    expect(res.status).toBe(500)
    const text = await res.text()
    expect(text).toContain('RSC runtime is only available')
  })

  test('page in sub-app at wrong path does not match the page route', async () => {
    const subApp = new Spiceflow({ basePath: '/admin' }).page(
      '/dashboard',
      async () => 'Dashboard',
    )

    const app = new Spiceflow().use(subApp).onError(() => {})

    const res = await app.handle(
      new Request('http://localhost/dashboard', {
        method: 'GET',
        headers: { accept: 'text/html' },
      }),
    )
    // The app has React pages so unmatched browser requests enter the React 404 path,
    // which fails with RSC error (500) outside Vite. The important thing is the page
    // route handler is NOT called — it's a React-level 404, not a match on /dashboard.
    expect(res.status).toBe(500)
    const text = await res.text()
    expect(text).toContain('RSC runtime is only available')
  })

  test('mixed API routes and pages in sub-app with basePath', async () => {
    const subApp = new Spiceflow({ basePath: '/admin' })
      .get('/api/data', () => ({ data: 'hello' }))
      .page('/dashboard', async () => 'Dashboard')

    const app = new Spiceflow().use(subApp).onError(() => {})

    const apiRes = await app.handle(
      new Request('http://localhost/admin/api/data', { method: 'GET' }),
    )
    expect(apiRes.status).toBe(200)
    expect(await apiRes.json()).toMatchInlineSnapshot(`
      {
        "data": "hello",
      }
    `)

    const pageRes = await app.handle(
      new Request('http://localhost/admin/dashboard', {
        method: 'GET',
        headers: { accept: 'text/html' },
      }),
    )
    expect(pageRes.status).toBe(500)
    const text = await pageRes.text()
    expect(text).toContain('RSC runtime is only available')
  })

  test('loader without matching page or layout stays a 404 route', async () => {
    let ranLoader = false

    const subApp = new Spiceflow({ basePath: '/admin' }).loader(
      '/reports/*',
      async () => {
        ranLoader = true
        return { reports: [] }
      },
    )

    const app = new Spiceflow().use(subApp)

    const res = await app.handle(
      new Request('http://localhost/admin/reports/monthly', {
        method: 'GET',
        headers: { accept: 'text/html' },
      }),
    )

    expect(res.status).toBe(404)
    expect(await res.text()).toBe('Not Found')
    expect(ranLoader).toBe(false)
  })

  test('request.url is normalized for .rsc requests before handlers run', async () => {
    const app = new Spiceflow().get('/dashboard', ({ request, path }) => ({
      url: request.url,
      originalUrl: request instanceof SpiceflowRequest ? request.originalUrl : 'missing',
      path,
    }))

    const res = await app.handle(
      new Request('http://localhost/dashboard.rsc?__rsc=&tab=settings'),
    )

    expect(await res.json()).toMatchInlineSnapshot(`
      {
        "originalUrl": "http://localhost/dashboard.rsc?__rsc=&tab=settings",
        "path": "/dashboard",
        "url": "http://localhost/dashboard?__rsc=&tab=settings",
      }
    `)
  })

  test('browser document request to .rsc URL redirects to clean URL', async () => {
    const app = new Spiceflow().get('/page', () => 'ok')

    const res = await app.handle(
      new Request('http://localhost/page.rsc?__rsc=', {
        headers: { 'sec-fetch-dest': 'document' },
      }),
    )
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/page')
  })

  test('browser document request to .rsc URL preserves other query params', async () => {
    const app = new Spiceflow().get('/dashboard', () => 'ok')

    const res = await app.handle(
      new Request('http://localhost/dashboard.rsc?__rsc=&tab=settings&v=2', {
        headers: { 'sec-fetch-dest': 'document' },
      }),
    )
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/dashboard?tab=settings&v=2')
  })

  test('browser document request to __rsc query without .rsc suffix redirects', async () => {
    const app = new Spiceflow().get('/page', () => 'ok')

    const res = await app.handle(
      new Request('http://localhost/page?__rsc=', {
        headers: { 'accept': 'text/html' },
      }),
    )
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/page')
  })

  test('programmatic RSC fetch without document headers is not redirected', async () => {
    const app = new Spiceflow().get('/page', () => 'ok')

    const res = await app.handle(
      new Request('http://localhost/page.rsc?__rsc='),
    )
    expect(res.status).toBe(200)
  })

  test('POST request with __rsc (server action) is not redirected', async () => {
    const app = new Spiceflow().post('/page', () => 'ok')

    const res = await app.handle(
      new Request('http://localhost/page?__rsc=action-id', {
        method: 'POST',
        headers: { 'sec-fetch-dest': 'document' },
        body: 'test',
      }),
    )
    expect(res.status).toBe(200)
  })

  test('multiple sub-apps with pages at different basePaths', async () => {
    const adminApp = new Spiceflow({ basePath: '/admin' }).page(
      '/dashboard',
      async () => 'Admin Dashboard',
    )

    const docsApp = new Spiceflow({ basePath: '/docs' }).page(
      '/getting-started',
      async () => 'Getting Started',
    )

    const app = new Spiceflow().use(adminApp).use(docsApp).onError(() => {})

    const allRoutes = app.getAllRoutes()
    const pagePaths = [
      ...new Set(allRoutes.filter((r) => r.kind === 'page').map((r) => r.path)),
    ].sort()

    expect(pagePaths).toMatchInlineSnapshot(`
      [
        "/admin/dashboard",
        "/docs/getting-started",
      ]
    `)

    const adminRes = await app.handle(
      new Request('http://localhost/admin/dashboard', {
        method: 'GET',
        headers: { accept: 'text/html' },
      }),
    )
    expect(adminRes.status).toBe(500) // RSC error = route matched

    const docsRes = await app.handle(
      new Request('http://localhost/docs/getting-started', {
        method: 'GET',
        headers: { accept: 'text/html' },
      }),
    )
    expect(docsRes.status).toBe(500) // RSC error = route matched
  })

  test('href works with page routes from sub-app (includes basePath)', () => {
    const subApp = new Spiceflow({ basePath: '/admin' })
      .page('/dashboard', async () => 'Dashboard')
      .page('/users/:id', async ({ params }) => params.id)

    const app = new Spiceflow().use(subApp)

    // href types include the basePath since JoinPath<BasePath, Path> encodes it
    expect(subApp.href('/admin/dashboard')).toBe('/admin/dashboard')
    expect(subApp.href('/admin/users/:id', { id: '42' })).toBe(
      '/admin/users/42',
    )
  })

  test('getAllRoutes normalizes trailing slash for layout at / in sub-app', () => {
    const subApp = new Spiceflow({ basePath: '/app' })
      .layout('/', ({ children }) => children)
      .page('/home', async () => 'Home')

    const app = new Spiceflow().use(subApp)

    const allRoutes = app.getAllRoutes()
    const paths = [
      ...new Set(allRoutes.map((r) => `${r.kind || 'api'}:${r.path}`)),
    ].sort()

    // Layout at '/' with basePath '/app' should be '/app', not '/app/'
    expect(paths).toMatchInlineSnapshot(`
      [
        "layout:/app",
        "page:/app/home",
      ]
    `)
  })

  test('getAllRoutes with wildcard route in sub-app has no trailing slash', () => {
    const subApp = new Spiceflow({ basePath: '/admin' })
      .get('/*', () => 'catch-all')
      .layout('/', ({ children }) => children)
      .page('/dashboard', async () => 'Dashboard')

    const app = new Spiceflow().use(subApp)

    const allRoutes = app.getAllRoutes()
    const paths = [...new Set(allRoutes.map((r) => r.path))].sort()

    // No trailing slashes — wildcard is '/admin/*', layout is '/admin'
    expect(paths.some((p) => p.endsWith('/') && p !== '/')).toBe(false)
    expect(paths).toContain('/admin/*')
    expect(paths).toContain('/admin')
    expect(paths).toContain('/admin/dashboard')
  })

  test('unmatched non-browser request returns 404 (not React runtime 500)', async () => {
    const subApp = new Spiceflow({ basePath: '/admin' }).page(
      '/dashboard',
      async () => 'Dashboard',
    )

    const app = new Spiceflow().use(subApp)

    const res = await app.handle(
      new Request('http://localhost/not-found', {
        method: 'GET',
        headers: { accept: 'application/json' },
      }),
    )
    expect(res.status).toBe(404)
  })

  test('explicit .post() on same path as .page() takes priority over page implicit POST', async () => {
    const app = new Spiceflow()
      .page('/confirm', async () => 'Confirm Page')
      .post('/confirm', () => {
        return Response.json({ confirmed: true })
      })

    const res = await app.handle(
      new Request('http://localhost/confirm', { method: 'POST' }),
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(await res.json()).toEqual({ confirmed: true })
  })

  test('page POST still works for server actions when no explicit .post() exists', async () => {
    const app = new Spiceflow()
      .page('/dashboard', async () => 'Dashboard')
      .onError(() => {})

    // POST without __rsc and without explicit .post() should enter React
    // rendering path (for server actions). It returns RSC or HTML, not 404.
    const res = await app.handle(
      new Request('http://localhost/dashboard', { method: 'POST' }),
    )
    // Should not be 404 — the page handler should still process it
    expect(res.status).not.toBe(404)
  })

  test('GET to page path still renders page when .post() exists on same path', async () => {
    const app = new Spiceflow()
      .page('/confirm', async () => 'Confirm Page')
      .post('/confirm', () => {
        return Response.json({ confirmed: true })
      })
      .onError(() => {})

    const res = await app.handle(
      new Request('http://localhost/confirm', {
        method: 'GET',
        headers: { accept: 'text/html' },
      }),
    )
    // Should enter React rendering, not return the .post() handler
    expect(res.status).not.toBe(404)
  })
})

test('page query schema applies zod .default() values at runtime', async () => {
  const app = new Spiceflow()
    .page({
      path: '/settings',
      query: z.object({
        tab: z.string().default('general'),
        page: z.coerce.number().default(1),
      }),
      handler: async ({ query }) => {
        return Response.json({ tab: query.tab, page: query.page })
      },
    })
    .onError((e) => Response.json({ error: String(e) }, { status: 500 }))

  // No query params — defaults should be applied
  const res = await app.handle(new Request('http://localhost/settings'))
  expect(res.status).toBe(200)
  const body = await res.json()
  expect(body).toEqual({ tab: 'general', page: 1 })
})

test('page query schema applies defaults while tolerating missing required fields', async () => {
  const app = new Spiceflow()
    .page({
      path: '/search',
      query: z.object({
        q: z.string().optional(),
        sort: z.string().default('relevance'),
      }),
      handler: async ({ query }) => {
        return Response.json({ q: query.q, sort: query.sort })
      },
    })
    .onError((e) => Response.json({ error: String(e) }, { status: 500 }))

  // Only q provided — sort should get default
  const res = await app.handle(new Request('http://localhost/search?q=hello'))
  expect(res.status).toBe(200)
  const body = await res.json()
  expect(body).toEqual({ q: 'hello', sort: 'relevance' })
})

test('page query schema preserves unknown keys not in schema', async () => {
  const app = new Spiceflow()
    .page({
      path: '/page',
      query: z.object({ tab: z.string().default('overview') }),
      handler: async ({ query }) => {
        return Response.json(query)
      },
    })
    .onError((e) => Response.json({ error: String(e) }, { status: 500 }))

  const res = await app.handle(new Request('http://localhost/page?tab=settings&utm_source=google'))
  expect(res.status).toBe(200)
  const body = await res.json()
  // tab comes from schema validation, utm_source preserved from raw query
  expect(body.tab).toBe('settings')
  expect(body.utm_source).toBe('google')
})

test('href works with multi-param paths that have trailing non-param segments', () => {
  const app = new Spiceflow()
    .page({
      path: '/org/:orgId/e/:eventId/settings',
      query: z.object({ tab: z.string().optional() }),
      handler: async () => 'Settings',
    })

  // Should compile and produce correct URL — params + query
  expect(
    app.href('/org/:orgId/e/:eventId/settings', {
      orgId: 'abc',
      eventId: 'evt1',
      tab: 'details',
    }),
  ).toBe('/org/abc/e/evt1/settings?tab=details')

  // Without query
  expect(
    app.href('/org/:orgId/e/:eventId/settings', {
      orgId: 'abc',
      eventId: 'evt1',
    }),
  ).toBe('/org/abc/e/evt1/settings')
})

test('href with multi-param path without query schema', () => {
  const app = new Spiceflow()
    .page({
      path: '/org/:orgId/e/:eventId/dashboard',
      handler: async () => 'Dashboard',
    })

  expect(
    app.href('/org/:orgId/e/:eventId/dashboard', {
      orgId: 'abc',
      eventId: 'evt1',
    }),
  ).toBe('/org/abc/e/evt1/dashboard')
})
