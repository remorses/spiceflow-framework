---
title: Fetch Client (Advanced)
description: Advanced fetch client patterns for headers, hooks, and RPC.
icon: globe
---

# Fetch Client (Advanced)

Advanced fetch client patterns including headers, hooks, error handling, server-side usage, type-safe RPC, and path building. For basic usage see the [Fetch Client section in the README](./index.mdx#fetch-client).

## Common Pitfalls

**Never interpolate path params into the path string.** Use `:param` syntax with a `params` object. Interpolated template literals resolve to `string`, which breaks type inference on params, body, and response.

```ts
// GOOD: typed path, typed params, typed response
const res = await safeFetch('/api/users/:id', {
  params: { id: '123' },
})

// BAD: path is just `string`, response is unknown, body unchecked
const res = await safeFetch(`/api/users/${id}`)
```

**All packages in a monorepo must use the exact same spiceflow version.** The `App` type carries private class properties from the `Spiceflow` class. If the CLI resolves spiceflow@1.19.0-rsc.3 but the server uses spiceflow@1.19.0-rsc.4, TypeScript sees two different class declarations and rejects the generic with `Types have separate declarations of a private property`.

**Never `return new Response(...)` in route handlers.** A raw `Response` in the return type erases the body type. The fetch client sees `Response | { id, name }` and can't infer the typed object. Use `return json(...)` instead (preserves body type and status), or `throw` anything (`throw new Response(...)`, `throw json(...)`) since thrown values don't affect the return type.

```ts
// GOOD: return json() preserves the error body type
handler() {
  if (!user) return json({ message: 'not found' }, { status: 404 })
  return { id: user.id, name: user.name }
}

// GOOD: throw anything is fine, doesn't pollute return type
handler() {
  if (!user) throw new Response('not found', { status: 404 })
  return { id: user.id, name: user.name }
}

// BAD: return new Response erases the body type
handler() {
  if (!user) return new Response('not found', { status: 404 })
  return { id: user.id, name: user.name }
}
```

**Route handlers must return objects for the response to be typed.** If a handler returns `res.json()` (which is `Promise<any>`), the typed fetch client gets `any` for the response. Return plain objects instead.

```ts
// GOOD: return type is inferred as { id: string, name: string }
handler() {
  return { id: user.id, name: user.name }
}

// BAD: return type is any, fetch client loses response type
handler() {
  return externalApi.json()
}
```

<details>
<summary>Detailed monorepo typed fetch guide</summary>

The typed fetch client only feels good when the server app exposes a clean type boundary and the client calls it in the intended style. Most weird TypeScript failures come from one of four mistakes:

1. importing the wrong app type
2. interpolating params into the path string
3. manually serializing the body
4. ignoring the `Error | Data` return type

### Basic setup

```ts
import { createSpiceflowFetch } from 'spiceflow/client'
import type { App } from '@my-org/website/src/app.tsx'

export const safeFetch = createSpiceflowFetch<App>('https://example.com', {
  headers: {
    Authorization: `Bearer ${token}`,
  },
})
```

### Good vs bad path usage

Use the declared route pattern and pass params separately:

```ts
// GOOD
const res = await safeFetch('/api/v0/orgs/:orgId/projects', {
  params: { orgId: 'org_123' },
})

// BAD
const res = await safeFetch(`/api/v0/orgs/${orgId}/projects`)
```

The bad version turns the path into a generic `string`, so TypeScript can no longer connect it to the route table.

### POST bodies

Pass `body` as a plain object. The client handles JSON serialization and headers.

```ts
// GOOD
const res = await safeFetch('/api/v0/orgs/:orgId/projects', {
  method: 'POST',
  params: { orgId: 'org_123' },
  body: { slug: 'frontend' },
})

// BAD
const res = await safeFetch('/api/v0/orgs/:orgId/projects', {
  method: 'POST',
  params: { orgId: 'org_123' },
  body: JSON.stringify({ slug: 'frontend' }),
  headers: { 'Content-Type': 'application/json' },
})
```

### Handling the response correctly

The return type is always `Error | Data`.

```ts
const res = await safeFetch('/api/v0/projects/:projectId/query', {
  method: 'POST',
  params: { projectId: 'proj_123' },
  body: { sql: 'SELECT 1' },
})

if (res instanceof Error) {
  throw res
}

console.log(res.rows)
console.log(res.data)
```

Do not skip the `instanceof Error` check.

### Cross-workspace imports

In a monorepo, import API types from **source files**, not built `dist/*.d.ts` files:

```ts
import type { App } from '@my-org/website/src/app.tsx'
```

This avoids build-order dependencies. The server doesn't need to build before the client can typecheck, which matters in CI where packages build in parallel.

The tradeoff is that tsc walks the server's full import graph and may hit unresolvable modules like `cloudflare:workers` or CSS imports. Fix these with a small ambient `.d.ts` stub in the client package:

```ts
// client/src/server-ambient.d.ts
declare module 'cloudflare:workers' {
  const env: any
  export { env }
}
declare module '*.css' {}
type ExportedHandler = any
```

Keep the server package as a `devDependency` of the client package for typechecking.

### Server-side requirements for good fetch inference

These server handlers infer well:

```ts
import { Spiceflow, json } from 'spiceflow'

export const app = new Spiceflow()
  .get('/api/health', () => {
    return { ok: true }
  })
  .route({
    method: 'POST',
    path: '/api/v0/projects/:projectId/query',
    async handler() {
      return { rows: 1, data: [{ value: 1 }] }
    },
  })
  .get('/api/not-found', () => {
    throw json({ message: 'not found' }, { status: 404 })
  })
```

These lose useful inference:

```ts
// BAD
return Response.json({ ok: true })

// BAD
return new Response('ok')
```

### Monorepo checklist

When typed fetch gets weird, check these first:

- server and client packages use the **same Spiceflow version**
- client imports the app type from **source files** with `import type`
- add ambient `.d.ts` stubs for unresolvable server-only modules (e.g. `cloudflare:workers`, `*.css`)
- client uses route patterns like `'/users/:id'` with `params`, never interpolated strings

</details>

## Headers

Set headers globally on the client, per request, or dynamically with a function. Per-request headers are merged with global headers.

```ts
import { createSpiceflowFetch } from 'spiceflow/client'

// Static global headers — sent with every request
const safeFetch = createSpiceflowFetch('http://localhost:3000', {
  headers: {
    Authorization: 'Bearer my-token',
    'X-Custom': 'value',
  },
})

// Per-request headers — merged on top of global headers
const result = await safeFetch('/users', {
  method: 'POST',
  body: { name: 'John' },
  headers: {
    'X-Request-Id': 'abc-123',
    'X-Idempotency-Key': 'unique-key',
  },
})

// Dynamic global headers — function called on every request
const authedFetch = createSpiceflowFetch('http://localhost:3000', {
  headers: (path, options) => ({
    Authorization: `Bearer ${getAccessToken()}`,
  }),
})

// Array of header sources — all merged in order
const multiFetch = createSpiceflowFetch('http://localhost:3000', {
  headers: [
    { 'X-App': 'my-app' },
    (path) => (path.startsWith('/admin') ? { 'X-Admin': 'true' } : {}),
  ],
})
```

## Hooks

Use `onRequest` and `onResponse` hooks for logging, retries, auth refresh, or response transformation. Both accept a single function or an array of functions.

`onResponse` receives a cloned `Response`. If the hook returns a **non-undefined value**, that value becomes the final result and default response parsing is skipped. Return `undefined` (or nothing) to fall through to normal parsing. This is useful for [custom serialization](custom-serialization.md) like superjson.

```ts
const safeFetch = createSpiceflowFetch('http://localhost:3000', {
  retries: 3,
  onRequest: (path, options) => {
    console.log(`→ ${options.method} ${path}`)
    // Return modified options, or void to keep original
    return options
  },
  onResponse: (response) => {
    console.log(`← ${response.status} ${response.url}`)
  },
})

// Multiple hooks run in order
const safeFetch2 = createSpiceflowFetch('http://localhost:3000', {
  onRequest: [
    (path, options) => {
      // Add timestamp header
      return {
        ...options,
        headers: { ...options.headers, 'X-Timestamp': Date.now().toString() },
      }
    },
    (path, options) => {
      console.log('Final request:', path, options.headers)
    },
  ],
})
```

## Path Matching

**Supported patterns:**

- **Named parameters**: `:param` - Captures dynamic segments like `/users/:id` or `/api/:version/users/:userId`
- **Wildcards**: `*` - Matches any remaining path segments like `/files/*` or `/proxy/*`. A wildcard route also matches the parent path without a trailing segment — `/files/*` matches both `/files/foo` and `/files`.
- **Catch-all routes**: `/*` - Matches any unmatched paths

**Unsupported patterns:**

- **Optional parameters**: `/:param?` - Use separate routes instead - IS NOT SUPPORTED
- **Named wildcards**: `/files/*name` - Use unnamed `*` only - IS NOT SUPPORTED
- **Partial parameters**: `/:param-suffix` or `/prefix-:param` - Use full segment parameters only - IS NOT SUPPORTED
- **Regex patterns**: `/users/(\\d+)` - Use string parameters with validation in handlers - IS NOT SUPPORTED
- **Multiple wildcards**: `/*/files/*` - Use single wildcard only - IS NOT SUPPORTED

## Fetch Client Errors

The fetch client returns `Error | Data` directly. When the server responds with a non-2xx status code, the client returns a `SpiceflowFetchError` instead of the data. Use `instanceof Error` to check:

- Responses with status codes 200-299 return the parsed data directly
- Responses with status codes < 200 or ≥ 300 return a `SpiceflowFetchError`
- The error has `status`, `value` (parsed response body), and `response` (raw Response) properties

```ts
// server.ts
import { Spiceflow } from 'spiceflow'

export const app = new Spiceflow()
  .route({
    method: 'GET',
    path: '/error',
    handler() {
      throw new Error('Something went wrong')
    },
  })
  .route({
    method: 'GET',
    path: '/unauthorized',
    handler() {
      return new Response('Unauthorized access', { status: 401 })
    },
  })
  .route({
    method: 'GET',
    path: '/success',
    handler() {
      throw new Response('Success message', { status: 200 })
      return ''
    },
  })

export type App = typeof app
```

```ts
// client.ts
import { createSpiceflowFetch } from 'spiceflow/client'

const safeFetch = createSpiceflowFetch('http://localhost:3000')

async function handleErrors() {
  const errorResult = await safeFetch('/error')
  if (errorResult instanceof Error) {
    console.error('Error occurred:', errorResult.message)
  }

  const unauthorizedResult = await safeFetch('/unauthorized')
  if (unauthorizedResult instanceof Error) {
    console.error(
      'Unauthorized:',
      unauthorizedResult.message,
      'Status:',
      unauthorizedResult.status,
    )
  }

  const successResult = await safeFetch('/success')
  if (successResult instanceof Error) return
  console.log('Success:', successResult) // 'Success message'
}
```

## Server-Side Fetch

You can pass the Spiceflow app instance directly to `createSpiceflowFetch()` instead of providing a URL. This makes "virtual" requests handled directly by the app without actual network requests. Useful for testing, generating documentation, or interacting with your API programmatically without setting up a server.

```tsx
import { Spiceflow } from 'spiceflow'
import { createSpiceflowFetch } from 'spiceflow/client'
import { openapi } from 'spiceflow/openapi'
import { writeFile } from 'node:fs/promises'

export const app = new Spiceflow()
  .use(openapi({ path: '/openapi' }))
  .route({
    method: 'GET',
    path: '/users',
    handler() {
      return [
        { id: 1, name: 'John' },
        { id: 2, name: 'Jane' },
      ]
    },
  })
  .route({
    method: 'POST',
    path: '/users',
    handler({ request }) {
      return request.json()
    },
  })

// Create fetch client by passing app instance directly
const safeFetch = createSpiceflowFetch(app)

// Get OpenAPI schema and write to disk
const data = await safeFetch('/openapi')
if (data instanceof Error) throw data
await writeFile('openapi.json', JSON.stringify(data, null, 2))
console.log('OpenAPI schema saved to openapi.json')
```

<details>
<summary>Fixing ts(2742) with SpiceflowFetch</summary>

When using `createSpiceflowFetch` and getting typescript error `The inferred type of '...' cannot be named without a reference to '...'. This is likely not portable. A type annotation is necessary. (ts 2742)`, you can resolve this issue by adding an explicit type for the client:

```ts
import type { SpiceflowFetch } from 'spiceflow/client'

export const f: SpiceflowFetch<App> = createSpiceflowFetch<App>(PUBLIC_URL)
```

</details>

## Type-Safe RPC

To maintain type safety when using the fetch client, **throw Response objects for errors** and **return objects directly for success cases**. The fetch client returns `Error | Data` directly — use `instanceof Error` to narrow the type:

```ts
import { Spiceflow } from 'spiceflow'
import { z } from 'zod'

export const app = new Spiceflow()
  .route({
    method: 'GET',
    path: '/users/:id',
    query: z.object({
      q: z.string(),
    }),
    response: z.object({
      id: z.string(),
      name: z.string(),
      email: z.string(),
    }),
    handler({ params }) {
      const user = getUserById(params.id)

      if (!user) {
        throw new Response('User not found', { status: 404 })
      }

      return {
        id: user.id,
        name: user.name,
        email: user.email,
      }
    },
  })
  .route({
    method: 'POST',
    path: '/users',
    request: z.object({
      name: z.string(),
      email: z.string().email(),
    }),
    response: z.object({
      id: z.string(),
      name: z.string(),
      email: z.string(),
    }),
    async handler({ request }) {
      const body = await request.json()

      if (await userExists(body.email)) {
        throw new Response('User already exists', { status: 409 })
      }

      const newUser = await createUser(body)

      return {
        id: newUser.id,
        name: newUser.name,
        email: newUser.email,
      }
    },
  })

export type App = typeof app
```

```ts
// client.ts
import { createSpiceflowFetch } from 'spiceflow/client'

const safeFetch = createSpiceflowFetch('http://localhost:3000')

// Path params are type-safe — TypeScript requires { id: string }
const user = await safeFetch('/users/:id', {
  params: { id: '123' },
  query: { q: 'something' },
})
if (user instanceof Error) {
  console.error('Error:', user.message)
  return
}
// user is typed as { id: string, name: string, email: string }
console.log('User:', user.name, user.email)

// Body is type-safe — TypeScript requires { name: string, email: string }
const newUser = await safeFetch('/users', {
  method: 'POST',
  body: { name: 'John', email: 'john@example.com' },
})
if (newUser instanceof Error) return newUser
console.log('Created:', newUser.id)
```

With this pattern:

- **Success responses**: Return objects directly for automatic JSON serialization and proper type inference
- **Error responses**: Throw `Response` objects — the fetch client returns a `SpiceflowFetchError` with `status`, `value`, and `response` properties
- **Type safety**: The fetch client gives you full type safety on **path params**, **query params**, **request body**, and **response data** — all inferred from your route definitions

## Path Building

`router.href()` provides a type-safe way to build URLs with parameters. It prevents runtime errors by ensuring all required parameters are provided and properly substituted into the path. Import `router` from `spiceflow/react`:

```ts
import { router } from 'spiceflow/react'
```

Type safety comes from the **register pattern**. Add `declare module 'spiceflow/react' { interface SpiceflowRegister { app: typeof app } }` at the bottom of your app entry file. This registers your app's route types globally, so `router.href()` knows every valid path, its params, and its query schema at compile time. Without the register block, `router.href()` still works at runtime but accepts any string.

```ts
import { router } from 'spiceflow/react'

router.href('/users/:id', { id: '123' })
// Result: '/users/123'

router.href('/users/:id/posts/:postId', { id: '456', postId: 'abc' })
// Result: '/users/456/posts/abc'
```

### Query Parameters

When a route has a `query` schema, `router.href()` accepts query parameters alongside path parameters in the same flat object. Query parameters are appended as a query string, and unknown keys are rejected at the type level:

```ts
router.href('/search', { q: 'hello', page: 1 })
// Result: '/search?q=hello&page=1'

router.href('/users/:id', { id: '42', fields: 'name' })
// Result: '/users/42?fields=name'

// @ts-expect-error - 'invalid' is not a known query key
router.href('/search', { invalid: 'x' })
```

<details>
<summary>OAuth callback example</summary>

`router.href()` is useful when building callback URLs for OAuth flows, where you need to construct URLs dynamically based on user data or session information:

```ts
import { router } from 'spiceflow/react'

const callbackUrl = new URL(
  router.href('/auth/callback/:provider/:userId', {
    provider: 'google',
    userId: '12345',
  }),
  'https://myapp.com',
).toString()

const oauthUrl =
  `https://accounts.google.com/oauth/authorize?` +
  `client_id=your-client-id&` +
  `redirect_uri=${encodeURIComponent(callbackUrl)}&` +
  `response_type=code&` +
  `scope=openid%20profile%20email`
```

</details>
