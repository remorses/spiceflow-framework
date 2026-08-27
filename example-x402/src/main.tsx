// Spiceflow + x402 example.
//
// Shape:
//   app (root)
//   ├── serveStatic('/public')
//   ├── layout '/*'     — RSC layout
//   ├── page   '/'      — RSC page with a <PaidData /> client component
//   └── use(paidApp)
//       paidApp (sub-app)
//       ├── use(x402({...}))  ← only applies to routes on paidApp
//       └── get '/paid' → () => ({ foo: 'bar' })
//
// Request flow:
//   GET /       → rootApp.page('/'), no x402 middleware in chain, renders HTML
//   GET /paid   → paidApp.get('/paid'), x402 middleware enforces payment
import './globals.css'
import { Spiceflow, serveStatic } from 'spiceflow'
import { Head, Link } from 'spiceflow/react'
import Stripe from 'stripe'
import { x402, stripeDepositAddress } from './x402-middleware.js'
import { PaidData } from './paid-data.js'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? 'sk_test_placeholder')

// Sub-app that owns every x402-protected route. Middleware registered on
// paidApp only runs for routes defined on paidApp (see
// getAppsInScope in spiceflow.tsx), so `/` below is untouched.
export const paidApp = new Spiceflow()
  .use(
    x402({
      price: '$0.01',
      network: 'eip155:84532', // Base Sepolia
      facilitatorUrl:
        process.env.FACILITATOR_URL ?? 'https://www.x402.org/facilitator',
      payTo: stripeDepositAddress({ stripe, network: 'base' }),
    }),
  )
  .get('/paid', () => ({ foo: 'bar' }))

export const app = new Spiceflow()
  .use(serveStatic({ root: './public' }))
  .use(paidApp)
  .layout('/*', ({ children }) => (
    <RootLayout>{children}</RootLayout>
  ))
  .page('/', function Home() {
    return (
      <main className="flex flex-col gap-6 p-8 max-w-2xl mx-auto">
        <h1 className="text-3xl font-bold">x402 + spiceflow</h1>
        <p className="text-gray-700 dark:text-gray-300">
          <code className="font-mono">/paid</code> is protected by the x402
          payment protocol. Each call costs <strong>$0.01</strong>, settled on
          Base Sepolia, with a fresh deposit address minted via Stripe.
        </p>
        <PaidData />
        <div className="flex flex-col gap-2 text-sm text-gray-600 dark:text-gray-400">
          <p>
            Hit it directly to see the 402 challenge:{' '}
            <Link href="/paid" className="underline">
              /paid
            </Link>
          </p>
          <p>
            Or from a shell:{' '}
            <code className="font-mono">curl -i http://localhost:3000/paid</code>
          </p>
        </div>
      </main>
    )
  })

function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <Head>
        <Head.Title>x402 + spiceflow</Head.Title>
      </Head>
      <body>{children}</body>
    </html>
  )
}

void app.listen(Number(process.env.PORT || 3000))

declare module 'spiceflow/react' {
  interface SpiceflowRegister { app: typeof app }
}
