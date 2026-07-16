import { Spiceflow } from 'spiceflow'
import { cors } from 'spiceflow/cors'
import { Chart } from './chart'
import { Counter } from './counter'
import { encodeFederationPayload } from 'spiceflow/federation'

// Minimal ESM module served as text/javascript for testing RenderFederatedPayload
// with plain JS files (e.g. esm.sh, Framer components).
const esmModuleSource = `
import { jsx } from "react/jsx-runtime";
export default function EsmGreeting(props) {
  return jsx("div", { "data-testid": "esm-greeting", children: "Hello from ESM: " + (props.name || "world") });
}
`

export const app = new Spiceflow()
  .use(cors({ origin: '*' }))
  .get('/api/esm-component.js', () => {
    return new Response(esmModuleSource, {
      headers: {
        'content-type': 'text/javascript',
        'access-control-allow-origin': '*',
      },
    })
  })
  .get('/api/chart', async ({ request }) => {
    const url = new URL(request.url)
    let props: Record<string, unknown> = {}
	try {
	  props = JSON.parse(url.searchParams.get('props') || '{}')
	} catch {
	  // invalid JSON, use empty props
	}

	return await encodeFederationPayload(<Chart {...props} />)
  })

  .get('/api/chat', async ({ request }) => {
    const url = new URL(request.url)
    const message = url.searchParams.get('message') || 'hello'

    // Simulate an AI chat response as a streaming async generator.
    // Client components discovered mid-stream are announced via incremental
    // `modules` SSE events, so streamed JSX can freely mix server-rendered
    // content and interactive client components (like the Counter below).
    async function* generateParts() {
      const responses = [
        `I received your message: "${message}"`,
        'Let me think about that for a moment...',
        'Here is my detailed answer with **formatting**.',
      ]

      for (let i = 0; i < responses.length; i++) {
        await new Promise((resolve) => setTimeout(resolve, 100))
        yield {
          type: 'text' as const,
          content: (
            <div data-testid={`chat-part-${i}`} style={{
              padding: '12px 16px',
              borderRadius: '12px',
              background: '#f0f4ff',
              border: '1px solid #c7d2fe',
              margin: '4px 0',
              fontFamily: 'system-ui, sans-serif',
            }}>
              {responses[i]}
            </div>
          ),
        }
      }

      // Interactive client component streamed mid-payload — its module is
      // only discovered here, after the metadata event was already sent.
      await new Promise((resolve) => setTimeout(resolve, 100))
      yield {
        type: 'text' as const,
        content: (
          <div data-testid="chat-part-counter">
            <Counter label="Streamed" />
          </div>
        ),
      }
    }

    return await encodeFederationPayload({ stream: generateParts() })
  })

  // Hand-crafted broken payload: the client module points at a chunk that
  // does not exist. Used by the host e2e suite to verify that a broken
  // federation payload degrades to the static SSR HTML instead of crashing
  // the host page.
  .get('/api/broken', async () => {
    const metadata = {
      remoteId: 'r_broken_fixture',
      clientModules: {
        deadbeef1234: { chunks: ['/assets/does-not-exist-abc.js'], css: [] },
      },
      cssLinks: [],
    }
    const ssrHtml =
      '<div data-testid="broken-ssr">static fallback content</div>'
    const flight =
      '1:I["deadbeef1234",[],"Broken",1]\n' +
      '0:["$","div",null,{"data-testid":"broken-root","children":["$","$L1",null,{}]}]\n'
    const body = [
      `event: metadata\ndata: ${JSON.stringify(metadata)}\n`,
      `event: ssr\ndata: ${JSON.stringify({ html: ssrHtml })}\n`,
      `event: flight\ndata: ${JSON.stringify(flight)}\n`,
      'event: done\ndata: \n',
    ].join('\n')
    return new Response(body, {
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        'access-control-allow-origin': '*',
      },
    })
  })

void app.listen(Number(process.env.PORT || 3001))

declare module 'spiceflow/react' {
  interface SpiceflowRegister { app: typeof app }
}
