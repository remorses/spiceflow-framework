---
'spiceflow': patch
---

Fix `externalizeShared` hydration failures by building import-map providers in a separate module graph. Shared React providers are now self-contained browser ESM with no self-referencing bare imports, and CommonJS calls to externalized modules are converted to browser-safe ESM imports. Application and federation chunks continue resolving shared modules through the host import map, and the generated HTML module-preloads every shared provider so hydration can fetch them immediately.
