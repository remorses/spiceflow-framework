// Deployment id is stamped on flight responses so the client can detect
// deploy skew and hard-reload. No cookie / 409 blocking.
//
// Mirrors render-react.test.ts: mock #rsc-runtime before importing Spiceflow
// so .page() can run outside a Vite RSC build.
import { test, expect, vi } from 'vitest'

vi.mock('#deployment-id', () => ({
  getDeploymentId: async () => 'deploy-123',
}))

vi.mock('#rsc-runtime', () => ({
  __spiceflowVitestMode: false,
  renderToReadableStream() {
    return new ReadableStream({
      start(controller) {
        controller.close()
      },
    })
  },
  createTemporaryReferenceSet: () => ({}),
  decodeReply: async () => null,
  decodeAction: async () => () => null,
  decodeFormState: async () => undefined,
  loadServerAction: async () => undefined,
}))

import { Spiceflow } from './spiceflow.tsx'
import { DEPLOYMENT_ID_HEADER } from './react/deployment.js'

test('rsc page navigation includes deployment id header', async () => {
  const res = await new Spiceflow()
    .page('/page', () => 'ok')
    .handle(new Request('http://localhost/page.rsc?__rsc='))

  expect(res.status).not.toBe(409)
  expect(res.headers.get('content-type') || '').toContain('text/x-component')
  expect(res.headers.get(DEPLOYMENT_ID_HEADER)).toBe('deploy-123')
})

test('matching client deployment id still runs the page', async () => {
  const res = await new Spiceflow()
    .page('/page', () => 'ok')
    .handle(
      new Request('http://localhost/page.rsc?__rsc=', {
        headers: { [DEPLOYMENT_ID_HEADER]: 'deploy-123' },
      }),
    )

  expect(res.status).toBe(200)
  expect(res.headers.get(DEPLOYMENT_ID_HEADER)).toBe('deploy-123')
  expect(res.headers.get('content-type') || '').toContain('text/x-component')
})

test('mismatched client deployment id short-circuits before work', async () => {
  let ran = false
  const res = await new Spiceflow()
    .page('/page', () => {
      ran = true
      return 'should-not-run'
    })
    .handle(
      new Request('http://localhost/page.rsc?__rsc=', {
        headers: { [DEPLOYMENT_ID_HEADER]: 'deploy-old' },
      }),
    )

  expect(ran).toBe(false)
  expect(res.status).toBe(204)
  expect(res.headers.get(DEPLOYMENT_ID_HEADER)).toBe('deploy-123')
})

test('server action with matching deployment id executes', async () => {
  const app = new Spiceflow().post('/api', () => 'action-result')
  const res = await app.handle(
    new Request('http://localhost/api?__rsc=action-id', {
      method: 'POST',
      headers: {
        [DEPLOYMENT_ID_HEADER]: 'deploy-123',
      },
      body: 'payload',
    }),
  )

  expect(res.status).not.toBe(409)
  expect(await res.text()).toContain('action-result')
})
