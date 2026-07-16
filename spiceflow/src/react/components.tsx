'use client'

import React from 'react'
import type { ReactFormState } from 'react-dom/client'
import { router } from 'spiceflow/react'
import { useFlightData } from './context.js'
import {
  contextHeaders,
  getErrorContext,
  isNotFoundError,
  isRedirectError,
} from './errors.js'

export function LayoutContent(props: { id?: string }) {
  const data = useFlightData()
  if (!data) return null
  const { elem, isPage } = resolveLayoutElement(data, props.id)
  // Wrap the innermost page content in error boundaries so that 404/error
  // responses render inside the layout shell instead of replacing it entirely.
  // The outer NotFoundBoundary/ErrorBoundary in BrowserRoot still catches
  // errors that escape (e.g. layout-level throws during SSR).
  if (isPage) {
    return (
      <ErrorBoundary errorComponent={InlineErrorPage}>
        <NotFoundBoundary component={InlineNotFoundPage}>
          {elem}
        </NotFoundBoundary>
      </ErrorBoundary>
    )
  }
  // Render global CSS from the app entry alongside the root element.
  // rscCssTransform auto-wraps exported component functions, but the app entry
  // exports a Spiceflow instance, so its CSS needs this manual injection.
  if (!props.id && data.globalCss) {
    return React.createElement(
      React.Fragment,
      null,
      data.globalCss,
      elem,
      data.head,
    )
  }
  if (!props.id && data.head) {
    return React.createElement(React.Fragment, null, elem, data.head)
  }
  return elem
}

function resolveLayoutElement(data: FlightData, id?: string) {
  if (!id) {
    return { elem: data.layouts[0]?.element ?? data.page, isPage: false }
  }
  const layoutIndex = data.layouts.findIndex((layout) => layout.id === id)
  const nextLayout = data.layouts[layoutIndex + 1]?.element
  if (nextLayout) {
    return { elem: nextLayout, isPage: false }
  }
  return { elem: data.page, isPage: true }
}

export type FlightData = {
  page: any
  layouts: { id: string; element: React.ReactNode }[]
  globalCss?: React.ReactNode
  loaderData?: Record<string, unknown>
  head?: React.ReactNode
}

import type { ReactServerErrorContext } from './errors.js'

export type ActionResult = {
  error?: ReactServerErrorContext
  data?: ReactFormState | null
}

export interface ErrorPageProps {
  error: Error & { digest?: string }
  serverError?: ReactServerErrorContext
  reset: () => void
}

interface Props {
  children?: React.ReactNode
  errorComponent: React.FC<ErrorPageProps>
}

interface State {
  error: Error | null
}

export function ErrorBoundary(props: Props) {
  return <ErrorBoundary_ {...props} />
}

class ErrorBoundary_ extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error: Error) {
    const ctx = getErrorContext(error)
    const hdrs = ctx ? contextHeaders(ctx) : undefined
    if (ctx && isRedirectError(ctx) && hdrs?.['location']) {
      console.log('redirecting from browser to', hdrs['location'])
      router.replace(hdrs['location'])
      return {}
    }
    if (ctx && isNotFoundError(ctx)) {
      throw error
    }
    if (import.meta.hot) {
      throw error
    }
    return { error }
  }

  reset = () => {
    React.startTransition(() => {
      this.setState({ error: null })
    })
  }

  override render() {
    const error = this.state.error
    if (error) {
      return (
        <>
          <this.props.errorComponent
            error={error}
            serverError={getErrorContext(error)}
            reset={this.reset}
          />
          <ErrorAutoReset reset={this.reset} />
        </>
      )
    }
    return this.props.children
  }
}

function ErrorAutoReset(props: Pick<ErrorPageProps, 'reset'>) {
  const initialHref = React.useRef(window.location.href).current
  React.useEffect(() => {
    return router.subscribe(() => {
      if (window.location.href !== initialHref) {
        props.reset()
      }
    })
  }, [props.reset, initialHref])
  return null
}

// https://github.com/vercel/next.js/blob/677c9b372faef680d17e9ba224743f44e1107661/packages/next/src/build/webpack/loaders/next-app-loader.ts#L73
// https://github.com/vercel/next.js/blob/677c9b372faef680d17e9ba224743f44e1107661/packages/next/src/client/components/error-boundary.tsx#L145
export function DefaultGlobalErrorPage(props: ErrorPageProps) {
  // React strips error.message in production but preserves error.digest,
  // which contains the original message from the server's onError callback.
  const detail = props.error?.digest || props.error?.message
  const heading = props.serverError ? 'Server Error' : 'Application Error'
  return (
    <html>
      <meta name="robots" content="noindex" />
      <title>{heading}</title>
      <body
        style={{
          fontFamily:
            'system-ui,"Segoe UI",Roboto,Helvetica,Arial,sans-serif,"Apple Color Emoji","Segoe UI Emoji"',
          height: '100vh',
          display: 'flex',
          flexDirection: 'column',
          placeContent: 'center',
          placeItems: 'center',
          fontSize: '14px',
          fontWeight: 400,
          lineHeight: '28px',
        }}
      >
        <h2>{heading}</h2>
        {detail && <p style={{ color: '#666', margin: 0 }}>{detail}</p>}
      </body>
    </html>
  )
}

// Inline error component used inside the layout. Unlike DefaultGlobalErrorPage it does
// NOT render <html>/<body>, so the surrounding layout shell stays alive during
// client-side navigation to a page that throws.
function InlineErrorPage(props: ErrorPageProps) {
  // React strips error.message in production but preserves error.digest,
  // which contains the sanitized original message from the server's onError callback.
  const detail = props.error?.digest || props.error?.message
  const heading = props.serverError
    ? 'Server Error'
    : 'Application Error'
  return (
    <div
      style={{
        fontFamily:
          'system-ui,"Segoe UI",Roboto,Helvetica,Arial,sans-serif,"Apple Color Emoji","Segoe UI Emoji"',
        display: 'flex',
        flexDirection: 'column',
        placeContent: 'center',
        placeItems: 'center',
        padding: '4rem 0',
        fontSize: '14px',
        fontWeight: 400,
        lineHeight: '28px',
      }}
    >
      <h2>{heading}</h2>
      {detail && <p style={{ color: '#666', margin: 0 }}>{detail}</p>}
    </div>
  )
}

// Inline 404 component used inside the layout. Unlike DefaultNotFoundPage it does NOT
// render <html>/<body>, so the surrounding layout shell stays alive during client-side
// navigation to a 404 page.
function InlineNotFoundPage() {
  return (
    <div
      style={{
        fontFamily:
          'system-ui,"Segoe UI",Roboto,Helvetica,Arial,sans-serif,"Apple Color Emoji","Segoe UI Emoji"',
        display: 'flex',
        placeContent: 'center',
        placeItems: 'center',
        padding: '4rem 0',
      }}
    >
      <div style={{ display: 'flex', lineHeight: '50px' }}>
        <h1
          style={{
            margin: '0 20px 0 0',
            padding: '0 23px 0 0',
            fontSize: 24,
            fontWeight: 500,
            borderRight: '1px solid rgba(0, 0, 0, .3)',
          }}
        >
          404
        </h1>
        <h2
          style={{
            fontSize: 14,
            fontWeight: 400,
          }}
        >
          This page could not be found.
        </h2>
      </div>
    </div>
  )
}

// https://github.com/vercel/next.js/blob/c74f3f54b23b3fc47dc7e214a8949844257a734a/packages/next/src/build/webpack/loaders/next-app-loader.ts#L72
// https://github.com/vercel/next.js/blob/8f5f0ef141a907d083eedb7c7aca52b04f9d258b/packages/next/src/client/components/not-found-error.tsx#L34-L39
export function DefaultNotFoundPage() {
  return (
    <html>
      <meta name="robots" content="noindex" />
      <title>not found</title>
      <body>
        <div
          style={{
            fontFamily:
              'system-ui,"Segoe UI",Roboto,Helvetica,Arial,sans-serif,"Apple Color Emoji","Segoe UI Emoji"',
            height: '100vh',
            display: 'flex',
            placeContent: 'center',
            placeItems: 'center',
          }}
        >
          <div style={{ display: 'flex', lineHeight: '50px' }}>
            <h1
              style={{
                margin: '0 20px 0 0',
                padding: '0 23px 0 0',
                fontSize: 24,
                fontWeight: 500,
                borderRight: '1px solid rgba(0, 0, 0, .3)',
              }}
            >
              404
            </h1>
            <h2
              style={{
                fontSize: 14,
                fontWeight: 400,
              }}
            >
              This page could not be found.
            </h2>
          </div>
        </div>
      </body>
    </html>
  )
}
export class NotFoundBoundary extends React.Component<{
  component: React.ComponentType
  children?: React.ReactNode
}> {
  override state: { error?: Error } = {}

  static getDerivedStateFromError(error: Error) {
    const ctx = getErrorContext(error)
    if (ctx && isNotFoundError(ctx)) {
      return { error }
    }
    throw error
  }

  override render() {
    if (this.state.error) {
      const Component = this.props.component
      return (
        <>
          <Component />
          <ErrorAutoReset
            reset={() => {
              React.startTransition(() => {
                this.setState({ error: null })
              })
            }}
          />
        </>
      )
    }
    return this.props.children
  }
}
