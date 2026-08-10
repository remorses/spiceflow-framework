---
'spiceflow': patch
---

Recover from missing client references in production instead of crashing.

When a stale browser tab navigates after a deploy and the server returns an RSC payload referencing a client component whose JS chunk no longer exists, the page now hard-reloads automatically to fetch fresh assets. Previously this threw `"client reference not found"` and crashed React with no recovery.

Uses `sessionStorage` with a 60-second window to prevent infinite reload loops. If the reload doesn't fix the problem, the error propagates to React's error boundary instead of looping. Skipped in dev mode so the Vite error overlay still shows.

Also deduplicates the `__vite_rsc_client_require__` wrapping logic between the browser entry and federation into a shared `wrapRequireWithFallback` function.
