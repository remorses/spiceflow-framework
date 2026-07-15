---
'spiceflow': patch
---

Fix `externalizeShared` breaking client hydration due to import map cycle and CJS `require()` errors.

Federation shared entry chunks are now pre-bundled with esbuild into self-contained ESM modules during the client build. This fixes two issues:

1. **Import map cycle**: bare specifiers like `from "react/jsx-runtime"` in the shared entry output matched the import map, which pointed back to the same chunk file, creating a browser module cycle.

2. **CJS require() in browser**: React/react-dom are CJS internally. When Rolldown bundled them, transitive deps like react-dom's `require('react')` were externalized (matching REACT_EXTERNALS), generating CJS `require()` calls. Import maps only work for ESM `import`, not CJS `require()`, so the call failed in the browser.

Pre-bundling with esbuild (no externals) inlines all transitive deps as ESM with proper CJS-to-ESM conversion and no `require()` calls.
