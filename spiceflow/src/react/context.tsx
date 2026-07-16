'use client'
import React from 'react'
import { coerceLoaderData } from 'spiceflow/react'
import type { AnySpiceflow } from '../spiceflow.js'
import { ServerPayload } from '../spiceflow.js'
import { FlightDataContext } from '#flight-data-context'
import { getRouterContext } from '#router-context'
import {
  type LoaderDataForPath,
  type RegisteredApp,
  type RouterPathArg,
} from './router.js'

export { FlightDataContext }

function readFlightDataContext() {
  if (!FlightDataContext) {
    return undefined
  }
  return React.useContext(FlightDataContext)
}

export function assertFlightDataContext(
  value: ReturnType<typeof readFlightDataContext>,
): Promise<ServerPayload> {
  if (value) {
    return value.payload
  }

  throw new Error(
    '[spiceflow] FlightDataContext is missing. This usually means the ' +
      'spiceflow module was loaded twice. Make sure only one copy of ' +
      'spiceflow is present in node_modules. Dedupe your dependencies, ' +
      'for example with `pnpm dedupe spiceflow`, `npm dedupe`, or `bun install`.',
  )
}

export function useFlightData() {
  const payload = React.use(assertFlightDataContext(readFlightDataContext()))
  return payload?.root
}

export function useLoaderData<
  App extends AnySpiceflow = RegisteredApp,
  const Path extends RouterPathArg<App> = string,
>(_path?: Path): LoaderDataForPath<App, Path> {
  const flightData = readFlightDataContext()
  if (typeof window === 'undefined' && !flightData) {
    return coerceLoaderData<App, Path>(
      getRouterContext()?.loaderData ?? {},
    )
  }

  const payload = React.use(assertFlightDataContext(flightData))
  return coerceLoaderData<App, Path>(payload?.root?.loaderData ?? {})
}
