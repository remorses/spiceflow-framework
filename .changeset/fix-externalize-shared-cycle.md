---
'spiceflow': patch
---

Fix `externalizeShared` creating a self-referencing import map cycle that kills client hydration.

When `externalizeShared: true` was set (used by holocron), the federation shared entry chunks (e.g. `federation-jsx-runtime-*.js`) contained bare specifiers like `from "react/jsx-runtime"`. The import map mapped `react/jsx-runtime` back to the same chunk file, causing a browser module cycle:

```
Uncaught SyntaxError: Detected cycle while resolving name 'default' in 'react/jsx-runtime'
```

The shared entry source files now import from `#federation/*` specifiers (mapped via `package.json` imports to the real packages). These don't match the `REACT_EXTERNALS` list, so Rolldown bundles the actual React code into the shared entry chunks instead of leaving bare specifiers that point back to themselves.
