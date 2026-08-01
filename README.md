<div align='center' className='hidden w-full'>
    <br/>
    <br/>
    <br/>
    <h1>spiceflow</h1>
    <p>type safe API and React Server Components framework for Node, Bun, and Cloudflare</p>
    <br/>
    <br/>
</div>

Spiceflow is a type-safe API framework and full-stack React RSC framework focused on absolute simplicity. It works across all JavaScript runtimes: Node.js, Bun, and Cloudflare Workers. Read the source code on [GitHub](https://github.com/remorses/spiceflow).

## Features

- Full-stack React framework with React Server Components (RSC), server actions, layouts, and automatic client code splitting
- Works everywhere: Node.js, Bun, and Cloudflare Workers with the same code
- Type safe schema based validation via Zod
- Type safe fetch client with full inference on path params, query, body, and response
- Simple and intuitive API using web standard Request and Response
- Can easily generate OpenAPI spec based on your routes
- Support for [Model Context Protocol](https://modelcontextprotocol.io/) to easily wire your app with LLMs
- Supports async generators for streaming via server sent events
- Modular design with `.use()` for mounting sub-apps
- Built-in [OpenTelemetry](https://opentelemetry.io/) tracing with zero overhead when disabled

## Installation

```bash
npm install spiceflow@rsc
```

> [!IMPORTANT]
> Spiceflow is still in pre-release. Install with `spiceflow@rsc`, not `spiceflow@latest`.

## AI Agents

To let your AI coding agent know how to use spiceflow, run:

```bash
npx -y skills add remorses/spiceflow
```

## Basic Usage

API routes return JSON automatically. React pages use `.page()` and `.layout()` for server-rendered UI with client interactivity:

```tsx
import { Spiceflow } from 'spiceflow'
import { Counter } from './counter'

export const app = new Spiceflow()
  .get('/api/hello', () => {
    return { message: 'Hello, World!' }
  })
  .layout('/*', async ({ children }) => {
    return (
      <html>
        <body>{children}</body>
      </html>
    )
  })
  .page('/', async () => {
    return (
      <div>
        <h1>Home</h1>
        <Counter />
      </div>
    )
  })
  .page('/about', async () => {
    return <h1>About</h1>
  })

app.listen(3000)
```

<details>
<summary>When to use .route() vs .get()/.post()</summary>

Use `.route()` instead of `.get()`/`.post()` when you want to pass Zod schemas for validation — it accepts `request`, `response`, `query`, and `params` schemas.

</details>

## Two Ways to Use Spiceflow

Spiceflow works as a **standalone API framework** or as a **full-stack React framework** — same router, same type safety, same code.

**API only** — no Vite, no React. Just install `spiceflow` and build type-safe APIs with Zod validation, streaming, OpenAPI, and a type-safe fetch client:

```ts
import { Spiceflow } from 'spiceflow'

const app = new Spiceflow()
  .get('/hello', () => ({ message: 'Hello!' }))

app.listen(3000)
```

**Full-stack React (RSC)** — add the Vite plugin to get server components, client components, layouts, server actions, and automatic code splitting. All API features still work alongside React pages:

```ts
// vite.config.ts
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import spiceflow from 'spiceflow/vite'

export default defineConfig({
  plugins: [react(), spiceflow({ entry: './src/main.tsx' })],
})
```

## Route Chaining

To preserve full type safety on the fetch client, routes must be chained in a single expression. Declaring the app separately and adding routes later loses the inferred types.

<details>
<summary>Why chaining matters</summary>

When you declare routes separately, TypeScript can't infer the combined route types across multiple statements. The fetch client needs the full chain to infer path params, query params, body types, and response types.

```ts
// This is an example of what NOT to do when using Spiceflow

import { Spiceflow } from 'spiceflow'

// DO NOT declare the app separately and add routes later
export const app = new Spiceflow()

// Do NOT do this! Defining routes separately will lose type safety
app.get('/hello', () => {
  return 'Hello, World!'
})
// Do NOT do this! Adding routes separately like this will lose type safety
app.post('/echo', async ({ request }) => {
  const body = await request.json()
  return body
})
```

</details>

## Returning JSON

Spiceflow automatically serializes objects returned from handlers to JSON. Return plain objects directly — this is the preferred approach because the typed fetch client can infer the response type automatically:

```ts
import { Spiceflow } from 'spiceflow'

export const app = new Spiceflow()
  .get('/user', () => {
    // Preferred — return type is inferred by the typed fetch client
    return { id: 1, name: 'John', email: 'john@example.com' }
  })
  .post('/data', async ({ request }) => {
    const body = await request.json()
    return {
      received: body,
      timestamp: new Date().toISOString(),
      processed: true,
    }
  })
```

When you need to return a non-200 status code, use the `json()` helper instead of `Response.json()`. It works the same way at runtime but preserves the data type and status code in the type system — so the fetch client gets full type safety for each status code:

```ts
import { Spiceflow, json } from 'spiceflow'

// Preferred — type-safe, fetch client knows this is a 404 with { error: string }
throw json({ error: 'Not found' }, { status: 404 })

// Avoid — Response.json() erases the type, fetch client sees unknown
throw Response.json({ error: 'Not found' }, { status: 404 })
```

## Routes & Validation

Define routes with Zod schemas for automatic request and response validation. Use `.route()` with `request`, `response`, `query`, and `params` schemas for full type safety.

### Request Validation

```ts
import { z } from 'zod'
import { Spiceflow } from 'spiceflow'

new Spiceflow().route({
  method: 'POST',
  path: '/users',
  request: z.object({
    name: z.string(),
    email: z.string().email(),
  }),
  async handler({ request }) {
    const body = await request.json() // here body has type { name: string, email: string }
    return `Created user: ${body.name}`
  },
})
```

<details>
<summary>How body parsing works</summary>

To get the body of the request, call `request.json()` to parse the body as JSON. Spiceflow does not parse the body automatically — there is no `body` field in the route argument. Instead you call either `request.json()` or `request.formData()` to get the body and validate it at the same time. The returned data will have the correct schema type instead of `any`.

The `request` object in every handler and middleware is a `SpiceflowRequest`, which extends the standard Web `Request`. On top of the standard API, it adds:

- **`request.parsedUrl`** — a lazily cached `URL` object, so you don't need to write `new URL(request.url)` yourself. Accessing `.pathname`, `.searchParams`, etc. is one property access away
- **`request.json()` / `request.formData()`** — parse and validate the body against the route schema in one step, returning typed data instead of `any`
- **`request.originalUrl`** — the raw transport URL before Spiceflow normalizes `.rsc` pathnames

</details>

### Response Schema

```ts
import { z } from 'zod'
import { Spiceflow } from 'spiceflow'

new Spiceflow().route({
  method: 'GET',
  path: '/users/:id',
  request: z.object({
    name: z.string(),
  }),
  response: z.object({
    id: z.number(),
    name: z.string(),
  }),
  async handler({ request, params }) {
    const typedJson = await request.json() // this body will have the correct type
    return { id: Number(params.id), name: typedJson.name }
  },
})
```

### Typed Error Responses

When a route declares a status-code response map, use the `json()` helper from `spiceflow` to return or throw non-200 responses with full type safety. Unlike `Response.json()`, `json()` carries the data type and status code through the type system — so TypeScript validates that the status code exists in the response schema and the body matches the declared shape.

```ts
import { Spiceflow, json } from 'spiceflow'
import { z } from 'zod'

new Spiceflow().route({
  method: 'GET',
  path: '/users/:id',
  response: {
    200: z.object({ id: z.string(), name: z.string() }),
    404: z.object({ error: z.string() }),
  },
  handler({ params }) {
    const user = findUser(params.id)
    if (!user) {
      // TypeScript validates: 404 is in the response map, and { error: string } matches the 404 schema
      throw json({ error: 'not found' }, { status: 404 })
    }
    return { id: user.id, name: user.name }
  },
})
```

If you pass a status code that's not in the response map, or a body that doesn't match the schema for that status, `tsc` reports an error:

```ts
// @ts-expect-error — 500 is not in the response schema
throw json({ error: 'server error' }, { status: 500 })

// @ts-expect-error — number doesn't match { error: string } for 404
throw json(42, { status: 404 })
```

The fetch client picks up these types automatically — each non-200 status becomes a typed `SpiceflowFetchError` with the exact body shape. See [Preserving Client Type Safety](./website/src/openapi.md#preserving-client-type-safety) for the full client-side pattern.

## Middleware

Middleware functions run before route handlers. They can log, authenticate, modify responses, or short-circuit the request entirely.

```ts
import { Spiceflow } from 'spiceflow'

new Spiceflow().use(({ request }) => {
  console.log(`Received ${request.method} request to ${request.parsedUrl.pathname}`)
})
```

### Mounted Apps

Middleware is scoped to the app where you register it. **Parent app middleware runs for child sub-app routes too**, but **sub-app middleware does not run for parent or sibling routes**.

```ts
import { Spiceflow } from 'spiceflow'

const admin = new Spiceflow({ basePath: '/admin' })
  .use(() => {
    console.log('admin only')
  })
  .get('/users', () => 'users')

new Spiceflow()
  .use(() => {
    console.log('root')
  })
  .use(admin)
  .get('/health', () => 'ok')

// GET /admin/users -> runs "root" and "admin only"
// GET /health      -> runs only "root"
```

If you want a mounted app's middleware to run for **every** request, create that mounted app with `scoped: false`:

```ts
const globalMiddleware = new Spiceflow({ scoped: false }).use(({ request }) => {
  console.log(request.parsedUrl.pathname)
})

new Spiceflow().use(globalMiddleware)
```

### Response Modification

Call `next()` to get the response from downstream handlers, then modify it before sending:

```ts
import { Spiceflow } from 'spiceflow'

new Spiceflow()
  .use(async ({ request }, next) => {
    const response = await next()
    if (response) {
      // Add a custom header to all responses
      response.headers.set('X-Powered-By', 'Spiceflow')
    }
    return response
  })
  .route({
    method: 'GET',
    path: '/example',
    handler() {
      return { message: 'Hello, World!' }
    },
  })
```

### Static Files

Use `serveStatic()` to serve files from a directory:

```ts
import { Spiceflow, serveStatic } from 'spiceflow'

export const app = new Spiceflow()
  .use(serveStatic({ root: './public' }))
  .route({
    method: 'GET',
    path: '/health',
    handler() {
      return { ok: true }
    },
  })
  .route({
    method: 'GET',
    path: '/*',
    handler() {
      return new Response('Not Found', { status: 404 })
    },
  })
```

Static middleware only serves `GET` and `HEAD` requests. It checks the exact file path first, and if the request points to a directory it tries `index.html` inside that directory.

<details>
<summary>Priority rules</summary>

- Concrete routes win over static files. A route like `/health` is handled by the route even if `public/health` exists.
- Static files win over root catch-all routes like `/*` and `*`.
- If static does not find a file, the request falls through to the next matching route.
- When multiple static middlewares are registered, they are checked in registration order. The first middleware that finds a file wins.

Example behavior:

```text
request /logo.png
  -> router matches `/*`
  -> static checks `public/logo.png`
  -> if file exists, static serves it
  -> otherwise the `/*` route runs
```

Directory requests without an `index.html` fall through instead of throwing filesystem errors like `EISDIR`.

</details>

You can stack multiple static roots:

```ts
export const app = new Spiceflow()
  .use(serveStatic({ root: './public' }))
  .use(serveStatic({ root: './uploads' }))
```

In this example, `./public/logo.png` wins over `./uploads/logo.png` because `./public` is registered first.

> Vite client build assets (`dist/client`) are served automatically in production — no need to register a `serveStatic` middleware for them.

### Static Routes (Pre-rendered)

Use `.staticGet()` to define API routes that are **pre-rendered at build time** and served as static files. The handler runs once during `vite build`, and the response body is written to `dist/client/` so it can be served directly without hitting the server at runtime:

```ts
export const app = new Spiceflow()
  .staticGet('/api/manifest.json', () => ({
    name: 'my-app',
    version: '1.0.0',
    features: ['rsc', 'streaming'],
  }))
  .staticGet('/robots.txt', () =>
    new Response('User-agent: *\nAllow: /', {
      headers: { 'content-type': 'text/plain' },
    }),
  )
```

In development, `staticGet` routes behave like normal `.get()` handlers — the handler runs on every request. At build time, Spiceflow calls each handler and writes the output to disk. The route path should include a file extension (`.json`, `.xml`, `.txt`) so the static file server can detect the correct MIME type.

For authorization, proxy, non-blocking auth, cookies, and graceful shutdown patterns, see [Middleware Patterns](./website/src/middleware-patterns.md).

## Error Handling

When a route handler or middleware throws an error, Spiceflow catches it and returns a JSON response with the error message and stack trace. **By default, unhandled errors are also logged to the console** with `Spiceflow unhandled error:` so you can see what went wrong during development.

Use `.onError()` to customize error handling. Registering an `.onError` callback **replaces the default logging**, so errors are only handled by your callback:

```ts
import { Spiceflow } from 'spiceflow'

const app = new Spiceflow()
  .get('/users/:id', async ({ params }) => {
    const user = await findUser(params.id)
    if (!user) throw Object.assign(new Error('User not found'), { status: 404 })
    return user
  })
  .onError(({ error, path }) => {
    // Custom error handling replaces default console.error logging
    console.error(`Error on ${path}:`, error.message)
    return new Response('Something went wrong', { status: 500 })
  })
```

If you return a `Response` from `.onError`, it becomes the response for that request. If you don't return anything, Spiceflow falls back to its default JSON error response (but skips the default logging since you have a handler registered).

To silence error logs entirely (useful in tests), register a no-op handler:

```ts
const app = new Spiceflow()
  .get('/test', () => { throw new Error('expected') })
  .onError(() => {})
```

Errors with a `status` property (or `statusCode`) are used as the HTTP status code. Invalid or out-of-range status codes are normalized to 500:

```ts
// Returns 400 Bad Request
throw Object.assign(new Error('Invalid input'), { status: 400 })
```

## Async Generators (Streaming)

Route handlers that are **async generators** automatically produce a Server-Sent Events response. Each `yield` sends a `data: ...\n\n` chunk to the client. Works with `.get()`, `.post()`, and `.route()`.

```ts
// server.ts
import { Spiceflow } from 'spiceflow'

export const app = new Spiceflow().route({
  method: 'GET',
  path: '/api/progress',
  async *handler() {
    yield { status: 'generating', progress: 0.5 }
    await someWork()
    yield { status: 'done', progress: 1.0 }
  },
})

export type App = typeof app
```

The typed fetch client detects async generator routes and returns an `AsyncGenerator` instead of a plain object. TypeScript infers the yield type automatically via `ReplaceGeneratorWithAsyncGenerator` in the type system.

```ts
// client.ts
import { createSpiceflowFetch } from 'spiceflow/client'

const safeFetch = createSpiceflowFetch('http://localhost:3000')

const stream = await safeFetch('/api/progress')
if (stream instanceof Error) throw stream

// stream is AsyncGenerator<{ status: string, progress: number }>
for await (const event of stream) {
  console.log(event.status, event.progress)
}
```

### Aborting a Stream

Pass an `AbortController` signal to cancel the stream. The server stops the generator and cleans up.

```ts
const controller = new AbortController()

// abort after 5 seconds
setTimeout(() => controller.abort(), 5000)

const stream = await safeFetch('/api/progress', {
  signal: controller.signal,
})
if (stream instanceof Error) throw stream

for await (const event of stream) {
  console.log(event)
}
// loop exits cleanly on abort, no error thrown
```

With **curl**, use `-N` to disable buffering and stream events line by line:

```bash
curl -N http://localhost:3000/api/progress
```

## Not Found Handler

For API routes (`.route()`, `.get()`, etc.), use `/*` as a catch-all to handle unmatched requests. For React pages, use `children === null` in a layout instead (see [Redirects and Not Found](#redirects-and-not-found)). More specific routes always take precedence regardless of registration order:

```ts
import { Spiceflow } from 'spiceflow'

export const app = new Spiceflow()
  .route({
    method: 'GET',
    path: '/users',
    handler() {
      return { users: [] }
    },
  })
  .route({
    method: 'GET',
    path: '/users/:id',
    handler({ params }) {
      return { id: params.id }
    },
  })
  // Catch-all for unmatched GET requests
  .route({
    method: 'GET',
    path: '/*',
    handler() {
      return new Response('Page not found', { status: 404 })
    },
  })
  // Or use .all() to catch any method
  .route({
    method: '*',
    path: '/*',
    handler({ request }) {
      return new Response(`Cannot ${request.method} ${request.parsedUrl.pathname}`, {
        status: 404,
      })
    },
  })

// Specific routes work as expected
// GET /users returns { users: [] }
// GET /users/123 returns { id: '123' }
// GET /unknown returns 'Page not found' with 404 status
```

> [!IMPORTANT]
> Do **not** use named wildcards like `*filePath`. Only bare `*` is supported. Named wildcards silently fail to match any request. Access the wildcard value via `params['*']` instead.

## Mounting Sub-Apps

```ts
import { Spiceflow } from 'spiceflow'
import { z } from 'zod'

const mainApp = new Spiceflow()
  .route({
    method: 'POST',
    path: '/users',
    async handler({ request }) {
      return `Created user: ${(await request.json()).name}`
    },
    request: z.object({
      name: z.string(),
    }),
  })
  .use(
    new Spiceflow().route({
      method: 'GET',
      path: '/',
      handler() {
        return 'Users list'
      },
    }),
  )
```

## Base Path

For standalone API servers (without Vite), set the base path in the constructor:

```ts
import { Spiceflow } from 'spiceflow'

export const app = new Spiceflow({ basePath: '/api/v1' })
app.route({
  method: 'GET',
  path: '/hello',
  handler() {
    return 'Hello'
  },
}) // Accessible at /api/v1/hello
```

### Vite Base Path

When using Spiceflow as a full-stack RSC framework with Vite, configure the base path via Vite's `base` option instead of the constructor:

```ts
// vite.config.ts
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import spiceflow from 'spiceflow/vite'

export default defineConfig({
  base: '/my-app',
  plugins: [react(), spiceflow({ entry: 'src/main.tsx' })],
})
```

<details>
<summary>Base path rules</summary>

The base path must be an absolute path starting with `/`. CDN URLs and relative paths are not supported.

Do not set `basePath` in the Spiceflow constructor when using Vite — Spiceflow will throw an error if both are set. The Vite `base` option is the single source of truth.

</details>

<details>
<summary>What gets auto-prepended and what doesn't</summary>

**What gets the base path auto-prepended:**

- `Link` component `href` — `<Link href="/dashboard" />` automatically renders as `<a href="/my-app/dashboard">`. If the href already includes the base prefix, it is not added again (`<Link href="/my-app/dashboard" />` stays as-is). To disable auto-prepending entirely, use the `rawHref` prop: `<Link rawHref href="/docs/docs" />` — useful when your path legitimately starts with the same string as the base
- `redirect()` Location header — `redirect("/login")` sends `Location: /my-app/login`
- `router.push()` and `router.replace()` — `router.push("/settings")` navigates to `/my-app/settings`
- `router.pathname` — returns the path **without** the base prefix (e.g. `/dashboard`, not `/my-app/dashboard`)
- Static asset URLs (`<script>`, `<link>` CSS tags) — handled automatically by Vite
- `serveStatic` file resolution — strips the base prefix before looking up files on disk

**What does NOT get auto-prepended:**

- Raw `<a href="/path">` tags (not using the `Link` component) — use `Link` instead
- External URLs and protocol-relative URLs (`//cdn.com/...`) — left as-is
- `fetch()` calls inside your app code — you need to construct the URL yourself
- `request.url` and `request.parsedUrl` in middleware — contain the full URL including the base prefix

</details>

## Fetch Client

`createSpiceflowFetch` provides a type-safe `fetch(path, options)` interface for calling your Spiceflow API. It gives you full type safety on **path params**, **query params**, **request body**, and **response data** — all inferred from your route definitions.

Export the app type from your server code:

```ts
// server.ts
import { Spiceflow } from 'spiceflow'
import { z } from 'zod'

export const app = new Spiceflow()
  .route({
    method: 'GET',
    path: '/hello',
    handler() {
      return 'Hello, World!'
    },
  })
  .route({
    method: 'POST',
    path: '/users',
    request: z.object({
      name: z.string(),
      email: z.string().email(),
    }),
    async handler({ request }) {
      const body = await request.json()
      return { id: '1', name: body.name, email: body.email }
    },
  })
  .route({
    method: 'GET',
    path: '/users/:id',
    handler({ params }) {
      return { id: params.id }
    },
  })
  .route({
    method: 'GET',
    path: '/search',
    query: z.object({ q: z.string(), page: z.coerce.number().optional() }),
    handler({ query }) {
      return { results: [], query: query.q, page: query.page }
    },
  })
  .route({
    method: 'GET',
    path: '/stream',
    async *handler() {
      yield 'Start'
      yield 'Middle'
      yield 'End'
    },
  })

export type App = typeof app
```

Then use `createSpiceflowFetch` on the client side — when `SpiceflowRegister` is set, the fetch client is fully typed without importing server code:

```ts
// client.ts
import { createSpiceflowFetch } from 'spiceflow/client'

const safeFetch = createSpiceflowFetch('http://localhost:3000')

// GET request — returns Error | Data, check with instanceof Error
const greeting = await safeFetch('/hello')
if (greeting instanceof Error) return greeting
console.log(greeting) // 'Hello, World!' — TypeScript knows the type

// POST with typed body — TypeScript requires { name: string, email: string }
const user = await safeFetch('/users', {
  method: 'POST',
  body: { name: 'John', email: 'john@example.com' },
})
if (user instanceof Error) return user
console.log(user.id, user.name, user.email) // fully typed

// Path params — type-safe, TypeScript requires { id: string }
const foundUser = await safeFetch('/users/:id', {
  params: { id: '123' },
})
if (foundUser instanceof Error) return foundUser
console.log(foundUser.id) // typed as string

// Query params — typed from the route's Zod schema
const searchResults = await safeFetch('/search', {
  query: { q: 'hello', page: 1 },
})
if (searchResults instanceof Error) return searchResults
console.log(searchResults.results, searchResults.query) // fully typed

// Streaming — async generator routes return an AsyncGenerator
const stream = await safeFetch('/stream')
if (stream instanceof Error) return stream
for await (const chunk of stream) {
  console.log(chunk) // 'Start', 'Middle', 'End'
}
```

The fetch client returns `Error | Data` directly following the [errore](https://errore.org) convention — use `instanceof Error` to check for errors with Go-style early returns, then the happy path continues with the narrowed data type. No `{ data, error }` destructuring, no null checks. On error, the returned `SpiceflowFetchError` has `status`, `value` (the parsed error body), and `response` (the raw Response object) properties.

You can set **headers** both globally (on the client) and per request:

```ts
// Global headers — sent with every request
const safeFetch = createSpiceflowFetch('http://localhost:3000', {
  headers: {
    Authorization: 'Bearer my-token',
  },
})

// Per-request headers — merged with global headers
const result = await safeFetch('/users', {
  headers: { 'X-Request-Id': '123' },
})

// Dynamic global headers with a function
const safeFetch2 = createSpiceflowFetch('http://localhost:3000', {
  headers: (path, options) => ({
    Authorization: `Bearer ${getToken()}`,
  }),
})
```

The client also supports **onRequest/onResponse hooks**, **retries**, and a **custom fetch** function. If `onResponse` returns a non-undefined value, it replaces the default response parsing (useful for [custom serialization](./website/src/custom-serialization.md)):

```ts
const safeFetch = createSpiceflowFetch('http://localhost:3000', {
  retries: 3,
  onRequest: (path, options) => {
    console.log(`→ ${options.method} ${path}`)
    return options
  },
  onResponse: (response) => {
    console.log(`← ${response.status}`)
  },
})
```

You can also pass a Spiceflow app instance directly for server-side usage without network requests:

```ts
const safeFetch = createSpiceflowFetch(app)
const greeting = await safeFetch('/hello')
if (greeting instanceof Error) throw greeting
```

For path matching patterns, error handling, server-side fetch, type-safe RPC, and path building, see **[Fetch Client (Advanced)](./website/src/fetch-client.md)**. To support types like `Date`, `Map`, `Set`, and `BigInt` across the wire, see **[Custom Serialization](./website/src/custom-serialization.md)**.

## OpenAPI

Spiceflow can generate a full OpenAPI 3.1 document from your routes without any extra configuration. Mount the `openapi` plugin and every route you registered on the app is picked up automatically — the same Zod schemas that validate the request and type the handler context are also the source of `parameters`, `requestBody`, and `responses` in the emitted document.

```ts
import { openapi } from 'spiceflow/openapi'
import { Spiceflow } from 'spiceflow'
import { z } from 'zod'

export const app = new Spiceflow()
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

const openapiSchema = await (
  await app.handle(new Request('http://localhost:3000/openapi.json'))
).json()
```

Every route accepts a **`detail`** field that is spread as-is into the OpenAPI operation object. Use it to add tags, summaries, descriptions, or any other [OpenAPI Operation](https://spec.openapis.org/oas/v3.1.0#operation-object) field:

```ts
app.route({
  method: 'POST',
  path: '/users',
  request: z.object({ name: z.string() }),
  response: z.object({ id: z.string() }),
  detail: {
    tags: ['users'],
    summary: 'Create a user',
    description: 'Creates a new user in the current organization.',
    operationId: 'createUser',
  },
  handler({ request }) {
    return { id: 'usr_123' }
  },
})
```

For status-code response maps, centralized error responses with `onError`, shared Zod schemas across routes, hiding internal routes from the document, writing markdown descriptions with `string-dedent`, generating a local `openapi.json` file from a script, and preserving fetch client type safety with thrown error responses, see [OpenAPI docs](./website/src/openapi.md).

## Adding CORS Headers

```ts
import { cors } from 'spiceflow/cors'
import { Spiceflow } from 'spiceflow'

export const app = new Spiceflow().use(cors()).route({
  method: 'GET',
  path: '/hello',
  handler() {
    return 'Hello, World!'
  },
})
```

## Server Lifecycle

`listen()` returns an object with `port`, `server`, and `stop()` for programmatic control:

```ts
const listener = await app.listen(3000)

console.log(`Listening on port ${listener.port}`)

await listener.stop()
```

> In Vite dev and during prerender, Spiceflow skips starting a real server. `listen()` still returns an object, but `port` and `server` are `undefined` and `stop()` is a noop, so cleanup code can stay unconditional.

## Graceful Shutdown

The `preventProcessExitIfBusy` middleware prevents platforms like Fly.io from killing your app while processing long requests. See [Middleware Patterns](./website/src/middleware-patterns.md#graceful-shutdown) for usage.

## Tracing (OpenTelemetry)

Spiceflow has built-in OpenTelemetry tracing. Pass a `tracer` to the constructor and every request gets automatic spans for middleware, handlers, loaders, layouts, pages, and RSC serialization. Server timing is enabled by default when a tracer is provided, exposing those spans as a `Server-Timing` response header in Chrome DevTools with nested descriptions like `handler - /users/:id > db.query`. Set `serverTiming: false` to disable it. Handlers can also read `traceId` and `spanId` from `span.spanContext?.()` when the tracer supports it. See [Tracing docs](./website/src/tracing.md) for setup, span trees, custom spans, and examples. If you use Strada as your OTel backend, see [Observability with Strada](./website/src/strada.md).

## Testing

Test your spiceflow app directly with vitest. No browser, no build step, sub-second feedback. Call `app.handle()` on routes, call server actions as plain functions, and assert on responses.

```ts
import { createSpiceflowFetch } from 'spiceflow/client'
import { SpiceflowTestResponse } from 'spiceflow/testing'
import { app } from './main.js'

const f = createSpiceflowFetch(app)

// API routes return typed JSON
const data = await f('/api/hello')
expect(data).toEqual({ message: 'Hello, World!' })

// Page routes return SpiceflowTestResponse with rendered HTML
const res = await f('/about')
if (!(res instanceof SpiceflowTestResponse)) throw new Error('expected page')
expect(await res.text()).toContain('About')
expect(res.loaderData).toEqual({ ... })
```

The spiceflow Vite plugin auto-detects vitest and configures everything. Server actions become plain callable functions, middleware runs before pages, and `.state()` lets you inject test doubles for databases and services without mocking modules. See the full [Testing guide](./website/src/testing.md) for authentication patterns, stateful workflows, and dependency injection.

## React Framework (RSC)

Spiceflow includes a full-stack React framework built on React Server Components (RSC). It uses Vite with `@vitejs/plugin-rsc` under the hood. Server components run on the server by default, and you use `"use client"` to mark interactive components that need to run in the browser.

### Setup

Install the dependencies and create a Vite config:

```bash
npm install spiceflow@rsc react react-dom
```

```ts
// vite.config.ts
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import spiceflow from 'spiceflow/vite'

export default defineConfig({
  plugins: [
    react(),
    spiceflow({
      entry: './src/main.tsx',
    }),
  ],
})
```

### Cloudflare RSC Setup

For Cloudflare Workers deployment with RSC, see [Cloudflare docs](./website/src/cloudflare.md). See [`example-cloudflare/`](https://github.com/remorses/spiceflow/tree/main/example-cloudflare) for a complete working example.

### Tailwind CSS

Install `@tailwindcss/vite` and `tailwindcss`, then add the Vite plugin:

```bash
npm install @tailwindcss/vite tailwindcss
```

```ts
// vite.config.ts
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
import spiceflow from 'spiceflow/vite'

export default defineConfig({
  plugins: [
    spiceflow({ entry: './src/main.tsx' }),
    react(),
    tailwindcss(),
  ],
})
```

Create a `globals.css` file with Tailwind and any CSS variables you need:

```css
/* src/globals.css */
@import 'tailwindcss';

:root {
  --radius: 0.625rem;
  --background: var(--color-white);
  --foreground: var(--color-neutral-800);
}
```

Import it at the top of your app entry so styles apply globally:

```tsx
// src/main.tsx
import './globals.css'
import { Spiceflow } from 'spiceflow'

export const app = new Spiceflow()
  .layout('/*', async ({ children }) => {
    return (
      <html>
        <body className="bg-white dark:bg-gray-900 text-black dark:text-white">
          {children}
        </body>
      </html>
    )
  })
  .page('/', async () => {
    return (
      <div className="flex flex-col items-center gap-4 p-8">
        <h1 className="text-4xl font-bold">Welcome</h1>
      </div>
    )
  })
```

### shadcn/ui

Spiceflow works with [shadcn/ui](https://ui.shadcn.com) out of the box. Instead of the usual `tsconfig.json` paths hack (`@/*`), use `package.json` `exports` for component imports — it's a standard Node.js feature that works across runtimes and lets other workspace packages import your components too. See [shadcn docs](./website/src/shadcn.md) for the full setup guide and [`example-shadcn/`](https://github.com/remorses/spiceflow/tree/main/example-shadcn) for a working example.

### App Entry

The entry file defines your routes using `.page()` for pages and `.layout()` for layouts. This file runs in the RSC environment on the server. Keep the route chain focused on handlers and move type-safe link building into components or other modules.

```tsx
// src/main.tsx
import { Spiceflow, serveStatic } from 'spiceflow'
import { router, Head, Link } from 'spiceflow/react'
import { z } from 'zod'
import { Counter } from './app/counter'
import { Nav } from './app/nav'

export const app = new Spiceflow()
  .use(serveStatic({ root: './public' }))
  .layout('/*', async ({ children }) => {
    return (
      <html>
        <Head>
          <Head.Meta charSet="UTF-8" />
        </Head>
        <body>
          <Nav />
          {children}
        </body>
      </html>
    )
  })
  .page('/', async () => {
    const data = await fetchSomeData()
    return (
      <div>
        <h1>Welcome</h1>
        <p>Server-rendered data: {data.message}</p>
        <Counter />
        <Link href={router.href('/users/:id', { id: '42' })}>View User 42</Link>
        <Link href={router.href('/search', { q: 'spiceflow' })}>Search</Link>
      </div>
    )
  })
  .page('/about', async () => {
    return (
      <div>
        <h1>About</h1>
        <Link href={router.href('/')}>Back to Home</Link>
      </div>
    )
  })
  .page('/users/:id', async ({ params }) => {
    return (
      <div>
        <h1>User {params.id}</h1>
      </div>
    )
  })
  // Object-style .page() with query schema — enables type-safe query params
  .page({
    path: '/search',
    query: z.object({ q: z.string(), page: z.number().optional() }),
    handler: async ({ query }) => {
      const results = await search(query.q, query.page)
      return (
        <div>
          <h1>Results for "{query.q}"</h1>
          {results.map((r) => (
            <p key={r.id}>{r.title}</p>
          ))}
        </div>
      )
    },
  })
  .listen(3000)

// Register the app type for type-safe routing everywhere
declare module 'spiceflow/react' {
  interface SpiceflowRegister { app: typeof app }
}
```

`router.href()` gives you **type-safe links** in component modules and other files outside the route chain. TypeScript validates that the path exists, params are correct, and query values match the schema. Invalid paths or missing params are caught at compile time.

Add the `declare module` block at the bottom of your app entry file. This registers your app's routes globally — then `import { router } from 'spiceflow/react'` anywhere in the project gives you a fully typed router without needing to pass generics or import the app type.

<details>
<summary>Avoid router inside loaders and API route handlers</summary>

Do not import or use `router` inside `.loader()`, `.get()`, `.post()`, or `.route()` handlers in the same file that initializes `export const app = new Spiceflow()`. The router type is derived from `typeof app`, while those handlers feed return types back into `typeof app` through loader data or typed API responses, so TypeScript can report recursive circular errors like TS7022.

Using `router.href()` for links inside `.page()` and `.layout()` JSX is okay in simple app entries because their rendered JSX does not feed app route metadata the same way. If a loader-heavy app still hits a circular `typeof app` error, move the link UI into a component module until the router type is split from loader data.

Context `redirect()` intentionally accepts a plain `string`. Do not pass `router.href()` into redirects inside app-entry handlers (`.page()`, `.layout()`, etc.) — redirect return values participate in handler return inference and can reintroduce the circular type path in loader-heavy apps. Standalone `"use server"` action files (separate from the app entry) are safe to use `router.href()` since they do not feed return types back into `typeof app`.

</details>

### Layouts

Define a root `.layout('/*', ...)` with the document shell (`<html>`, `<head>`, `<body>`). More specific layouts should only return shared parent UI like sidebars, nav, or section chrome — not another `<html>` shell. Wildcard layouts also match their base path, so `/app/*` wraps both `/app` and `/app/settings`.

```tsx
export const app = new Spiceflow()
  .layout('/*', async ({ children }) => {
    return (
      <html>
        <body>{children}</body>
      </html>
    )
  })
  .layout('/app/*', async ({ children }) => {
    return <section className="app-shell">{children}</section>
  })
  .layout('/docs/*', async ({ children }) => {
    return <section className="docs-shell">{children}</section>
  })
  .page('/app', async () => {
    return <h1>App home</h1>
  })
  .page('/app/settings', async () => {
    return <h1>App settings</h1>
  })
  .page('/docs', async () => {
    return <h1>Docs home</h1>
  })
  .page('/docs/getting-started', async () => {
    return <h1>Getting started</h1>
  })
```

<details>
<summary>Nesting rules</summary>

Only the root layout should render the full HTML document shell. If a nested layout also renders `<html>`, the shell repeats and you end up nesting full HTML documents inside each other. Only add scoped layouts when many pages share the same parent components.

</details>

### SEO

Use `<Head>`, `<Head.Title>`, and `<Head.Meta>` from `spiceflow/react` for type-safe, automatically deduplicated head tags that are correctly injected during SSR. Page tags override layout tags with the same key.

Every page should have a `<Head.Title>` and a `<Head.Meta name="description">`. These are the two most important tags for SEO — they control what appears in search engine results.

<details>
<summary>Title and description guidelines</summary>

**Title:** Keep titles under 60 characters so they don't get truncated in search results. Put the most important keywords first. Use a consistent format like `Page Name | Site Name`.

**Description:** Keep descriptions between 120–160 characters. Summarize the page content clearly — this is the snippet shown below the title in search results. Each page should have a unique description that accurately reflects its content.

Always use `<Head>`, `<Head.Title>`, and `<Head.Meta>` from `spiceflow/react` instead of raw `<head>`, `<title>`, and `<meta>` tags. The `Head` components are type-safe, automatically deduplicated (page tags override layout tags with the same key), and correctly injected into the document head during SSR.

</details>

```tsx
.page('/', async () => {
  return (
    <div>
      <Head>
        <Head.Title>Spiceflow – Build Type-Safe APIs</Head.Title>
        <Head.Meta name="description" content="A fast, type-safe API and RSC framework for TypeScript." />
      </Head>
      <h1>Welcome</h1>
    </div>
  )
})
```

If you want a consistent title prefix or suffix across all pages, create a wrapper component:

```tsx
function PageHead({ title, description }: { title: string; description: string }) {
  return (
    <Head>
      <Head.Title>{title} | My App</Head.Title>
      <Head.Meta name="description" content={description} />
    </Head>
  )
}

// Then use it in any page
.page('/about', async () => {
  return (
    <div>
      <PageHead title="About" description="Learn more about our team and mission." />
      <h1>About</h1>
    </div>
  )
})
```

### Query Params

Define a `query` schema on routes and pages that accept query parameters — even when all params are optional. Use the object notation for `.page()` and `.route()` so the query requirements are documented in the route definition and accessible with full type safety in the handler:

```tsx
import { Spiceflow } from 'spiceflow'
import { z } from 'zod'

export const app = new Spiceflow()
  // Object notation gives you typed query access
  .page({
    path: '/products',
    query: z.object({
      category: z.string().optional(),
      sort: z.enum(['price', 'name', 'date']).optional(),
      page: z.coerce.number().optional(),
    }),
    handler: async ({ query }) => {
      // query.category is string | undefined — fully typed
      // query.sort is 'price' | 'name' | 'date' | undefined
      // query.page is number | undefined
      const products = await getProducts(query)
      return (
        <div>
          <h1>Products</h1>
          {products.map((p) => <p key={p.id}>{p.name}</p>)}
        </div>
      )
    },
  })
```

<details>
<summary>Why always define a query schema</summary>

Without a query schema, `query` is `Record<string, string | undefined>` — you lose autocomplete, typos go unnoticed, and there's no documentation of what the page accepts.

Always define a `query` schema on routes and pages that accept query parameters. Use `href()` to build links to these pages — when a route has a query schema, `href` enforces the correct query keys at compile time. If you rename or remove a query param from the schema, every `href()` call that references it becomes a type error — no stale links.

</details>

**Use `href()` to build links to these pages.** When a route has a query schema, `href` enforces the correct query keys at compile time. If you rename or remove a query param from the schema, every `href()` call that references it becomes a type error — no stale links:

```tsx
'use client'
import { router, Link } from 'spiceflow/react'

export function ProductFilters() {
  return (
    <nav>
      {/* TypeScript validates these query keys against the schema */}
      <Link href={router.href('/products', { category: 'shoes', sort: 'price' })}>
        Shoes by Price
      </Link>
      <Link href={router.href('/products', { sort: 'date', page: 2 })}>
        Page 2, newest first
      </Link>

      {/* @ts-expect-error — 'color' is not in the query schema */}
      <Link href={router.href('/products', { color: 'red' })}>Red</Link>
    </nav>
  )
}
```

The same pattern works for API routes with `.route()`. Query params are automatically coerced from strings to match the schema type — you don't need `z.coerce.number()`, just use `z.number()` directly:

```tsx
export const app = new Spiceflow()
  .route({
    method: 'GET',
    path: '/api/search',
    query: z.object({
      q: z.string(),
      limit: z.number().optional(),
      offset: z.number().optional(),
    }),
    handler({ query }) {
      // query.q is string, query.limit is number | undefined
      return searchDatabase(query.q, query.limit, query.offset)
    },
  })
```

**Array query params** use repeated keys in the URL: `?tag=a&tag=b` (not comma-separated). Single values are automatically wrapped into arrays when the schema expects `z.array()`:

```tsx
// URL: /api/posts?tag=react or /api/posts?tag=react&tag=typescript
export const app = new Spiceflow().route({
  method: 'GET',
  path: '/api/posts',
  query: z.object({
    tag: z.array(z.string()),
    limit: z.number().optional(),
  }),
  handler({ query }) {
    // query.tag is always string[], even with a single ?tag=react
    // query.limit is number | undefined, coerced from the string automatically
    return getPostsByTags(query.tag)
  },
})
```

### Client Components

Mark interactive components with `"use client"` at the top of the file. These are hydrated in the browser and can use hooks like `useState`.

```tsx
// src/app/counter.tsx
'use client'

import { useState } from 'react'

export function Counter() {
  const [count, setCount] = useState(0)
  return (
    <div>
      <p>Count: {count}</p>
      <button onClick={() => setCount(count + 1)}>+</button>
    </div>
  )
}
```

### Don't export plain objects from `'use client'` files

In RSC, the entire module marked with `'use client'` becomes an opaque client reference on the server. You can render client component references as JSX, but you **cannot spread or iterate** them. If a server component imports a plain object (like a component map or config) from a `'use client'` file and tries to spread it, the spread produces nothing.

```tsx
// BAD: server component can't spread this
// my-components.tsx
'use client'
import { useState } from 'react'
function Counter() { /* ... uses useState */ }
function P({ children }) { return <p className="prose">{children}</p> }
export const components = { p: P, counter: Counter }

// GOOD: keep the map in a server-compatible file
// counter.tsx
'use client'
export function Counter() { /* ... uses useState */ }

// my-components.tsx (no 'use client')
import { Counter } from './counter'
function P({ children }) { return <p className="prose">{children}</p> }
export const components = { p: P, counter: Counter }
```

Only components that use browser-only APIs (hooks, DOM refs) need `'use client'`. Pure JSX, config objects, and component maps must stay in server-compatible modules. Import individual client components into the server module, not the other way around.

### Loaders

Loaders run on the server before page and layout handlers. They solve a common problem: when you need the same data in both server components and client components, or in both a layout and a page, without prop drilling or React context.

Prefer putting route data in loaders when that data is shared by more than one part of the route tree. This keeps fetching in one place, avoids fetching the same data once in a layout and again in a page, and lets React components read the current route data directly instead of receiving long prop chains.

**Use loaders instead of passing route data through props.** Props are still great for local UI state, callbacks, and reusable primitives like `<Button variant="ghost" />`, but route data should usually come from `useLoaderData()`. This avoids prop drilling, keeps components movable, and stays type safe because the hook is inferred from the route loader path.

Split data by route ownership instead of making one parent loader parse every URL. Put data that every dashboard page needs in `/dashboard/*`, data that every project page needs in `/dashboard/projects/:projectId/*`, and page-only data next to the page route. Components can call `useLoaderData()` multiple times when they need data from multiple loader levels.

Calling `useLoaderData()` is cheap. It reads the already-loaded request data from React context, so different components and different React trees can call it directly without causing extra loader executions or extra network requests. Do not centralize loader data into a custom props object just to pass it back down through the tree. That pattern repeats the loader return type by hand and can drift out of sync. Prefer calling `useLoaderData('/route/pattern')` where the data is needed, so TypeScript keeps the component shape linked to the real loader return value.

If a parent layout rarely needs to know a child route param, use the web-standard `URLPattern` API instead of a hand-written regex. This is most useful for parent chrome that must sit above several child layouts, like tabs that span both the sidebar and content frame. Prefer splitting layouts and loaders cleanly so you do not need this pattern in normal route trees.

```tsx
export const app = new Spiceflow()
  .loader('/dashboard/*', async ({ request }) => {
    const projectId = new URLPattern({ pathname: '/dashboard/projects/:projectId/*' })
      .exec(request.url)?.pathname.groups.projectId ?? null

    const user = await getUser(request)

    return { user, projectId }
  })
  .layout('/dashboard/*', async ({ loaderData, children }) => {
    return (
      <DashboardShell>
        {loaderData.projectId && <ProjectTabs projectId={loaderData.projectId} />}
        {children}
      </DashboardShell>
    )
  })
```

Loaders only run for requests that also match a `.page()` or `.layout()`. They are not standalone endpoints. If you want to serve content without rendering a page or layout, use `.get()`, `.route()`, or another API handler instead.

```tsx
export const app = new Spiceflow()
  .page('/login', async () => <Login />)
  // Auth loader for the dashboard route
  .loader('/dashboard', async ({ request, redirect }) => {
    const user = await getUser(request.headers.get('cookie'))
    if (!user) throw redirect('/login')
    return { user }
  })
  // Page-specific loader
  .loader('/dashboard', async () => {
    const stats = await getStats()
    return { stats }
  })
  .layout('/dashboard', async ({ loaderData, children }) => {
    // loaderData.user is available here from the dashboard loader
    return (
      <html>
        <body>
          <nav>{loaderData.user.name}</nav>
          {children}
        </body>
      </html>
    )
  })
  .page('/dashboard', async ({ loaderData }) => {
    // Both loaders matched, data is merged by specificity
    // loaderData = { user: ..., stats: ... }
    return <Dashboard />
  })
```

A Remix-style dashboard can put shared shell data in a parent loader, project data in a nested loader, then page data in loaders placed next to each page. The layout, page, and client components all read from the same request-scoped loader data without threading props through every layer:

```tsx
export const app = new Spiceflow()
  .loader('/dashboard/*', async ({ request }) => {
    const user = await getUser(request)
    const projects = await getProjects(user.id)
    return { user, projects }
  })
  .layout('/dashboard/*', async ({ children }) => {
    return <DashboardShell>{children}</DashboardShell>
  })
  .loader('/dashboard/projects/:projectId/*', async ({ params }) => {
    const project = await getProject(params.projectId)
    const environments = await getProjectEnvironments(params.projectId)
    return { project, environments }
  })
  .loader('/dashboard/projects/:projectId/secrets', async ({ params }) => {
    const secrets = await getSecrets(params.projectId)
    return { secrets }
  })
  .page('/dashboard/projects/:projectId/secrets', async () => {
    return <SecretsPage />
  })

declare module 'spiceflow/react' {
  interface SpiceflowRegister { app: typeof app }
}
```

```tsx
// src/app/dashboard-shell.tsx
'use client'

import { useLoaderData } from 'spiceflow/react'
import type { ReactNode } from 'react'

export function DashboardShell({ children }: { children: ReactNode }) {
  const { user, projects } = useLoaderData('/dashboard/*')
  return (
    <div>
      <aside>
        <p>{user.name}</p>
        {projects.map((project) => <a key={project.id} href={project.href}>{project.name}</a>)}
      </aside>
      <main>{children}</main>
    </div>
  )
}
```

```tsx
// src/app/secrets-page.tsx
'use client'

import { useLoaderData } from 'spiceflow/react'

export function SecretsPage() {
  const { project, environments } = useLoaderData('/dashboard/projects/:projectId/*')
  const { secrets } = useLoaderData('/dashboard/projects/:projectId/secrets')

  return (
    <section>
      <h1>{project.name}</h1>
      <p>{environments.length} environments</p>
      <SecretsTable />
    </section>
  )
}

export function SecretsTable() {
  const { secrets } = useLoaderData('/dashboard/projects/:projectId/secrets')
  return secrets.map((secret) => <div key={secret.id}>{secret.name}</div>)
}
```

Prefer this over prop drilling route data through every component:

```tsx
// Avoid this for route data. It grows brittle as pages get deeper.
export function SecretsPage({ project, environments, secrets }) {
  return <SecretsTable secrets={secrets} />
}
```

The loader version is type safe end to end. If you rename `secrets` to `secretRows` in the loader, every `useLoaderData('/dashboard/projects/:projectId/secrets')` call that still reads `secrets` becomes a TypeScript error.

```tsx
// More specific loaders can still read merged data when that is simpler.
export function ProjectHeader() {
  const { user, project } = useLoaderData('/dashboard/projects/:projectId/*')
  return <h1>{project.name} for {user.name}</h1>
}
```

When you need only one loader level, read only that level:

```tsx
export function ProjectSwitcher() {
  const { projects } = useLoaderData('/dashboard/*')
  return projects.map((project) => <a href={project.href}>{project.name}</a>)
}
```

```tsx
// Server routes can still read loaderData directly when rendering simple markup.
export const app = new Spiceflow()
  .loader('/account', async ({ request }) => {
    const user = await getUser(request)
    return { user }
  })
  .page('/account', async ({ loaderData }) => {
    return <h1>{loaderData.user.name}</h1>
  })
```

Loaders are a route-data boundary, not a replacement for every prop. Keep props for local state and component options. Use loaders for server data tied to the current route.

When multiple loaders match a route (e.g. `/*` and `/dashboard` both match `/dashboard`), their return values are merged into a single flat object. More specific loaders override less specific ones on key conflicts.

Loader data is type safe when the app is registered globally with `SpiceflowRegister`. `useLoaderData('/dashboard/projects/:id')` and `router.getLoaderData('/dashboard/projects/:id')` infer the merged object returned by every matching loader, so renaming a loader field or removing it becomes a TypeScript error in every component that reads it.

**Serialization**: loader return values are serialized through the React RSC flight format, not JSON. You can return JSX (including server components and client component elements with their props), `Promise`, async iterators, `Map`, `Set`, `Date`, `BigInt`, typed arrays, and any client component reference — all deserialized faithfully on the client. This means a loader can return a fully rendered `<Sidebar user={user} />` element and another component can receive it as `loaderData.sidebar` and drop it into the tree.

**Reading loader data in client components** uses the `useLoaderData` hook from `spiceflow/react`:

```tsx
// src/app/sidebar.tsx
'use client'

import { useLoaderData } from 'spiceflow/react'

export function Sidebar() {
  // Type-safe: path narrows the return type to the loaders matching '/dashboard'
  const { user, stats } = useLoaderData('/dashboard')
  return (
    <aside>
      {user.name} — {stats.totalViews} views
    </aside>
  )
}
```

Loader data updates automatically on client-side navigation — when the user navigates to a new route, the server re-runs the matching loaders and the new data arrives atomically with the new page content via the RSC flight stream.

**Reading loader data imperatively** uses the `router` import. This works in client code outside React components and during active server render. Call it inside component scope, event handlers, or helper functions tied to the current render flow instead of binding request-sensitive access at module scope:

```tsx
// src/app/editor-toolbar.tsx
'use client'

import { router, useLoaderData } from 'spiceflow/react'

async function readCurrentDocument() {
  return router.getLoaderData('/editor/:id')
}

export function EditorToolbar() {
  const { document } = useLoaderData('/editor/:id')

  async function refresh() {
    const next = await readCurrentDocument()
    console.log(next.document.title)
  }

  return <button onClick={refresh}>{document.title}</button>
}
```

### Streaming with `use()`

Loaders can return an unawaited `Promise` to start a slow fetch without blocking the page render. The promise travels through the RSC flight stream to the client, where a `'use client'` component calls `use(promise)` inside a `<Suspense>` boundary. The page HTML is sent immediately with the fallback; the real content streams in once the promise settles.

```tsx
// src/main.tsx
import { Suspense } from 'react'
import { HeavyStats } from './app/heavy-stats'

app
  .loader('/dashboard', async ({ request }) => {
    const user = await getUser(request)         // fast, awaited — blocks nothing
    const statsPromise = getExpensiveStats()    // slow, NOT awaited — streams later
    return { user, statsPromise }
  })
  .page('/dashboard', async ({ loaderData }) => {
    return (
      <div>
        <h1>Welcome {loaderData.user.name}</h1>
        <Suspense fallback={<p>Loading stats…</p>}>
          <HeavyStats statsPromise={loaderData.statsPromise} />
        </Suspense>
      </div>
    )
  })
```

```tsx
// src/app/heavy-stats.tsx
'use client'

import { use } from 'react'

export function HeavyStats({ statsPromise }: { statsPromise: Promise<Stats> }) {
  const stats = use(statsPromise)   // suspends here until the promise resolves
  return <div>{stats.totalViews} views</div>
}
```

The mechanics: the loader finishes immediately after `getUser()`, so the page server component renders and the RSC flight stream starts. The `statsPromise` is serialized into the stream as a pending promise reference. On the client, `use(statsPromise)` suspends `HeavyStats` and React shows the `<Suspense>` fallback. When the promise resolves on the server, the result is flushed into the same flight stream and React replaces the fallback with the real component — no extra HTTP round-trip.

This is faster than `await getExpensiveStats()` in the loader because the page skeleton reaches the browser immediately instead of waiting for the slow fetch to finish before any HTML is sent.

**Error handling**: if a loader throws a `redirect()` or `notFound()`, the entire request short-circuits — the page handler never runs. If a loader throws any other error, it renders through the nearest error boundary instead of showing a blank page.

### Parallel Data Fetching

Spiceflow already parallelizes at the framework level — all matched loaders run concurrently, then layouts and the page render concurrently after loaders finish. Within a single handler, use `Promise.all` for independent fetches instead of sequential `await`s:

```tsx
.page('/dashboard', async () => {
  const [user, posts, analytics] = await Promise.all([
    getUser(),
    getPosts(),
    getStats(),
  ])
  return <Dashboard user={user} posts={posts} analytics={analytics} />
})
```

### Forms & Server Actions

Forms use React 19's `<form action>` with server functions marked `"use server"`. They work before JavaScript loads (progressive enhancement).

Forms also support normal browser submissions when `action` is a string URL. This is standard HTML behavior in Spiceflow: the browser submits the form to the URL and performs a full document navigation.

```tsx
.page('/search', async () => {
  return (
    <form method="get" action="/results">
      <input name="q" />
      <button type="submit">Search</button>
    </form>
  )
})
```

Prefer a server or client action when the form should feel app-like. Passing a function to `action` lets React handle submission in a transition instead of doing a full browser reload. A server action can mutate data, then automatically re-render the current page with fresh server data or throw the handler context `redirect` to navigate. A client action can update local state, call APIs, or schedule a client navigation with `router.push()` / `router.replace()`.

```tsx
<form action={saveSettings}>
  <input name="name" />
  <Button type="submit">Save</Button>
</form>
```

**Every server action call automatically re-renders the current page with fresh server data.** This applies to forms, client wrapper functions, and direct imported server action calls. The re-render happens via React reconciliation, so client component state is preserved. No manual `router.refresh()` needed after a server action.

Every submit button should show a loading state while its form action is in progress. Use `useFormStatus` from `react-dom` in your Button component to auto-detect pending forms — the button shows a spinner automatically when it's inside a `<form>` with a pending action:

Prefer file-level `"use server"` (a dedicated file like `src/actions.tsx`) over inline `"use server"` inside function bodies. Inline is fine for simple form actions defined directly in a server component page, or when the action needs the handler context `redirect`. If you find yourself passing actions as props to client components, import them from a `"use server"` file instead — it keeps action logic centralized and reusable.

```tsx
// src/app/button.tsx
'use client'
import { useFormStatus } from 'react-dom'

export function Button({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const { pending } = useFormStatus()
  const loading = props.type === 'submit' && pending
  return (
    <button disabled={loading} {...props}>
      {loading ? 'Loading...' : children}
    </button>
  )
}
```

Then use it in forms — no manual loading state needed. Use `parseFormData` to validate form fields with a Zod schema, and `schema.keyof().enum` for type-safe input `name` attributes (typos become compile errors):

```tsx
import { z } from 'zod'
import { parseFormData } from 'spiceflow'
import { Button } from './app/button'

const subscribeSchema = z.object({ email: z.string().email() })
const fields = subscribeSchema.keyof().enum

.page('/thank-you', async () => <ThankYou />)
.page('/subscribe', async ({ redirect }) => {
  async function subscribe(formData: FormData) {
    'use server'
    const { email } = parseFormData(subscribeSchema, formData)
    await addSubscriber(email)
    throw redirect('/thank-you')
  }
  return (
    <form action={subscribe}>
      <input name={fields.email} type="email" required />
      <Button type="submit">Subscribe</Button>
    </form>
  )
})
```

Use `useActionState` to display return values from the action. The action receives the previous state as its first argument and `FormData` as the second:

```tsx
// src/actions.tsx
'use server'

import { z } from 'zod'
import { parseFormData } from 'spiceflow'

export const subscribeSchema = z.object({ email: z.string().email() })

export async function subscribe(prev: string, formData: FormData) {
  const { email } = parseFormData(subscribeSchema, formData)
  await addSubscriber(email)
  return `Subscribed ${email}!`
}
```

```tsx
// src/app/newsletter.tsx
'use client'
import { useActionState } from 'react'
import { Button } from './button'
import { subscribeSchema } from '../actions'

const fields = subscribeSchema.keyof().enum

export function NewsletterForm({
  action,
}: {
  action: (prev: string, formData: FormData) => Promise<string>
}) {
  const [message, formAction] = useActionState(action, '')
  return (
    <form action={formAction}>
      <input name={fields.email} type="email" required />
      <Button type="submit">Subscribe</Button>
      {message && <p>{message}</p>}
    </form>
  )
}
```

```tsx
// In your server component page
.page('/newsletter', async () => {
  return <NewsletterForm action={subscribe} />
})
```

Server actions called directly from client event handlers also trigger the same automatic re-render:

```tsx
// src/actions.ts
'use server'

export async function deletePost(id: string) {
  await db.posts.delete(id)
}
```

```tsx
// src/app/delete-button.tsx
'use client'

import { deletePost } from '../actions'

export function DeleteButton({ id }: { id: string }) {
  return (
    <button
      onClick={async () => {
        await deletePost(id)
        // page re-renders automatically — no router.refresh() needed
      }}
    >
      Delete
    </button>
  )
}
```

#### Action Buttons Without FormData

When a server action takes **no arguments** (or only typed arguments, not `FormData`), skip the `<form>` wrapper entirely. Use `useTransition` for pending state instead of `useFormStatus` (which requires a parent `<form>`):

```tsx
// src/app/checkout-button.tsx
'use client'

import { useTransition } from 'react'
import { startCheckout } from '../actions'

export function CheckoutButton() {
  const [pending, startTransition] = useTransition()
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => startTransition(() => startCheckout())}
    >
      {pending ? 'Redirecting...' : 'Subscribe'}
    </button>
  )
}
```

This is simpler than wrapping in a `<form action={startCheckout}>` with `useFormStatus()`, and avoids layout issues caused by the extra `<form>` element. Use `<form>` only when you actually need `FormData` (input fields) or progressive enhancement (works before JS loads).

<details>
<summary>Avoid deadlocks in client form actions</summary>

`router.refresh()` is fire-and-forget. Do not build awaitable navigation or refresh helpers and then use them inside a React client form action (`<form action={async () => { ... }}>`). React keeps that form action transition pending until the action returns, so awaiting the refresh or navigation commit from inside the action can deadlock the page.

</details>

### Progress Bar

Render `<ProgressBar />` once in the root layout. For manual client-side async work, wrap the call in `ProgressBar.start()` / `ProgressBar.end()`:

```tsx
// src/main.tsx
import { Spiceflow } from 'spiceflow'
import { ProgressBar } from 'spiceflow/react'
import { SaveButton } from './app/save-button'

export const app = new Spiceflow().layout('/*', async ({ children }) => {
  return (
    <html>
      <body>
        <ProgressBar />
        {children}
        <SaveButton />
      </body>
    </html>
  )
})

// src/app/save-button.tsx
'use client'

import { ProgressBar } from 'spiceflow/react'

export function SaveButton() {
  return (
    <button
      onClick={async () => {
        ProgressBar.start()
        try {
          await fetch('/api/save', { method: 'POST' })
        } finally {
          ProgressBar.end()
        }
      }}
    >
      Save
    </button>
  )
}
```

Manual calls share the same state as router navigation, so if a navigation and a client fetch overlap, the bar stays visible until both have finished.

<details>
<summary>React export shape</summary>

Do not mix React component exports with non-React exports like `const`, `Context`, or plain helper functions in the same public module. That can break HMR / Fast Refresh because the module stops behaving like a pure component module.

If a component needs imperative helpers, attach them as static properties on the component instead of exporting separate helpers. For example, prefer `ProgressBar.start()` / `ProgressBar.end()` over standalone `startProgressBar()` or `endProgressBar()` exports.

</details>

If a server action throws, the error is caught by the nearest `ErrorBoundary`. The error message is preserved (sanitized to strip secrets) and displayed to the user in both development and production builds.

### Error Handling

Use `ErrorBoundary` from `spiceflow/react` to catch errors from form actions. It provides `ErrorBoundary.ErrorMessage` and `ErrorBoundary.ResetButton` sub-components that read the error and reset function from context — so they work as standalone elements anywhere in the `fallback` tree.

Actions should **throw errors** instead of returning error strings. Return **objects** for rich success data instead of scalars. Use `parseFormData` for validation — it throws a `ValidationError` when the schema fails, which `ErrorBoundary` catches automatically:

```tsx
// src/actions.ts
'use server'

import { z } from 'zod'
import { parseFormData } from 'spiceflow'

export const postSchema = z.object({ title: z.string().min(1, 'Title is required') })

export async function createPost(formData: FormData) {
  const { title } = parseFormData(postSchema, formData)
  const post = await db.posts.create({ title })
  return { id: post.id }
}
```

```tsx
// src/app/create-post.tsx
'use client'

import { ErrorBoundary } from 'spiceflow/react'
import { createPost, postSchema } from '../actions'

const fields = postSchema.keyof().enum

export function CreatePostForm() {
  return (
    <ErrorBoundary
      fallback={
        <div>
          <ErrorBoundary.ErrorMessage className="text-red-500" />
          <ErrorBoundary.ResetButton>Try again</ErrorBoundary.ResetButton>
        </div>
      }
    >
      <form action={createPost}>
        <input name={fields.title} required />
        <Button type="submit">Create</Button>
      </form>
    </ErrorBoundary>
  )
}
```

`ErrorBoundary.ErrorMessage` renders a `<div>` with `white-space: pre-wrap` and `ErrorBoundary.ResetButton` renders a `<button>`. Both accept all their respective HTML element props via `...props` spread, so you can pass `className`, `style`, `data-testid`, etc. Long error messages are **truncated** to 10 lines by default with a "Show more" toggle. Override with `<ErrorBoundary.ErrorMessage maxLines={5} />`.

**ErrorBoundary catches errors from three sources:**

| Source | Where it runs | ErrorBoundary catches? |
|---|---|---|
| Server action throws | Server | Yes |
| `parseFormData` in a server action (no try/catch) | Server | Yes (`ValidationError` propagates) |
| `parseFormData` in a client form action | Browser | Yes (thrown inside React's form action transition) |

When the form action throws, the `ErrorBoundary` catches the error, hides the form, and renders the `fallback` with the error message and a reset button. Clicking "Try again" restores the form. The error boundary also auto-resets when the user navigates to a different page.

The recommended pattern is to run `parseFormData` **client-side** inside the form action, then call the server action with the validated data. This gives instant validation feedback without a server round-trip, and the `ValidationError` is still caught by `ErrorBoundary`:

```tsx
// src/app/create-contact.tsx
'use client'

import { parseFormData } from 'spiceflow'
import { ErrorBoundary } from 'spiceflow/react'
import { contactSchema } from '../schemas'
import { createContact } from '../actions'

const fields = contactSchema.keyof().enum

export function CreateContactForm() {
  return (
    <ErrorBoundary fallback={...}>
      <form action={async (formData: FormData) => {
        const data = parseFormData(contactSchema, formData) // client-side validation
        await createContact(data)                           // server action
      }}>
        <input name={fields.name} />
        <input name={fields.email} type="email" />
        <Button type="submit">Create</Button>
      </form>
    </ErrorBoundary>
  )
}
```

#### Error Position: `above` and `below`

By default, `ErrorBoundary` **replaces** the form with the fallback when an error occurs. This causes layout shift and the user loses sight of their filled inputs. Use `above` or `below` to keep the form visible and interactive alongside the error message:

```tsx
<ErrorBoundary below fallback={
  <div className="text-red-500">
    <ErrorBoundary.ErrorMessage />
    <ErrorBoundary.ResetButton>Dismiss</ErrorBoundary.ResetButton>
  </div>
}>
  <form action={submitForm}>
    <input name={fields.name} />
    <Button type="submit">Save</Button>
  </form>
</ErrorBoundary>
```

`below` puts the error **below** the form. `above` puts it **above**. The form stays fully interactive; the user can fix their inputs and resubmit directly without clicking reset first. This works because form action errors don't invalidate the children's render tree; the error comes from the action, not from rendering.

For **direct action calls** (onClick handlers, not forms), use try/catch since the error doesn't propagate through React's rendering. Wrap in `startTransition` if you want pending state (`isPending`) and non-blocking behavior while the server data loads:

```tsx
import { useTransition } from 'react'

function DeleteButton({ id }: { id: string }) {
  const [isPending, startTransition] = useTransition()
  return (
    <button
      disabled={isPending}
      onClick={() => {
        startTransition(async () => {
          try {
            await deletePost({ id })
          } catch (e) {
            alert(e.message)
          }
        })
      }}
    >
      {isPending ? 'Deleting...' : 'Delete'}
    </button>
  )
}
```

### Redirecting After Actions

When a server action needs to navigate to a different page (e.g. after creating a resource), use `redirect` inside the action instead of `router.push()` on the client. Since every server action triggers a page re-render, calling `router.push()` after the action would briefly flash the re-rendered current page before navigating away.

In standalone `"use server"` action files, always wrap the redirect target with `router.href()` for type safety — TypeScript will catch invalid paths and missing params at compile time:

```tsx
// src/actions.ts
'use server'

import { redirect } from 'spiceflow'
import { router } from 'spiceflow/react'
import { parseFormData } from 'spiceflow'
import type { z } from 'zod'
import { projectSchema } from './schemas.ts'

export async function createProject(formData: FormData) {
  const { name } = parseFormData(projectSchema, formData)
  const project = await db.projects.create({ name })
  // router.href validates the path and params against the route table at compile time
  throw redirect(router.href('/orgs/:orgId/projects/:projectId', {
    orgId: project.orgId,
    projectId: project.id,
  }))
}
```

For inline actions defined directly inside a `.page()` or `.layout()` handler (in the same file as `export const app`), use the handler context `redirect` with a plain string or the `params` option instead. The `router.href()` type reads from `typeof app`, which can create a circular TypeScript error when used inside an app-entry handler:

```tsx
import { Spiceflow, parseFormData } from 'spiceflow'
import { z } from 'zod'

const projectSchema = z.object({ name: z.string().min(1) })
const fields = projectSchema.keyof().enum

export const app = new Spiceflow()
  .page('/orgs/:orgId/projects/:projectId', async ({ params }) => {
    const project = await db.projects.find(params.projectId)
    return <ProjectPage project={project} />
  })
  .page('/orgs/:orgId/projects/new', async ({ params, redirect }) => {
    async function createProject(formData: FormData) {
      'use server'
      const { name } = parseFormData(projectSchema, formData)
      const project = await db.projects.create({ name, orgId: params.orgId })
      // Use plain string redirect inside app-entry inline actions to avoid circular types
      throw redirect('/orgs/:orgId/projects/:projectId', {
        params: { orgId: params.orgId, projectId: project.id },
      })
    }

    return (
      <form action={createProject}>
        <input name={fields.name} required />
        <button type="submit">Create</button>
      </form>
    )
  })
```

`router.push()`, `router.replace()`, `router.back()`, `router.forward()`, and `router.go()` are still the right choice for pure client-side navigation that doesn't involve a server action (e.g. tab switches, select dropdowns, back buttons). These APIs are all fire-and-forget — do not build awaitable wrappers around navigation commits and then call them inside a React client form action.

#### Setting Cookies from Server Actions

Server actions **can set cookies**: pass `headers` as the second argument to `redirect()`. The browser stores the `set-cookie` header from the action response, the router follows the redirect client-side, and loaders re-run with the new cookie — no full page reload needed. Never create a GET route + `window.location.href` full-page navigation just to set a cookie.

```tsx
// src/actions.ts
'use server'

import { redirect } from 'spiceflow'
import { router } from 'spiceflow/react'

export async function switchOrg({ orgId }: { orgId: string }) {
  await assertMembership(orgId)
  throw redirect(router.href('/dashboard'), {
    headers: {
      'set-cookie': `active_org=${orgId}; Path=/; HttpOnly; SameSite=Lax`,
    },
  })
}
```

### Router

Import `router` from `spiceflow/react` for type-safe navigation, URL building, and imperative loader data access. It works in **client components, server components, non-route modules, page handlers, and layout handlers**. Avoid using it inside `.loader()`, `.get()`, `.post()`, or `.route()` handlers in the app entry file because those handler return types feed back into `typeof app` and can create recursive circular TypeScript errors while `app` is being inferred. `useLoaderData` and `useRouterState` are exported separately from `spiceflow/react`.

`router` is a **stable singleton** — the same object reference every time. It's safe to use in component bodies, pass to hook dependency arrays, or reference at module scope. The reference never changes between renders, so it won't trigger unnecessary re-renders or effect re-runs.

Use `href()` for links so route and query changes are caught by TypeScript.

```tsx
// src/app/nav.tsx
'use client'

import { router, Link } from 'spiceflow/react'

export function Nav() {

  return (
    <nav>
      <Link href={router.href('/')}>Home</Link>
      <Link href={router.href('/about')}>About</Link>
      <Link href={router.href('/users/:id', { id: '1' })}>User 1</Link>
      <Link href={router.href('/search', { q: 'docs', page: 1 })}>Search Docs</Link>
    </nav>
  )
}
```

<details>
<summary>Using router in mounted sub-apps</summary>

`router` sees all routes registered on the root app, regardless of where you import it. Component modules used by mounted sub-apps still see the whole route table — not just the sub-app's own routes:

```tsx
// src/features/billing/billing-page.tsx
import { router, Link } from 'spiceflow/react'

export function BillingPage() {
  // router is typed against the WHOLE app, not just billingApp
  return (
    <div>
      <h1>Billing</h1>
      {/* Link to a route defined in a different sub-app */}
      <Link href={router.href('/users/:id', { id: '42' })}>Back to profile</Link>
    </div>
  )
}
```

No need to thread `app` through props or imports — every import is still fully type-checked against the root app's route table.

</details>

Wildcard routes like `/orgs/:orgId/*` accept **template literals** with interpolated values. TypeScript template literal types ensure only strings matching a registered route pattern are accepted:

```tsx
// Pattern form — pass params as an object
router.href('/orgs/:orgId/*', { orgId: 'acme', '*': 'projects' })
// → "/orgs/acme/projects"

// Template literal form — params already in the string
const orgId = 'acme'
router.href(`/orgs/${orgId}/projects`)
// → "/orgs/acme/projects"

// Works with any depth under the wildcard
const projectId = 'p1'
router.href(`/orgs/${orgId}/projects/${projectId}/settings`)
// → "/orgs/acme/projects/p1/settings"
```

The pattern form gives the strongest type checking — param names, query keys, and route existence are all validated. The template literal form is checked against registered route prefixes, but once values are interpolated TypeScript no longer knows the original param names. Invalid prefixes like `/settings/foo` still error at compile time either way.

`router` works on the server too — use it in server components to build type-safe links without needing the `app` closure:

```tsx
// src/app/org-breadcrumb.tsx (server component — no "use client")
import { router, Link } from 'spiceflow/react'

export async function OrgBreadcrumb({ orgId }: { orgId: string }) {
  return (
    <nav>
      <Link href={router.href('/')}>Home</Link>
      <span> / </span>
      <Link href={router.href(`/orgs/${orgId}/projects`)}>Projects</Link>
    </nav>
  )
}
```

<details>
<summary>Always use href() for links</summary>

Every `Link` href and every programmatic navigation path should go through `href()`. Raw string paths like `<Link href="/users/42">` bypass type checking — if the route is renamed from `/users/:id` to `/profiles/:id`, the raw string silently becomes a 404 while `href('/users/:id', { id: '42' })` immediately fails `tsc`. When a route path changes or gets removed, `tsc` catches every stale `href()` call at compile time.

This applies to client and server component modules. The `router` import is the same typed singleton everywhere outside loaders and API route handlers.

</details>

### Navigation & State

The `router` object handles type-safe client-side navigation. `router.push`, `router.replace`, and `router.href` accept typed paths with autocomplete — params and query values are validated at compile time:

```tsx
// src/app/search-filters.tsx
'use client'

import { router, useRouterState } from 'spiceflow/react'

export function SearchFilters() {
  const { pathname, searchParams } = useRouterState()

  const query = searchParams.get('q') ?? ''
  const page = Number(searchParams.get('page') ?? '1')
  const sort = searchParams.get('sort') ?? 'relevance'

  function setPage(n: number) {
    router.push({
      search: '?' + new URLSearchParams({ q: query, page: String(n), sort }),
    })
  }

  function setSort(newSort: string) {
    router.push({
      search: '?' + new URLSearchParams({ q: query, page: '1', sort: newSort }),
    })
  }

  return (
    <div>
      <p>
        Showing results for "{query}" — page {page}, sorted by {sort}
      </p>
      <button onClick={() => setSort('date')}>Sort by Date</button>
      <button onClick={() => setPage(page + 1)}>Next Page</button>
    </div>
  )
}
```

`useRouterState()` subscribes to navigation changes and re-renders the component when the URL changes. It returns the current `pathname`, `search`, `hash`, and a parsed `searchParams` (a read-only `URLSearchParams`).

You can also navigate to a different pathname with search params, or use `router.replace` to update without adding a history entry:

```tsx
import { router } from 'spiceflow/react'

function Example() {

  // Navigate to a new path with search params
  router.push({
    pathname: '/search',
    search: '?' + new URLSearchParams({ q: 'spiceflow' }),
  })

  // Replace current history entry (back button skips this)
  router.replace({
    search: '?' + new URLSearchParams({ tab: 'settings' }),
  })

  // Or just use a plain string
  router.push('/search?q=spiceflow&page=1')
}
```

<details>
<summary>Navigation methods are fire-and-forget</summary>

`router.push()`, `router.replace()`, `router.back()`, `router.forward()`, and `router.go()` schedule navigation and return immediately. Do not wrap them in helpers that wait for the next navigation commit and then call those helpers from a React client form action — React keeps the form action transition pending until the action returns, so awaiting that same commit can deadlock the page.

</details>

### Type-Safe Routing

Spiceflow uses a **type registry** pattern (similar to TanStack Router) for type-safe routing. Add this one line at the bottom of your app entry file to enable type safety across all public APIs:

```tsx
// src/main.tsx
import { Spiceflow } from 'spiceflow'

export const app = new Spiceflow()
  .page('/login', async () => 'login')
  .page('/users/:id', async ({ params }) => <div>User {params.id}</div>)
  .page('/settings', async () => 'settings')

// Register the app type globally
declare module 'spiceflow/react' {
  interface SpiceflowRegister { app: typeof app }
}
```

After this, **all typed APIs** are fully typed everywhere, no generics needed:

```tsx
// spiceflow/react exports
import { router, useLoaderData, useRouterState } from 'spiceflow/react'

router.href('/login')                    // ✅ valid
router.href('/users/:id', { id: '42' }) // ✅ params validated
router.href('/nonexistent')              // ❌ compile error

const data = useLoaderData('/dashboard') // ✅ typed loader data
const state = useRouterState()           // ✅ typed router state

// spiceflow/client exports
import { createSpiceflowFetch } from 'spiceflow/client'
const f = createSpiceflowFetch('http://localhost:3000') // ✅ typed fetch
```

Some apps have valid routes that are not part of `typeof app` — mounted sub-apps, docs generators, or external route tables. Declare them with the optional `knownPaths` property, a string union of extra paths that flows into `router.href()`, `<Link>`, `router.push()`, and `router.replace()`. Param patterns (`:slug`) and wildcards (`*`) work like regular routes:

```tsx
declare module 'spiceflow/react' {
  interface SpiceflowRegister {
    app: typeof app
    knownPaths: '/docs' | '/docs/:slug' | '/files/*'
  }
}

router.href('/docs')                          // ✅ valid
router.href('/docs/:slug', { slug: 'intro' }) // ✅ params validated
router.href('/files/*', { '*': 'a/b.txt' })   // ✅ wildcard param
router.href('/still-invalid')                 // ❌ compile error
```

Without the `declare module`, all APIs still work at runtime — they just accept any path without compile-time validation. See [docs/type-safety.md](./website/src/type-safety.md) for details on how the register pattern works inside inline handlers, autocomplete behavior, and multi-app workspaces.

### Server Actions

Use `"use server"` to define functions that run on the server but can be called from client components (e.g. form actions).

```tsx
// src/app/actions.tsx
'use server'

import { z } from 'zod'
import { getActionRequest, parseFormData } from 'spiceflow'

export const contactSchema = z.object({ name: z.string().min(1) })

export async function submitForm(formData: FormData) {
  const { signal } = getActionRequest()
  const { name } = parseFormData(contactSchema, formData)
  // signal is aborted when the client disconnects or cancels —
  // pass it to any downstream work so it cancels automatically
  await saveToDatabase(name, { signal })
}
```

On the client, `getActionAbortController()` returns the `AbortController` for the most recent in-flight call to a server action, or `undefined` if nothing is in-flight. Call `.abort()` to cancel the fetch.

**Server actions are public POST endpoints.** Any HTTP client can call them — not just your own browser. CSRF protection (Origin header check) prevents cross-site form submissions, but it does not authenticate the caller. If a server action mutates data, creates resources, or does anything user-specific, it must authenticate and authorize the request explicitly. The same rule applies to all API routes (`.get()`, `.post()`, etc.) and any middleware that modifies state. See the [Security guide](./website/src/security.md) for patterns.

Server actions include CSRF protection. The `Origin` header of POST requests is checked against the app's origin. This check is **disabled in development** (when `vite dev` is running) so tunnels and proxies work without issues. In production, the origin check works automatically on any hosting platform (Cloudflare Workers, Node.js, Vercel, etc.) because the browser's `Origin` header matches the server's URL.

<details>
<summary>allowedActionOrigins (rare, only for reverse proxies)</summary>

If you use a reverse proxy that rewrites the request URL before it reaches your app (so `request.url` differs from the browser's origin), server actions return `403 Forbidden: origin mismatch`. Use `allowedActionOrigins` to allow additional origins:

```tsx
const app = new Spiceflow({
  allowedActionOrigins: [
    'https://my-app.example.com',
    /\.my-proxy\.dev$/,
  ],
})
```

Each entry can be an exact origin string or a `RegExp` tested against the request's `Origin` header. You do **not** need this on Cloudflare Workers, Vercel, Fly.io, or any platform where the request URL already matches your domain.

</details>

### Streaming UI from Server Actions

Server actions can return JSX directly — including via async generators that stream React elements to the client incrementally. The RSC flight protocol serializes each yielded element as it arrives, and the client deserializes them into real React elements you can render.

This is useful for AI chat interfaces where the model generates structured output with tool calls. Instead of streaming raw text, you stream rendered UI:

```tsx
// src/app/actions.tsx
'use server'

import { getActionRequest } from 'spiceflow'
import { WeatherCard } from './weather-card'
import { StockChart } from './stock-chart'

export async function* chat(
  messages: { role: string; content: string }[],
): AsyncGenerator<React.ReactElement> {
  // Pass the request signal to downstream work so the LLM call
  // is cancelled when the client aborts (e.g. clicks "Stop")
  const { signal } = getActionRequest()
  const stream = await callLLM(messages, { signal })

  for await (const event of stream) {
    if (event.type === 'text') {
      yield <p>{event.content}</p>
    }
    if (event.type === 'tool_call' && event.name === 'get_weather') {
      const weather = await fetchWeather(event.args.city)
      yield <WeatherCard city={event.args.city} weather={weather} />
    }
    if (event.type === 'tool_call' && event.name === 'get_stock') {
      const data = await fetchStock(event.args.symbol)
      yield <StockChart symbol={event.args.symbol} data={data} />
    }
  }
}
```

```tsx
// src/app/chat.tsx
'use client'

import { z } from 'zod'
import { useState, useTransition, type ReactNode } from 'react'
import { getActionAbortController } from 'spiceflow/react'
import { parseFormData } from 'spiceflow'
import { chat } from './actions'

const chatSchema = z.object({ message: z.string().min(1) })
const fields = chatSchema.keyof().enum

export function Chat() {
  const [parts, setParts] = useState<ReactNode[]>([])
  const [isPending, startTransition] = useTransition()

  function send(formData: FormData) {
    const { message } = parseFormData(chatSchema, formData)
    setParts([])
    startTransition(async () => {
      const stream = await chat([{ role: 'user', content: message }])
      for await (const jsx of stream) {
        setParts((prev) => [...prev, jsx])
      }
    })
  }

  return (
    <div>
      <div>{parts.map((part, i) => <div key={i}>{part}</div>)}</div>
      <form action={send}>
        <input name={fields.message} placeholder="Ask something..." />
        <button type="submit" disabled={isPending}>Send</button>
        {isPending && (
          <button type="button" onClick={() => getActionAbortController(chat)?.abort()}>
            Stop
          </button>
        )}
      </form>
    </div>
  )
}
```

Each yielded element — whether a text paragraph, a weather card, or a stock chart — arrives as a fully rendered React component. The client doesn't need to know how to render tool calls; it just accumulates whatever JSX the server sends.

### Redirects and Not Found

Use the handler context `redirect` and `response.status` inside `.page()` and `.layout()` handlers to control navigation and HTTP status codes:

```tsx
import { Spiceflow } from 'spiceflow'

export const app = new Spiceflow()
  .page('/login', async () => <Login />)
  .layout('/*', async ({ children, request }) => {
    // When no page matches, children is null — render a custom 404
    return (
      <AppLayout>
        {children ?? <NotFound />}
      </AppLayout>
    )
  })
  .page('/dashboard', async ({ request, redirect }) => {
    const user = await getUser(request)
    if (!user) {
      throw redirect('/login')
    }
    return <Dashboard user={user} />
  })
  .page('/posts/:id', async ({ params, response }) => {
    const post = await getPost(params.id)
    if (!post) {
      response.status = 404
      return <NotFound message={`Post ${params.id} not found`} />
    }
    return <Post post={post} />
  })
  // Layouts can throw redirect — useful for auth guards that protect
  // an entire section of your app
  .layout('/admin/*', async ({ children, request, redirect }) => {
    const user = await getUser(request)
    if (!user?.isAdmin) {
      throw redirect('/login')
    }
    return <AdminLayout>{children}</AdminLayout>
  })

export type App = typeof app
```

Context `redirect()` accepts a plain string URL plus an optional second argument for custom status codes and headers. It is intentionally not type-safe against the route table, so it does not pull `typeof app` back into handler context inference:

```tsx
// 301 permanent redirect
.page('/old-login', async ({ redirect }) => {
  throw redirect('/login', { status: 301 })
})

// Redirect with custom headers
.page('/logout', async ({ redirect }) => {
  throw redirect('/login', {
    headers: { 'set-cookie': 'session=; Max-Age=0' },
  })
})
```

<details>
<summary>Response status, headers, and HTTP behavior</summary>

**`response.status` and `response.headers`** — every page and layout handler receives a mutable `response` object on the context. Set `response.status` to control the HTTP status code (defaults to 200). Set `response.headers` to add custom headers like `cache-control` or `set-cookie`.

**Correct HTTP status codes.** Unlike Next.js, where redirects always return a 200 status with client-side handling, Spiceflow returns the actual HTTP status code in the response — `307` for redirects (with a `Location` header) and whatever you set via `response.status` for pages. This works even when the throw happens after an `await`, because the SSR layer intercepts the error from the RSC stream before flushing the HTML response. Search engines see correct status codes, and `fetch()` calls with `redirect: "manual"` get the real `307` response.

**Client-side navigation.** When a user clicks a `<Link>` that navigates to a page throwing context `redirect()`, the router performs the redirect client-side without a full page reload.

</details>

<details>
<summary>Authentication: pages vs API routes</summary>

Pages and layouts should always `throw redirect('/login')` from handler context when the user is not authenticated. API routes (`.get()`, `.post()`, etc.) should return a JSON error with a 401 status instead. This keeps the experience clean: users visiting a protected page get redirected to login instead of seeing a raw JSON blob, while API consumers get a proper typed error response they can handle programmatically.

```tsx
// Page — redirect to login
.page('/dashboard', async ({ request, redirect }) => {
  const user = await getUser(request)
  if (!user) throw redirect('/login')
  return <Dashboard user={user} />
})

// Layout — redirect to login (protects all nested pages)
.layout('/app/*', async ({ children, request, redirect }) => {
  const user = await getUser(request)
  if (!user) throw redirect('/login')
  return <AppLayout>{children}</AppLayout>
})

// API route — return JSON 401
.get('/api/profile', async ({ request }) => {
  const user = await getUser(request)
  if (!user) return json({ error: 'Not authenticated' }, { status: 401 })
  return json({ user })
})

// Middleware — protect all routes in a sub-app with JSON 401
const api = new Spiceflow()
  .use(async ({ request }) => {
    const user = await getUser(request)
    if (!user) return json({ error: 'Not authenticated' }, { status: 401 })
  })
  .get('/profile', async ({ request }) => {
    const user = await getUser(request)
    return json({ user })
  })

app.use(api, { prefix: '/api' })
```

</details>

### Code Splitting

Code splitting of client components is **automatic** — you don't need `React.lazy()` or dynamic `import()`. Each `"use client"` file becomes a separate chunk, and the browser only loads the chunks needed for the current page.

<details>
<summary>How it works</summary>

When the RSC flight stream is sent to the browser, it contains references to client component chunks rather than the actual code. The browser resolves and loads only the chunks referenced on the current page. If route `/about` uses `<Map />` and route `/dashboard` uses `<Chart />`, visiting `/about` will never download the Chart component's JavaScript.

</details>

<details>
<summary>Barrel file pitfall</summary>

Avoid barrel files with `"use client"`. If you have a single file with `"use client"` that re-exports many components, all of them end up in one chunk — defeating code splitting. Instead, put `"use client"` in each individual component file:

```tsx
// BAD — one big chunk for everything
// src/components/index.tsx
'use client'
export { Chart } from './chart'
export { Map } from './map'
export { Table } from './table'
```

```tsx
// GOOD — each component is its own chunk
// src/components/chart.tsx
'use client'
export function Chart() {
  /* ... */
}

// src/components/map.tsx
;('use client')
export function Map() {
  /* ... */
}

// Re-export barrel has no directive, just passes through
// src/components/index.tsx
export { Chart } from './chart'
export { Map } from './map'
```

</details>

### Resource Preloading

React 19 exports `preload`, `preinit`, `prefetchDNS`, and `preconnect` from `react-dom`. Call them in your component render body and they emit `<link>` tags into SSR HTML so the browser starts fetching before any JS runs. Works in both server and client components; duplicates are auto-deduplicated.

```tsx
import { preload, preinit, prefetchDNS, preconnect } from 'react-dom'

function App() {
  preload('/assets/hero.mp4', { as: 'video' })
  preload('/fonts/Inter.woff2', { as: 'font', type: 'font/woff2', crossOrigin: 'anonymous' })
  preinit('/styles/dashboard.css', { as: 'style' })   // downloads AND inserts
  prefetchDNS('https://api.example.com')
  preconnect('https://cdn.example.com', { crossOrigin: 'anonymous' })

  return <div>{/* ... */}</div>
}
```

| Function | Effect | Use for |
|---|---|---|
| `preload` | Download and cache | Videos, images, fonts |
| `preinit` | Download and execute | Stylesheets, scripts |
| `prefetchDNS` | DNS lookup | API domains |
| `preconnect` | DNS + TCP + TLS | CDNs, auth providers |

### Directory Paths

> Only available when using the Vite plugin.

Server components sometimes need to read files from the filesystem at runtime — for example, reading images from `public/` to generate Open Graph images, or writing cached files to disk. Using `import.meta.dirname` breaks on platforms like Vercel where the function runs from a different directory than where you built.

`publicDir` and `distDir` resolve to the correct absolute paths in every environment:

```tsx
import { publicDir, distDir } from 'spiceflow'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

export async function generateOgImage(slug: string) {
  const template = await readFile(path.join(publicDir, 'og-template.png'))
  // ... generate image
  await writeFile(path.join(distDir, 'cache', `${slug}.png`), result)
}
```

| | `publicDir` | `distDir` |
|---|---|---|
| **Dev** | `<cwd>/public` | `<cwd>` |
| **Production** | `<outDir>/client` (where Vite copies public/ contents) | `<outDir>` |

### Remote Components & Federation

Expose any Flight-serializable value from a route with `encodeFederationPayload(...)`, then either render the fetched `Response` with `RenderFederatedPayload` or decode it imperatively with `decodeFederationPayload(response)`. This works for SSR'd remote components, plain objects, or objects containing JSX. Async iterables are supported when they are fields on an object payload (for example `{ stream }`), so clients can `for await` the decoded field directly.

```tsx
// remote app
import { encodeFederationPayload } from 'spiceflow/federation'

.get('/api/chart', async () => {
  return await encodeFederationPayload(<Chart dataSource="revenue" />)
})

// host app
import { Suspense } from 'react'
import { RenderFederatedPayload } from 'spiceflow/react'

.page('/', async () => {
  const response = await fetch('https://remote.example.com/api/chart')
  return (
    <Suspense fallback={<div>Loading chart...</div>}>
      <RenderFederatedPayload response={response} />
    </Suspense>
  )
})
```

See [Federation docs](./website/src/federation.md) for full setup, imperative decoding with `decodeFederationPayload`, import map deduplication, and external ESM components.

## Model Context Protocol (MCP)

Spiceflow includes an MCP plugin that exposes your API routes as tools and resources for AI language models. Mount it with `.use(mcp())` and all routes become callable tools with proper input validation. See [MCP docs](./website/src/mcp.md) for full setup, client examples, and integrating with existing MCP servers.

## Cloudflare Bindings

On Cloudflare Workers, the simplest way to read bindings is to import `env` directly from `cloudflare:workers`. Run `wrangler types` after changing `wrangler.jsonc` so Wrangler regenerates `worker-configuration.d.ts` — that gives `env` a type-safe `Env` shape automatically.

```tsx
import { Spiceflow } from 'spiceflow'
import { env } from 'cloudflare:workers'

export const app = new Spiceflow()
  .route({
    method: 'GET',
    path: '/kv/:key',
    async handler({ params }) {
      const value = await env.KV.get(params.key)
      return { key: params.key, value }
    },
  })
  .route({
    method: 'POST',
    path: '/queue',
    async handler({ request }) {
      const body = await request.json()
      await env.QUEUE.send(body)
      return { success: true, message: 'Added to queue' }
    },
  })

export default {
  fetch(request: Request) {
    return app.handle(request)
  },
}
```

## Background Tasks (`waitUntil`)

All background promises (fire-and-forget work like analytics, logging, cache writes) **must** use `waitUntil` from the handler context. Never do `void somePromise()` or `somePromise().catch(...)` directly; the runtime may kill the process before the promise settles.

```ts
export const app = new Spiceflow().route({
  method: 'POST',
  path: '/process',
  async handler({ request, waitUntil }) {
    const data = await request.json()

    waitUntil(
      fetch('https://analytics.example.com/track', {
        method: 'POST',
        body: JSON.stringify({ event: 'processed', data }),
      }),
    )

    return { success: true }
  },
})
```

On Cloudflare Workers, `waitUntil` automatically delegates to the Workers `ExecutionContext.waitUntil`. On Node.js it is a no-op by default; pass a custom implementation via `new Spiceflow({ waitUntil: (p) => { ... } })` if you need background work to be tracked. See [Cloudflare docs](./website/src/cloudflare.md#background-tasks-waituntil) for full examples including Cloudflare integration and custom implementations.

## KV Page Caching

Cache full-page HTML in Cloudflare KV with deployment-aware cache keys. See [Cloudflare docs](./website/src/cloudflare.md#kv-page-caching) for the full middleware example.

## Cross-Deployment Safety

Each production build stamps a unique **deployment id** (build timestamp). Soft navigations compare the client bootstrap id to the server's `x-spiceflow-deployment-id` header; on mismatch the client hard-reloads the target page so it never imports deleted content-hashed chunks from a previous deploy.

That matters on hosts that **replace** the asset set per deploy (for example Cloudflare Workers Assets). Hosts that keep old hashes indefinitely can still soft-navigate across deploys when client components stay backward-compatible.

RSC flight payloads use **client reference IDs** (hash of file path), not chunk URLs. After a full reload, the new bootstrap map loads the matching chunks. See [Deployment Skew](./website/src/deployment-skew.md) for a deep dive.

<details>
<summary>How deploy skew detection works</summary>

1. **Build** — Vite inlines a deployment id via `virtual:spiceflow-deployment-id`.
2. **HTML load** — SSR bootstrap stamps `self.__SPICEFLOW_DEPLOYMENT_ID__` before the client entry runs.
3. **Flight responses** — every RSC response includes `x-spiceflow-deployment-id`.
4. **Soft navigation / action** — `entry.client` compares header vs bootstrap id; mismatch → `location.replace` of the document URL.

Dev mode leaves the id empty so detection is disabled. `getDeploymentId()` remains available for analytics and cache keys.

</details>

<details>
<summary>Edge cases and encryption</summary>

- The new server renders a brand-new `"use client"` component that didn't exist in the old build — a hard reload picks up the new bootstrap map.
- A client component keeps the same file path but its props interface changes — reload after deploy avoids serving old component code with new props.
- Inline `"use server"` functions that capture variables need a stable `RSC_ENCRYPTION_KEY` (base64 32-byte key) so encrypted closures survive across deployments.

</details>

<details>
<summary>How the deployment ID is resolved per environment</summary>

The deployment ID uses the `#deployment-id` import map in `package.json`:

- **`react-server`** — `virtual:spiceflow-deployment-id` (build timestamp from Vite)
- **`default`** (browser, tests) — returns `''` from `getDeploymentId()`; the browser reads the id from `self.__SPICEFLOW_DEPLOYMENT_ID__` set by the SSR bootstrap instead

In dev mode the RSC loader also returns `''`.

</details>

## Node.js Handlers

In user-facing code, you should almost never convert a Node.js `req`/`res` pair into a standard `Request` yourself. Spiceflow already exposes the right adapter for each situation, so this conversion should stay inside Spiceflow rather than in app code.

<details>
<summary>Which adapter to use</summary>

- If you want to run your app on a port in Node.js or Bun, use `app.listen(3000)`. Spiceflow sets up the server adapter for you. Cloudflare Workers are the main exception because there is no port-based server to listen on there.
- If you need to plug a Spiceflow app into a classic Node.js handler API that gives you `req` and `res` (for example a Next.js pages API route), use `app.handleForNode(req, res)`.
- If you are already inside a modern WHATWG-style handler that gives you a standard `Request`, just delegate with `return app.handle(request)`.

If you find yourself writing manual request-conversion glue in app code, that is usually a sign that you should use one of these Spiceflow entrypoints instead.

</details>

```ts
import { Spiceflow } from 'spiceflow'
import type { IncomingMessage, ServerResponse } from 'node:http'

export const app = new Spiceflow().get('/hello', () => {
  return { hello: 'world' }
})

// Run directly on Node.js or Bun
app.listen(3000)

// Use inside a classic Node.js req/res handler
export async function nodeHandler(req: IncomingMessage, res: ServerResponse) {
  await app.handleForNode(req, res)
}

// Use inside a standard Request handler
export default {
  fetch(request: Request) {
    return app.handle(request)
  },
}
```

## Next.js Integration

```ts
// pages/api/[...path].ts
import { getJwt } from '@app/utils/ssr' // exasmple session function
import type { NextApiRequest, NextApiResponse } from 'next'

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  // IMPORTANT! nothing should be run before calling handleForNode that could read the request body!
  await mcpAuthApp.handleForNode(req, res)
}

export const config = {
  api: {
    bodyParser: false,
  },
}
```

## Docker Deployment

The build output is self-contained — `dist/` includes all traced runtime dependencies, so you can copy it directly into a Docker image without installing packages at deploy time. See [Docker docs](./website/src/docker.md) for Dockerfile examples and cross-platform native module handling.

## Class Instances

If you need to store a Spiceflow router as a property in a class instance, use the `AnySpiceflow` type.

<details>
<summary>Avoid <code>this</code> in route handlers</summary>

Do not use `this` inside route handlers to reference the parent class. The `this` context inside handlers always refers to the Spiceflow instance, not your class instance. Instead, capture the parent class reference in a variable outside the handlers.

</details>

```ts
import { Spiceflow, AnySpiceflow } from 'spiceflow'

export class ChatDurableObject {
  private router: AnySpiceflow
  private state: DurableObjectState

  constructor(state: DurableObjectState, env: Env) {
    this.state = state
    const self = this // Capture parent class reference - IMPORTANT!

    this.router = new Spiceflow()
      .route({
        method: 'GET',
        path: '/messages',
        async handler() {
          // Use 'self' instead of 'this' to access parent class
          // this.state would NOT work here - 'this' refers to Spiceflow instance
          const messages = (await self.state.storage.get('messages')) || []
          return { messages }
        },
      })
      .route({
        method: 'POST',
        path: '/messages',
        async handler({ request }) {
          const { message } = await request.json()
          // Use 'self' to access parent class properties
          const messages = (await self.state.storage.get('messages')) || []
          messages.push({ id: Date.now(), text: message })
          await self.state.storage.put('messages', messages)
          return { success: true }
        },
      })
  }

  fetch(request: Request) {
    return this.router.handle(request)
  }
}
```

## `use client` trap in optimized dependencies

If a `node_modules` dependency mixes server and client code in one entry, Vite can flatten the `'use client'` boundary into a server chunk — crashing at startup with errors like `useState is undefined`. See [docs/use-client-trap.md](docs/use-client-trap.md) for symptoms, diagnosis, and fixes.

## Comparisons

#### Elysia

This project was born as a fork of Elysia with several changes:

- Use Zod instead of Typebox
- Do not compile user code with `aot` and `eval`, Elysia is very difficult to contribue to because the app is generated by compiling the user routes with `new Function()`, which also causes [several bugs](https://github.com/elysiajs/elysia/pull/773)
- Better async generator support by using SSE

#### Hono

This project shares many inspirations with Hono with many differences

- First class OpenAPI support, you don't need to change anything to produce an OpenAPI spec, just add the `openapi` plugin to automaitcally export your openapi schema on `/openapi`
- Much simpler framework, everything is done with native `Request` and `Response` objects instead of framework specific utilities
- Support for async generators
- Adding schemas to your routes is easier and does not require using `validator` functions, which slow down TypeScript inference
- The generated RPC client has much faster type inference, intellisense in VSCode appears in milliseconds instead of seconds
- Spiceflow uses whatwg Request and Response instead of custom utilities like `c.text` and `c.req`
