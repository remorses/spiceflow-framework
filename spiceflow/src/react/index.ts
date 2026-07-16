import { actionAbortControllers } from './action-abort.js'
import {
  DefaultGlobalErrorPage,
  DefaultNotFoundPage,
  ErrorBoundary as RootErrorBoundary,
  LayoutContent,
  NotFoundBoundary,
} from './components.js'
import { FlightDataContext } from './context.js'
import {
  getDocumentLocationFromResponse,
  isFlightResponse,
  stripRscUrl,
} from './deployment.js'
import { getErrorContext, isRedirectError } from './errors.js'
import {
  getLastNavigationEvent,
  getSavedScrollState,
  getScrollPositions,
  isHashOnlyLocationChange,
  recordScrollPosition,
  router as clientRouter,
  saveScrollState,
} from './router.js'

export const __clientRuntime = {
  actionAbortControllers,
  DefaultGlobalErrorPage,
  DefaultNotFoundPage,
  ErrorBoundary: RootErrorBoundary,
  FlightDataContext,
  getDocumentLocationFromResponse,
  getErrorContext,
  getLastNavigationEvent,
  getSavedScrollState,
  getScrollPositions,
  isFlightResponse,
  isHashOnlyLocationChange,
  isRedirectError,
  LayoutContent,
  NotFoundBoundary,
  recordScrollPosition,
  router: clientRouter,
  saveScrollState,
  stripRscUrl,
}

export { Link } from './link.tsx'
export type { LinkProps } from './link.tsx'
export { ProgressBar } from './progress.tsx'
export {
  getRouter,
  isHashOnlyLocationChange,
  router,
  useRouterState,
} from './router.tsx'
export type {
  NavigationEvent,
  ReadonlyURLSearchParams,
  RegisteredApp,
  RouterPaths,
  RouterQuerySchemas,
  SpiceflowRegister,
} from './router.tsx'
export { Head } from './head.tsx'
export type {
  MetaProps,
  TitleProps,
  HeadLinkProps,
  ScriptProps,
  StyleProps,
  BaseProps,
} from './head-tags.tsx'
export { redirect } from './errors.tsx'
export { useLoaderData } from './context.tsx'
export { getActionAbortController } from './action-abort.ts'
export {
  decodeFederationPayload,
  decodeFederationPayloadDetails,
  injectFederationCss,
  RenderFederatedPayload,
  setupFederationConsumer,
} from './federated-payload.ts'
export { ErrorBoundary } from './error-boundary.tsx'
export { setReactErrorHandlers } from './error-handlers.ts'
export type { ReactErrorHandlers } from './error-handlers.ts'
export { publicDir, distDir } from '#spiceflow-dirs'
