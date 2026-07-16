---
title: Federation
description: Compose multiple spiceflow apps at the RSC level.
icon: puzzle
---

# Federation

Federation lets you compose multiple spiceflow apps at the React Server Component level. A **remote** app exposes components, and a **host** app embeds them — with full SSR, hydration, and client interactivity.

## Remote Components

Federation lets you move React Server Component payloads across app boundaries. The producer returns `encodeFederationPayload(...)`, and the consumer either renders a fetched `Response` with `RenderFederatedPayload` or decodes it imperatively with `decodeFederationPayload`.

```tsx
import { Suspense } from 'react'
import { RenderFederatedPayload } from 'spiceflow/react'

const response = await fetch('https://my-remote.com/api/chart?props=' + encodeURIComponent(JSON.stringify({
  dataSource: 'revenue',
})))

<Suspense fallback={<div>Loading...</div>}>
  <RenderFederatedPayload response={response} />
</Suspense>

const esmResponse = await fetch('https://esm.sh/some-chart-component')

<Suspense fallback={<div>Loading...</div>}>
  <RenderFederatedPayload response={esmResponse} />
</Suspense>

const framerResponse = await fetch('https://framer.com/m/IOKnob-DT0M.js@eZsKjfnRtnN8np5uwoAx')

<Suspense fallback={<div>Loading...</div>}>
  <RenderFederatedPayload response={framerResponse} />
</Suspense>
```

`RenderFederatedPayload` must be wrapped in `<Suspense>` — the fallback shows while the server responds (federation) or while the module loads (ESM).

## Setting Up Federation

**Remote app** — exposes a Flight payload via `encodeFederationPayload`:

```tsx
// remote/vite.config.ts
import spiceflow from 'spiceflow/vite'

export default defineConfig({
  base: process.env.REMOTE_ORIGIN || 'http://localhost:3001',
  plugins: [
    spiceflow({
      entry: './src/main.tsx',
      externalizeShared: true,
    }),
  ],
})
```

```tsx
// remote/src/main.tsx
import { Spiceflow } from 'spiceflow'
import { cors } from 'spiceflow/cors'
import { encodeFederationPayload } from 'spiceflow/federation'
import { Chart } from './chart'
import { Table } from './table'
import { db } from './db'

export const app = new Spiceflow()
  .use(cors({ origin: '*' }))
  // Dynamic: fetch data at request time, render the component, return the SSE response
  .get('/api/chart', async ({ request }) => {
    const props = JSON.parse(request.parsedUrl.searchParams.get('props') || '{}')
    const rows = await db.query('SELECT month, revenue FROM sales WHERE year = 2025')
    return await encodeFederationPayload(<Chart data={rows} {...props} />)
  })
  // Static: pre-rendered at build time and written to disk.
  // Serve it from S3, a CDN, or any static host — no server needed at runtime.
  .staticGet('/api/table', async () => {
    const rows = await db.query('SELECT name, role, department FROM employees')
    return await encodeFederationPayload(<Table rows={rows} />)
  })
```

The `.staticGet` route runs at build time and writes the response to disk. You can upload the output to S3 or any static host — the host app fetches it like any other URL, and `RenderFederatedPayload` renders it with full SSR and hydration. No server running for the remote at runtime.

**Host app** — fetches the response and renders it:

```tsx
// host/src/main.tsx
import { Suspense } from 'react'
import { Spiceflow } from 'spiceflow'
import { RenderFederatedPayload } from 'spiceflow/react'

const REMOTE = process.env.REMOTE_ORIGIN || 'http://localhost:3001'

export const app = new Spiceflow()
  .page('/', async () => {
    const chart = await fetch(`${REMOTE}/api/chart`)
    const table = await fetch(`${REMOTE}/api/table`)

    return (
      <div>
        <Suspense fallback={<div>Loading chart...</div>}>
          <RenderFederatedPayload response={chart} />
        </Suspense>
        <Suspense fallback={<div>Loading table...</div>}>
          <RenderFederatedPayload response={table} />
        </Suspense>
      </div>
    )
  })
```

The remote components are SSR-rendered in the host's HTML stream, then hydrated on the client with full interactivity. CSS from the remote is automatically injected.

## Static Markup

Use `renderToStaticMarkup(...)` from `spiceflow/federation` when you need an **HTML string** from JSX inside the RSC environment. This is useful for email HTML, static snippets, and other server-only markup that should not be hydrated.

```tsx
import { renderToStaticMarkup } from 'spiceflow/federation'

app.get('/api/email-preview', async () => {
  const html = await renderToStaticMarkup(
    <section>
      <h1>Welcome, Ada</h1>
      <p>Your invite code is 1234.</p>
    </section>,
  )

  return new Response(html, {
    headers: { 'content-type': 'text/html;charset=utf-8' },
  })
})
```

Spiceflow exports this helper because React's `renderToStaticMarkup` from `react-dom/server` does **not** work inside the React Server Components environment. RSC first renders JSX to a Flight stream, then the SSR environment decodes that stream into HTML. This helper uses the same Flight-to-HTML bridge that federation uses internally.

## Imperative Decode

Use `decodeFederationPayload(response)` when you want to fetch a route manually in a client event handler and use the decoded value yourself. This works for plain objects, JSX, or objects containing JSX. Async iterables are supported when they are fields on an object payload, for example `{ stream }`.

```tsx
'use client'

import { useState } from 'react'
import { decodeFederationPayload } from 'spiceflow/react'

export function ChatButton() {
  const [parts, setParts] = useState<React.ReactNode[]>([])

  async function handleClick() {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'hello' }),
    })

    const decoded = await decodeFederationPayload<{
      message: string
      content: React.ReactNode
    }>(response)

    setParts((prev) => [...prev, <div key={prev.length}>{decoded.content}</div>])
  }

  return <button onClick={handleClick}>Load</button>
}
```

<details>
<summary>How federation works under the hood</summary>

`encodeFederationPayload` returns a `Response` in SSE (`text/event-stream`) format with these events:
- **metadata** — remoteId, client module chunk URLs, stylesheet URLs
- **ssr** — pre-rendered HTML for instant display when the top-level payload is a React element
- **modules** (zero or more) — client modules discovered while streaming; always emitted before the flight chunk that references them, so consumers can load the chunks just in time
- **flight** (one per row) — RSC Flight stream rows (serialized React tree)
- **done** — signals end of payload

Streaming payloads (async generators) discover client references lazily while rendering. The incremental `modules` events mean streamed JSX can freely mix server-rendered content and interactive client components — the consumer loads each newly announced module before feeding the next flight chunk to the decoder.

The host fetches this SSE response, SSR-renders the HTML via `dangerouslySetInnerHTML`, then hydrates using `hydrateRoot` to patch the existing DOM in-place (no flash).

**Import map and module deduplication.** Spiceflow automatically injects a `<script type="importmap">` into the HTML with entries for shared modules:

```
react, react-dom, react-dom/client, react/jsx-runtime, spiceflow/react
```

Each entry points to a hashed chunk built from the host app's own dependencies. When a remote component's client code does `import React from 'react'`, the browser resolves it through the import map to the **host's React chunk** — not a separate copy. This is how federation avoids duplicate React instances (which would break hooks and context). The same deduplication works for any module you add via the `importMap` plugin option: if a Framer component does `import { motion } from 'framer-motion'`, and you've mapped `framer-motion` to a local re-export file, the browser loads the host's bundled copy.

This means remote client components can use `useRouterState` from the host and read host-provided React contexts (via `useContextBridge` from [its-fine](https://github.com/pmndrs/its-fine)). External ESM components from esm.sh or Framer also benefit — as long as they externalize `react` (e.g. `https://esm.sh/some-lib?external=react`), the import map resolves the bare specifier to the host's instance and everything just works.

</details>

## Streaming and Suspense

`encodeFederationPayload` handles React elements and plain objects differently. When the top-level value is a **React element**, the entire flight stream is buffered before any SSE events are sent. This gives the consumer SSR HTML for instant display, but it means **Suspense boundaries inside the element do not stream incrementally**. The client waits until every promise resolves before seeing anything.

When the top-level value is a **plain object**, flight rows stream incrementally as they become available. Suspense fallbacks arrive immediately, and resolved content streams in later.

If streaming matters for your federation payload (slow data fetches, AI responses, anything behind a `<Suspense>` boundary), wrap your JSX in an object and render it on the consumer side:

```tsx
// ❌ Top-level JSX — entire payload is buffered, no Suspense streaming
app.get('/api/dashboard', async () => {
  return await encodeFederationPayload(
    <Suspense fallback={<div>Loading...</div>}>
      <SlowChart />
    </Suspense>
  )
})

// ✅ Object with JSX field — flight rows stream incrementally
app.get('/api/dashboard', async () => {
  return await encodeFederationPayload({
    chart: (
      <Suspense fallback={<div>Loading...</div>}>
        <SlowChart />
      </Suspense>
    ),
  })
})
```

The consumer decodes the object and renders the JSX field:

```tsx
'use client'

import { useEffect, useState } from 'react'
import { decodeFederationPayload } from 'spiceflow/react'

export function Dashboard() {
  const [chart, setChart] = useState<React.ReactNode>(null)

  useEffect(() => {
    fetch('/api/dashboard')
      .then((res) => decodeFederationPayload<{ chart: React.ReactNode }>(res))
      .then((decoded) => setChart(decoded.chart))
  }, [])

  return <div>{chart}</div>
}
```

The same applies to async iterables. Wrapping a generator in an object field streams items as they yield:

```tsx
app.get('/api/feed', async () => {
  async function* items() {
    yield { id: '1', text: 'first' }
    await sleep(100)
    yield { id: '2', text: 'second' }
  }
  return await encodeFederationPayload({ stream: items() })
})
```

**Why the difference?** Top-level React elements get SSR-rendered into an HTML string before sending, which requires the complete flight payload. Objects skip SSR and stream rows as they arrive. This is a tradeoff: top-level elements give instant visible HTML (no flash of empty content), while object payloads give incremental streaming at the cost of no SSR preview.

## External ESM Components

`RenderFederatedPayload` also works with plain JavaScript modules — any URL that returns `content-type: text/javascript`. The module is dynamically imported in the browser, and its default export (or first function export) is rendered as a React component.

This is useful for loading components from Framer, esm.sh, or any CDN that serves ES modules. ESM components are **client-only** — they render `null` during SSR and load after hydration.

Framer components import bare specifiers like `framer` and `framer-motion`. These need to be in the browser's import map so the dynamic `import()` can resolve them. Use the `importMap` option in your Vite config to point these specifiers to local re-export files — this way the browser uses the same bundled instance as your host app (deduplication):

```ts
// vite.config.ts
import spiceflow from 'spiceflow/vite'

export default defineConfig({
  plugins: [
    spiceflow({
      entry: './src/main.tsx',
      importMap: {
        'framer-motion': './src/shared/framer-motion.ts',
        'framer': './src/shared/framer.ts',
      },
    }),
  ],
})
```

```ts
// src/shared/framer-motion.ts
export * from 'framer-motion'
```

```ts
// src/shared/framer.ts
export * from 'framer'
```

Each local file is built into a hashed chunk — the same pattern spiceflow uses internally for React and `spiceflow/react`. If you prefer loading from a CDN instead, pass a URL:

```ts
importMap: {
  'framer-motion': 'https://esm.sh/framer-motion?external=react',
  'framer': 'https://esm.sh/unframer@latest/esm/framer.js?external=react',
}
```

These entries are merged into the auto-generated import map that spiceflow already injects for `react`, `react-dom`, `react/jsx-runtime`, and `spiceflow/react`.
