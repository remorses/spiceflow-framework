---
'spiceflow': patch
---

add optional `knownPaths` property to `SpiceflowRegister` for declaring extra valid typed paths that are not part of `typeof app` (mounted sub-apps, docs generators, external route tables). Declared paths flow into `router.href()`, `<Link>`, `router.push()`, and `router.replace()`, with full support for `:param` and `*` wildcard patterns:

```ts
declare module 'spiceflow/react' {
  interface SpiceflowRegister {
    app: typeof app
    knownPaths: '/docs' | '/docs/:slug' | '/files/*'
  }
}

router.href('/docs/:slug', { slug: 'intro' }) // typed
router.href('/files/*', { '*': 'a/b.txt' })   // typed
```
