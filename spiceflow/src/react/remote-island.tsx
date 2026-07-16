'use client'

import React, { useLayoutEffect, useRef } from 'react'
import { createRoot, hydrateRoot, type Root } from 'react-dom/client'
import { type ContextBridge, useContextBridge } from 'its-fine'
import {
  decodeParsedFederationPayload,
  injectFederationCss,
  resolveFederatedUrl,
  type FederatedClientModuleInfo,
  type ParsedFederatedFlightPayload,
} from './federated-payload.js'

const isBrowser = typeof window !== 'undefined'

// During SSR, useContextBridge throws because FiberProvider doesn't exist in
// the server render tree. Context bridging is only meaningful on the client
// anyway (server has no interactive contexts to bridge), so return a
// passthrough wrapper on the server.
const PassthroughBridge: ContextBridge = ({ children }) =>
  <>{children}</>

function useContextBridgeSafe(): ContextBridge {
  if (!isBrowser) return PassthroughBridge
  return useContextBridge()
}

type ClientModules = Record<string, FederatedClientModuleInfo>

// Cache decoded React trees by remoteId so re-renders don't re-decode.
// Bounded to prevent unbounded memory growth in long-lived sessions.
const MAX_TREE_CACHE = 100
const treeCache = new Map<string, Promise<React.ReactNode>>()

function getOrCreateTree({
  parsed,
}: {
  parsed: ParsedFederatedFlightPayload
}): Promise<React.ReactNode> {
  const cached = treeCache.get(parsed.metadata.remoteId)
  if (cached) return cached

  if (treeCache.size >= MAX_TREE_CACHE) {
    const oldest = treeCache.keys().next().value
    if (oldest) treeCache.delete(oldest)
  }

  const promise = decodeParsedFederationPayload<React.ReactNode>(parsed)
  treeCache.set(parsed.metadata.remoteId, promise)
  // Don't cache failures — a later render (e.g. after a transient network
  // error) should retry the decode instead of replaying the rejection.
  promise.catch(() => {
    if (treeCache.get(parsed.metadata.remoteId) === promise) {
      treeCache.delete(parsed.metadata.remoteId)
    }
  })
  return promise
}

// Contain errors thrown by remote client components (module load failures,
// render errors) inside the island. The fallback re-renders the static SSR
// HTML so the user still sees content instead of a crashed host page.
class RemoteIslandErrorBoundary extends React.Component<
  { ssrHtml: string; children: React.ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error) {
    console.error(
      '[federation] Remote island failed to render, falling back to static SSR HTML',
      error,
    )
  }

  render() {
    if (this.state.error) {
      return (
        <div
          suppressHydrationWarning
          dangerouslySetInnerHTML={{ __html: this.props.ssrHtml ?? '' }}
        />
      )
    }
    return this.props.children
  }
}

// Inject CSS <link> tags into a target root (document.head or a shadow root).
function injectCssLinks(
  target: Document | ShadowRoot,
  clientModules: ClientModules,
  remoteOrigin: string,
) {
  for (const [, info] of Object.entries(clientModules)) {
    for (const cssPath of info.css ?? []) {
      const href = resolveFederatedUrl(cssPath, remoteOrigin)
      if (!target.querySelector(`link[href="${CSS.escape(href)}"]`)) {
        const link = document.createElement('link')
        link.rel = 'stylesheet'
        link.href = href
        if (target instanceof Document) {
          target.head.appendChild(link)
        } else {
          target.appendChild(link)
        }
      }
    }
  }
}

// Inject top-level cssLinks (from the payload) into a shadow root.
function injectTopLevelCssLinks(
  shadow: ShadowRoot,
  cssLinks: string[],
  remoteOrigin: string,
) {
  for (const cssHref of cssLinks) {
    const href = resolveFederatedUrl(cssHref, remoteOrigin)
    if (!shadow.querySelector(`link[href="${CSS.escape(href)}"]`)) {
      const link = document.createElement('link')
      link.rel = 'stylesheet'
      link.href = href
      shadow.appendChild(link)
    }
  }
}

// Renders the decoded remote tree using hydrateRoot so React patches the
// existing SSR DOM nodes instead of clearing and remounting them.
//
// The host React tree always renders dangerouslySetInnerHTML. React only
// re-applies innerHTML when __html changes (string comparison in reconciler),
// so after hydrateRoot/createRoot takes ownership the host never overwrites it.
//
// useContextBridge (from its-fine) collects all React contexts from the host
// fiber tree and re-provides them inside the remote root. This means remote
// client components can read host-provided contexts (theme, auth, i18n, etc.)
// even though they live in a separate React root.
//
// useRouterState also works because it uses a module-level history singleton
// (useSyncExternalStore), not React context — the shared spiceflow/react
// module via import map makes it accessible across roots.
//
// First mount: hydrateRoot patches the SSR HTML DOM (no clearing).
// On remoteId change: ssrHtml changes → React updates innerHTML first (new
// content visible immediately), then createRoot re-mounts the new tree.
//
// When isolateStyles is true, content renders inside a Shadow DOM:
// - SSR: Declarative Shadow DOM (<template shadowrootmode="open">) wraps the
//   SSR HTML + CSS links so the browser creates the shadow root before JS loads.
//   DSD is parser-only — it only works during initial HTML parsing, not when set
//   via innerHTML (e.g. client-side navigation). The effect falls back to
//   attachShadow() when no parser-created shadow root exists.
// - Client: useLayoutEffect gets or creates the shadow root, injects CSS links
//   inside it, then hydrates/renders into a mount point within the shadow.
// - Remote styles stay inside the shadow root, host styles stay outside.
//   CSS custom properties (variables) still penetrate for theming.
export function RemoteIsland({
  parsed,
  isolateStyles,
}: {
  parsed: ParsedFederatedFlightPayload
  isolateStyles?: boolean
}) {
  const {
    flightPayload,
    remoteOrigin,
    metadata,
    ssrHtml,
  } = parsed
  const remoteId = metadata.remoteId
  const clientModules = metadata.clientModules
  const cssLinks = metadata.cssLinks
  const containerRef = useRef<HTMLDivElement>(null)
  const rootRef = useRef<Root | null>(null)
  // Track whether this island has been mounted (via hydrate or createRoot).
  // Prevents false hydration attempts on remoteId changes after an imperative
  // first mount — hasChildNodes() would be true from old client-rendered DOM,
  // but that's not SSR HTML so hydrateRoot would fail.
  const hasMountedRef = useRef(false)
  // Bridge all host contexts into the remote root so remote client components
  // can read host-provided React contexts (theme, auth, i18n, etc.).
  const Bridge = useContextBridgeSafe()

  // Start decoding immediately during render so chunk loading and Flight
  // decoding overlap with React's commit phase instead of waiting for it.
  // treeCache deduplicates, so the useLayoutEffect below awaits the same promise.
  if (isBrowser) {
    void getOrCreateTree({ parsed })
  }

  useLayoutEffect(() => {
    const host = containerRef.current
    if (!host) return

    let isMounted = true

    if (isolateStyles) {
      // Shadow DOM path: render inside a shadow root for style isolation.
      // DSD may have already created the shadow root from SSR HTML parsing.
      const existingShadow = host.shadowRoot
      const shadow = existingShadow ?? host.attachShadow({ mode: 'open' })

      // Inject top-level CSS links inside the shadow root
      injectTopLevelCssLinks(shadow, cssLinks ?? [], remoteOrigin)
      // Inject per-component CSS links inside the shadow root
      injectCssLinks(shadow, clientModules, remoteOrigin)

      // Find or create the mount point inside the shadow
      let mountPoint = shadow.querySelector<HTMLDivElement>('[data-mount]')
      if (!mountPoint) {
        mountPoint = document.createElement('div')
        mountPoint.setAttribute('data-mount', '')
        shadow.appendChild(mountPoint)
      }

      void getOrCreateTree({ parsed })
        .then((decoded) => {
          if (!isMounted) return
          const tree = (
            <RemoteIslandErrorBoundary ssrHtml={ssrHtml}>
              <Bridge>{decoded}</Bridge>
            </RemoteIslandErrorBoundary>
          )

          // Can only hydrate on first mount when a parser-created shadow root
          // exists (DSD from SSR) AND the mount point has SSR content to patch.
          // hasMountedRef prevents false hydration on remoteId changes where
          // mountPoint has stale client-rendered DOM, not SSR HTML.
          const canHydrate =
            !hasMountedRef.current &&
            !!ssrHtml &&
            !!existingShadow &&
            mountPoint!.hasChildNodes()

          hasMountedRef.current = true
          if (canHydrate) {
            rootRef.current = hydrateRoot(mountPoint!, tree, {
              onRecoverableError() {},
            })
          } else {
            mountPoint!.replaceChildren()
            const r = createRoot(mountPoint!)
            r.render(tree)
            rootRef.current = r
          }
        })
        .catch((error) => {
          // Decode failed — keep showing the static SSR HTML instead of
          // crashing. The island simply stays non-interactive.
          console.error(
            '[federation] Failed to decode remote payload, keeping static SSR HTML',
            error,
          )
        })
    } else {
      // Default path: render directly in the container (no shadow DOM).
      // Start CSS injection and tree decoding in parallel, await both
      // before rendering so components don't flash without styles.
      const cssReady = injectFederationCss(metadata, remoteOrigin)

      void Promise.all([getOrCreateTree({ parsed }), cssReady])
        .then(([decoded]) => {
          if (!isMounted) return
          const tree = (
            <RemoteIslandErrorBoundary ssrHtml={ssrHtml}>
              <Bridge>{decoded}</Bridge>
            </RemoteIslandErrorBoundary>
          )
          if (!hasMountedRef.current && ssrHtml) {
            hasMountedRef.current = true
            rootRef.current = hydrateRoot(host, tree, {
              onRecoverableError() {},
            })
          } else {
            hasMountedRef.current = true
            const r = createRoot(host)
            r.render(tree)
            rootRef.current = r
          }
        })
        .catch((error) => {
          // Decode failed — keep showing the static SSR HTML instead of
          // crashing. The island simply stays non-interactive.
          console.error(
            '[federation] Failed to decode remote payload, keeping static SSR HTML',
            error,
          )
        })
    }

    return () => {
      isMounted = false
      // Defer unmount to the next microtask to avoid "Attempted to
      // synchronously unmount a root while React was already rendering".
      // queueMicrotask runs before setTimeout(0), so the old root unmounts
      // before the new effect's render starts.
      const root = rootRef.current
      rootRef.current = null
      if (root) {
        queueMicrotask(() => root.unmount())
      }
    }
  }, [remoteId, flightPayload, remoteOrigin, isolateStyles, parsed])

  // When isolating styles, wrap SSR HTML in a Declarative Shadow DOM template
  // so the browser creates the shadow root during initial HTML parsing (before JS).
  // DSD is parser-only — only works during initial document parse, not innerHTML.
  if (isolateStyles) {
    const cssLinksHtml = (cssLinks ?? [])
      .map((href) => {
        const abs = resolveFederatedUrl(href, remoteOrigin)
        return `<link rel="stylesheet" href="${abs}">`
      })
      .join('')

    const dsdHtml = ssrHtml
      ? `<template shadowrootmode="open">${cssLinksHtml}<div data-mount>${ssrHtml}</div></template>`
      : ''

    return (
      <div
        ref={containerRef}
        data-remote-id={remoteId}
        data-isolate-styles
        suppressHydrationWarning
        dangerouslySetInnerHTML={{ __html: dsdHtml }}
      />
    )
  }

  return (
    <div
      ref={containerRef}
      data-remote-id={remoteId}
      suppressHydrationWarning
      dangerouslySetInnerHTML={{ __html: ssrHtml ?? '' }}
    />
  )
}
