// Federation shared entry for React. Uses #federation/react instead of bare
// 'react' so Rolldown's REACT_EXTERNALS array doesn't externalize it.
// These entries must bundle the real React code; the import map points
// bare 'react' back to this chunk, so using bare 'react' here would
// create a self-referencing cycle in the browser.
import * as React from '#federation/react'

export { default } from '#federation/react'
export {
  Activity,
  Children,
  Component,
  Fragment,
  Profiler,
  PureComponent,
  StrictMode,
  Suspense,
  act,
  cache,
  cacheSignal,
  captureOwnerStack,
  cloneElement,
  createContext,
  createElement,
  createRef,
  forwardRef,
  isValidElement,
  lazy,
  memo,
  startTransition,
  use,
  useActionState,
  useCallback,
  useContext,
  useDebugValue,
  useDeferredValue,
  useEffect,
  useEffectEvent,
  useId,
  useImperativeHandle,
  useInsertionEffect,
  useLayoutEffect,
  useMemo,
  useOptimistic,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
  version,
} from '#federation/react'

const ReactAny = React as any
export const __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE =
  ReactAny.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE
export const __COMPILER_RUNTIME = ReactAny.__COMPILER_RUNTIME
export const unstable_useCacheRefresh = ReactAny.unstable_useCacheRefresh
