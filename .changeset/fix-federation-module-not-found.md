---
'spiceflow': patch
---

Fix "Module not found in remote registry" error when a federation payload's client component has only entry/framework JS deps. Previously `selectClientChunks` stripped all such deps and the module was silently dropped from `clientModules` metadata, even though Flight still referenced it. Now falls back to the module's own path so the consumer can still load it.
