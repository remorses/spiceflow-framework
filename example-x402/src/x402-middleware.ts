// Small spiceflow middleware that protects a sub-app with the x402 payment
// protocol. Lives inside the example (not spiceflow core) on purpose: it is
// ~250 lines and only depends on @x402/core, which makes it easy to read
// top-to-bottom as a reference implementation.
//
// Compared to @x402/hono's paymentMiddleware (~380 lines + a 1000-line
// x402HTTPResourceServer wrapper), this skips:
//   - its own route matcher (spiceflow's trie router already matched)
//   - HTML paywall generation (@x402/paywall)
//   - dynamic bazaar extension loading
//   - the Hono context adapter (we use web-standard Request directly)
//   - settlement-overrides header magic
//
// Scoping is done by mounting a sub-app via `app.use(paidSubApp)`. Any route
// defined on the sub-app runs through this middleware; routes on the parent
// app do not.
//
// Error handling follows the `errore` pattern (errors as values via
// `Error | T` unions and `instanceof Error` narrowing). The middleware
// returns a Response directly for every failure mode so callers never need
// to handle thrown errors.

import {
  x402ResourceServer,
  HTTPFacilitatorClient,
  type FacilitatorClient,
} from '@x402/core/server'
import {
  decodePaymentSignatureHeader,
  encodePaymentResponseHeader,
} from '@x402/core/http'
import type {
  PaymentPayload,
  PaymentRequirements,
  Network,
  Price,
} from '@x402/core/types'
import type { VerifyResponse, SettleResponse } from '@x402/core/types'
import type { ResourceConfig } from '@x402/core/server'
import { ExactEvmScheme } from '@x402/evm/exact/server'
import type { MiddlewareHandler } from 'spiceflow'
import NodeCache from 'node-cache'
import type Stripe from 'stripe'
import * as errore from 'errore'

type Ctx = Parameters<MiddlewareHandler>[0]

// -----------------------------------------------------------------------------
// Domain errors
// -----------------------------------------------------------------------------

export class X402ConfigError extends errore.createTaggedError({
  name: 'X402ConfigError',
  message: 'x402 configuration error: $reason',
}) {}

export class X402VerifyError extends errore.createTaggedError({
  name: 'X402VerifyError',
  message: 'x402 verify failed: $reason',
}) {}

export class X402SettleError extends errore.createTaggedError({
  name: 'X402SettleError',
  message: 'x402 settle failed: $reason',
}) {}

export class X402PayToError extends errore.createTaggedError({
  name: 'X402PayToError',
  message: 'Could not resolve payTo address: $reason',
}) {}

export class StripeDepositError extends errore.createTaggedError({
  name: 'StripeDepositError',
  message: 'Stripe deposit address error: $reason',
}) {}

// -----------------------------------------------------------------------------
// Narrow interface for the resource server
// -----------------------------------------------------------------------------
//
// Declaring only the methods the middleware uses means:
//   1. Tests pass a plain object literal with these methods — no type
//      assertions, no vi.mock, no fancy test doubles.
//   2. The middleware is explicit about which parts of @x402/core it depends
//      on, so upstream API changes show up as type errors in one place.
//   3. `x402ResourceServer` satisfies this interface structurally, so
//      production usage needs no adapter.
export interface X402Server {
  buildPaymentRequirements(
    config: ResourceConfig,
  ): Promise<PaymentRequirements[]>
  findMatchingRequirements(
    availableRequirements: PaymentRequirements[],
    paymentPayload: PaymentPayload,
  ): PaymentRequirements | undefined
  verifyPayment(
    paymentPayload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResponse>
  settlePayment(
    paymentPayload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse>
}

// -----------------------------------------------------------------------------
// Middleware
// -----------------------------------------------------------------------------

/** Resolver that returns a payTo address, or an Error if it can't. */
export type PayToResolver = (
  ctx: Ctx,
) => Promise<string | Error> | string | Error

export interface X402Options {
  /** USD price per request, e.g. `"$0.01"`. */
  price: Price
  /** CAIP-2 network id, e.g. `"eip155:84532"` for Base Sepolia. */
  network: Network
  /**
   * Recipient address. Either a literal string, or a resolver that returns
   * the address (or an Error). Use `stripeDepositAddress()` to mint a fresh
   * Stripe-custody address per request.
   */
  payTo: string | PayToResolver
  /** Defaults to `https://www.x402.org/facilitator`. */
  facilitatorUrl?: string
  /** Defaults to `"exact"`. */
  scheme?: string
  /**
   * Escape hatch for tests: inject a fake (or custom) resource server
   * instead of lazily building one.
   */
  server?: X402Server
}

/**
 * Create a spiceflow middleware that enforces an x402 payment on every
 * request that reaches it. Mount it on a sub-app to scope which routes
 * it protects.
 *
 * ```ts
 * const paidApp = new Spiceflow()
 *   .use(x402({ price: '$0.01', network: 'eip155:84532', payTo: '0x...' }))
 *   .get('/paid', () => ({ foo: 'bar' }))
 *
 * const app = new Spiceflow().use(paidApp)
 * ```
 */
export function x402(options: X402Options): MiddlewareHandler {
  const scheme = options.scheme ?? 'exact'
  const facilitatorUrl =
    options.facilitatorUrl ?? 'https://www.x402.org/facilitator'

  // Lazy singleton: the first request to this middleware constructs and
  // initializes the resource server. initialize() fetches the facilitator's
  // supported schemes/networks over HTTP, which we can't do at module load.
  let server: X402Server | null = options.server ?? null
  let initPromise: Promise<X402Server | Error> | null = null

  const getServer = async (): Promise<X402Server | Error> => {
    if (server) return server
    if (!initPromise) {
      initPromise = (async () => {
        const client: FacilitatorClient = new HTTPFacilitatorClient({
          url: facilitatorUrl,
        })
        const fresh = new x402ResourceServer(client).register(
          options.network,
          new ExactEvmScheme(),
        )
        const init = await fresh.initialize().then(
          () => fresh,
          (e) => new X402ConfigError({ reason: 'initialize', cause: e }),
        )
        if (init instanceof Error) return init
        server = init
        return init
      })()
    }
    return initPromise
  }

  return async (ctx, next) => {
    const { request } = ctx
    const resource = new URL(request.url).pathname

    const resourceServer = await getServer()
    if (resourceServer instanceof Error) {
      return serverError(resourceServer)
    }

    const payTo = await resolvePayTo(options.payTo, ctx)
    if (payTo instanceof Error) return serverError(payTo)

    const requirements = await resourceServer
      .buildPaymentRequirements({
        scheme,
        network: options.network,
        payTo,
        price: options.price,
      })
      .catch(
        (e) =>
          new X402ConfigError({ reason: 'buildPaymentRequirements', cause: e }),
      )
    if (requirements instanceof Error) return serverError(requirements)

    const header =
      request.headers.get('x-payment') ??
      request.headers.get('payment-signature')

    if (!header) {
      return paymentRequired({
        error: 'Payment required',
        requirements,
        resource,
      })
    }

    const payload = errore.try({
      try: () => decodePaymentSignatureHeader(header),
      catch: (e) =>
        new X402VerifyError({ reason: 'decode payment header', cause: e }),
    })
    if (payload instanceof Error) {
      return paymentRequired({
        error: payload.message,
        requirements,
        resource,
      })
    }

    const match = resourceServer.findMatchingRequirements(requirements, payload)
    if (!match) {
      return paymentRequired({
        error: 'No matching payment requirements',
        requirements,
        resource,
      })
    }

    const verify = await resourceServer
      .verifyPayment(payload, match)
      .catch(
        (e) => new X402VerifyError({ reason: 'verifyPayment', cause: e }),
      )
    if (verify instanceof Error) {
      return paymentRequired({
        error: verify.message,
        requirements,
        resource,
      })
    }
    if (!verify.isValid) {
      return paymentRequired({
        error: verify.invalidReason ?? 'Invalid payment',
        requirements,
        resource,
      })
    }

    // Payment is verified, run the real handler.
    const res = await next()
    // If the handler errored, skip settlement — the client should not be
    // charged for a failed response.
    if (!res || res.status >= 400) return res

    const settle = await resourceServer
      .settlePayment(payload, match)
      .catch(
        (e) => new X402SettleError({ reason: 'settlePayment', cause: e }),
      )
    if (settle instanceof Error) {
      return new Response(
        JSON.stringify({ error: 'settlement failed', reason: settle.message }),
        { status: 402, headers: { 'content-type': 'application/json' } },
      )
    }
    if (!settle.success) {
      return new Response(
        JSON.stringify({
          error: 'settlement failed',
          reason: settle.errorReason,
        }),
        { status: 402, headers: { 'content-type': 'application/json' } },
      )
    }

    // Attach the signed settlement receipt so the client can verify on-chain.
    res.headers.set('x-payment-response', encodePaymentResponseHeader(settle))
    return res
  }
}

async function resolvePayTo(
  payTo: string | PayToResolver,
  ctx: Ctx,
): Promise<string | Error> {
  if (typeof payTo === 'string') return payTo
  const result = await payTo(ctx)
  if (result instanceof Error) {
    return new X402PayToError({ reason: result.message, cause: result })
  }
  return result
}

function paymentRequired({
  error,
  requirements,
  resource,
}: {
  error: string
  requirements: PaymentRequirements[]
  resource: string
}): Response {
  const body = {
    x402Version: 2,
    error,
    resource: { url: resource, description: '', mimeType: 'application/json' },
    accepts: requirements,
  }
  return new Response(JSON.stringify(body), {
    status: 402,
    headers: {
      'content-type': 'application/json',
      'www-authenticate': `x402 scheme="${requirements[0]?.scheme ?? 'exact'}"`,
    },
  })
}

function serverError(err: Error): Response {
  console.error('[x402 middleware]', err)
  return new Response(JSON.stringify({ error: err.message }), {
    status: 500,
    headers: { 'content-type': 'application/json' },
  })
}

// -----------------------------------------------------------------------------
// Stripe-backed payTo resolver
// -----------------------------------------------------------------------------

export interface StripeDepositAddressOptions {
  stripe: Stripe
  /** `"base"` for Base (Sepolia) or `"tempo"` for Stripe's Tempo network. */
  network: 'base' | 'tempo'
  /**
   * Nominal deposit amount quoted to Stripe when minting the address.
   * The underlying crypto deposit address is pre-funded; the actual per-call
   * price is enforced by x402. Defaults to $100.
   */
  amountUsd?: number
  /** Address cache TTL in seconds. Defaults to 5 minutes. */
  ttlSeconds?: number
}

// readField pulls a field off an unknown value without type assertions or
// `in` operator checks. Returns undefined if the value isn't an object or
// the field doesn't exist. This is the narrowing primitive used to walk
// loosely-typed objects from Stripe and x402 payment payloads.
function readField(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined
  return Reflect.get(value, key)
}

// The Stripe SDK types don't yet include the preview crypto deposit fields,
// so we walk pi.next_action via readField and pull the address out by name.
function toCryptoDepositAddress(
  nextAction: unknown,
  network: string,
): string | null {
  const details = readField(nextAction, 'crypto_display_details')
  const addresses = readField(details, 'deposit_addresses')
  const entry = readField(addresses, network)
  const address = readField(entry, 'address')
  return typeof address === 'string' ? address : null
}

function extractRecipient(payload: PaymentPayload): string | null {
  // EVM "exact" scheme: recipient lives at payload.payload.authorization.to.
  const to = readField(readField(payload.payload, 'authorization'), 'to')
  return typeof to === 'string' ? to : null
}

/**
 * Returns a payTo resolver that asks Stripe for a fresh crypto deposit
 * address on first hit, then re-uses it while the client retries with its
 * signed payment. Mirrors the `createPayToAddress` helper from
 * `stripe-samples/machine-payments` but scoped to a closure so the cache
 * and Stripe client are encapsulated.
 */
export function stripeDepositAddress(
  options: StripeDepositAddressOptions,
): PayToResolver {
  const cache = new NodeCache({ stdTTL: options.ttlSeconds ?? 300 })
  const amountUsd = options.amountUsd ?? 100

  return async ({ request }) => {
    // Retry branch: the client attached an authorization header. Verify
    // the recipient address came from us (i.e. is in cache) to prevent a
    // forged credential from redirecting settlement elsewhere.
    const paymentHeader = request.headers.get('x-payment')
    if (paymentHeader) {
      const payload = errore.try({
        try: () => decodePaymentSignatureHeader(paymentHeader),
        catch: (e) =>
          new StripeDepositError({
            reason: 'decode payment header',
            cause: e,
          }),
      })
      if (payload instanceof Error) return payload

      const to = extractRecipient(payload)?.toLowerCase() ?? null
      if (to === null || !cache.has(to)) {
        return new StripeDepositError({
          reason: 'payTo address not present in server cache',
        })
      }
      return to
    }

    // Fresh-address branch: mint a new deposit address via Stripe.
    // The `mode: 'deposit'` and `deposit_options` fields on payment_method_
    // options.crypto are part of a preview API that isn't in the Stripe SDK's
    // types yet, so we use @ts-expect-error for the one offending call
    // instead of leaking `as any` assertions through the codebase.
    const pi = await options.stripe.paymentIntents
      .create({
        amount: amountUsd * 100 * 10_000,
        currency: 'usd',
        payment_method_types: ['crypto'],
        payment_method_data: { type: 'crypto' },
        payment_method_options: {
          crypto: {
            // @ts-expect-error Stripe crypto deposit preview API not in SDK types
            mode: 'deposit',
            deposit_options: { networks: [options.network] },
          },
        },
        confirm: true,
      })
      .catch(
        (e) =>
          new StripeDepositError({ reason: 'paymentIntents.create', cause: e }),
      )
    if (pi instanceof Error) return pi

    const address = toCryptoDepositAddress(pi.next_action, options.network)
    if (address === null) {
      return new StripeDepositError({
        reason: `no deposit address for network "${options.network}"`,
      })
    }
    const lower = address.toLowerCase()
    cache.set(lower, true)
    return lower
  }
}
