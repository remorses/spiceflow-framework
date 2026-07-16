import { Suspense } from 'react'
import { Spiceflow } from 'spiceflow'
import { encodeFederationPayload } from 'spiceflow/federation'
import { Head, Link, RenderFederatedPayload } from 'spiceflow/react'
import { LocalCounter } from './local-counter'

const REMOTE_ORIGIN = process.env.REMOTE_ORIGIN || 'http://localhost:3051'
const HOST_ORIGIN = `http://localhost:${process.env.PORT || 3052}`

function withProps(url: string, props?: Record<string, unknown>) {
  const next = new URL(url)
  if (props) {
    next.searchParams.set('props', JSON.stringify(props))
  }
  return next.toString()
}

function fetchFederatedResponse(url: string, props?: Record<string, unknown>) {
  return fetch(withProps(url, props))
}

function handleFederatedResponse(path: string, props?: Record<string, unknown>) {
  return app.handle(new Request(withProps(new URL(path, HOST_ORIGIN).toString(), props)))
}

export const app = new Spiceflow()
  .layout('/*', async ({ children }) => {
    return (
      <html lang="en">
        <Head>
          <Head.Title>Federation Host</Head.Title>
        </Head>
        <body>
          <div id="root">{children}</div>
        </body>
      </html>
    )
  })
  .page('/', async () => {
    return (
      <div>
        <h1 data-testid="host-title">Federation Host App</h1>
        <p>This page embeds a component from the remote server.</p>

        <div data-testid="remote-section">
          <h2>Remote Chart Component:</h2>
          <Suspense fallback={<div data-testid="remote-loading">Loading remote component...</div>}>
            <RenderFederatedPayload
              response={await fetchFederatedResponse(`${REMOTE_ORIGIN}/api/chart`, {
                dataSource: 'revenue',
              })}
            />
          </Suspense>
        </div>

        <div data-testid="isolated-remote-section">
          <h2>Remote Chart Component (Shadow DOM isolated):</h2>
          <Suspense
            fallback={<div data-testid="isolated-remote-loading">Loading isolated remote component...</div>}
          >
            <RenderFederatedPayload
              response={await fetchFederatedResponse(`${REMOTE_ORIGIN}/api/chart`, {
                dataSource: 'isolated',
              })}
              isolateStyles
            />
          </Suspense>
        </div>

        <Link href="/isolated-nav" data-testid="nav-to-isolated">Go to isolated nav page</Link>

        <div data-testid="esm-section">
          <h2>ESM Component:</h2>
          <Suspense fallback={<div data-testid="esm-loading">Loading ESM component...</div>}>
            <RenderFederatedPayload
              response={await fetch(`${REMOTE_ORIGIN}/api/esm-component.js`)}
            />
          </Suspense>
        </div>

        <div data-testid="local-remote-section">
          <h2>Local Remote Component:</h2>
          <Suspense
            fallback={<div data-testid="local-remote-loading">Loading local remote component...</div>}
          >
            <RenderFederatedPayload
              response={await handleFederatedResponse('/api/local-widget', {
                label: 'Self-hosted',
              })}
            />
          </Suspense>
        </div>

        <div data-testid="framer-section">
          <h2>Framer Component (IOKnob):</h2>
          <Suspense fallback={<div data-testid="framer-loading">Loading Framer component...</div>}>
            <RenderFederatedPayload
              response={await fetch(
                'https://framer.com/m/IOKnob-DT0M.js@eZsKjfnRtnN8np5uwoAx',
              )}
            />
          </Suspense>
        </div>
      </div>
    )
  })

  // Consumes the remote's intentionally broken payload (its client module
  // chunk 404s). The island must degrade to the static SSR HTML while the
  // rest of the page stays interactive.
  .page('/broken-remote', async () => {
    return (
      <div>
        <h1 data-testid="broken-title">Broken Remote Page</h1>
        <LocalCounter />
        <div data-testid="broken-section">
          <Suspense fallback={<div>Loading broken remote...</div>}>
            <RenderFederatedPayload
              response={await fetch(`${REMOTE_ORIGIN}/api/broken`)}
            />
          </Suspense>
        </div>
      </div>
    )
  })

  .page('/no-remote', async () => {
    return (
      <div>
        <h1 data-testid="no-remote-title">Page Without Remote Components</h1>
        <Link href="/isolated-nav" data-testid="nav-to-isolated">Go to isolated</Link>
        <Link href="/plain-nav" data-testid="nav-to-plain">Go to plain remote</Link>
      </div>
    )
  })

  .page('/isolated-nav', async () => {
    return (
      <div>
        <h1 data-testid="nav-page-title">Client Navigation Target</h1>
        <Link href="/" data-testid="back-link">Back to home</Link>
        <div data-testid="nav-isolated-section">
          <Suspense
            fallback={<div data-testid="nav-isolated-loading">Loading isolated remote...</div>}
          >
            <RenderFederatedPayload
              response={await fetchFederatedResponse(`${REMOTE_ORIGIN}/api/chart`, {
                dataSource: 'nav-isolated',
              })}
              isolateStyles
            />
          </Suspense>
        </div>
      </div>
    )
  })

  .page('/plain-nav', async () => {
    return (
      <div>
        <h1 data-testid="plain-nav-title">Plain Remote (No Isolation)</h1>
        <Link href="/no-remote" data-testid="back-to-no-remote">Back</Link>
        <div data-testid="nav-plain-section">
          <Suspense fallback={<div data-testid="nav-plain-loading">Loading plain remote...</div>}>
            <RenderFederatedPayload
              response={await fetchFederatedResponse(`${REMOTE_ORIGIN}/api/chart`, {
                dataSource: 'nav-plain',
              })}
            />
          </Suspense>
        </div>
      </div>
    )
  })

  .get('/api/local-widget', async ({ request }) => {
    const url = new URL(request.url)
    let props: Record<string, unknown> = {}
    try {
      props = JSON.parse(url.searchParams.get('props') || '{}')
    } catch {}
    return await encodeFederationPayload(<LocalCounter {...props} />)
  })

void app.listen(Number(process.env.PORT || 3002))

declare module 'spiceflow/react' {
  interface SpiceflowRegister { app: typeof app }
}
