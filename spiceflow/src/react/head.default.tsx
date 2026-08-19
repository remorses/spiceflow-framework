// Fallback for the client/SSR environment. `Head` is an RSC-only API.
//
// `Head` does not render anything. It records its children into a
// `React.cache()` store during the RSC render, and `CollectedHead` reads that
// store back out when spiceflow builds the document head. A `'use client'`
// module is never executed during the RSC render, so a `<Head>` inside one
// records nothing: the page silently ships with no `<title>` and no `<meta>`,
// with no error and no warning anywhere.
//
// That silent no-op is very expensive to debug, because the page looks fine and
// only the document head is missing. Throwing here turns it into an immediate
// error on the first render instead of an SEO bug discovered weeks later.
import { __spiceflowVitestMode } from '#rsc-runtime'

import { Head as ServerHead } from './head.tsx'

function HeadInClientComponent(): null {
  // The vitest harness renders server components through this entry too, since
  // it never applies the `react-server` condition. Spiceflow does not build a
  // document head in that mode (routes return the JSX tree directly), so keep
  // the historical no-op there instead of failing legitimate server usage.
  if (__spiceflowVitestMode) return null

  throw new Error(
    '[spiceflow] <Head> only works inside a server component, and this one is in a "use client" module.\n' +
      'Head tags are collected during the RSC render, which never runs client components, so this <Head> ' +
      'cannot contribute anything to the document head.\n' +
      'Move it into the .page() or .layout() handler that renders this component, or into any server ' +
      'component in the tree. To change the title from the browser, set document.title in an effect instead.',
  )
}

/**
 * Throws when rendered. See the comment above: the real `Head` lives in the
 * `react-server` build and is resolved through the `react-server` export
 * condition of `spiceflow/react`.
 *
 * Typed as `typeof ServerHead` so both builds present the identical API and
 * editors show no difference between a server and a client file.
 */
export const Head: typeof ServerHead = Object.assign(HeadInClientComponent, {
  Meta: ServerHead.Meta,
  Title: ServerHead.Title,
  Link: ServerHead.Link,
  Script: ServerHead.Script,
  Style: ServerHead.Style,
  Base: ServerHead.Base,
})
