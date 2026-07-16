// Tests the federation SSE encoder stream behavior and cancellation cleanup.
import { beforeEach, describe, expect, test, vi } from 'vitest'

let cancelFlightStream = vi.fn()

// Configurable client references the mock will emit during rendering.
// Each test can push entries before calling encodeFederationPayload.
type ClientRef = {
  id: string
  name: string
  deps: { js: string[]; css: string[] }
}
let pendingClientRefs: ClientRef[] = []

// Scripted flight chunks: each step can fire client references (simulating
// Flight discovering a reference while serializing that chunk) right before
// the chunk bytes are enqueued. Used to test mid-stream `modules` events.
let scriptedChunks: { refs?: ClientRef[]; chunk: string }[] | null = null

vi.mock('#rsc-runtime', () => ({
  renderToReadableStream(_value: unknown, _unused: unknown, opts?: { onClientReference?: (meta: any) => void }) {
    // Fire any queued client references so the encoder sees them.
    for (const ref of pendingClientRefs) {
      opts?.onClientReference?.(ref)
    }
    pendingClientRefs = []

    if (scriptedChunks) {
      const steps = scriptedChunks
      scriptedChunks = null
      let index = 0
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          if (index >= steps.length) {
            controller.close()
            return
          }
          const step = steps[index++]
          for (const ref of step.refs ?? []) {
            opts?.onClientReference?.(ref)
          }
          controller.enqueue(new TextEncoder().encode(step.chunk))
        },
        cancel() {
          cancelFlightStream()
        },
      })
    }

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

async function readAllSSEEvents(response: Response) {
  const text = await response.text()
  const events: { event: string; data: string }[] = []
  for (const block of text.split('\n\n')) {
    const trimmed = block.trim()
    if (!trimmed) continue
    let event = ''
    let data = ''
    for (const line of trimmed.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice(7)
      else if (line.startsWith('data: ')) data = line.slice(6)
      else if (line === 'data:') data = ''
    }
    if (event) events.push({ event, data })
  }
  return events
}

describe('encodeFederationPayload', () => {
  beforeEach(() => {
    cancelFlightStream = vi.fn()
    scriptedChunks = null
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

  test('announces module with empty chunks when deps only contain entry and framework chunks', async () => {
    // The module code only lives inside entry/framework chunks that
    // consumers must not load. Instead of silently dropping the module
    // (which caused "Module not found in remote registry" with no context),
    // announce it with an empty chunk list — same-site consumers resolve it
    // through the host registry, cross-site consumers get a precise error.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
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

    expect(metadata.clientModules).toMatchInlineSnapshot(`
      {
        "abc123": {
          "chunks": [],
          "css": [],
        },
      }
    `)
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('no loadable chunks'),
    )
    consoleError.mockRestore()

    await reader!.cancel()
  })

  test('emits modules events before the flight chunk that references them', async () => {
    // Simulates a streaming payload (async generator) where a client
    // reference is discovered mid-stream — the exact holocron chat shape.
    // The `modules` event must always precede the flight event whose chunk
    // references the newly discovered module.
    scriptedChunks = [
      { chunk: '0:{"stream":"$1"}\n' },
      {
        refs: [
          {
            id: '763edff9d1d3',
            name: 'P',
            deps: { js: ['/assets/markdown-abc.js'], css: ['/assets/md.css'] },
          },
        ],
        chunk: '2:I["763edff9d1d3",[],"P",1]\n1:{"jsx":["$","$L2",null,{}]}\n',
      },
      { chunk: '1:C\n' },
    ]

    const response = await encodeFederationPayload({ stream: 'fake' })
    const events = await readAllSSEEvents(response)

    expect(
      events.map((e) => ({
        event: e.event,
        data:
          e.event === 'flight'
            ? JSON.parse(e.data)
            : e.data.replace(/"remoteId":"[^"]+"/, '"remoteId":"<redacted>"'),
      })),
    ).toMatchInlineSnapshot(`
      [
        {
          "data": "{"remoteId":"<redacted>","clientModules":{},"cssLinks":[]}",
          "event": "metadata",
        },
        {
          "data": "{"html":""}",
          "event": "ssr",
        },
        {
          "data": "{"clientModules":{"763edff9d1d3":{"chunks":["/assets/markdown-abc.js"],"css":["/assets/md.css"]}},"cssLinks":["/assets/md.css"]}",
          "event": "modules",
        },
        {
          "data": "0:{"stream":"$1"}
      ",
          "event": "flight",
        },
        {
          "data": "2:I["763edff9d1d3",[],"P",1]
      1:{"jsx":["$","$L2",null,{}]}
      ",
          "event": "flight",
        },
        {
          "data": "1:C
      ",
          "event": "flight",
        },
        {
          "data": "",
          "event": "done",
        },
      ]
    `)

    // Ordering invariant: the modules event announcing the module comes
    // before the flight event whose payload references it.
    const modulesIndex = events.findIndex((e) => e.event === 'modules')
    const referencingFlightIndex = events.findIndex(
      (e) => e.event === 'flight' && e.data.includes('763edff9d1d3'),
    )
    expect(modulesIndex).toBeGreaterThan(-1)
    expect(referencingFlightIndex).toBeGreaterThan(-1)
    expect(modulesIndex).toBeLessThan(referencingFlightIndex)
  })

  test('metadata includes modules discovered before streaming starts', async () => {
    pendingClientRefs.push({
      id: 'early123',
      name: 'Early',
      deps: { js: ['/assets/early-abc.js'], css: [] },
    })
    scriptedChunks = [{ chunk: '0:{"ok":true}\n' }]

    const response = await encodeFederationPayload({ stream: 'fake' })
    const events = await readAllSSEEvents(response)

    const metadata = JSON.parse(
      events.find((e) => e.event === 'metadata')!.data,
    )
    expect(metadata.clientModules).toHaveProperty('early123')
    // Already announced in metadata — no duplicate modules event
    expect(events.filter((e) => e.event === 'modules')).toEqual([])
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
