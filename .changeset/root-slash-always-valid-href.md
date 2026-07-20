---
'spiceflow': patch
---

Make `'/'` always valid in typed hrefs. `<Link href="/">`, `router.href('/')`, and `router.push('/')` now type-check correctly even when the home route registers with path `''`. Also fix `buildHref('')` to return `'/'` instead of an empty string, which previously caused anchor hrefs to point at the current page instead of the site root.
