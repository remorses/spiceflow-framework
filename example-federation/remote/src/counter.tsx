'use client'

import { useState } from 'react'
import { useFormStatus } from 'react-dom'
import { useRouterState } from 'spiceflow/react'
import './counter.css'

export function Counter({ label = 'Remote' }: { label?: string }) {
  const [count, setCount] = useState(0)
  const { pending } = useFormStatus()
  const { pathname } = useRouterState()
  return (
    <div data-testid="remote-counter">
      <span data-testid="remote-url">url: {pathname}</span>
      <span data-testid="remote-form-status">
        form: {pending ? 'pending' : 'idle'}
      </span>
      <span>
        {label} counter: {count}
      </span>
      <button onClick={() => setCount((c) => c + 1)}>+</button>
      <button onClick={() => setCount((c) => c - 1)}>-</button>
    </div>
  )
}
