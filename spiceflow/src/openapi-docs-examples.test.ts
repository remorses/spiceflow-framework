// Validates every code example that appears in README.md's "OpenAPI" section
// and docs/openapi.md. Each example is wrapped in a function so TypeScript
// type-checks the code, and a single `test()` runs the example against
// app.handle() to confirm it also works at runtime.
//
// When you edit those docs, keep this file in sync so compile or runtime
// regressions show up immediately.

import { describe, expect, test } from 'vitest'
import { z } from 'zod'
import { Spiceflow } from './spiceflow.js'
import { openapi } from './openapi.js'
import { createSpiceflowFetch } from './client/fetch.js'
import { SpiceflowFetchError } from './client/index.js'
import { json } from './error.js'

// `string-dedent` is referenced in the doc example but is not a dependency
// of the spiceflow package. Emulate it with a local tagged template so this
// test file type-checks and runs without pulling in an extra dep.
// See https://www.npmjs.com/package/string-dedent for the real implementation.
function dedent(strings: TemplateStringsArray, ...values: unknown[]): string {
  let raw = ''
  for (let i = 0; i < strings.length; i++) {
    raw += strings[i]
    if (i < values.length) raw += String(values[i])
  }
  const lines = raw.split('\n')
  if (lines[0] === '') lines.shift()
  if (lines.length && lines[lines.length - 1].trim() === '') lines.pop()
  const indent = Math.min(
    ...lines
      .filter((l) => l.trim().length > 0)
      .map((l) => l.match(/^ */)![0].length),
  )
  return lines.map((l) => l.slice(indent)).join('\n')
}

// ─── Shared stubs ────────────────────────────────────────────────────────────
// The doc examples reference these domain helpers without defining them.
// Stubs let the examples type-check and run as real tests.

type DomainUser = { id: string; name: string; email: string; createdAt: string }

function findUser(id: string): DomainUser | undefined {
  if (id === 'missing' || id === 'banned') return undefined
  return {
    id,
    name: 'Alice',
    email: 'alice@example.com',
    createdAt: new Date('2024-01-01T00:00:00.000Z').toISOString(),
  }
}

async function userExists(email: string): Promise<boolean> {
  return email === 'taken@example.com'
}

async function createUser(body: {
  name: string
  email: string
}): Promise<DomainUser> {
  return {
    id: 'usr_' + body.name,
    name: body.name,
    email: body.email,
    createdAt: new Date('2024-01-01T00:00:00.000Z').toISOString(),
  }
}

// ─── Shared schemas used by the later examples ──────────────────────────────
// These mirror docs/openapi.md "Reusing Schemas Across Routes" and
// "Centralized Error Responses With onError" sections.

const User = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().email(),
  createdAt: z.string().datetime(),
})

const UserList = z.object({
  items: z.array(User),
  nextCursor: z.string().nullable(),
})

const ErrorResponse = z.object({
  message: z.string(),
  code: z.string(),
  requestId: z.string().optional(),
})

const commonResponses = {
  500: ErrorResponse,
  401: ErrorResponse,
} as const

// ─── README.md: "OpenAPI" section ────────────────────────────────────────────

function readmeOpenApiExample() {
  const app = new Spiceflow()
    .use(openapi({ path: '/openapi.json' }))
    .route({
      method: 'GET',
      path: '/hello',
      query: z.object({
        name: z.string(),
        age: z.number(),
      }),
      response: z.string(),
      handler({ query }) {
        return `Hello, ${query.name}!`
      },
    })
    .route({
      method: 'POST',
      path: '/user',
      request: z.object({
        name: z.string(),
        email: z.string().email(),
      }),
      response: z.object({ id: z.string() }),
      async handler({ request }) {
        const body = await request.json()
        return { id: 'usr_' + body.name }
      },
    })

  return app
}

// ─── docs/openapi.md: "Basic Usage" ──────────────────────────────────────────

function basicUsageExample() {
  return new Spiceflow()
    .use(
      openapi({
        path: '/openapi.json',
        info: {
          title: 'My API',
          version: '1.0.0',
        },
      }),
    )
    .route({
      method: 'GET',
      path: '/users/:id',
      params: z.object({ id: z.string() }),
      response: z.object({
        id: z.string(),
        name: z.string(),
      }),
      handler({ params }) {
        return { id: params.id, name: 'Alice' }
      },
    })
}

// ─── docs/openapi.md: "Define Inputs With Zod" ───────────────────────────────

function defineInputsWithZodExample() {
  return new Spiceflow()
    .use(openapi({ path: '/openapi.json' }))
    .route({
      method: 'POST',
      path: '/users/:orgId',
      params: z.object({ orgId: z.string() }),
      query: z.object({
        notify: z.boolean().optional(),
      }),
      request: z.object({
        name: z.string(),
        email: z.string().email(),
      }),
      response: z.object({
        id: z.string(),
        name: z.string(),
        email: z.string(),
      }),
      async handler({ params, query, request }) {
        // params is typed as { orgId: string }
        // query is typed as { notify?: boolean }
        // body is typed as { name: string, email: string }
        const body = await request.json()
        const _check: string = params.orgId
        const _check2: boolean | undefined = query.notify
        void _check
        void _check2
        return {
          id: 'usr_123',
          name: body.name,
          email: body.email,
        }
      },
    })
}

// ─── docs/openapi.md: "Status-Code Response Map" ─────────────────────────────

function statusCodeResponseMapExample() {
  const ErrorShape = z.object({
    message: z.string(),
    code: z.string(),
  })

  return new Spiceflow()
    .use(openapi({ path: '/openapi.json' }))
    .route({
      method: 'GET',
      path: '/users/:id',
      params: z.object({ id: z.string() }),
      response: {
        200: z.object({
          id: z.string(),
          name: z.string(),
        }),
        404: ErrorShape,
        500: ErrorShape,
      },
      handler({ params }) {
        const user = findUser(params.id)
        if (!user) {
          throw json(
            { message: 'not found', code: 'NOT_FOUND' },
            { status: 404 },
          )
        }
        return { id: user.id, name: user.name }
      },
    })
}

// ─── docs/openapi.md: "Centralized Error Responses With onError" ─────────────

function centralizedErrorResponsesExample() {
  return new Spiceflow()
    .use(openapi({ path: '/openapi.json' }))
    .onError(({ error, request }) => {
      console.error('[api]', request.url, error)
      return json(
        {
          message: error.message || 'internal server error',
          code: 'INTERNAL',
        },
        { status: 500 },
      )
    })
    .route({
      method: 'GET',
      path: '/users/:id',
      params: z.object({ id: z.string() }),
      response: {
        ...commonResponses,
        200: z.object({ id: z.string(), name: z.string() }),
        404: ErrorResponse,
      },
      handler({ params }) {
        const user = findUser(params.id)
        if (!user) {
          throw json(
            { message: 'not found', code: 'NOT_FOUND' },
            { status: 404 },
          )
        }
        return user
      },
    })
    .route({
      method: 'POST',
      path: '/users',
      request: z.object({ name: z.string(), email: z.string().email() }),
      response: {
        ...commonResponses,
        200: z.object({ id: z.string() }),
      },
      async handler({ request }) {
        const body = await request.json()
        return { id: 'usr_' + body.name }
      },
    })
}

// ─── docs/openapi.md: "Reusing Schemas Across Routes" ────────────────────────

function reusingSchemasExample() {
  return new Spiceflow({ basePath: '/users' })
    .route({
      method: 'GET',
      path: '/',
      query: z.object({ cursor: z.string().optional() }),
      response: { ...commonResponses, 200: UserList },
      handler: () => ({ items: [], nextCursor: null }),
    })
    .route({
      method: 'GET',
      path: '/:id',
      params: z.object({ id: z.string() }),
      response: { ...commonResponses, 200: User },
      handler: ({ params }) => ({
        id: params.id,
        name: 'Alice',
        email: 'alice@example.com',
        createdAt: new Date('2024-01-01T00:00:00.000Z').toISOString(),
      }),
    })
}

// ─── docs/openapi.md: "Hiding Routes From the Document" ──────────────────────

function hidingRoutesExample() {
  return new Spiceflow()
    .use(openapi({ path: '/openapi.json' }))
    .route({
      method: 'GET',
      path: '/health',
      detail: { hide: true },
      handler: () => ({ ok: true }),
    })
    .route({
      method: 'POST',
      path: '/internal/reindex',
      detail: { hide: true },
      handler: () => ({ queued: true }),
    })
}

// ─── docs/openapi.md: "Custom Descriptions With Markdown" ────────────────────

function customDescriptionsExample() {
  return new Spiceflow()
    .use(openapi({ path: '/openapi.json' }))
    .route({
      method: 'POST',
      path: '/users',
      request: z.object({
        name: z.string(),
        email: z.string().email(),
      }),
      response: { ...commonResponses, 200: User },
      detail: {
        summary: 'Create a user',
        tags: ['users'],
        description: dedent`
          Creates a new user in the current organization.

          ## Behavior

          - The \`email\` field must be unique across the organization.
            If it already exists, the endpoint returns \`409 Conflict\`.
          - The returned \`id\` is a stable prefix-encoded identifier
            (\`usr_\` prefix + 24 base32 characters).

          ## Example

          \`\`\`bash
          curl -X POST https://api.example.com/users \\
            -H 'content-type: application/json' \\
            -d '{ "name": "Alice", "email": "alice@example.com" }'
          \`\`\`
        `,
      },
      async handler({ request }) {
        const body = await request.json()
        if (await userExists(body.email)) {
          throw json(
            { message: 'conflict', code: 'CONFLICT' },
            { status: 409 },
          )
        }
        return createUser(body)
      },
    })
}

// ─── docs/openapi.md: "Writing the Schema to a Local File" ───────────────────

async function writeSchemaToLocalFileExample() {
  const app = basicUsageExample()

  const response = await app.handle(
    new Request('http://localhost/openapi.json'),
  )
  const schema = await response.json()
  // The real doc example writes to disk with writeFile. We just check it
  // serializes here.
  const pretty = JSON.stringify(schema, null, 2)
  return pretty
}

// ─── docs/openapi.md: "Preserving Client Type Safety" ────────────────────────

function preservingClientTypeSafetyApp() {
  const NotFound = z.object({ message: z.literal('not found') })
  const Forbidden = z.object({
    message: z.literal('forbidden'),
    reason: z.string(),
  })

  return new Spiceflow().route({
    method: 'GET',
    path: '/users/:id',
    params: z.object({ id: z.string() }),
    response: {
      200: z.object({ id: z.string(), name: z.string() }),
      403: Forbidden,
      404: NotFound,
    },
    handler({ params }) {
      if (params.id === 'banned') {
        throw json(
          { message: 'forbidden', reason: 'account suspended' },
          { status: 403 },
        )
      }
      const user = findUser(params.id)
      if (!user) {
        throw json({ message: 'not found' }, { status: 404 })
      }
      // Returned directly — the fetch client will type this as the success case only.
      return { id: user.id, name: user.name }
    },
  })
}

async function preservingClientTypeSafetyClient() {
  const app = preservingClientTypeSafetyApp()
  const api = createSpiceflowFetch<typeof app>(app)

  const result = await api('/users/:id', { params: { id: 'abc' } })

  if (result instanceof Error) {
    if (!(result instanceof SpiceflowFetchError)) return
    switch (result.status) {
      case 403: {
        // result.value is { message: 'forbidden'; reason: string }
        const _reason: string = (result.value as { reason: string }).reason
        console.error('Forbidden:', _reason)
        break
      }
      case 404: {
        // result.value is { message: 'not found' }
        const _err: string = (result.value as { message: string }).message
        console.error('User not found', _err)
        break
      }
    }
    return null
  }

  // result is typed as { id: string; name: string } — no error shape leaked in
  return { id: result.id, name: result.name }
}

// ─── Runtime validation ──────────────────────────────────────────────────────

describe('openapi docs examples compile and run', () => {
  test('README "OpenAPI" example responds to /hello and /openapi.json', async () => {
    const app = readmeOpenApiExample()

    const schema = await app
      .handle(new Request('http://localhost/openapi.json'))
      .then((r) => r.json())
    expect(schema.openapi).toBe('3.1.3')
    expect(schema.paths['/hello']).toBeTruthy()
    expect(schema.paths['/user']).toBeTruthy()

    const hello = await app.handle(
      new Request('http://localhost/hello?name=World&age=30'),
    )
    expect(hello.status).toBe(200)
    expect(await hello.text()).toBe('"Hello, World!"')
  })

  test('Basic Usage example responds to /users/:id', async () => {
    const app = basicUsageExample()
    const res = await app.handle(new Request('http://localhost/users/42'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id: '42', name: 'Alice' })
  })

  test('Define Inputs With Zod example validates params, query and body', async () => {
    const app = defineInputsWithZodExample()
    const res = await app.handle(
      new Request('http://localhost/users/org_1?notify=true', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Alice', email: 'alice@example.com' }),
      }),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      id: 'usr_123',
      name: 'Alice',
      email: 'alice@example.com',
    })
  })

  test('Status-Code Response Map example returns 200 and 404', async () => {
    const app = statusCodeResponseMapExample()
    const ok = await app.handle(new Request('http://localhost/users/42'))
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ id: '42', name: 'Alice' })

    const notFound = await app.handle(
      new Request('http://localhost/users/missing'),
    )
    expect(notFound.status).toBe(404)
    expect(await notFound.json()).toEqual({
      message: 'not found',
      code: 'NOT_FOUND',
    })
  })

  test('Centralized Error Responses example handles 404 and spreads 500', async () => {
    const app = centralizedErrorResponsesExample()
    const notFound = await app.handle(
      new Request('http://localhost/users/missing'),
    )
    expect(notFound.status).toBe(404)
    expect(await notFound.json()).toEqual({
      message: 'not found',
      code: 'NOT_FOUND',
    })

    // Verify the schema lists the 500 response from commonResponses
    const schema = await app
      .handle(new Request('http://localhost/openapi.json'))
      .then((r) => r.json())
    expect(
      schema.paths['/users/{id}'].get.responses['500'],
    ).toBeTruthy()
    expect(
      schema.paths['/users/{id}'].get.responses['401'],
    ).toBeTruthy()
  })

  test('Reusing Schemas example exposes /users routes', async () => {
    const app = reusingSchemasExample()
    const list = await app.handle(new Request('http://localhost/users/'))
    expect(list.status).toBe(200)
    expect(await list.json()).toEqual({ items: [], nextCursor: null })
  })

  test('Hiding Routes example omits hidden routes from the schema', async () => {
    const app = hidingRoutesExample()
    const schema = await app
      .handle(new Request('http://localhost/openapi.json'))
      .then((r) => r.json())
    expect(schema.paths['/health']).toBeUndefined()
    expect(schema.paths['/internal/reindex']).toBeUndefined()
  })

  test('Custom Descriptions example includes the markdown description', async () => {
    const app = customDescriptionsExample()
    const schema = await app
      .handle(new Request('http://localhost/openapi.json'))
      .then((r) => r.json())
    const description = schema.paths['/users'].post.description
    expect(typeof description).toBe('string')
    expect(description).toContain('Creates a new user in the current organization.')
    expect(description).toContain('## Behavior')
  })

  test('Writing the Schema example produces a JSON string', async () => {
    const pretty = await writeSchemaToLocalFileExample()
    expect(pretty).toContain('"openapi"')
    const parsed = JSON.parse(pretty)
    expect(parsed.paths['/users/{id}']).toBeTruthy()
  })

  test('Preserving Client Type Safety: happy path returns typed success', async () => {
    const app = preservingClientTypeSafetyApp()
    const res = await app.handle(new Request('http://localhost/users/42'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id: '42', name: 'Alice' })
  })

  test('Preserving Client Type Safety: 403 surfaces as typed error', async () => {
    const app = preservingClientTypeSafetyApp()
    const res = await app.handle(new Request('http://localhost/users/banned'))
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({
      message: 'forbidden',
      reason: 'account suspended',
    })
  })

  test('Preserving Client Type Safety: 404 surfaces as typed error', async () => {
    const app = preservingClientTypeSafetyApp()
    const res = await app.handle(new Request('http://localhost/users/missing'))
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ message: 'not found' })
  })

  test('Preserving Client Type Safety: client fetch returns happy data', async () => {
    const data = await preservingClientTypeSafetyClient()
    expect(data).toEqual({ id: 'abc', name: 'Alice' })
  })
})
