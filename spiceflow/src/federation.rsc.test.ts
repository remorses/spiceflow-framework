// Tests the federation SSE encoder stream behavior and cancellation cleanup.
import { beforeEach, describe, expect, test, vi } from 'vitest'

let cancelFlightStream = vi.fn()

// Configurable client references the mock will emit during rendering.
// Each test can push entries before calling encodeFederationPayload.
let pendingClientRefs: {
  id: string
  name: string
  deps: { js: string[]; css: string[] }
}[] = []

vi.mock('#rsc-runtime', () => ({
  renderToReadableStream(_value: unknown, _unused: unknown, opts?: { onClientReference?: (meta: any) => void }) {
    // Fire any queued client references so the encoder sees them.
    for (const ref of pendingClientRefs) {
      opts?.onClientReference?.(ref)
    }
    pendingClientRefs = []

    let sent = false
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent) return
        sent = true
        controller.enqueue(new TextEncoder().encode('0:{"ok":true}\n1:{"ok":false}\n'))
      },
      cancel() {
        cancelFlightStream()
      },
    })
  },
}))

import { encodeFederationPayload } from './federation.rsc.ts'

describe('encodeFederationPayload', () => {
  beforeEach(() => {
    cancelFlightStream = vi.fn()
  })

  test('streams SSE events incrementally with streaming-safe headers', async () => {
    const response = await encodeFederationPayload({ message: 'hello' })

    expect(response.headers.get('content-type')).toBe(
      'text/event-stream; charset=utf-8',
    )
    expect(response.headers.get('content-encoding')).toBe('none')

    const reader = response.body?.getReader()
    expect(reader).toBeDefined()

    const decoder = new TextDecoder()
    const firstChunk = decoder.decode((await reader!.read()).value)
    const secondChunk = decoder.decode((await reader!.read()).value)
    const thirdChunk = decoder.decode((await reader!.read()).value)

    expect(firstChunk).toContain('event: metadata\n')
    expect(firstChunk).toContain('"clientModules":{}')
    expect(firstChunk).toContain('"cssLinks":[]')
    expect(secondChunk).toBe('event: ssr\ndata: {"html":""}\n\n')
    expect(JSON.parse(thirdChunk.match(/^event: flight\ndata: (.*)\n\n$/)?.[1] ?? '""')).toBe(
      '0:{"ok":true}\n1:{"ok":false}\n',
    )

    await reader!.cancel()
  })

  test('includes chunk after entry when it is not framework or entry', async () => {
    // In production builds, vite-rsc lists deps as: framework chunk,
    // entry chunk (index-*.js), then the chunk containing the actual module.
    // The old code used `break` at the entry, dropping everything after it.
    // The fix uses `continue` so non-entry, non-framework chunks after the
    // entry are still included.
    pendingClientRefs.push({
      id: '763edff9d1d3',
      name: 'P',
      deps: {
        js: [
          '/assets/spiceflow-framework-abc.js',
          '/assets/index-def.js',
          '/assets/worker-entry-ghi.js',
        ],
        css: [],
      },
    })

    const response = await encodeFederationPayload({ message: 'hello' })
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    const firstChunk = decoder.decode((await reader!.read()).value)

    const metadataMatch = firstChunk.match(/data: ({.*})/)
    expect(metadataMatch).toBeTruthy()
    const metadata = JSON.parse(metadataMatch![1])

    // worker-entry is included even though it appears after the entry chunk
    expect(metadata.clientModules).toMatchInlineSnapshot(`
      {
        "763edff9d1d3": {
          "chunks": [
            "/assets/worker-entry-ghi.js",
          ],
          "css": [],
        },
      }
    `)

    await reader!.cancel()
  })

  test('drops module when deps only contain entry and framework chunks', async () => {
    pendingClientRefs.push({
      id: 'abc123',
      name: 'X',
      deps: {
        js: ['/assets/spiceflow-framework-abc.js', '/assets/index-def.js'],
        css: [],
      },
    })

    const response = await encodeFederationPayload({ message: 'hello' })
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    const firstChunk = decoder.decode((await reader!.read()).value)

    const metadataMatch = firstChunk.match(/data: ({.*})/)
    expect(metadataMatch).toBeTruthy()
    const metadata = JSON.parse(metadataMatch![1])

    expect(metadata.clientModules).toMatchInlineSnapshot(`{}`)

    await reader!.cancel()
  })

  test('cancels the underlying flight stream when the consumer aborts', async () => {
    const response = await encodeFederationPayload({ message: 'hello' })
    const reader = response.body!.getReader()

    await reader.read()
    await reader.read()
    await reader.read()
    await reader.cancel()

    expect(cancelFlightStream).toHaveBeenCalledTimes(1)
  })
})
