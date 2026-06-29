---
'spiceflow': patch
---

Fix OOM during standalone dependency tracing on large projects by disabling `emitGlobs` in @vercel/nft.

The nft tracer's `emitGlobs` feature triggers `glob()` filesystem scans when it detects wildcard require patterns like `require('./' + name)`. These scans pull entire directories into the trace, cascading into more AST parsing and unbounded cache growth (4GB+ heap on large apps). Disabling only `emitGlobs` fixes the OOM while keeping native addon detection, pino transport tracing, and `__dirname` file references working.

Also adds an `nft` option to the spiceflow vite plugin for tuning tracing behavior:

```ts
spiceflow({
  entry: './src/main.tsx',
  // re-enable glob expansion
  nft: { analysis: true },
  // disable all analysis for max speed
  nft: { analysis: false },
  // lower concurrent fs ops for memory-constrained envs
  nft: { fileIOConcurrency: 512 },
})
```
