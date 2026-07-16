// Global type augmentations for spiceflow internals.

declare var __SPICEFLOW_PRERENDER: boolean | undefined
declare var __SPICEFLOW_CLIENT_LOAD_COUNT__: number | undefined

declare module 'cloudflare:workers' {
  export function waitUntil(promise: Promise<unknown>): void

  class CloudflareSpan {
    readonly isTraced: boolean
    setAttribute(
      key: string,
      value: string | number | boolean | undefined,
    ): void
  }

  namespace tracing {
    function enterSpan<T, A extends unknown[]>(
      name: string,
      callback: (span: CloudflareSpan, ...args: A) => T,
      ...args: A
    ): T
  }
}

declare var Deno:
  | {
      serve: (
        options: { port: number; hostname?: string },
        handler: (request: Request) => Response | Promise<Response>,
      ) => unknown
    }
  | undefined
