---
'spiceflow': patch
---

remove the `user-components` federation client chunk split so remotes and normal RSC producers share one path. encode ships client chunk deps but drops `spiceflow-framework` and the vite-rsc client entry (`index-*.js`), which hosts must not load. loadFederatedClientModules only registers chunks that export `export_${id}`.
