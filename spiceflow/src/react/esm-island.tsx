// Client component that dynamically imports an ESM module from a URL and
// renders its default (or first) export as a React component. Used by
// RenderFederatedPayload when the response content-type is JavaScript instead of
// a spiceflow federation JSON payload.
'use client'

import React, { lazy, useState, useSyncExternalStore, Component } from 'react'
import { prefetchDNS, preconnect } from 'react-dom'

const noopSubscribe = () => () => {}
const getHydratedSnapshot = () => true
const getServerSnapshot = () => false

class EsmErrorBoundary extends Component<
  { children: React.ReactNode; src: string },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error) {
    console.error(
      `[RenderFederatedPayload] Failed to load ESM module from ${this.props.src}:`,
      error,
    )
  }

  render() {
    if (this.state.error) {
      return null
    }
    return this.props.children
  }
}

export function EsmIsland({
  src,
  props,
}: {
  src: string
  props?: Record<string, unknown>
}) {
  const isHydrated = useSyncExternalStore(
    noopSubscribe,
    getHydratedSnapshot,
    getServerSnapshot,
  )

  try {
    const url = new URL(src)
    prefetchDNS(url.origin)
    preconnect(url.origin)
  } catch {}

  const [LazyComponent] = useState(() => {
    if (typeof window === 'undefined') return null
    return lazy(async () => {
      const dynamicImport = new Function('url', 'return import(url)') as (
        url: string,
      ) => Promise<any>
      const mod = await dynamicImport(src)
      const Component = mod.default || Object.values(mod).find(
        (v) => typeof v === 'function',
      )
      if (!Component) {
        throw new Error(
          `[RenderFederatedPayload] No component export found in ${src}`,
        )
      }
      return { default: Component as React.ComponentType<any> }
    })
  })

  if (!isHydrated || !LazyComponent) return null

  // No inner Suspense — let the lazy suspension propagate to the user's
  // <Suspense> boundary so their fallback/skeleton shows during loading.
  // RenderFederatedPayload is an async server component which already requires
  // <Suspense> to work, so the boundary is guaranteed to exist.
  return (
    <EsmErrorBoundary src={src}>
      <LazyComponent {...(props ?? {})} />
    </EsmErrorBoundary>
  )
}
