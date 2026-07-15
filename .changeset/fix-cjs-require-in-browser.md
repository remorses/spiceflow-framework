---
'spiceflow': patch
---

Fix federation shared entries generating CJS `require()` calls that fail in the browser. Shared entry chunks are now pre-bundled with esbuild into self-contained ESM, properly converting CJS React/react-dom code without any `require()` calls.
