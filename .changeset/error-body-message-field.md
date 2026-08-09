---
'spiceflow': patch
---

document that API error bodies must name the human-readable field `message`, never `error`. `SpiceflowFetchError` builds its `.message` from that key, so callers read `err.message` like on any other `Error`; with any other key the client falls back to `JSON.stringify(body)` and `err.message` becomes a raw JSON blob. All README and docs examples now use `{ message: '...' }` with machine-readable data in sibling fields such as `code`.
