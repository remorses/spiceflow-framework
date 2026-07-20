import { SpiceflowRequest, WaitUntil, Method } from './spiceflow.js'
import { serveStatic } from './static-node.js'
import type { MiddlewareHandler } from './types.js'

export { Spiceflow } from './spiceflow.js'
export { redirect } from './react/errors.js'
export type { SpiceflowRegister, RegisteredApp, RegisteredKnownPaths } from './react/router.js'
export type {
  AnySpiceflow,
  SpiceflowListenResult,
  WaitUntil,
} from './spiceflow.js'
export type { ContextResponse, SpiceflowContext } from './context.js'
export type { MergedLoaderData, AllLoaderData } from './types.js'
export { ValidationError, json, type TypedResponse } from './error.js'
export type {
  SpiceflowTracer,
  SpiceflowSpan,
  SpiceflowSpanContext,
} from './instrumentation.js'
export { withSpan, noopSpan, noopTracer } from './instrumentation.js'
export { preventProcessExitIfBusy } from './prevent-process-exit-if-busy.js'
export { getDeploymentId } from '#deployment-id'
export { publicDir, distDir } from '#spiceflow-dirs'
export { getActionRequest } from './action-context.js'
export { parseFormData, parseFormDataAsync } from './parse-form-data.js'

// utility Response to be used in Cloudflare Workers to shut up the TypeScript errors (cloudflare Response is different than normal Response type)
class Response extends globalThis.Response {}

export { Response }
export { SpiceflowRequest }
export type { MiddlewareHandler }
export { serveStatic }
