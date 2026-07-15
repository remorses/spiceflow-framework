import { describe, expect, it } from 'vitest'
import { injectRSCPayload } from './transform.js'

describe('injectRSCPayload', () => {
  it('strips the original closing tags and appends them once', async () => {
    const encoder = new TextEncoder()
    const decoder = new TextDecoder()
    const readable = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('<html><body>hello'))
        controller.enqueue(encoder.encode('</body></html>'))
        controller.close()
      },
    })

    const transformed = readable.pipeThrough(injectRSCPayload({}))
    const chunks: Uint8Array[] = []
    const reader = transformed.getReader()

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
    }

    const result = decoder.decode(Buffer.concat(chunks))
    expect(result).toBe('<html><body>hello</body></html>')
    expect(result.match(/<\/body><\/html>/g)).toHaveLength(1)
  })

  it('injects shared module preloads after the import map', async () => {
    const encoder = new TextEncoder()
    const readable = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode('<html><head></head><body>hello</body></html>'),
        )
        controller.close()
      },
    })

    const transformed = readable.pipeThrough(
      injectRSCPayload({
        importMapJson: '{"imports":{"react":"/react.js"}}',
        modulePreloadUrls: ['/react.js', '/react.js', '/react-dom.js?v=1&x=2'],
      }),
    )
    const result = await new Response(transformed).text()

    expect(result).toMatchInlineSnapshot(
      `"<html><head><script type=\"importmap\">{\"imports\":{\"react\":\"/react.js\"}}</script><link rel=\"modulepreload\" href=\"/react.js\"><link rel=\"modulepreload\" href=\"/react-dom.js?v=1&amp;x=2\"></head><body>hello</body></html>"`,
    )
  })

  it('keeps the injected flight script wrapper valid', async () => {
    const encoder = new TextEncoder()
    const decoder = new TextDecoder()
    const html = '<html><body>hello</body></html>'
    const rscStream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('"flight"'))
        controller.close()
      },
    })

    const readable = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(html))
        controller.close()
      },
    })

    const transformed = readable.pipeThrough(injectRSCPayload({ rscStream }))
    const chunks: Uint8Array[] = []
    const reader = transformed.getReader()

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
    }

    const result = decoder.decode(Buffer.concat(chunks))
    expect(result).toContain(
      '<script>(self.__FLIGHT_DATA||=[]).push("\\"flight\\"")</script>',
    )
    expect(result).not.toContain('</\\script>')
  })
})
