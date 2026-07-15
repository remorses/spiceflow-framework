---
'spiceflow': patch
---

Fix federation shared entry pre-bundling not triggering when module paths are resolved differently from the computed SHARED_ENTRIES paths (e.g. due to symlinks, pnpm virtual store, or real-path normalization). The load hook now matches by path suffix instead of exact equality.
