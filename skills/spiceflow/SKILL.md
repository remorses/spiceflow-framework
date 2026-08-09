---
name: spiceflow
description: 'Spiceflow is a super simple, fast, and type-safe API and React Server Components framework for TypeScript. Works on Node.js, Bun, and Cloudflare Workers. ALWAYS load this skill BEFORE writing or editing ANY spiceflow code, including one-line changes: routes, pages, layouts, loaders, server actions, forms, ErrorBoundary, redirects, cookies, navigation, Link, router, ProgressBar, the typed fetch client, middleware, and OpenAPI. A project uses spiceflow if anything imports from "spiceflow" or "spiceflow/react", or constructs new Spiceflow(). The API is small but very opinionated and the opinions are NOT guessable; writing spiceflow code from memory or from what looks like Next.js produces wrong code every time.'
---

# Spiceflow

## When to load this skill

**ALWAYS, before you touch ANY spiceflow code.** Not "when stuck", not "for big changes", not "if the task looks unusual" — every single time, including one-line edits.

A project uses spiceflow if anything imports from `spiceflow` or `spiceflow/react`, or constructs `new Spiceflow()`. That covers:

- routes (`.get`, `.post`, `.route`), pages, layouts, loaders
- server actions, forms, `ErrorBoundary`, `parseFormData`, `useActionState`
- redirects, cookies, navigation, `Link`, `router`, `ProgressBar`
- the typed fetch client, middleware, tracing, OpenAPI

The API surface is small but **very opinionated**, and the opinions are NOT guessable. Every framework has its own answer for forms, pending state, error display, and redirects; spiceflow's answers are frequently different from Next.js and from React defaults. Writing spiceflow code from memory, or from what "looks like Next.js", produces wrong code every time.

If you already started editing spiceflow code without loading this skill, stop, load it, read the README, and re-check what you wrote.

## Read the full README first

Every time you work with spiceflow, you MUST fetch the **entire** README from the main branch. The README is the primary documentation and every section matters. You MUST read it completely, from start to finish, with no truncation. Partial reads cause you to miss critical API details, conventions, and patterns that lead to wrong implementations.

```bash
curl -s https://raw.githubusercontent.com/remorses/spiceflow/main/README.md
```

If you are about to design any navigation, cookie, redirect, or refresh behavior and you have not fetched the README in this session, stop and fetch it first.

**Do NOT truncate, summarize, or skip sections.** Never pipe to `head`, `tail`, `sed`, or any command that cuts the output short. Never stop reading early because it "looks long enough." The README contains sections on routing, RSC, server actions, layouts, error handling, forms, federation, deployment, and more. Missing any of them means missing framework behavior you will get wrong.

After reading the full README, check if it references any docs/ files relevant to your task. If it does, fetch those too in full:

```bash
# Always read these when the task involves the corresponding feature
curl -s https://raw.githubusercontent.com/remorses/spiceflow/main/docs/fetch-client.md
curl -s https://raw.githubusercontent.com/remorses/spiceflow/main/docs/testing.md
curl -s https://raw.githubusercontent.com/remorses/spiceflow/main/docs/openapi.md
```

Read every referenced doc that is relevant to the task. These subdocuments contain API details, caveats, and examples that are not duplicated in the README. Skipping them is the same as skipping the README itself.

## Testing spiceflow apps

Before writing any vitest tests for a spiceflow app, ALWAYS read the testing guide first:

```bash
curl -s https://raw.githubusercontent.com/remorses/spiceflow/main/docs/testing.md
```

It covers setup, API route testing, page route testing, server actions, `createTestTracer` for span snapshots, HTML formatting with posthtml, DI with `.state()`, and better-auth integration patterns.

Reference examples for real-world usage:

- **[example-vitest](https://github.com/remorses/spiceflow/tree/main/example-vitest)** — tests API routes, page routes, server actions, DI with state, tracing spans, and HTML snapshot formatting
- **[example-vitest-cloudflare](https://github.com/remorses/spiceflow/tree/main/example-vitest-cloudflare)** — tests running inside Cloudflare Workers runtime (workerd) via `@cloudflare/vitest-pool-workers`, covering D1 database, KV, and `cloudflare:workers` APIs

## Client navigation links

Always import and use `Link` from `spiceflow/react` for navigational links in Spiceflow apps. Do not render raw `<a>` elements for links. `Link` enables client-side navigation while preserving normal anchor behavior for external URLs, hashes, `target`, `rel`, styling, and event handlers. `Link` supports external URLs too, so it is fine to use for ambiguous or user-provided links when you do not know ahead of time whether they are internal or external.

**`Link` auto-prepends the Vite `base` path.** Never manually prepend the base path to `Link` href values. `<Link href="/dashboard" />` automatically renders as `<a href="/my-app/dashboard">` when the Vite base is `/my-app/`. Manually prepending causes double-prefixing. This only applies to `Link`; raw `fetch()` calls, `Response.redirect()`, and other non-Link URL construction still need manual base path handling.

## OpenTelemetry instrumentation

Spiceflow supports automatic route instrumentation when you pass an OpenTelemetry-compatible tracer to the constructor:

```ts
import { trace } from '@opentelemetry/api'
import { Spiceflow } from 'spiceflow'

const tracer = trace.getTracer('my-app')

export const app = new Spiceflow({ tracer })
  .get('/hello', ({ span }) => {
    span.setAttribute('app.route', '/hello')
    return { hello: 'world' }
  })
```

When a project uses Strada for observability, read `docs/strada.md` and pass Strada's re-exported `trace` API to Spiceflow so spans go through the configured provider.

Always pass a tracer for production Spiceflow apps unless there is a specific reason not to. The handler context then exposes `span` and `tracer`, so route code can add attributes or create child spans without manual request wrappers.

## Typed fetch client rules

When using the typed fetch client (`createSpiceflowFetch`), follow these rules:

- **Use `:param` paths with a `params` object.** Never interpolate IDs into the path string. `` `/users/${id}` `` is just `string` and breaks all type inference.
- **All packages in a monorepo must use the exact same spiceflow version.** Mismatched versions cause `Types have separate declarations of a private property` errors. Use `pnpm update -r spiceflow` (without `--latest`) to sync.
- **Import API types from source files, not `dist/*.d.ts`.** Use `import type { App } from "website/src/server.tsx"`. This avoids build-order dependencies (server doesn't need to build before client can typecheck). If tsc fails on unresolvable modules in the server's transitive imports (like `cloudflare:workers`, CSS, etc.), add a small ambient `.d.ts` stub in the client package.
- **Use `import type` for cross-workspace API types.** Never value-import the server app just to get fetch client typing.
- **Keep the server package as a `devDependency`** of the client package for typechecking.
- **Route handlers must return plain objects** for the response type to be inferred. Returning `res.json()` or `Response.json()` erases the type to `any`.
- **Never `return new Response(...)`.** It erases the body type. Use `return json(...)` (preserves type and status) or `throw` anything (`throw new Response(...)` is fine since throws don't affect return type).
- **`body` is a plain object**, not `JSON.stringify()`. The client serializes it automatically.
- **Response is `Error | Data`.** Check with `instanceof Error`, then the happy path has the narrowed type.

## Duplicate spiceflow in monorepos

Spiceflow must be a single copy in `node_modules`. Duplicates cause type errors (`Types have separate declarations of a private property`) and Vite resolution bugs.

**Always use `-r` (recursive) when updating spiceflow in a monorepo:**

```bash
# pnpm
pnpm update -r spiceflow

# npm
npm update spiceflow --workspaces

# bun
bun update -r spiceflow
```

**When you hit weird type errors or Vite/spiceflow resolution issues, deduplicate first:**

```bash
# pnpm
pnpm dedupe

# npm
npm dedupe --workspaces

# bun (re-install deduplicates automatically)
bun install
```

## Security: server actions and routes are public endpoints

Server actions (`"use server"`) are **public POST endpoints**. Any HTTP client can call them directly, not just the app's own browser. CSRF protection (Origin header check) blocks cross-site form submissions but does NOT authenticate the caller. Every server action that mutates data, creates resources, or reads user-specific data MUST authenticate and authorize the request explicitly, for example by reading a session from cookies or a bearer token from headers. The same rule applies to all API routes (`.get()`, `.post()`, etc.) and middleware that modifies state.

```tsx
'use server'

import { getActionRequest } from 'spiceflow'
import { getUser } from './auth'

export async function deleteProject(id: string) {
  const { request } = getActionRequest()
  const user = await getUser(request)
  if (!user) throw new Error('Not authenticated')
  if (!user.canDelete(id)) throw new Error('Not authorized')
  await db.project.delete({ where: { id } })
}
```

Never assume a server action is only reachable through your own UI. Treat every server action like a public API endpoint.

## Never `router.refresh()` after server actions

Successful server actions re-run matching loaders and reconcile the current page. Do not call `router.refresh()` afterward. Use it only when data changes outside a server action.

`router.refresh()` is fire-and-forget. Do not await a custom refresh or navigation commit helper inside a React form action because the transition can deadlock.

## Router usage in app entry handlers

`router` from `spiceflow/react` is typed from the globally registered `typeof app`. Do **not** use `router` inside `.loader()`, `.get()`, `.post()`, or `.route()` handlers in the same file that initializes `export const app = new Spiceflow()`. Those handlers feed return types back into `typeof app` through loader data or typed API responses, so `router.href()` can create recursive circular TypeScript errors such as TS7022.

`router.href()` is okay in components, other modules, and for JSX links inside `.page()` / `.layout()` handlers because rendered page/layout JSX is not part of the app metadata. If a loader-heavy app still hits a circular `typeof app` error from page/layout usage, move the link UI into a component module. Context `redirect()` intentionally accepts a plain `string`; do not pass `router.href()` into redirects inside app-entry handlers because redirect return values participate in handler return inference and can reintroduce the cycle.
