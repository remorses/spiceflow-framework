# example-x402

A spiceflow app that protects a single API route (`GET /paid`) with the
[x402](https://www.x402.org) payment protocol. Each request costs **$0.01**,
settled on **Base Sepolia** in USDC. Fresh deposit addresses are minted via
Stripe PaymentIntents, mirroring [stripe-samples/machine-payments](https://github.com/stripe-samples/machine-payments).

## Shape

```
app (root Spiceflow)
├── serveStatic('/public')
├── layout  '/*'
├── page    '/'                    ← RSC page with a <PaidData /> client comp
└── use(paidApp)
    paidApp (Spiceflow sub-app)
    ├── use(x402({ price, network, payTo }))  ← only runs for paidApp routes
    └── get '/paid' → () => ({ foo: 'bar' })
```

Spiceflow scopes middleware by **sub-app ownership**, not by path. Mounting
`paidApp` via `app.use(paidApp)` means the x402 handshake only runs for routes
defined on `paidApp`. Anything on the parent app (`/`, static files, RSC
pages) is untouched.

## Why a custom middleware instead of `@x402/hono`

`@x402/hono`'s `paymentMiddleware` is ~380 lines and wraps a ~1000-line
`x402HTTPResourceServer`. It carries its own route matcher, HTML paywall
generator, Hono context adapter, bazaar extension loader, and settlement
overrides header. Spiceflow already has a trie router, so a bespoke ~180-line
middleware at [`src/x402-middleware.ts`](./src/x402-middleware.ts) is enough.
It only imports from `@x402/core/server`, `@x402/core/http`, `@x402/core/types`,
and `@x402/evm/exact/server`.

## Setup

```bash
cp .env.example .env
# fill in STRIPE_SECRET_KEY
pnpm install
pnpm dev
```

Open <http://localhost:3000> and click **Call /paid** to see the 402 challenge,
or hit the route directly with curl:

```bash
curl -i http://localhost:3000/paid
# HTTP/1.1 402 Payment Required
# www-authenticate: x402 scheme="exact"
# content-type: application/json
#
# {"x402Version":2,"error":"Payment required","accepts":[...]}
```

A real x402 client would sign an on-chain payment to the `payTo` address in
the challenge and retry with an `x-payment` header. See
[x402.org](https://www.x402.org) for client libraries.

## Environment

| Variable            | Required | Default                                   |
|---------------------|----------|-------------------------------------------|
| `STRIPE_SECRET_KEY` | yes      | —                                         |
| `FACILITATOR_URL`   | no       | `https://www.x402.org/facilitator`        |
| `PORT`              | no       | `3000`                                    |

## Tests

```bash
pnpm test
```

The middleware unit tests inject a fake `x402ResourceServer` via the
undocumented `server` option on `x402()`. No network, no mocks.
