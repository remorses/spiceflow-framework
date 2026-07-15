import React from 'react'
import type { ServerPayload } from '../spiceflow.js'
import type { RouterContextData } from '../router-context.js'

export type FlightDataContextValue = {
  payload: Promise<ServerPayload>
  routerData: RouterContextData
}

declare global {
  var __spiceflowFlightDataContext:
    | React.Context<FlightDataContextValue | undefined>
    | undefined
}

// Federation providers are built in a separate module graph, so the context
// must be shared across both copies of spiceflow/react.
export const FlightDataContext = (globalThis.__spiceflowFlightDataContext ??=
  React.createContext<FlightDataContextValue | undefined>(undefined))
