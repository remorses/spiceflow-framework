/// <reference types="vite/client" />
/// <reference types="@vitejs/plugin-rsc/types" />

declare module 'virtual:app-entry' {
  import type { Spiceflow } from 'spiceflow'
  export const app: Spiceflow
  export default any
}

declare module '#rsc-runtime' {
  export {
    renderToReadableStream,
    createTemporaryReferenceSet,
    decodeReply,
    decodeAction,
    decodeFormState,
    loadServerAction,
  } from '@vitejs/plugin-rsc/rsc'
  export const __spiceflowVitestMode: boolean
}

declare module 'virtual:spiceflow-deployment-id' {
  const deploymentId: string | undefined
  export default deploymentId
}

declare module 'virtual:spiceflow-dirs' {
  export const publicDir: string
  export const distDir: string
}

declare module 'virtual:spiceflow-import-map' {
  const importMapJson: string
  export const modulePreloadUrls: string[]
  export default importMapJson
}

// Federation: Flight decoder exposed globally by entry.client.tsx
// so federated payload helpers can decode remote Flight payloads in the browser.
declare var __spiceflow_createFromReadableStream: (<T>(
  stream: ReadableStream<Uint8Array>,
) => PromiseLike<T>) | undefined

// React root error handlers. Set these before hydration (e.g. from an
// observability SDK like Strada) to receive all React render errors globally,
// even when the user has their own ErrorBoundary.
// These map 1:1 to React 19's createRoot/hydrateRoot options.
declare var __spiceflow_onCaughtError: ((error: unknown, errorInfo: { componentStack?: string }) => void) | undefined
declare var __spiceflow_onUncaughtError: ((error: unknown, errorInfo: { componentStack?: string }) => void) | undefined
declare var __spiceflow_onRecoverableError: ((error: unknown, errorInfo: { componentStack?: string }) => void) | undefined
