---
title: OpenAPI
description: Generate OpenAPI 3.1 docs from your Zod schemas.
icon: file-json
---

# OpenAPI

Spiceflow generates a full OpenAPI 3.1 document from your routes without you writing a single line of schema by hand. The `openapi` plugin walks every registered route and uses the Zod schemas you already passed to `request`, `query`, `params`, and `response` to produce the `paths`, `parameters`, `requestBody`, and `responses` sections for you.

There is nothing "magical" or decorator-based here — the same Zod schemas that validate the request at runtime and give you a typed handler context are also the input for the OpenAPI output.

## Basic Usage

Mount the plugin with `.use(openapi({ path: '/openapi.json' }))` and every other route registered on the app (before or after the plugin) is picked up automatically when a client requests that path:

```ts
import { Spiceflow } from 'spiceflow'
import { openapi } from 'spiceflow/openapi'
import { z } from 'zod'

export const app = new Spiceflow()
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

const schema = await app
  .handle(new Request('http://localhost/openapi.json'))
  .then((res) => res.json())
```

The returned document is a standard `OpenAPIV3.Document` you can hand off to Swagger UI, Redoc, Fern, Stainless, or any other OpenAPI tool.

## Define Inputs With Zod

The preferred way to describe a route is to pass Zod schemas for every piece of input. This gives you **three things at once** with zero duplication:

1. **Runtime validation** — requests with a bad body, query, or params are rejected with a `400`.
2. **Type-safe handler context** — `request.json()`, `query`, and `params` are typed from the same schemas.
3. **OpenAPI output** — `requestBody`, `parameters`, and `responses` are emitted directly from the schemas.

```ts
import { Spiceflow } from 'spiceflow'
import { openapi } from 'spiceflow/openapi'
import { z } from 'zod'

export const app = new Spiceflow()
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
      return {
        id: 'usr_123',
        name: body.name,
        email: body.email,
      }
    },
  })
```

> **Always prefer `.route()` over `.get()` / `.post()` for public APIs.** The `.route()` form takes every schema key (`request`, `response`, `query`, `params`, `detail`) in a single object, which is easier to discover and keeps the schemas attached to the handler where they belong. Use `.get()` / `.post()` only for quick internal routes that do not need validation or OpenAPI.

## Status-Code Response Map

When a route can return different payloads depending on the status code, pass `response` as an object keyed by HTTP status codes instead of a single schema. Each entry becomes its own entry in the emitted OpenAPI `responses` object:

```ts
import { z } from 'zod'
import { Spiceflow, json } from 'spiceflow'
import { openapi } from 'spiceflow/openapi'

const ErrorShape = z.object({
  message: z.string(),
  code: z.string(),
})

export const app = new Spiceflow()
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
```

`json(body, init)` is a type-safe wrapper around `Response.json()` — it sets `content-type: application/json` automatically and carries the data type and status code through the type system. Prefer `json()` over `Response.json()` so the fetch client gets typed error responses.

**Name the human-readable field `message`, never `error`.** `SpiceflowFetchError` builds its `.message` from that key, so callers read `err.message` like on any other `Error`. With any other key the client falls back to `JSON.stringify(body)` and `err.message` becomes a raw JSON blob. Machine-readable data goes in sibling fields such as `code`.

**Use the status-code map whenever you already know which non-2xx status codes your route can return and there is a realistic possibility of errors.** Consumers of your API — and tools like Fern or Stainless that generate SDKs from the OpenAPI document — get precise types for each failure mode instead of a generic "it might fail".

The client side also benefits: `createSpiceflowFetch` reads this map to produce a discriminated error type per status code. See [Preserving Client Type Safety](#preserving-client-type-safety) below.

## Centralized Error Responses With `onError`

In most real APIs the same handful of error shapes show up on every route — usually a `500` for unexpected failures, a `401` for missing auth, maybe a `400` for validation. Spiceflow has a centralized `onError` handler that runs for every thrown error, which pairs naturally with a **shared response object you spread into each route**.

Define the error schema and the corresponding response entry in one module, then spread it into every route:

```ts
// src/api/shared-responses.ts
import { z } from 'zod'

export const ErrorResponse = z.object({
  message: z.string(),
  code: z.string(),
  requestId: z.string().optional(),
})

// Shared response entries that every route should document.
export const commonResponses = {
  500: ErrorResponse,
  401: ErrorResponse,
} as const
```

```ts
// src/api/app.ts
import { Spiceflow, json } from 'spiceflow'
import { openapi } from 'spiceflow/openapi'
import { z } from 'zod'
import { commonResponses, ErrorResponse } from './shared-responses'

export const app = new Spiceflow()
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
```

Every route now documents the shared `500` and `401` responses without duplicating the schema, and the actual `500` body is produced by a single `onError` handler at the app root. If you later change the error shape, you only edit `shared-responses.ts`.

> **Spread `...commonResponses` first, then list route-specific entries.** Later keys win in object spread, so putting the shared responses at the top lets an individual route override, say, the shared `500` with a more specific schema if it ever needs to — and leaves the route-specific entries like `200` and `404` visually grouped at the bottom.

## Reusing Schemas Across Routes

When the same type appears in more than one route — `User`, `Organization`, `PaginatedList<T>` — **define the Zod schema once in a dedicated file and import it**. Do not inline the same object in multiple routes; besides the duplication, you lose the ability to rename a field in one place.

```ts
// src/schemas.ts
import { z } from 'zod'

export const User = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().email(),
  createdAt: z.string().datetime(),
})

export type User = z.infer<typeof User>

export const UserList = z.object({
  items: z.array(User),
  nextCursor: z.string().nullable(),
})
```

```ts
// src/api/users.ts
import { Spiceflow } from 'spiceflow'
import { z } from 'zod'
import { User, UserList } from '../schemas'
import { commonResponses } from './shared-responses'

export const usersApi = new Spiceflow({ basePath: '/users' })
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
      createdAt: new Date().toISOString(),
    }),
  })
```

Any schema that appears in more than one route should live in a single `src/schemas.ts` file (or wherever you keep domain types) and be imported everywhere it is used. Keep it as one flat file until it actually grows too large — a single `schemas.ts` is easier to navigate than a `schemas/` folder with one file per type.

## Hiding Routes From the Document

Pass `detail: { hide: true }` on any route you do not want to appear in the generated OpenAPI document. This is useful for internal health checks, debug endpoints, and routes that exist purely for server-to-server communication:

```ts
import { Spiceflow } from 'spiceflow'
import { openapi } from 'spiceflow/openapi'

export const app = new Spiceflow()
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
```

Hidden routes still work normally at runtime — they just do not show up in the emitted schema.

## Custom Descriptions With Markdown

The `detail` field accepts anything from the OpenAPI operation object, so you can attach `summary`, `description`, `tags`, `operationId`, and any vendor extension. For anything longer than a single line, write the description as a real multi-line string using the [`string-dedent`](https://www.npmjs.com/package/string-dedent) package so your code stays readable and the leading indentation is stripped automatically.

```ts
import { Spiceflow } from 'spiceflow'
import { openapi } from 'spiceflow/openapi'
import { z } from 'zod'
import dedent from 'string-dedent'
import { User } from '../schemas'
import { commonResponses } from './shared-responses'

export const app = new Spiceflow()
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
      return {
        id: 'usr_abc',
        name: body.name,
        email: body.email,
        createdAt: new Date().toISOString(),
      }
    },
  })
```

Markdown in the description is rendered by Swagger UI, Redoc, Scalar, Fern, and Stainless, so you can include headings, bullets, inline code, and fenced code blocks.

## Writing the Schema to a Local File

You often want a physical `openapi.json` file checked into the repo — for SDK generation, for docs sites, or for diffing the schema on every PR. The cleanest way to produce one is to call `app.handle()` directly instead of spinning up a real HTTP server:

```ts
// scripts/generate-openapi.ts
import { writeFile } from 'node:fs/promises'
import { app } from '../src/api/app'

const response = await app.handle(
  new Request('http://localhost/openapi.json'),
)
const schema = await response.json()

await writeFile('openapi.json', JSON.stringify(schema, null, 2))
console.log('Wrote openapi.json')
```

Run it with any TypeScript runner:

```bash
tsx scripts/generate-openapi.ts
# or
bun scripts/generate-openapi.ts
```

Wire this into your build so the file is always in sync with the code:

```json
{
  "scripts": {
    "openapi": "tsx scripts/generate-openapi.ts",
    "prebuild": "pnpm openapi"
  }
}
```

If you prefer a type-safe call, use `createSpiceflowFetch` against the app instance (no real network, no server) — see the [fetch client docs](fetch-client.md#server-side-fetch) for a worked example.

## Preserving Client Type Safety

The [type-safe fetch client](fetch-client.md) reads your route schemas the same way the OpenAPI plugin does, so the way you declare `response` directly affects what the client sees.

**Rule of thumb:** success responses should be **returned** from the handler, and non-2xx responses should be **thrown** using `json()`. Use `json()` from `spiceflow` instead of `Response.json()` — it preserves the data type and status code in the type system, so TypeScript validates that the status exists in the response schema and the body shape matches. `Response.json()` erases all type information.

When you throw non-successful responses, the client inference stays clean: the happy-path return type is just `Data`, and errors are delivered as a `SpiceflowFetchError` that `instanceof Error` narrows away.

```ts
// src/api/app.ts
import { Spiceflow, json } from 'spiceflow'
import { z } from 'zod'

const NotFound = z.object({ message: z.literal('not found') })
const Forbidden = z.object({ message: z.literal('forbidden'), reason: z.string() })

export const app = new Spiceflow().route({
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

export type App = typeof app
```

On the client side, the fetch client gives you back a discriminated `Error | Data` union. The error half is typed from the status-code response map: for each non-200 status you defined, the client gets a `SpiceflowFetchError<status, body>` with the **exact body shape** that status returns.

```ts
// src/client.ts
import { createSpiceflowFetch } from 'spiceflow/client'

const api = createSpiceflowFetch('https://api.example.com')

const result = await api('/users/:id', { params: { id: 'abc' } })

if (result instanceof Error) {
  // result is typed as
  //   | SpiceflowFetchError<403, { message: 'forbidden'; reason: string }>
  //   | SpiceflowFetchError<404, { message: 'not found' }>
  switch (result.status) {
    case 403:
      // result.value is { message: 'forbidden'; reason: string }
      console.error('Forbidden:', result.value.reason)
      break
    case 404:
      // result.value is { message: 'not found' }
      console.error('User not found')
      break
  }
  return
}

// result is typed as { id: string; name: string } — no error shape leaked in
console.log('User:', result.id, result.name)
```

Three things fall out of this pattern:

1. **The success branch is clean.** `result.id` and `result.name` are available without null checks or type narrowing on error fields.
2. **Every error status is exhaustively typed.** If you add a new status to the route's `response` map, TypeScript forces you to handle it on the client.
3. **The OpenAPI document is accurate.** The same map that drives the client types also drives the `responses` object in `openapi.json`, so your SDK consumers see exactly the same contract.

If a route has no documented non-2xx responses at all, the client falls back to a generic `SpiceflowFetchError<number, any>` for the error branch — which still works, but loses per-status typing. Add status entries to `response` whenever you care about the failure shape.
