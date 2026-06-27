// Pure adapter logic for wrapping a Cloudflare-style enterSpan function into
// a SpiceflowTracer. Separated from the cloudflare:workers import so the
// wrapping logic can be tested in Node without the workerd runtime.
import type { SpiceflowTracer, SpiceflowSpan } from './instrumentation.js'

interface CfSpanLike {
  setAttribute(key: string, value: string | number | boolean | undefined): void
}

type EnterSpanFn = <T>(
  name: string,
  callback: (span: CfSpanLike) => T,
) => T

// OTel SpanStatusCode.ERROR = 2
const STATUS_ERROR = 2

function wrapCfSpan(cfSpan: CfSpanLike): SpiceflowSpan {
  return {
    setAttribute(key, value) {
      cfSpan.setAttribute(key, value)
      return this
    },
    // Cloudflare spans don't have setStatus yet, so we map it to attributes
    // following OTel semantic conventions so errors are visible in the
    // Cloudflare dashboard and any OTel export destination.
    setStatus(status) {
      if (status.code === STATUS_ERROR) {
        cfSpan.setAttribute('otel.status_code', 'ERROR')
        if (status.message) {
          cfSpan.setAttribute('otel.status_description', status.message)
        }
      }
      return this
    },
    // Cloudflare spans don't have recordException yet, so we map the
    // exception details to attributes following OTel exception event
    // conventions (exception.type, exception.message, exception.stacktrace).
    recordException(exception) {
      if (exception instanceof Error) {
        cfSpan.setAttribute('exception.type', exception.name)
        cfSpan.setAttribute('exception.message', exception.message)
        if (exception.stack) {
          cfSpan.setAttribute('exception.stacktrace', exception.stack)
        }
      } else {
        cfSpan.setAttribute('exception.message', String(exception))
      }
    },
    updateName() {
      return this
    },
    spanContext() {
      return undefined
    },
    end() {},
  }
}

export function createCloudflareTracer(enterSpan: EnterSpanFn): SpiceflowTracer {
  return {
    startActiveSpan(name: string, ...args: any[]) {
      const fn = args[args.length - 1]
      const options =
        args.length >= 2 && typeof args[0] !== 'function' ? args[0] : undefined
      return enterSpan(name, (cfSpan) => {
        if (options?.attributes) {
          for (const [k, v] of Object.entries(options.attributes)) {
            if (v !== undefined) cfSpan.setAttribute(k, v as any)
          }
        }
        return fn(wrapCfSpan(cfSpan))
      })
    },
  }
}
