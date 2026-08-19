// Tests Head deduplication so nested metadata renders once.
import React from 'react'
import ReactDOMServer from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import { Head, collectHeadElements } from './head.js'
import { Head as ClientHead } from './head.default.js'
import { getProcessedHeadTagElements } from './head-processing.js'

describe('Head', () => {
  test('deduplicates nested head tags during collection', () => {
    const tags = collectHeadElements(
      <>
        <Head.Title>Nested title</Head.Title>
        <Head.Title>Nested title</Head.Title>
        <Head.Meta name="description" content="Nested description" />
        <Head.Meta name="description" content="Nested description" />
        <div>
          <Head.Meta property="og:image" content="/nested-image.png" />
        </div>
      </>,
    )
    const html = ReactDOMServer.renderToStaticMarkup(
      <>{getProcessedHeadTagElements({ tags })}</>,
    )

    expect(html).toMatchInlineSnapshot(
      '"<title>Nested title</title><meta name=\"description\" content=\"Nested description\"/><meta property=\"og:image\" content=\"/nested-image.png\"/>"',
    )
  })

  test('preserves icons with different media queries', () => {
    const tags = collectHeadElements(
      <>
        <Head.Link
          rel="icon"
          href="/icon-light.png"
          media="(prefers-color-scheme: light)"
        />
        <Head.Link
          rel="icon"
          href="/icon-dark.png"
          media="(prefers-color-scheme: dark)"
        />
      </>,
    )
    const html = ReactDOMServer.renderToStaticMarkup(
      <>{getProcessedHeadTagElements({ tags })}</>,
    )

    expect(html).toMatchInlineSnapshot(
      '"<link rel=\"icon\" href=\"/icon-light.png\" media=\"(prefers-color-scheme: light)\"/><link rel=\"icon\" href=\"/icon-dark.png\" media=\"(prefers-color-scheme: dark)\"/>"',
    )
  })
})

// `spiceflow/react` resolves to head.default.tsx outside the react-server
// condition, which is what every "use client" module gets. Rendering a <Head>
// there used to collect nothing and drop the document head silently.
describe('Head in a client component', () => {
  test('throws instead of silently collecting nothing', () => {
    expect(() =>
      ReactDOMServer.renderToStaticMarkup(
        <ClientHead>
          <ClientHead.Title>Never reaches the document</ClientHead.Title>
        </ClientHead>,
      ),
    ).toThrowErrorMatchingInlineSnapshot(`
      [Error: [spiceflow] <Head> only works inside a server component, and this one is in a "use client" module.
      Head tags are collected during the RSC render, which never runs client components, so this <Head> cannot contribute anything to the document head.
      Move it into the .page() or .layout() handler that renders this component, or into any server component in the tree. To change the title from the browser, set document.title in an effect instead.]
    `)
  })

  test('still exposes the tag components so types and dedup keys match', () => {
    expect(ClientHead.Title).toBe(Head.Title)
    expect(ClientHead.Meta).toBe(Head.Meta)
    expect(ClientHead.Link).toBe(Head.Link)
    expect(ClientHead.Script).toBe(Head.Script)
    expect(ClientHead.Style).toBe(Head.Style)
    expect(ClientHead.Base).toBe(Head.Base)
  })
})
