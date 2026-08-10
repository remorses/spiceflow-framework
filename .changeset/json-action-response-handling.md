---
'spiceflow': patch
---

Server actions now handle `json()` responses gracefully. Throwing `json({ email: "Invalid", password: "Too short" }, { status: 400 })` from a server action produces a readable error message on the client (`"email: Invalid, password: Too short"`) instead of the previous generic `"Expected action response to be text/x-component"` error. If the JSON body has a `message` field, that field is used as the error message directly. Returning `json({ ... })` from a server action now unwraps the Response and delivers the parsed JSON data to the client, instead of crashing with a Flight serialization error. Response headers (like `set-cookie`) from thrown JSON responses are preserved on the Flight HTTP response.
