---
'spiceflow': patch
---

Update to latest Vite ecosystem packages: vite 8.2.1, @vitejs/plugin-rsc 0.5.34, @vitejs/plugin-react 6.0.5, react 19.2.8.

Fix infinite `resolveId` recursion between `spiceflow:dedupe-singleton` and `rsc:virtual-client-package` that caused production builds to hang at the RSC transform step. The dedupe resolver now passes a custom marker to prevent re-entry when other plugins intercept the resolution chain.

Fix `useId()` hydration mismatch in production builds caused by a missing `<Toaster />` placeholder in the SSR render tree. The SSR tree structure now matches the browser tree exactly so React generates identical IDs during server rendering and client hydration.
