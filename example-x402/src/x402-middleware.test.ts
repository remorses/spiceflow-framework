// Tests for the x402() spiceflow middleware.
//
// We inject a plain object that matches the narrow X402Server interface via
// the `server` option on x402(). No type assertions, no vi.mock, no
// facilitator network calls.
import { describe, expect, test } from 'vitest'
import { Spiceflow } from 'spiceflow'
import type {
  PaymentPayload,
  PaymentRequirements,
  VerifyResponse,
  SettleResponse,
} from '@x402/core/types'
import { x402, type X402Server } from './x402-middleware.js'

const reqs: PaymentRequirements[] = [
  {
    scheme: 'exact',
    network: 'eip155:84532',
    amount: '10000',
    asset: '0xUSDCSepoliaAsset',
    payTo: '0xFakeRecipient',
    maxTimeoutSeconds: 300,
    extra: {},
  },
]

interface FakeConfig {
  verify?: VerifyResponse
  settle?: SettleResponse
  match?: boolean
}

function fakeServer(cfg: FakeConfig = {}): X402Server & {
  calls: { build: number; verify: number; settle: number }
} {
  const calls = { build: 0, verify: 0, settle: 0 }
  return {
    calls,
    buildPaymentRequirements: async () => {
      calls.build++
      return reqs
    },
    findMatchingRequirements: (available) =>
      cfg.match === false ? undefined : available[0],
    verifyPayment: async () => {
      calls.verify++
      return cfg.verify ?? { isValid: true }
    },
    settlePayment: async () => {
      calls.settle++
      return (
        cfg.settle ?? {
          success: true,
          transaction: '0xabc',
          network: 'eip155:84532',
        }
      )
    },
  }
}

function makeApp(cfg: FakeConfig = {}) {
  return new Spiceflow()
    .use(
      x402({
        price: '$0.01',
        network: 'eip155:84532',
        payTo: '0xFakeRecipient',
        server: fakeServer(cfg),
      }),
    )
    .get('/paid', () => ({ foo: 'bar' }))
}

function validPaymentHeader(): string {
  // Minimal base64-encoded payload that findMatchingRequirements will
  // accept when the fake returns reqs[0]. Shape is not validated by the
  // fake server — we only need decode to succeed.
  const payload: PaymentPayload = {
    x402Version: 2,
    accepted: reqs[0]!,
    payload: {
      signature: '0xdeadbeef',
      authorization: {
        from: '0xpayer',
        to: '0xFakeRecipient',
        value: '10000',
        validAfter: '0',
        validBefore: '9999999999',
        nonce: '0x00',
      },
    },
  }
  return Buffer.from(JSON.stringify(payload)).toString('base64')
}

describe('x402 middleware', () => {
  test('no payment header → 402 with challenge body', async () => {
    const app = makeApp()
    const res = await app.handle(new Request('http://localhost/paid'))
    expect(res.status).toBe(402)
    expect(res.headers.get('www-authenticate')).toBe('x402 scheme="exact"')
    const body = await res.json()
    expect(body.error).toBe('Payment required')
    expect(body.x402Version).toBe(2)
    expect(body.resource.url).toBe('/paid')
    expect(body.accepts).toHaveLength(1)
    expect(body.accepts[0]!.scheme).toBe('exact')
  })

  test('unparseable payment header → 402 with decode error', async () => {
    const app = makeApp()
    const res = await app.handle(
      new Request('http://localhost/paid', {
        headers: { 'x-payment': '!!!not-base64!!!' },
      }),
    )
    expect(res.status).toBe(402)
    const body = await res.json()
    expect(body.error).toContain('decode payment header')
  })

  test('valid payment, verify succeeds, settle succeeds → 200 with receipt', async () => {
    const app = makeApp()
    const res = await app.handle(
      new Request('http://localhost/paid', {
        headers: { 'x-payment': validPaymentHeader() },
      }),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ foo: 'bar' })
    const receipt = res.headers.get('x-payment-response')
    expect(typeof receipt).toBe('string')
    expect(receipt!.length).toBeGreaterThan(0)
  })

  test('verify fails → 402 with reason, handler never runs', async () => {
    let handlerCalls = 0
    const app = new Spiceflow()
      .use(
        x402({
          price: '$0.01',
          network: 'eip155:84532',
          payTo: '0xFakeRecipient',
          server: fakeServer({
            verify: { isValid: false, invalidReason: 'insufficient_funds' },
          }),
        }),
      )
      .get('/paid', () => {
        handlerCalls++
        return { foo: 'bar' }
      })
    const res = await app.handle(
      new Request('http://localhost/paid', {
        headers: { 'x-payment': validPaymentHeader() },
      }),
    )
    expect(res.status).toBe(402)
    const body = await res.json()
    expect(body.error).toBe('insufficient_funds')
    expect(handlerCalls).toBe(0)
  })

  test('no matching requirements → 402', async () => {
    const app = makeApp({ match: false })
    const res = await app.handle(
      new Request('http://localhost/paid', {
        headers: { 'x-payment': validPaymentHeader() },
      }),
    )
    expect(res.status).toBe(402)
    const body = await res.json()
    expect(body.error).toBe('No matching payment requirements')
  })

  test('handler errors after verify → settle is skipped, error passes through', async () => {
    const server = fakeServer()
    const app = new Spiceflow()
      .use(
        x402({
          price: '$0.01',
          network: 'eip155:84532',
          payTo: '0xFakeRecipient',
          server,
        }),
      )
      .get('/paid', () => {
        return new Response('boom', { status: 500 })
      })
    const res = await app.handle(
      new Request('http://localhost/paid', {
        headers: { 'x-payment': validPaymentHeader() },
      }),
    )
    expect(res.status).toBe(500)
    expect(server.calls.settle).toBe(0)
  })

  test('dynamic payTo resolver is called with the middleware context', async () => {
    let receivedPath: string | undefined
    const app = new Spiceflow()
      .use(
        x402({
          price: '$0.01',
          network: 'eip155:84532',
          payTo: (ctx) => {
            receivedPath = new URL(ctx.request.url).pathname
            return '0xDynamicRecipient'
          },
          server: fakeServer(),
        }),
      )
      .get('/paid', () => ({ foo: 'bar' }))
    const res = await app.handle(new Request('http://localhost/paid'))
    expect(res.status).toBe(402)
    expect(receivedPath).toBe('/paid')
  })

  test('routes outside the paidApp sub-app are not gated', async () => {
    const paid = new Spiceflow()
      .use(
        x402({
          price: '$0.01',
          network: 'eip155:84532',
          payTo: '0xFakeRecipient',
          server: fakeServer(),
        }),
      )
      .get('/paid', () => ({ foo: 'bar' }))

    const root = new Spiceflow().get('/free', () => ({ ok: true })).use(paid)

    const free = await root.handle(new Request('http://localhost/free'))
    expect(free.status).toBe(200)
    expect(await free.json()).toEqual({ ok: true })

    const paidRes = await root.handle(new Request('http://localhost/paid'))
    expect(paidRes.status).toBe(402)
  })

  test('payTo resolver returning an Error → 500 with error message', async () => {
    const app = new Spiceflow()
      .use(
        x402({
          price: '$0.01',
          network: 'eip155:84532',
          payTo: () => new Error('wallet is offline'),
          server: fakeServer(),
        }),
      )
      .get('/paid', () => ({ foo: 'bar' }))
    const res = await app.handle(new Request('http://localhost/paid'))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toContain('wallet is offline')
  })
})
