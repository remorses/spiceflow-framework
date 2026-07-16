---
'spiceflow': patch
---

Fix `useId()` hydration mismatch between SSR and client in production builds. The SSR component tree was missing a sibling placeholder for `DefaultScrollRestoration`, causing React's tree-position-based ID generation to produce different values during SSR vs hydration. This broke any library using `useId()` internally (base-ui, radix-ui, headless-ui, etc).
