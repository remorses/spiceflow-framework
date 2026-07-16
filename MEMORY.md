# Session memory

## Minimize scope to the actual problem

When user asks to fix "X", implement only X. Don't add defensive features for edge cases they didn't mention.

**Example:** user asked to "update document.title on client-side navigation". First attempt added:
- `FALLBACK_TAG_NAMES` + `getReactTypeName()` (module-federation edge case — never asked for)
- Eager `getHeadSnapshot()` replacing the existing `CollectedHead` architecture
- Tree walking with `flattenText`/`extractTitleText` helpers

User response: "This looks like an over-engineered mess." Correct reaction — the actual fix is ~15 lines.

## RSC head store architecture in spiceflow

`spiceflow/src/react/head.tsx` uses `React.cache(() => ({ tags: [] }))` for per-request isolation.

Render order guarantees:

```
layouts/page render  →  <Head> runs  →  pushes into getHeadStore().tags
                                                      │
                                                      ▼
                                             CollectedHead renders LAST
                                             (placed in FlightData.head)
                                                      │
                                                      ▼
                                             reads store, emits <title>...<meta>
```

This means **any server component placed alongside `CollectedHead`** can also read
the populated store. No need for a second tree walk or parallel mechanism.

To add title-updating on client navigation: extend `CollectedHead` to also render a
`'use client'` component with the title string. That component does
`useEffect(() => { document.title = title }, [title])`. Reuses the same store.

## Don't replicate machinery when a store already exists

If data is already collected somewhere (via `React.cache`, context, etc), consume
it from its existing storage instead of walking trees or adding parallel state.

## Keep generated READMEs in sync

After editing root `README.md`, regenerate the three downstream copies:

```bash
echo '<!-- DO NOT EDIT: This file is auto-generated from root README.md -->' > ./spiceflow/README.md
echo '' >> ./spiceflow/README.md
cat ./README.md >> ./spiceflow/README.md
cp ./README.md ./website/app/readme.mdx
cp ./README.md ./website/public/readme.md
```

The three generated files are gitignored, so they don't show in `git status`.

## Vite 8 optimizeDeps: `+` bug with pnpm scoped packages

**Symptom:** dev server crashes on startup with

```
TypeError: Cannot destructure property 'exportsData' of
           'depForEntryFileName[chunk.fileName]' as it is undefined.
    at ...vite/dist/node/chunks/node.js:31312:14
```

**Cause:** pnpm stores scoped packages in `.pnpm/@scope+pkg@version/` directories —
`+` is pnpm's scope separator. Vite's `flattenId` does NOT escape `+`, but rolldown
replaces `+` with `_` in chunk filenames. So if `optimizeDeps.include` contains an
absolute path like `.pnpm/@vitejs+plugin-rsc@.../.../file.js`, the key in
`depForEntryFileName` has `+` but the chunk filename has `_` → mismatch → crash.

**Debug technique:** patch node_modules vite to log the missing chunk:

```js
if (!depForEntryFileName[chunk.fileName]) {
  console.error('[DEBUG] missing:', chunk.fileName, 'keys:', Object.keys(depForEntryFileName))
}
```

**Fix approaches:**
1. Use `'spiceflow > dep'` nested-id syntax — Vite's `nestedResolveBasedir` already
   respects `preserveSymlinks` so pnpm `+` paths aren't produced. Simplest. Downside:
   requires spiceflow to be resolvable from the project root (breaks wrapper-plugin
   nesting like `@holocron.so/vite` → spiceflow).
2. Wrapper plugins can prefix: `'holocron > spiceflow > superjson'` when spiceflow
   is nested. Wrapper knows its own name.
3. Use `tryResolve` + post-process `.pnpm/.../node_modules/` segment to get the
   symlinked path (our previous fix, now reverted for simplicity).

**Upstream:** this is a Vite/rolldown bug. `flattenId` should escape `+` or
rolldown shouldn't normalize it.

## Strict federation entry facades

Keep client `preserveEntrySignatures = 'strict'`: `allow-extension` merges remote client-reference implementations into the producer `index` chunk. `selectClientChunks` intentionally excludes that entry to avoid bootstrapping the producer inside the host, so merged implementations disappear from federation metadata and hydration, shadow roots, ESM components, and navigation fail. Strict facades preserve independently loadable client-reference chunks while still excluding the producer bootstrap.

## Wrapper plugin architecture

`@holocron.so/vite` (at ~/Documents/GitHub/holocron) wraps spiceflow and bundles
it as a transitive dep. When wrapper plugins use spiceflow's
`optimizeDeps.include` entries, they need to rewrite `'spiceflow > X'` to
`'<wrapper-name> > spiceflow > X'` so Vite can resolve them from the consumer's
project root (where only the wrapper is installed, not spiceflow directly).

**Shipped pattern:** a small plugin that runs AFTER `spiceflowPlugin` and maps
entries. Lives in `holocron/vite/src/vite-plugin.ts` as
`rewriteSpiceflowNestedIds` (commit `7aff1049` in holocron,
`aebee8d` in spiceflow).

```ts
const rewriteSpiceflowNestedIds: Plugin = {
  name: 'holocron:rewrite-spiceflow-nested-ids',
  configEnvironment(_name, config) {
    if (!config.optimizeDeps?.include) return
    config.optimizeDeps.include = (
      config.optimizeDeps.include as string[]
    ).map((entry) =>
      typeof entry === 'string' && entry.startsWith('spiceflow >')
        ? `@holocron.so/vite > ${entry}`
        : entry,
    )
  },
}
```

Plugin order in the returned array matters — spiceflowPlugin must come first
so its `'spiceflow > X'` entries are already present when we rewrite.

## CollectedHead: derive DocumentTitle from deduped tags, not reversed.find

`CollectedHead` in `spiceflow/src/react/head.tsx` used to pick the title in two
independent ways: the SSR `<title>` went through `getProcessedHeadTagElements`
(Map-based dedup, last `.set()` wins), while `DocumentTitle`'s `title` prop came
from `reversed.find((t) => t.type === 'title')` (first match wins). For input
store `[page, layout]` those two code paths disagree: the Map picks `page`
(layout set first, then page overwrites), the `find` picks `layout` (first in
the reversed array). Result: SSR HTML shows `<title>Page title</title>`, then
hydration runs `DocumentTitle.useEffect` which sets `document.title = "Layout
title"` and the tab silently flips.

Fix: call `getProcessedHeadTagElements` first, then read the title from the
deduped output via `processedTags.find((t) => t.type === 'title')`. One source
of truth, so SSR and client stay in sync regardless of push order.

Testing lesson: `toHaveTitle` retry assertions can give false positives for
race conditions — they pass as soon as the title matches once. To catch
hydration overrides, first wait for a post-hydration signal (e.g.
`layout-mount-count` going from 0 to 1) and then assert with a plain `expect`.

## React.cache() dual instance: use resolve.dedupe, not custom dispatchers

`@vitejs/plugin-rsc` vendors `react-server-dom-webpack` as CJS files that do
`require("react")`. Under pnpm's strict module isolation, this `require` can
resolve to a different React instance than user code's `import React from 'react'`.
The vendor's `renderToReadableStream` sets `ReactSharedInternals.A` (cache dispatcher)
on its React, but user code reads `A` from a different instance → `React.cache()`
returns fresh objects every call → Head/CollectedHead tag collection breaks.

**Fix:** `resolve.dedupe: ['react', 'react-dom', ...]` in RSC and SSR environments.
This forces Vite to resolve all React imports from the project root regardless of
where the importer lives. One line in `configEnvironment`, no custom dispatchers needed.

**Wrong fix:** Custom `AsyncLocalStorage`-backed cache dispatcher wired into
`ReactSharedInternals.A` (commit `eb96e01`). Works but reimplements React internals
and doesn't address the root cause.

## Git safety

During this session I tried to revert a recently-committed local change and
got blocked by the instruction "NEVER rewrite git history / amend unless
asked". Correct response: add a new follow-up commit that undoes/redoes, do
not reset/amend. That's what `aebee8d` does on top of `7cdae0c`.

## Federation stream cancellation

Federated RSC streaming needs cancellation wired through both layers: the outer SSE `Response` stream and the inner Flight stream/parser. If either side lacks `cancel()`/`return()` cleanup, aborted decodes keep reading in the background and streaming fixes look correct in happy-path tests while still leaking work.

## Standalone test isolation

`test-e2e-start` runs the built server from the app root, so Node can still fall back to source `node_modules` and hide missing `dist/node_modules` files. For standalone tracing regressions, copy `dist/` into a temp directory and boot `node dist/rsc/index.js` there so resolution only sees traced output.

## Returned page responses

If a `.page()` or `.layout()` handler returns a `Response`, never place that object directly into `FlightData` (`page`/`layouts`) or React RSC serialization crashes with `Only plain objects... {page: Response}`. Redirect `Response`s should short-circuit out of `renderReact()` as raw HTTP responses; non-redirect `Response`s should be turned into `<ThrowResponse>` so browser/client navigation still goes through the existing notFound/error boundary flow.

## Federation modules must be announced just-in-time

Streaming federation payloads discover client references while flight chunks are already being consumed, so a metadata-only module map is architecturally insufficient. Any module announcement mechanism must emit incrementally, ordered before the flight chunk that references the module; the consumer pump must await chunk loading before enqueueing later flight chunks into the Flight decoder.

## Federation require patch: host-first and memoized

The patched `__vite_rsc_require__` must try the host loader before the remote registry (same-site federation shares ids; registry-first shadows host modules with sync objects and blanks client nav) and must return the same promise instance per id: React's flight client preloads then requires, and a fresh promise on the second call lacks `.status`, so React executes `throw moduleExports.reason` → `throw undefined`.
