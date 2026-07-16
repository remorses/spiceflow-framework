// Public ErrorBoundary for handling server action errors and render errors.
// Uses context so sub-components (ErrorMessage, ResetButton) can access
// the error and reset function from anywhere in the fallback tree.
//
// `above` / `below` props keep children visible and interactive alongside
// the fallback so there is no layout shift when a form action throws.
// The user can fix their inputs and resubmit without clicking reset first.

'use client'

import React from 'react'
import { router } from 'spiceflow/react'
import {
  contextHeaders,
  getErrorContext,
  isRedirectError,
  isNotFoundError,
} from './errors.js'

interface ErrorBoundaryContextValue {
  error: (Error & { digest?: string }) | null
  reset: () => void
}

const ErrorBoundaryContext = React.createContext<ErrorBoundaryContextValue>({
  error: null,
  reset: () => {},
})

function useErrorBoundary() {
  return React.useContext(ErrorBoundaryContext)
}

// Sub-component: renders the error message from the nearest ErrorBoundary.
// Renders a <div> with white-space:pre-wrap by default so multiline errors
// render correctly. Supports maxLines to truncate long messages with an
// expand toggle. Passes through all HTML div props.
function ErrorMessage({
  maxLines = 10,
  style,
  ...props
}: React.ComponentProps<'div'> & { maxLines?: number }) {
  const { error } = useErrorBoundary()
  const [expanded, setExpanded] = React.useState(false)
  if (!error) return null
  const message = error.digest || error.message
  if (!message) return null
  const lineCount = message.split('\n').length
  const isTruncated = !expanded && lineCount > maxLines
  return (
    <div {...props} style={{ whiteSpace: 'pre-wrap', ...style }}>
      <span
        style={
          isTruncated
            ? {
                display: '-webkit-box',
                WebkitLineClamp: maxLines,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
              }
            : undefined
        }
      >
        {message}
      </span>
      {lineCount > maxLines && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          style={{
            background: 'none',
            border: 'none',
            padding: 0,
            cursor: 'pointer',
            textDecoration: 'underline',
            font: 'inherit',
            color: 'inherit',
            opacity: 0.7,
            display: 'block',
            marginTop: '0.25rem',
          }}
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  )
}

// Sub-component: renders a reset button for the nearest ErrorBoundary.
// Renders a <button> by default. Passes through all HTML button props.
function ResetButton({
  children = 'Try again',
  ...props
}: React.ComponentProps<'button'>) {
  const { reset } = useErrorBoundary()
  return (
    <button onClick={reset} {...props}>
      {children}
    </button>
  )
}

interface ErrorBoundaryProps {
  children?: React.ReactNode
  fallback: React.ReactNode
  /** Show the error fallback above children instead of replacing them.
   *  Children stay visible and interactive so users can fix inputs and resubmit. */
  above?: boolean
  /** Show the error fallback below children instead of replacing them.
   *  Children stay visible and interactive so users can fix inputs and resubmit. */
  below?: boolean
}

interface ErrorBoundaryState {
  error: (Error & { digest?: string }) | null
}

class ErrorBoundaryInner extends React.Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  constructor(props: ErrorBoundaryProps) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error: Error) {
    const ctx = getErrorContext(error)
    const hdrs = ctx ? contextHeaders(ctx) : undefined
    if (ctx && isRedirectError(ctx) && hdrs?.['location']) {
      router.replace(hdrs['location'])
      return {}
    }
    if (ctx && isNotFoundError(ctx)) {
      throw error
    }
    return { error }
  }

  reset = () => {
    React.startTransition(() => {
      this.setState({ error: null })
    })
  }

  // Synchronous reset used by onSubmitCapture in above/below mode.
  // Clears the error before the new form action runs. If the action
  // throws again, getDerivedStateFromError sets the error right back.
  resetSync = () => {
    this.setState({ error: null })
  }

  override render() {
    const error = this.state.error
    if (error) {
      const context = { error, reset: this.reset }
      if (this.props.above) {
        return (
          <ErrorBoundaryContext.Provider value={context}>
            {this.props.fallback}
            <div onSubmitCapture={this.resetSync} style={{ display: 'contents' }}>
              {this.props.children}
            </div>
            <ErrorAutoReset reset={this.reset} />
          </ErrorBoundaryContext.Provider>
        )
      }
      if (this.props.below) {
        return (
          <ErrorBoundaryContext.Provider value={context}>
            <div onSubmitCapture={this.resetSync} style={{ display: 'contents' }}>
              {this.props.children}
            </div>
            {this.props.fallback}
            <ErrorAutoReset reset={this.reset} />
          </ErrorBoundaryContext.Provider>
        )
      }
      return (
        <ErrorBoundaryContext.Provider value={context}>
          {this.props.fallback}
          <ErrorAutoReset reset={this.reset} />
        </ErrorBoundaryContext.Provider>
      )
    }
    return this.props.children
  }
}

function ErrorAutoReset({ reset }: { reset: () => void }) {
  const initialHref = React.useRef(window.location.href).current
  React.useEffect(() => {
    return router.subscribe(() => {
      if (window.location.href !== initialHref) {
        reset()
      }
    })
  }, [reset, initialHref])
  return null
}

// Public ErrorBoundary component with sub-components for error display and reset.
//
// Usage (default — replaces children with fallback):
//   <ErrorBoundary fallback={<ErrorFallback />}>
//     <form action={myAction}>...</form>
//   </ErrorBoundary>
//
// Usage (error above form, form stays interactive):
//   <ErrorBoundary above fallback={<ErrorFallback />}>
//     <form action={myAction}>...</form>
//   </ErrorBoundary>
//
// Usage (error below form, form stays interactive):
//   <ErrorBoundary below fallback={<ErrorFallback />}>
//     <form action={myAction}>...</form>
//   </ErrorBoundary>
function ErrorBoundary(props: ErrorBoundaryProps) {
  return <ErrorBoundaryInner {...props} />
}

ErrorBoundary.ErrorMessage = ErrorMessage
ErrorBoundary.ResetButton = ResetButton

export { ErrorBoundary }
