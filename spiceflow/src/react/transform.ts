// ported from https://github.com/devongovett/rsc-html-stream/blob/main/server.js

const encoder = new TextEncoder()
const latin1Decoder = new TextDecoder('latin1')
const trailerBodyBytes = encoder.encode('</body></html>')
const flightScriptPrefix = '(self.__FLIGHT_DATA||=[]).push('

function encodeBinaryChunkToBase64(chunk: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(chunk).toString('base64')
  }
  return btoa(latin1Decoder.decode(chunk))
}

function endsWithSequence(haystack: Uint8Array, needle: Uint8Array) {
  if (haystack.length < needle.length) return false

  const offset = haystack.length - needle.length
  for (let i = 0; i < needle.length; i++) {
    if (haystack[offset + i] !== needle[i]) {
      return false
    }
  }

  return true
}

function findSequence(haystack: Uint8Array, needle: Uint8Array): number {
  const limit = haystack.length - needle.length
  outer: for (let i = 0; i <= limit; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer
    }
    return i
  }
  return -1
}

// Must be injected before modulepreload links that use bare specifiers.
const headOpenBytes = encoder.encode('<head>')

export function injectRSCPayload({
  rscStream,
  importMapJson,
  modulePreloadUrls = [],
}: {
  rscStream?: ReadableStream<Uint8Array>
  importMapJson?: string
  modulePreloadUrls?: string[]
}) {
  let resolveFlightDataPromise: (value: void) => void
  let flightDataPromise = new Promise<void>(
    (resolve) => (resolveFlightDataPromise = resolve),
  )
  let startedRSC = false
  let importMapInjected = !importMapJson

  // Buffer all HTML chunks enqueued during the current tick of the event loop
  // and write them to the output stream all at once. This ensures that we don't
  // generate invalid HTML by injecting RSC in between two partial chunks of HTML.
  // Uses setImmediate (fires after I/O, before timers) instead of setTimeout(0)
  // which has a minimum ~1ms delay on Node.js.
  let buffered: Uint8Array[] = []
  let scheduled = false
  const schedule =
    typeof setImmediate === 'function'
      ? (fn: () => void) => setImmediate(fn)
      : (fn: () => void) => setTimeout(fn, 0)

  function flushBufferedChunks(
    controller: TransformStreamDefaultController<Uint8Array>,
  ) {
    for (let chunk of buffered) {
      let end = chunk.length
      if (endsWithSequence(chunk, trailerBodyBytes)) {
        end -= trailerBodyBytes.length
      }

      if (!importMapInjected && end > 0) {
        const slice = end === chunk.length ? chunk : chunk.subarray(0, end)
        const headIdx = findSequence(slice, headOpenBytes)
        if (headIdx >= 0) {
          importMapInjected = true
          const afterHead = headIdx + headOpenBytes.length
          const importMapScript = encoder.encode(
            `<script type="importmap">${importMapJson}</script>`,
          )
          const modulePreloads = encoder.encode(
            [...new Set(modulePreloadUrls)]
              .map(
                (href) =>
                  `<link rel="modulepreload" href="${escapeHtmlAttribute(href)}">`,
              )
              .join(''),
          )
          controller.enqueue(slice.subarray(0, afterHead))
          controller.enqueue(importMapScript)
          controller.enqueue(modulePreloads)
          controller.enqueue(slice.subarray(afterHead))
          continue
        }
      }

      if (end > 0) {
        controller.enqueue(
          end === chunk.length ? chunk : chunk.subarray(0, end),
        )
      }
    }

    buffered.length = 0
    scheduled = false
  }

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffered.push(chunk)
      if (scheduled) return

      scheduled = true
      schedule(async () => {
        flushBufferedChunks(controller)
        if (!startedRSC) {
          startedRSC = true
          void writeRSCStream(rscStream, controller)
            .catch((err) => controller.error(err))
            .then(() => resolveFlightDataPromise())
        }
      })
    },
    async flush(controller) {
      await flightDataPromise
      if (scheduled) {
        flushBufferedChunks(controller)
      }
      controller.enqueue(trailerBodyBytes)
    },
  })
}

function escapeHtmlAttribute(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
}

async function writeRSCStream(
  rscStream: ReadableStream<Uint8Array> | undefined,
  controller: TransformStreamDefaultController<Uint8Array>,
) {
  let decoder = new TextDecoder('utf-8', { fatal: true })
  if (!rscStream) {
    return
  }
  const reader = rscStream.getReader()
  while (true) {
    const { done, value: chunk } = await reader.read()
    if (done) break

    // Try decoding the chunk to send as a string.
    // If that fails (e.g. binary data that is invalid unicode), write as base64.
    try {
      writeChunk(
        JSON.stringify(decoder.decode(chunk, { stream: true })),
        controller,
      )
    } catch (err) {
      let base64 = JSON.stringify(encodeBinaryChunkToBase64(chunk))
      writeChunk(
        `Uint8Array.from(atob(${base64}), m => m.codePointAt(0))`,
        controller,
      )
    }
  }

  let remaining = decoder.decode()
  if (remaining.length) {
    writeChunk(JSON.stringify(remaining), controller)
  }
}

function writeChunk(
  chunk: string,
  controller: TransformStreamDefaultController<Uint8Array>,
) {
  controller.enqueue(
    encoder.encode(
      `<script>${escapeScript(flightScriptPrefix + chunk + ')')}</script>`,
    ),
  )
}

// Escape closing script tags and HTML comments in JS content.
// https://www.w3.org/TR/html52/semantics-scripting.html#restrictions-for-contents-of-script-elements
// Avoid replacing </script with <\/script as it would break the following valid JS: 0</script/ (i.e. regexp literal).
// Instead, escape the s character.
function escapeScript(script: string): string {
  return script.replace(/<!--/g, '<\\!--').replace(/<\/(script)/gi, '</\\$1')
}
