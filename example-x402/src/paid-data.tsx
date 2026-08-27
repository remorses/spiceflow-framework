'use client'

// Client component that demonstrates the x402 handshake from the browser.
// The first fetch gets a 402 with the payment challenge; the real "agent"
// flow would then sign an on-chain payment and retry with an x-payment
// header. We just show the challenge body so you can see it.
import { useState } from 'react'

interface Challenge {
  x402Version: number
  error: string
  accepts: Array<{
    scheme: string
    network: string
    payTo: string
    amount: string
    asset?: string
  }>
}

export function PaidData() {
  const [state, setState] = useState<
    | { kind: 'idle' }
    | { kind: 'loading' }
    | { kind: 'challenge'; status: number; body: Challenge }
    | { kind: 'paid'; body: unknown }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' })

  return (
    <div className="flex flex-col gap-3 p-4 border border-gray-300 dark:border-gray-700 rounded">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => {
            setState({ kind: 'loading' })
            fetch('/paid')
              .then(async (res) => {
                const body = await res.json().catch(() => null)
                if (res.status === 402) {
                  setState({ kind: 'challenge', status: res.status, body })
                  return
                }
                if (res.ok) {
                  setState({ kind: 'paid', body })
                  return
                }
                setState({
                  kind: 'error',
                  message: `HTTP ${res.status}: ${JSON.stringify(body)}`,
                })
              })
              .catch((err) => {
                setState({ kind: 'error', message: String(err) })
              })
          }}
          className="px-3 py-1.5 text-sm font-medium bg-black text-white dark:bg-white dark:text-black rounded"
        >
          Call /paid
        </button>
        <span className="text-xs text-gray-500">status: {state.kind}</span>
      </div>

      {state.kind === 'challenge' && (
        <div className="flex flex-col gap-1 text-xs">
          <span className="font-semibold">
            {state.status} Payment Required — {state.body.error}
          </span>
          <pre className="p-3 bg-gray-100 dark:bg-gray-900 overflow-x-auto rounded">
            {JSON.stringify(state.body.accepts, null, 2)}
          </pre>
          <p className="text-gray-500">
            An x402 client would sign an on-chain payment to{' '}
            <code>payTo</code> and retry with an <code>x-payment</code> header.
          </p>
        </div>
      )}

      {state.kind === 'paid' && (
        <pre className="p-3 text-xs bg-gray-100 dark:bg-gray-900 rounded">
          {JSON.stringify(state.body, null, 2)}
        </pre>
      )}

      {state.kind === 'error' && (
        <span className="text-xs text-red-600">{state.message}</span>
      )}
    </div>
  )
}
