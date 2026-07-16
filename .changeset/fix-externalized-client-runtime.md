---
'spiceflow': patch
---

Fix duplicate Spiceflow client state with `externalizeShared`. Framework bootstrap and client components now import router state through the external `spiceflow/react` provider, so the browser evaluates one runtime and internal links fetch and render their destination.
