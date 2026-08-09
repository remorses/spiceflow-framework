// Imperative toast notification system for spiceflow.
// Uses inline styles only (no CSS classes) so it works in any app without
// configuration. Inspired by react-hot-toast visually.
//
// The toast renderer is auto-mounted by spiceflow's BrowserRoot so action
// error toasts work out of the box. Users can import toast() to show custom
// toasts from anywhere.
//
// The store is module-scoped so toast() works outside React (event handlers,
// plain functions, etc). Subscribers are notified synchronously.

'use client'

import React from 'react'

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

type ToastType = 'error' | 'success' | 'info'

interface ToastItem {
  id: number
  message: string
  type: ToastType
  removing?: boolean
}

let nextId = 1
let items: ToastItem[] = []
const subscribers = new Set<() => void>()

function notify() {
  for (const fn of subscribers) fn()
}

function addToast({
  message,
  type,
  duration,
}: {
  message: string
  type: ToastType
  duration: number
}) {
  const MAX_MESSAGE_LENGTH = 200
  const truncated =
    message.length > MAX_MESSAGE_LENGTH
      ? message.slice(0, MAX_MESSAGE_LENGTH) + '...'
      : message
  const item: ToastItem = {
    id: nextId++,
    message: truncated,
    type,
  }
  items = [...items, item]
  notify()

  setTimeout(() => {
    dismissToast(item.id)
  }, duration)

  return item.id
}

function dismissToast(id: number) {
  const idx = items.findIndex((t) => t.id === id)
  if (idx === -1) return
  // Mark as removing to trigger exit animation
  items = items.map((t) => (t.id === id ? { ...t, removing: true } : t))
  notify()
  setTimeout(() => {
    items = items.filter((t) => t.id !== id)
    notify()
  }, 300)
}

// ---------------------------------------------------------------------------
// Public imperative API
// ---------------------------------------------------------------------------

interface ToastOptions {
  duration?: number
}

function toastFn(message: string, options?: ToastOptions & { type?: ToastType }) {
  return addToast({
    message,
    type: options?.type ?? 'info',
    duration: options?.duration ?? 4000,
  })
}

toastFn.error = (message: string, options?: ToastOptions) =>
  addToast({ message, type: 'error', duration: options?.duration ?? 5000 })

toastFn.success = (message: string, options?: ToastOptions) =>
  addToast({ message, type: 'success', duration: options?.duration ?? 3000 })

toastFn.dismiss = dismissToast

export const toast = toastFn

// ---------------------------------------------------------------------------
// Action error branding
// ---------------------------------------------------------------------------

const ACTION_ERROR_BRAND = Symbol.for('spiceflow.actionError')

export function brandActionError(error: Error) {
  Reflect.set(error, ACTION_ERROR_BRAND, true)
}

export function isActionError(error: Error): boolean {
  return Reflect.get(error, ACTION_ERROR_BRAND) === true
}

// ---------------------------------------------------------------------------
// Unhandled rejection handler — installed once by the toast renderer.
// Catches branded action errors that escape React's error boundary tree
// entirely (e.g. action called from a raw addEventListener callback).
// ---------------------------------------------------------------------------

let handlerInstalled = false

function installActionErrorHandler() {
  if (handlerInstalled) return
  handlerInstalled = true

  window.addEventListener('unhandledrejection', (event) => {
    const error = event.reason
    if (!isActionError(error)) return
    event.preventDefault()
    const message =
      error instanceof Error
        ? error.message || 'Server action failed'
        : String(error)
    toast.error(message)
  })
}

// ---------------------------------------------------------------------------
// Keyframes style injection (once per document)
// ---------------------------------------------------------------------------

const STYLE_ID = '__spiceflow-toast-style'

function ensureStyles() {
  if (typeof document === 'undefined') return
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = [
    '@keyframes spiceflow-toast-in {',
    '  from { opacity: 0; transform: translateY(-8px) scale(0.96); }',
    '  to { opacity: 1; transform: translateY(0) scale(1); }',
    '}',
    '@keyframes spiceflow-toast-out {',
    '  from { opacity: 1; transform: translateY(0) scale(1); }',
    '  to { opacity: 0; transform: translateY(-8px) scale(0.96); }',
    '}',
  ].join('\n')
  document.head.appendChild(style)
}

// ---------------------------------------------------------------------------
// React components
// ---------------------------------------------------------------------------

function subscribe(callback: () => void) {
  subscribers.add(callback)
  return () => { subscribers.delete(callback) }
}

function getSnapshot() {
  return items
}

const emptyItems: ToastItem[] = []

function getServerSnapshot() {
  return emptyItems
}

const accentColors: Record<ToastType, string> = {
  error: '#ef4444',
  success: '#22c55e',
  info: '#3b82f6',
}

function ToastEntry({ item }: { item: ToastItem }) {
  return (
    <div
      role="alert"
      data-testid="spiceflow-toast"
      data-toast-type={item.type}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        padding: '12px 16px',
        background: '#fff',
        color: '#1a1a1a',
        borderRadius: '8px',
        boxShadow:
          '0 4px 12px rgba(0,0,0,0.12), 0 1px 3px rgba(0,0,0,0.08)',
        borderLeft: `4px solid ${accentColors[item.type]}`,
        fontSize: '14px',
        lineHeight: '1.5',
        fontFamily:
          'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
        maxWidth: '420px',
        width: 'max-content',
        pointerEvents: 'auto',
        animation: item.removing
          ? 'spiceflow-toast-out 0.3s ease forwards'
          : 'spiceflow-toast-in 0.3s ease forwards',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      }}
      onClick={() => dismissToast(item.id)}
    >
      <span style={{ flex: 1, minWidth: 0 }}>{item.message}</span>
      <button
        type="button"
        aria-label="Dismiss"
        style={{
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          padding: '0 0 0 4px',
          fontSize: '18px',
          lineHeight: 1,
          color: '#999',
          flexShrink: 0,
        }}
        onClick={(e) => {
          e.stopPropagation()
          dismissToast(item.id)
        }}
      >
        &times;
      </button>
    </div>
  )
}

function ToastRenderer() {
  const toasts = React.useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot,
  )

  React.useEffect(() => {
    ensureStyles()
    installActionErrorHandler()
  }, [])

  if (toasts.length === 0) return null

  return (
    <div
      data-testid="spiceflow-toaster"
      style={{
        position: 'fixed',
        top: '16px',
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 2147483647,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '8px',
        pointerEvents: 'none',
      }}
    >
      {toasts.map((item) => (
        <ToastEntry key={item.id} item={item} />
      ))}
    </div>
  )
}

export { ToastRenderer as __ToastRenderer }
