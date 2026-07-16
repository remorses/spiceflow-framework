import { afterEach, describe, expect, test, vi } from 'vitest'

import {
  decodeFederationPayload,
  parseFederationPayload,
} from './federated-payload.js'

function flightChunk(value: string) {
  return JSON.stringify(value)
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('decodeFederationPayload', () => {
  test('decodes async generator payloads', async () => {
    vi.stubGlobal('window', globalThis)
    vi.stubGlobal(
      '__spiceflow_createFromReadableStream',
      vi.fn(async () =>
        (async function* () {
          yield 'stream-1'
          yield 'stream-2'
          yield 'stream-3'
        })(),
      ),
    )

    const response = new Response(
      [
        `event: metadata\ndata: ${JSON.stringify({
          remoteId: 'r_test',
          clientModules: {},
          cssLinks: [],
        })}\n`,
        `event: flight\ndata: ${flightChunk('0:{}\n')}\n`,
        'event: done\ndata: \n',
      ].join('\n'),
      {
        headers: {
          'content-type': 'text/event-stream',
        },
      },
    )

    const decoded = await decodeFederationPayload<AsyncIterable<string>>(response)

    const items: string[] = []
    for await (const item of decoded) {
      items.push(item)
    }

    expect(items).toMatchInlineSnapshot(`
      [
        "stream-1",
        "stream-2",
        "stream-3",
      ]
    `)
  })

  test('processes mid-stream modules events before enqueueing later flight chunks', async () => {
    // Ordering invariant of the pump: a `modules` event must be fully
    // handled (chunk load attempted) BEFORE the following flight chunk is
    // handed to the Flight decoder. We observe the load attempt via the
    // console.error the loader emits when a chunk fails to import (vitest's
    // VM cannot execute dynamic import, so the attempt always logs). Actual
    // successful chunk loading/registration is covered by the federation
    // e2e suites in a real browser.
    vi.stubGlobal('window', globalThis)

    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {})
    const loadAttempted = () =>
      consoleError.mock.calls.some((call) =>
        String(call[0]).includes('modstream'),
      )

    const chunkObservations: { chunk: string; loadAttempted: boolean }[] = []
    vi.stubGlobal(
      '__spiceflow_createFromReadableStream',
      vi.fn(async (stream: ReadableStream<Uint8Array>) => {
        const reader = stream.getReader()
        const decoder = new TextDecoder()
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          chunkObservations.push({
            chunk: decoder.decode(value),
            loadAttempted: loadAttempted(),
          })
        }
        return 'decoded'
      }),
    )

    const moduleChunkUrl =
      'data:text/javascript,export const export_modstream = { Component: () => null }'

    const response = new Response(
      [
        `event: metadata\ndata: ${JSON.stringify({
          remoteId: 'r_modules_test',
          clientModules: {},
          cssLinks: [],
        })}\n`,
        `event: ssr\ndata: ${JSON.stringify({ html: '' })}\n`,
        `event: flight\ndata: ${flightChunk('0:{"stream":"$1"}\n')}\n`,
        `event: modules\ndata: ${JSON.stringify({
          clientModules: { modstream: { chunks: [moduleChunkUrl], css: [] } },
          cssLinks: [],
        })}\n`,
        `event: flight\ndata: ${flightChunk('2:I["modstream",[],"Component",1]\n')}\n`,
        'event: done\ndata: \n',
      ].join('\n'),
      {
        headers: {
          'content-type': 'text/event-stream',
        },
      },
    )

    const decoded = await decodeFederationPayload(response)
    expect(decoded).toBe('decoded')

    await vi.waitFor(() => {
      expect(chunkObservations.length).toBe(2)
    })

    // The second flight chunk (which references the module) must only reach
    // the decoder after the module load was attempted.
    expect(chunkObservations[1].chunk).toContain('modstream')
    expect(chunkObservations[1].loadAttempted).toBe(true)

    consoleError.mockRestore()
  })

  test('cancels the SSE response body when parsing stops early', async () => {
    const onCancel = vi.fn()
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              `event: metadata\ndata: ${JSON.stringify({
                remoteId: 'r_test',
                clientModules: {},
                cssLinks: [],
              })}\n\n`,
            ),
          )
        },
        cancel() {
          onCancel()
        },
      }),
      {
        headers: {
          'content-type': 'text/event-stream',
        },
      },
    )

    const events = parseFederationPayload(response)
    const firstEvent = await events.next()

    expect(firstEvent.done).toBe(false)
    expect(firstEvent.value).toMatchObject({
      type: 'metadata',
      payload: {
        remoteId: 'r_test',
        clientModules: {},
        cssLinks: [],
      },
    })

    await events.return(undefined)

    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  test('cancels the SSE response body when the Flight decoder fails mid-stream', async () => {
    vi.stubGlobal('window', globalThis)
    vi.stubGlobal(
      '__spiceflow_createFromReadableStream',
      vi.fn(async () => {
        throw new Error('decoder failed')
      }),
    )

    const onCancel = vi.fn()
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              [
                `event: metadata\ndata: ${JSON.stringify({
                  remoteId: 'r_test',
                  clientModules: {},
                  cssLinks: [],
                })}\n\n`,
                `event: flight\ndata: ${flightChunk('0:{}\n')}\n\n`,
              ].join(''),
            ),
          )
        },
        cancel() {
          onCancel()
        },
      }),
      {
        headers: {
          'content-type': 'text/event-stream',
        },
      },
    )

    await expect(decodeFederationPayload(response)).rejects.toThrow(
      'decoder failed',
    )

    await vi.waitFor(() => {
      expect(onCancel).toHaveBeenCalledTimes(1)
    })
  })
})
