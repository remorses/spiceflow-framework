---
'spiceflow': patch
---

fix infinite recursion during SSR when a parent app registers a wildcard layout (like `.layout('/*', ({ children }) => <>{children}</>)`) and a mounted child app registers a layout on the same path. Route ids were only unique per Spiceflow instance, so both layouts got the same id and the client-side layout resolver made the child layout resolve to itself, crashing every page render with "Maximum call stack size exceeded". Layout ids are now uniquified per request, so the parent wildcard layout wraps child app pages exactly once as the outermost layout.
