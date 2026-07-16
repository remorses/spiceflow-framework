---
'spiceflow': patch
---

Replace the `federation: 'remote'` Vite option with `externalizeShared: true` for federation producers. The unified option now configures strict client entry signatures, shared-module externalization in production and development, OXC JSX, and dev CSS metadata. Remote client component styles are again injected in normal documents and isolated shadow roots when the producer runs with `vite dev`.
