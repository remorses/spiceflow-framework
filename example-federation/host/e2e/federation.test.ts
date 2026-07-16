import { expect, test } from '@playwright/test'

const hostPort = 3052
const remotePort = 3051
const baseURL = `http://localhost:${hostPort}`
const remoteURL = `http://localhost:${remotePort}`

interface FederationPayloadMetadata {
  remoteId: string
  clientModules: Record<string, { chunks: string[]; css: string[] }>
  cssLinks: string[]
}

declare global {
  interface Window {
    __spiceflow_createFromReadableStream?: unknown
  }
}

// Parse an SSE response body into typed events.
// Returns { metadata, ssrHtml, flightRows } for easy assertions.
async function parseFederationSSE(response: Response) {
  const text = await response.text()
  const events: { event: string; data: string }[] = []

  // Split on double-newline to get individual SSE events
  for (const block of text.split('\n\n')) {
    const trimmed = block.trim()
    if (!trimmed) continue
    let event = ''
    let data = ''
    for (const line of trimmed.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice(7)
      else if (line.startsWith('data: ')) data = line.slice(6)
      else if (line === 'data:') data = ''
    }
    if (event) events.push({ event, data })
  }

  const metadataEvent = events.find((e) => e.event === 'metadata')
  const ssrEvent = events.find((e) => e.event === 'ssr')
  const flightEvents = events.filter((e) => e.event === 'flight')

  const metadata: FederationPayloadMetadata = metadataEvent
    ? JSON.parse(metadataEvent.data)
    : { remoteId: '', clientModules: {}, cssLinks: [] }
  const ssrHtml = ssrEvent ? JSON.parse(ssrEvent.data).html : ''
  const flightRows = flightEvents.flatMap((e) => {
    const chunk: string = JSON.parse(e.data)
    return chunk.split('\n').filter(Boolean)
  })

  return { metadata, ssrHtml, flightRows }
}

async function fetchWithRetry({
  url,
  retries = 3,
  delayMs = 200,
}: {
  url: string
  retries?: number
  delayMs?: number
}) {
  let lastError: unknown

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await fetch(url)
    } catch (error) {
      lastError = error
    }

    if (attempt === retries - 1) break
    await new Promise((resolve) => setTimeout(resolve, delayMs))
  }

  throw lastError
}

test.describe('federation', () => {
  test('remote API returns SSE with flight payload and client modules', async () => {
    const propsParam = encodeURIComponent(JSON.stringify({ dataSource: 'revenue' }))
    const response = await fetchWithRetry({
      url: `${remoteURL}/api/chart?props=${propsParam}`,
    })
    expect(response.ok).toBe(true)
    expect(response.headers.get('content-type')).toContain('text/event-stream')

    const { metadata, ssrHtml, flightRows } = await parseFederationSSE(response)

    expect(metadata.remoteId).toBeTruthy()
    expect(metadata.clientModules).toBeTruthy()

    const flightPayload = flightRows.join('\n')
    expect(flightPayload).toContain('remote-chart')
    expect(flightPayload).toContain('Counter')

    // ssrHtml contains pre-rendered HTML for the component
    expect(ssrHtml).toContain('data-testid="remote-chart"')
    expect(ssrHtml).toContain('revenue')
    expect(ssrHtml).toContain('data-testid="remote-counter"')
    expect(ssrHtml).toContain('counter:')

    // Encode drops client entry + framework; ships portable group chunks only.
    expect(Object.keys(metadata.clientModules).length).toBeGreaterThan(0)
    for (const info of Object.values(metadata.clientModules)) {
      expect(info.chunks.length).toBeGreaterThan(0)
      for (const chunk of info.chunks) {
        expect(chunk).not.toContain('spiceflow-framework')
        expect(chunk).not.toMatch(/(?:^|\/)index-[^/?#]+\.js(?:[?#]|$)/)
      }
    }

    // CSS links are included in the payload
    expect(metadata.cssLinks).toBeTruthy()
    expect(metadata.cssLinks.length).toBeGreaterThan(0)
    for (const cssLink of metadata.cssLinks) {
      expect(cssLink).toContain(remoteURL)
      expect(cssLink).toMatch(/\.css$/)
    }

    // clientModules entries include css arrays
    const modulesWithCss = Object.values(metadata.clientModules).filter(
      (info: any) => info.css && info.css.length > 0,
    )
    expect(modulesWithCss.length).toBeGreaterThan(0)
  })

  test('remote component is SSR-rendered in the host HTML', async () => {
    const response = await fetch(`${baseURL}/`)
    expect(response.ok).toBe(true)
    const html = await response.text()

    // Strip <script> tags so we only check visible HTML, not Flight payload
    // data embedded in inline scripts.
    const visible = html.replace(/<script[\s\S]*?<\/script>/gi, '')

    expect(visible).toContain('Federation Host App')
    expect(visible).toContain('data-remote-id')

    // Remote server component data is SSR-rendered as visible HTML
    expect(visible).toContain('data-testid="remote-chart"')
    expect(visible).toContain('revenue')
    expect(visible).toContain('Point')

    // Remote client component (Counter) initial state is SSR-rendered
    expect(visible).toContain('data-testid="remote-counter"')
    expect(visible).toContain('counter:')
  })

  test('remote CSS is injected in host HTML via preinit', async () => {
    const response = await fetch(`${baseURL}/`)
    const html = await response.text()

    // ReactDOM.preinit emits <link rel="stylesheet"> tags with the
    // remote's absolute CSS URL in the host HTML.
    const cssLinkRegex = new RegExp(
      `<link[^>]*rel="stylesheet"[^>]*href="${remoteURL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^"]*\\.css"`,
    )
    expect(html).toMatch(cssLinkRegex)
  })

  test('remote chunk URLs are absolute (use remote base)', async () => {
    const propsParam = encodeURIComponent(JSON.stringify({ dataSource: 'revenue' }))
    const response = await fetchWithRetry({
      url: `${remoteURL}/api/chart?props=${propsParam}`,
    })
    const { metadata } = await parseFederationSSE(response)

    // JS chunk paths should be absolute with remote origin
    for (const info of Object.values(metadata.clientModules)) {
      for (const chunk of info.chunks) {
        expect(chunk).toMatch(/^https?:\/\//)
        expect(chunk).toContain(remoteURL)
      }
    }
  })

  test('remote client component hydrates and is interactive', async ({
    page,
  }) => {
    await page.goto('/')
    const section = page.getByTestId('remote-section')
    const counter = section.getByTestId('remote-counter')
    await expect(counter).toBeVisible({ timeout: 10000 })
    await expect(counter.getByText('counter: 0')).toBeVisible()
    await expect(counter.getByTestId('remote-form-status')).toHaveText(
      'form: idle',
    )

    // Wait for hydration — the button must respond to clicks. In dev mode,
    // remount after hydration can briefly detach elements.
    await expect(async () => {
      await counter.getByRole('button', { name: '+' }).click()
      await expect(counter.getByText('counter: 1')).toBeVisible()
    }).toPass({ timeout: 10000 })

    await counter.getByRole('button', { name: '+' }).click()
    await expect(counter.getByText('counter: 2')).toBeVisible()

    await counter.getByRole('button', { name: '-' }).click()
    await expect(counter.getByText('counter: 1')).toBeVisible()
  })

  test('remote component reads host router URL', async ({ page }) => {
    await page.goto('/')
    const section = page.getByTestId('remote-section')
    const remoteUrl = section.getByTestId('remote-url')
    await expect(remoteUrl).toBeVisible({ timeout: 10000 })
    await expect(remoteUrl).toHaveText('url: /')
  })

  test('host preloads its shared import map providers', async () => {
    const response = await fetch(`${baseURL}/`)
    const html = await response.text()

    const importMapJson = html.match(
      /<script type="importmap">([\s\S]+?)<\/script>/,
    )?.[1]
    if (!importMapJson) throw new Error('Import map was not injected')

    const importMap: Record<string, string> = JSON.parse(importMapJson).imports
    const sharedUrls = [
      ...new Set(
        Object.values(importMap).filter((url) =>
          url.includes('/federation-shared/'),
        ),
      ),
    ]
    const preloadUrls = [
      ...html.matchAll(
        /<link rel="modulepreload" href="([^"]*\/federation-shared\/[^"]+)">/g,
      ),
    ].map((match) => match[1])

    expect(preloadUrls).toEqual(sharedUrls)
    expect(importMap).toHaveProperty('spiceflow/react')
  })

  test('host loads one Spiceflow client runtime', async ({ page }) => {
    test.skip(
      !process.env.E2E_START,
      'externalizeShared runtime ownership is a production build invariant',
    )
    await page.goto('/')
    await expect(page.getByTestId('remote-section')).toBeVisible()

    const loadCount = await page.evaluate(() =>
      Reflect.get(globalThis, '__SPICEFLOW_CLIENT_LOAD_COUNT__'),
    )
    expect(loadCount).toBe(1)
  })

  test('no React errors during hydration', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (err) => errors.push(err.message))

    await page.goto('/')
    const section = page.getByTestId('remote-section')
    await expect(section.getByTestId('remote-counter')).toBeVisible({
      timeout: 10000,
    })

    expect(errors).toEqual([])
  })

  test('isolateStyles: SSR HTML contains declarative shadow DOM template', async () => {
    const response = await fetch(`${baseURL}/`)
    const html = await response.text()

    // The isolated remote section should contain a DSD template
    expect(html).toContain('data-isolate-styles')
    expect(html).toContain('<template shadowrootmode="open">')
    expect(html).toContain('data-mount')
    // SSR content should be inside the DSD template
    expect(html).toContain('isolated')
  })

  test('isolateStyles: isolated CSS is inside shadow root, not leaked to document.head', async ({
    page,
  }) => {
    // Use the /isolated-nav page which ONLY has an isolated component —
    // no non-isolated component to add CSS to document.head via preinit.
    await page.goto('/isolated-nav')
    await page.waitForSelector('[data-isolate-styles]', { timeout: 10000 })

    // Wait for shadow root to have CSS links
    await page.waitForFunction(() => {
      const host = document.querySelector('[data-isolate-styles]')
      return host?.shadowRoot?.querySelector('link[rel="stylesheet"]') !== null
    }, undefined, { timeout: 10000 })

    const { headCssHrefs, shadowCssHrefs } = await page.evaluate(() => {
      const headLinks = Array.from(
        document.head.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'),
        (l) => l.href,
      ).filter(Boolean)

      const host = document.querySelector('[data-isolate-styles]')!
      const shadowLinks = Array.from(
        host.shadowRoot!.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'),
        (l) => l.href,
      ).filter(Boolean)

      return { headCssHrefs: headLinks, shadowCssHrefs: shadowLinks }
    })

    // Shadow root should have remote CSS links
    expect(shadowCssHrefs.length).toBeGreaterThan(0)
    expect(shadowCssHrefs[0]).toContain('localhost:3051')

    // Remote CSS should NOT be in document.head (only in shadow root)
    const remoteCssInHead = headCssHrefs.filter((h) => h.includes('localhost:3051'))
    expect(remoteCssInHead).toEqual([])
  })

  test('isolateStyles: shadow root contains CSS links and content', async ({
    page,
  }) => {
    await page.goto('/')

    // Wait for the isolated component to hydrate
    const shadowHost = page.locator('[data-isolate-styles]')
    await expect(shadowHost).toBeVisible({ timeout: 10000 })

    // Check shadow root has CSS links
    const shadowCssLinks = await shadowHost.evaluate((el) => {
      const shadow = el.shadowRoot
      if (!shadow) return []
      return Array.from(shadow.querySelectorAll('link[rel="stylesheet"]'))
        .map((l) => l.getAttribute('href'))
        .filter(Boolean)
    })
    expect(shadowCssLinks.length).toBeGreaterThan(0)
    expect(shadowCssLinks[0]).toContain('localhost:3051')

    // Check shadow root has the mount point with content
    const hasMountContent = await shadowHost.evaluate((el) => {
      const shadow = el.shadowRoot
      if (!shadow) return false
      const mount = shadow.querySelector('[data-mount]')
      return mount !== null && mount.hasChildNodes()
    })
    expect(hasMountContent).toBe(true)
  })

  test('isolateStyles: remote client component hydrates inside shadow DOM', async ({
    page,
  }) => {
    await page.goto('/')

    const shadowHost = page.locator('[data-isolate-styles]')
    await expect(shadowHost).toBeVisible({ timeout: 10000 })

    // Wait for hydration — counter should be interactive inside shadow root
    await page.waitForFunction(() => {
      const host = document.querySelector('[data-isolate-styles]')
      if (!host?.shadowRoot) return false
      const counter = host.shadowRoot.querySelector('[data-testid="remote-counter"]')
      return counter !== null
    }, undefined, { timeout: 10000 })

    // Click the + button inside shadow DOM and verify state changes
    const counterText = await shadowHost.evaluate((el) => {
      const shadow = el.shadowRoot!
      const counter = shadow.querySelector('[data-testid="remote-counter"]')
      return counter?.textContent
    })
    expect(counterText).toContain('counter:')

    // Click + button and verify counter incremented. Wrapped in toPass to
    // retry through hydration remount in dev mode.
    await expect(async () => {
      await shadowHost.evaluate((el) => {
        const shadow = el.shadowRoot!
        const btn = shadow.querySelector<HTMLButtonElement>(
          '[data-testid="remote-counter"] button',
        )
        if (btn) btn.click()
      })
      const text = await shadowHost.evaluate((el) => {
        const counter = el.shadowRoot?.querySelector('[data-testid="remote-counter"]')
        return counter?.textContent || ''
      })
      expect(text).toContain('counter: 1')
    }).toPass({ timeout: 10000 })
  })

  test('isolateStyles: host styles do not affect shadow DOM content', async ({
    page,
  }) => {
    await page.goto('/')

    const shadowHost = page.locator('[data-isolate-styles]')
    await expect(shadowHost).toBeVisible({ timeout: 10000 })

    // Wait for content inside shadow
    await page.waitForFunction(() => {
      const host = document.querySelector('[data-isolate-styles]')
      return host?.shadowRoot?.querySelector('[data-testid="remote-chart"]') !== null
    }, undefined, { timeout: 10000 })

    // Inject a hostile global style that would hide the remote chart
    await page.evaluate(() => {
      const style = document.createElement('style')
      style.textContent = '[data-testid="remote-chart"] { display: none !important; }'
      document.head.appendChild(style)
    })

    // The chart inside shadow DOM should still have normal display
    const isVisible = await shadowHost.evaluate((el) => {
      const shadow = el.shadowRoot!
      const chart = shadow.querySelector('[data-testid="remote-chart"]')
      if (!chart) return false
      const style = getComputedStyle(chart)
      return style.display !== 'none'
    })
    expect(isVisible).toBe(true)
  })

  test('isolateStyles: no React errors during hydration', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (err) => errors.push(err.message))

    await page.goto('/')

    // Wait for isolated component to hydrate
    await page.waitForFunction(() => {
      const host = document.querySelector('[data-isolate-styles]')
      return host?.shadowRoot?.querySelector('[data-testid="remote-counter"]') !== null
    }, undefined, { timeout: 10000 })

    expect(errors).toEqual([])
  })

  test('client-nav: isolated remote renders after navigating from page without remotes', async ({
    page,
  }) => {
    const errors: string[] = []
    page.on('pageerror', (err) => errors.push(err.message))

    // Start on a page with no remote components at all
    await page.goto('/no-remote')
    await expect(page.getByTestId('no-remote-title')).toBeVisible({ timeout: 10000 })
    await page.waitForFunction(
      () => typeof window.__spiceflow_createFromReadableStream === 'function',
      undefined,
      { timeout: 10000 },
    )

    // Navigate client-side to a page with an isolated remote component.
    // DSD won't fire here — the template is set via RSC payload, not initial HTML parse.
    // This exercises the imperative attachShadow() fallback path.
    await page.click('[data-testid="nav-to-isolated"]')
    await expect(page).toHaveURL(`${baseURL}/isolated-nav`, { timeout: 10000 })

    // Wait for shadow root with content
    await page.waitForFunction(() => {
      const host = document.querySelector('[data-isolate-styles]')
      if (!host?.shadowRoot) return false
      return host.shadowRoot.querySelector('[data-testid="remote-counter"]') !== null
    }, undefined, { timeout: 15000 })

    // CSS links should be inside shadow root
    const shadowCssCount = await page.evaluate(() => {
      const host = document.querySelector('[data-isolate-styles]')!
      return host.shadowRoot!.querySelectorAll('link[rel="stylesheet"]').length
    })
    expect(shadowCssCount).toBeGreaterThan(0)

    // Counter should be interactive — retry through hydration remount
    await expect(async () => {
      await page.evaluate(() => {
        const host = document.querySelector('[data-isolate-styles]')!
        const btn = host.shadowRoot!.querySelector<HTMLButtonElement>(
          '[data-testid="remote-counter"] button',
        )
        if (btn) btn.click()
      })
      const text = await page.evaluate(() => {
        const host = document.querySelector('[data-isolate-styles]')
        const counter = host?.shadowRoot?.querySelector('[data-testid="remote-counter"]')
        return counter?.textContent || ''
      })
      expect(text).toContain('counter: 1')
    }).toPass({ timeout: 10000 })

    expect(errors).toEqual([])
  })

  test('client-nav: non-isolated remote renders after navigating from page without remotes', async ({
    page,
  }) => {
    const errors: string[] = []
    page.on('pageerror', (err) => errors.push(err.message))

    // Start on a page with no remote components
    await page.goto('/no-remote')
    await expect(page.getByTestId('no-remote-title')).toBeVisible({ timeout: 10000 })
    await page.waitForFunction(
      () => typeof window.__spiceflow_createFromReadableStream === 'function',
      undefined,
      { timeout: 10000 },
    )

    // Navigate to a page with a plain (non-isolated) remote component
    await page.click('[data-testid="nav-to-plain"]')

    // Wait for the remote counter to appear in the regular DOM.
    // Client navigation triggers a server-side fetch to the remote — can be
    // slow under load from prior tests, so use a generous timeout.
    const section = page.getByTestId('nav-plain-section')
    await expect(section.getByTestId('remote-counter')).toBeVisible({ timeout: 30000 })
    await expect(section.getByText('counter: 0')).toBeVisible()

    // Counter should be interactive — retry through hydration remount
    await expect(async () => {
      await section.getByRole('button', { name: '+' }).click()
      await expect(section.getByText('counter: 1')).toBeVisible()
    }).toPass({ timeout: 10000 })

    expect(errors).toEqual([])
  })

  test('client-nav: isolated remote CSS does not leak to head after navigation', async ({
    page,
  }) => {
    // Start on a page with no remotes — document.head has no remote CSS
    await page.goto('/no-remote')
    await expect(page.getByTestId('no-remote-title')).toBeVisible({ timeout: 10000 })
    await page.waitForFunction(
      () => typeof window.__spiceflow_createFromReadableStream === 'function',
      undefined,
      { timeout: 10000 },
    )

    // Navigate to isolated remote page
    await page.click('[data-testid="nav-to-isolated"]')
    await expect(page).toHaveURL(`${baseURL}/isolated-nav`, { timeout: 10000 })

    // Wait for shadow root with content
    await page.waitForFunction(() => {
      const host = document.querySelector('[data-isolate-styles]')
      if (!host?.shadowRoot) return false
      return host.shadowRoot.querySelector('[data-testid="remote-counter"]') !== null
    }, undefined, { timeout: 15000 })

    // Remote CSS should be inside shadow root only, not in document.head
    const { headRemoteCss, shadowCss } = await page.evaluate(() => {
      const headLinks = Array.from(
        document.head.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'),
        (l) => l.href,
      ).filter((h) => h.includes('localhost:3051'))

      const host = document.querySelector('[data-isolate-styles]')!
      const shadowLinks = Array.from(
        host.shadowRoot!.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'),
        (l) => l.href,
      ).filter(Boolean)

      return { headRemoteCss: headLinks, shadowCss: shadowLinks }
    })

    expect(shadowCss.length).toBeGreaterThan(0)
    expect(headRemoteCss).toEqual([])
  })

  test('client-nav: navigate away and back preserves isolation', async ({
    page,
  }) => {
    const errors: string[] = []
    page.on('pageerror', (err) => errors.push(err.message))

    // Start on no-remote page
    await page.goto('/no-remote')
    await expect(page.getByTestId('no-remote-title')).toBeVisible({ timeout: 10000 })
    await page.waitForFunction(
      () => typeof window.__spiceflow_createFromReadableStream === 'function',
      undefined,
      { timeout: 10000 },
    )

    // Navigate to isolated remote
    await page.click('[data-testid="nav-to-isolated"]')
    await expect(page).toHaveURL(`${baseURL}/isolated-nav`, { timeout: 10000 })
    await page.waitForFunction(() => {
      const host = document.querySelector('[data-isolate-styles]')
      return host?.shadowRoot?.querySelector('[data-testid="remote-counter"]') !== null
    }, undefined, { timeout: 15000 })

    // Navigate back
    await page.goBack()
    await expect(page.getByTestId('no-remote-title')).toBeVisible({ timeout: 10000 })

    // Navigate to isolated remote again via the no-remote page link
    await page.click('[data-testid="nav-to-isolated"]')
    await expect(page).toHaveURL(`${baseURL}/isolated-nav`, { timeout: 10000 })
    await page.waitForFunction(() => {
      const host = document.querySelector('[data-isolate-styles]')
      return host?.shadowRoot?.querySelector('[data-testid="remote-counter"]') !== null
    }, undefined, { timeout: 15000 })

    // Counter should start fresh (new mount)
    await expect.poll(async () => {
      return page.evaluate(() => {
        const host = document.querySelector('[data-isolate-styles]')
        return host?.shadowRoot?.querySelector('[data-testid="remote-counter"]')?.textContent ?? ''
      })
    }, { timeout: 10000 }).toContain('counter: 0')

    expect(errors).toEqual([])
  })

  test('ESM component endpoint returns JavaScript', async () => {
    const response = await fetchWithRetry({
      url: `${remoteURL}/api/esm-component.js`,
    })
    expect(response.ok).toBe(true)
    const contentType = response.headers.get('content-type') || ''
    expect(contentType).toContain('text/javascript')
    const text = await response.text()
    expect(text).toContain('EsmGreeting')
  })

  test('ESM component renders after hydration', async ({ page }) => {
    await page.goto('/')
    const greeting = page.getByTestId('esm-greeting')
    await expect(greeting).toBeVisible({ timeout: 10000 })
    await expect(greeting).toHaveText('Hello from ESM: world')
  })

  test('local remote component hydrates and is interactive', async ({ page }) => {
    await page.goto('/')
    const counter = page.getByTestId('local-counter')
    await expect(counter).toBeVisible({ timeout: 10000 })
    await expect(counter.getByText('Self-hosted counter: 0')).toBeVisible()

    await expect(async () => {
      await counter.getByRole('button', { name: '+' }).click()
      await expect(counter.getByText('Self-hosted counter: 1')).toBeVisible()
    }).toPass({ timeout: 10000 })
  })

  test('Framer IOKnob renders after hydration', async ({ page }) => {
    await page.goto('/')
    const section = page.getByTestId('framer-section')
    await expect(section).toBeVisible({ timeout: 10000 })

    // Wait for the Framer component to render (not just the heading)
    await expect.poll(async () => {
      return page.evaluate(() => {
        const el = document.querySelector('[data-testid="framer-section"]')
        if (!el) return 0
        return Array.from(el.children).filter((c) => c.tagName !== 'H2').length
      })
    }, { timeout: 15000 }).toBeGreaterThan(0)
  })

  test('flight events are valid Flight format', async () => {
    const propsParam = encodeURIComponent(JSON.stringify({ dataSource: 'test' }))
    const response = await fetchWithRetry({
      url: `${remoteURL}/api/chart?props=${propsParam}`,
    })
    const { flightRows } = await parseFederationSSE(response)
    expect(flightRows.length).toBeGreaterThan(0)

    // Each flight event data should match Flight format: <rowId>:<data>
    for (const row of flightRows) {
      expect(row).toMatch(/^[0-9a-f]*:/)
    }
  })

  test('flight events have client refs and model rows', async () => {
    const propsParam = encodeURIComponent(JSON.stringify({ dataSource: 'test' }))
    const response = await fetchWithRetry({
      url: `${remoteURL}/api/chart?props=${propsParam}`,
    })
    const { flightRows } = await parseFederationSSE(response)

    const clientRefs = flightRows.filter((l) => l.match(/^[0-9a-f]+:I\[/))
    const modelRows = flightRows.filter((l) => l.match(/^[0-9a-f]+:\["\$"/))

    expect(clientRefs.length).toBeGreaterThan(0)
    expect(modelRows.length).toBeGreaterThan(0)
  })

})
