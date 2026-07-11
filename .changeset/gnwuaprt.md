---
'spiceflow': minor
---

Add `externalizeShared` config option that externalizes React and shared deps from client chunks at build time. Federation payloads then use bare specifiers resolved by the host's import map, without requiring the full `federation: 'remote'` mode. The app still works as a normal first-party site with dev HMR, no absolute base URL, and no special chunk splitting.
