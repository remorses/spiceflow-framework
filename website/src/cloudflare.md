---
title: Cloudflare
description: Cloudflare Workers setup, observability, background tasks, and KV page caching.
icon: cloud
---

# Cloudflare

Cloudflare Workers setup, observability, background tasks, and KV page caching.

## Cloudflare RSC Setup

For Cloudflare Workers, keep the worker-specific SSR output and child environment wiring in Vite, then let your Worker default export delegate to `app.handle(request)`.

**Every Cloudflare Worker entry file must have a `default export` with a `fetch` handler.** Spiceflow does not generate this implicitly. Without it, the Worker has no entry point and requests will fail.

```jsonc
// wrangler.jsonc
{
  "main": "./src/main.tsx",
}
```

```ts
// vite.config.ts
import { cloudflare } from '@cloudflare/vite-plugin'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import spiceflow from 'spiceflow/vite'

export default defineConfig({
  plugins: [
    react(),
    spiceflow({ entry: './src/main.tsx' }),
    cloudflare({
      viteEnvironment: {
        name: 'rsc',
        childEnvironments: ['ssr'],
      },
    }),
  ],
})
```

```tsx
// src/main.tsx
import { Spiceflow } from 'spiceflow'

export const app = new Spiceflow().page('/', async () => {
  return <div>Hello from Cloudflare RSC</div>
})

export type App = typeof app

export default {
  fetch(request: Request) {
    return app.handle(request)
  },
}
```

See [`example-cloudflare/`](https://github.com/remorses/spiceflow/tree/main/example-cloudflare) for a complete working example.

### Terminal colors

The Cloudflare Vite plugin runs your worker code inside workerd, which doesn't expose a TTY. Color libraries like `picocolors` and `chalk` disable colors when they detect no TTY, so terminal output loses all formatting. Set `FORCE_COLOR=1` in your dev and build scripts to restore colors:

```json
{
  "scripts": {
    "dev": "FORCE_COLOR=1 vite dev",
    "build": "FORCE_COLOR=1 vite build"
  }
}
```

When you add or change bindings in `wrangler.jsonc`, run `wrangler types`. Wrangler regenerates `worker-configuration.d.ts`, which provides the global `Env` type and the typed `env` export from `cloudflare:workers`.

### Wrangler Environments

The `@cloudflare/vite-plugin` resolves and flattens your `wrangler.json` config at **build time** and writes it into `dist/rsc/wrangler.json`. When `wrangler deploy` runs, it reads this generated config — not your top-level `wrangler.json`. This means `wrangler deploy --env preview` alone is not enough if the build was done without specifying the environment.

Set the `CLOUDFLARE_ENV` env var during `vite build` so the plugin resolves the correct environment section:

```bash
# Build for preview environment
CLOUDFLARE_ENV=preview vite build && wrangler deploy --env preview

# Build for production (default, no env var needed)
vite build && wrangler deploy
```

Without `CLOUDFLARE_ENV=preview`, the generated `dist/rsc/wrangler.json` will contain the top-level config (production name, routes, KV namespaces, etc.) and `--env preview` will be ignored at deploy time.

## Automatic Tracing

On Cloudflare Workers, spiceflow automatically instruments every request with [custom spans](https://developers.cloudflare.com/workers/observability/traces/custom-spans/) using the native `tracing.enterSpan()` API. No `tracer` option needed; just enable tracing in `wrangler.jsonc`:

```jsonc
// wrangler.jsonc
{
  "observability": {
    "traces": {
      "enabled": true
    }
  }
}
```

Every request produces spans for middleware, handlers, loaders, layouts, pages, and RSC serialization. These appear alongside Cloudflare's automatic platform spans (KV reads, D1 queries, fetch calls) in the Cloudflare dashboard and OpenTelemetry exports.

```
GET /dashboard [server]
├── middleware - auth
├── loader - /dashboard        ← spiceflow span
├── page - /dashboard          ← spiceflow span
├── env.MY_KV.get("key")      ← automatic CF span
└── rsc.serialize              ← spiceflow span
```

Custom spans created with `context.tracer.startActiveSpan()` in your handlers also appear in the trace tree. The `span` and `tracer` on the handler context work the same as with an OTel tracer.

If you pass an explicit `tracer` to the Spiceflow constructor, it takes priority over the automatic Cloudflare tracer.

<details>
<summary>Cloudflare span limitations</summary>

The Cloudflare tracing API is newer than OTel and doesn't support all `SpiceflowSpan` methods natively yet. Spiceflow bridges the gap where possible:

- `span.setStatus()` — error statuses are mapped to `otel.status_code` and `otel.status_description` attributes
- `span.recordException()` — mapped to `exception.type`, `exception.message`, and `exception.stacktrace` attributes
- `span.updateName()` — no-op
- `span.spanContext()` — returns `undefined` (CF planned for future)
- `span.end()` — no-op (CF auto-ends spans when the callback returns)

`span.setAttribute()` works fully. Error details from `recordException` and `setStatus` are visible as span attributes in the Cloudflare dashboard and any OTel export destination.

</details>

## Observability

<!-- Sources for this section:
  - https://developers.cloudflare.com/workers/observability/
  - https://developers.cloudflare.com/workers/observability/traces/
  - https://developers.cloudflare.com/workers/observability/traces/custom-spans/
  - https://developers.cloudflare.com/workers/observability/traces/spans-and-attributes/
  - https://developers.cloudflare.com/workers/observability/exporting-opentelemetry-data/
  - https://developers.cloudflare.com/workers/observability/logs/workers-logs/
  - https://developers.cloudflare.com/workers/observability/logs/real-time-logs/
  - https://developers.cloudflare.com/workers/observability/query-builder/
  - https://developers.cloudflare.com/workers/wrangler/configuration/#observability
-->

Every Cloudflare Workers project should enable observability to get logs, traces, and error visibility. Add this to your `wrangler.jsonc`:

```jsonc
// wrangler.jsonc
{
  "observability": {
    "enabled": true,
    "traces": {
      "enabled": true
    }
  }
}
```

`observability.enabled` turns on **logs** (console output, uncaught exceptions, request metadata). `observability.traces.enabled` turns on **traces** (span trees for every request).

### Streaming logs with wrangler tail

Stream live logs from your deployed worker in the terminal:

```bash
wrangler tail                    # all logs
wrangler tail --status error     # errors only
wrangler tail --search "TypeError"  # filter by text
wrangler tail --format json      # JSON output for piping to jq
```

Traces and historical logs are available in the [Cloudflare dashboard](https://dash.cloudflare.com) under Workers & Pages → your worker → **Observability**. Spiceflow sets `error.type`, `otel.status_code`, `exception.message`, and `exception.stacktrace` as span attributes on errors, so they are queryable in the dashboard.

## Background Tasks (`waitUntil`)

Spiceflow provides a `waitUntil` function in the handler context that allows you to schedule tasks in the background in a cross platform way. It will use the Cloudflare Workers `waitUntil` if present. It's currently a no-op in Node.js.

### Basic Usage

```ts
import { Spiceflow } from 'spiceflow'

export const app = new Spiceflow().route({
  method: 'POST',
  path: '/process',
  async handler({ request, waitUntil }) {
    const data = await request.json()

    // Schedule background task
    waitUntil(
      fetch('https://analytics.example.com/track', {
        method: 'POST',
        body: JSON.stringify({ event: 'data_processed', data }),
      }),
    )

    // Return response immediately
    return { success: true, id: Math.random().toString(36) }
  },
})
```

### Cloudflare Workers Integration

In Cloudflare Workers, `waitUntil` is automatically detected from the global context:

```ts
import { Spiceflow } from 'spiceflow'

export const app = new Spiceflow().route({
  method: 'POST',
  path: '/webhook',
  async handler({ request, waitUntil }) {
    const payload = await request.json()

    // Process webhook data in background
    waitUntil(
      processWebhookData(payload)
        .then(() => console.log('Webhook processed'))
        .catch((err) => console.error('Webhook processing failed:', err)),
    )

    // Respond immediately to webhook sender
    return new Response('OK', { status: 200 })
  },
})

async function processWebhookData(payload: any) {
  // Simulate time-consuming processing
  await new Promise((resolve) => setTimeout(resolve, 1000))
  // Save to database, send notifications, etc.
}

export default {
  fetch(request: Request) {
    return app.handle(request)
  },
}
```

### Custom `waitUntil` Function

You can also provide your own `waitUntil` implementation:

```ts
import { Spiceflow } from 'spiceflow'

export const app = new Spiceflow({
  waitUntil: (promise) => {
    // Custom implementation for non-Cloudflare environments
    promise.catch((err) => console.error('Background task failed:', err))
  },
}).route({
  method: 'GET',
  path: '/analytics',
  async handler({ waitUntil }) {
    // Schedule analytics tracking
    waitUntil(trackPageView('/analytics'))

    return { message: 'Analytics page loaded' }
  },
})

async function trackPageView(path: string) {
  // Track page view in analytics system
  console.log(`Page view tracked: ${path}`)
}
```

**Note:** In non-Cloudflare environments, if no custom `waitUntil` function is provided, the default implementation is a no-op that doesn't wait for the promises to complete.

## KV Page Caching

Use middleware to cache full-page HTML in Cloudflare KV. The deployment ID is included in the cache key so each deploy gets its own cache namespace — this prevents serving stale HTML that references old CSS/JS filenames with different content hashes.

This example uses `import { env } from 'cloudflare:workers'` to access KV bindings directly from anywhere in your code, without threading env through `.state()`. Run `wrangler types` whenever the bindings change so `env.PAGE_CACHE` stays type-safe.

```tsx
import { Spiceflow, getDeploymentId } from 'spiceflow'
import { env } from 'cloudflare:workers'

export const app = new Spiceflow()
  .use(async ({ request, waitUntil }, next) => {
    if (request.method !== 'GET') {
      return next()
    }

    const { pathname, search } = request.parsedUrl
    const deploymentId = await getDeploymentId()
    const cacheKey = `${deploymentId}:${pathname}${search}` // IMPORTANT. cache key must always include search to distinguish html and rsc responses

    const cached = await env.PAGE_CACHE.get(cacheKey)
    if (cached) {
      return new Response(cached, {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'x-cache': 'HIT',
        },
      })
    }

    const response = await next()
    if (!response || response.status !== 200) {
      return response
    }

    const html = await response.text()
    // Write to KV in the background so the response is not delayed
    waitUntil(
      env.PAGE_CACHE.put(cacheKey, html, {
        expirationTtl: 60 * 60 * 24 * 7, // 7 days
      }),
    )

    return new Response(html, {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'x-cache': 'MISS',
      },
    })
  })
  .page('/', async () => {
    return (
      <div>
        <h1>Home</h1>
      </div>
    )
  })

export default {
  fetch(request: Request) {
    return app.handle(request)
  },
}
```

When a new version is deployed the build timestamp changes, so `getDeploymentId()` returns a different value and all cache keys are effectively new. Old entries expire naturally after 7 days.

## CORS for Static Assets

On Cloudflare Workers, static assets (JS, CSS, images, fonts) are served by Cloudflare's CDN **before** the Worker code runs. This means CORS headers set in your Worker code don't apply to static files. Without CORS, images loaded cross-origin can't be drawn to a `<canvas>`, fonts won't load from other origins, and `fetch()` from another domain can't read the response.

To enable CORS on all static assets, create a `public/_headers` file in your project:

```
/*
  Access-Control-Allow-Origin: *
```

Vite copies `public/` contents into the client build output, which becomes the Cloudflare `assets.directory`. Cloudflare reads `_headers` from there and applies the rules to all static asset responses. The `_headers` file itself is not served as an asset.

See the [Cloudflare Workers headers docs](https://developers.cloudflare.com/workers/static-assets/headers/) for path patterns, placeholders, and how to restrict CORS to specific origins.

## Edge Caching (Workers Cache)

Cloudflare [Workers Cache](https://developers.cloudflare.com/workers/cache/) puts a **regionally tiered cache in front of your Worker**. On a cache hit, your Worker code never runs and you pay zero CPU time. Enable it with one line in `wrangler.jsonc` and control it with standard `Cache-Control` headers on your responses.

```jsonc
// wrangler.jsonc
{
  "cache": { "enabled": true }
}
```

That's it. No middleware needed. Any cacheable GET response with `Cache-Control` headers is automatically cached and served from Cloudflare's edge on subsequent requests.

### Setting Cache-Control on pages

Use the `response` context object to set headers from page handlers or layouts:

```tsx
import { Spiceflow } from 'spiceflow'

export const app = new Spiceflow()
  .page('/', async ({ response }) => {
    // Fresh for 5 min; serve stale for up to 1 hour while refreshing
    response.headers.set(
      'Cache-Control',
      'public, max-age=300, stale-while-revalidate=3600',
    )
    return <div>Cached at the edge</div>
  })
```

### Setting Cache-Control on API routes

```ts
export const app = new Spiceflow()
  .route({
    method: 'GET',
    path: '/api/data',
    handler() {
      return new Response(JSON.stringify({ ok: true }), {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=300, stale-while-revalidate=3600',
        },
      })
    },
  })
```

### Vary

Set the `Vary` header on your response to cache different variants per request header (e.g. content type, language). Workers Cache stores a separate cached variant per distinct combination of those header values.

```ts
response.headers.set('Vary', 'Accept, Accept-Language')
```

### Cache behavior

Workers Cache is **regionally tiered by default** with two layers: a lower tier in the data center closest to the user and an upper tier that aggregates across the network. The first request anywhere populates the upper tier; all subsequent requests from any data center can be served without running your Worker.

Key features:
- **`stale-while-revalidate`** serves the stale response immediately while refreshing in the background, so users never wait for a re-render
- **`Cache-Tag`** header lets you purge specific content programmatically via `ctx.cache.purge({ tags: ["product:123"] })`
- **Per-entrypoint caching** via the `exports` config lets you cache some entrypoints and not others (e.g. skip cache on a gateway that authenticates, cache the expensive backend)
- Cache belongs to the Worker, not the zone. Works on `workers.dev`, preview URLs, and Workers for Platforms

See the [Workers Cache docs](https://developers.cloudflare.com/workers/cache/) for the full feature surface including cache keys, purging, and composition patterns.

### Legacy `headersCache` middleware

Before Workers Cache existed (July 2026), the `headersCache` middleware from `spiceflow/cloudflare` was the only way to cache Worker responses at the edge. It uses the Cache API (`caches.default`) directly inside your Worker code. **This middleware is now deprecated for most use cases.** Prefer the native Workers Cache config above.

The middleware is still available for advanced scenarios like custom cache key logic or custom `shouldCache` predicates:

```ts
import { headersCache } from 'spiceflow/cloudflare'

app.use(headersCache({
  // Custom cache eligibility check
  shouldCache: (request, response) => response.status === 200,

  // Custom cache key (must be an absolute URL string or Request)
  cacheKey: (request) => {
    const url = new URL(request.url)
    url.search = '' // ignore query params
    return url.toString()
  },
}))
```

Key differences from native Workers Cache:
- The Worker still runs on every request (middleware checks cache internally)
- No tiered caching, per-colo only
- No `stale-while-revalidate` support
- No `Cache-Tag` purging

### Edge Cache vs KV Cache

| | Workers Cache (wrangler config) | KV Cache (above) |
|---|---|---|
| **Storage** | CDN edge, regionally tiered | KV, globally replicated |
| **Durability** | Ephemeral, can be evicted | Persistent until TTL |
| **Latency** | Fastest (Worker doesn't run on hit) | ~10-50ms |
| **Consistency** | Tiered, upper tier shared globally | Eventually consistent (~60s) |
| **Best for** | High-traffic pages, API responses | Pages that must survive cache eviction |
| **Setup** | `"cache": { "enabled": true }` in wrangler.jsonc | Requires KV binding in wrangler.jsonc |

