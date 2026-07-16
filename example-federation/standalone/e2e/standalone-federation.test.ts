import { expect, test } from '@playwright/test'

const standalonePort = 3053
const remotePort = 3051
const baseURL = `http://localhost:${standalonePort}`
const remoteURL = `http://localhost:${remotePort}`

// Federation decode loads remote chunks via dynamic import which takes a few
// seconds on first load (cold cache). Use generous timeouts.
const DECODE_TIMEOUT = 30_000

test.describe('standalone federation consumer', () => {
  test('loads and renders remote chart with interactive client component', async ({ page }) => {
    await page.goto('/')

    await page.getByTestId('load-chart').click()

    const chart = page.getByTestId('remote-chart')
    await expect(chart).toBeVisible({ timeout: DECODE_TIMEOUT })

    await expect(chart).toContainText('Chart: default')
    await expect(chart).toContainText('Point 1: 10')

    // Verify client component rendered and is interactive
    const counter = page.getByTestId('remote-counter')
    await expect(counter).toBeVisible()
    await expect(counter).toContainText('counter: 0')

    await counter.getByRole('button', { name: '+' }).click()
    await expect(counter).toContainText('counter: 1')

    await counter.getByRole('button', { name: '+' }).click()
    await expect(counter).toContainText('counter: 2')
  })

  test('streams chat messages via async generator federation', async ({ page }) => {
    await page.goto('/')

    await page.getByTestId('chat-input').fill('test message')
    await page.getByTestId('chat-submit').click()

    await expect(page.getByTestId('message-user')).toContainText('test message')

    // Wait for all 3 streamed parts to appear
    await expect(page.getByTestId('chat-part-0')).toBeVisible({ timeout: DECODE_TIMEOUT })
    await expect(page.getByTestId('chat-part-1')).toBeVisible({ timeout: DECODE_TIMEOUT })
    await expect(page.getByTestId('chat-part-2')).toBeVisible({ timeout: DECODE_TIMEOUT })

    await expect(page.getByTestId('chat-part-0')).toContainText('I received your message: "test message"')
    await expect(page.getByTestId('chat-part-1')).toContainText('Let me think about that')
    await expect(page.getByTestId('chat-part-2')).toContainText('detailed answer')
  })

  test('streamed client component hydrates and is interactive', async ({ page }) => {
    // The counter part is streamed AFTER the metadata event — its client
    // module is announced via an incremental `modules` SSE event. This is
    // the regression test for "Module not found in remote registry" when
    // client references are discovered mid-stream (holocron chat shape).
    const pageErrors: string[] = []
    page.on('pageerror', (err) => pageErrors.push(err.message))

    await page.goto('/')

    await page.getByTestId('chat-input').fill('counter please')
    await page.getByTestId('chat-submit').click()

    const counterPart = page.getByTestId('chat-part-counter')
    await expect(counterPart).toBeVisible({ timeout: DECODE_TIMEOUT })

    const counter = counterPart.getByTestId('remote-counter')
    await expect(counter).toBeVisible()
    await expect(counter).toContainText('Streamed counter: 0')

    await counter.getByRole('button', { name: '+' }).click()
    await expect(counter).toContainText('Streamed counter: 1')

    expect(pageErrors).toEqual([])
  })

  test('remote CSS is injected into document', async ({ page }) => {
    await page.goto('/')

    await page.getByTestId('load-chart').click()

    const counter = page.getByTestId('remote-counter')
    await expect(counter).toBeVisible({ timeout: DECODE_TIMEOUT })

    // Verify a <link rel="stylesheet"> pointing to the remote origin exists in <head>
    const remoteCssLinks = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('link[rel="stylesheet"]'))
      return links
        .map((l) => l.getAttribute('href') || '')
        .filter((href) => href.includes('localhost:3051'))
    })
    expect(remoteCssLinks.length).toBeGreaterThan(0)

    // Wait for remote CSS to load and apply (#3b82f6 = rgb(59, 130, 246))
    await expect
      .poll(
        () => counter.evaluate((el) => getComputedStyle(el).borderColor),
        { timeout: 5000 },
      )
      .toBe('rgb(59, 130, 246)')

    // Verify border-radius from counter.css (8px)
    const borderRadius = await counter.evaluate(
      (el) => getComputedStyle(el).borderRadius,
    )
    expect(borderRadius).toBe('8px')

    // Verify button background from counter.css (#3b82f6)
    const btnBg = await counter
      .getByRole('button', { name: '+' })
      .evaluate((el) => getComputedStyle(el).backgroundColor)
    expect(btnBg).toBe('rgb(59, 130, 246)')
  })

  test('shadow DOM: CSS is inside shadow root, not in document.head', async ({ page }) => {
    await page.goto('/')

    await page.getByTestId('load-shadow-chart').click()

    // Wait for the shadow DOM mount to contain the remote chart
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const host = document.querySelector('[data-testid="shadow-chart-host"]')
            if (!host) return 'no host'
            if (!host.shadowRoot) return 'no shadow'
            const mount = host.shadowRoot.querySelector('[data-mount]')
            if (!mount) return 'no mount'
            const chart = mount.querySelector('[data-testid="remote-chart"]')
            return chart ? 'ready' : 'no chart'
          }),
        { timeout: DECODE_TIMEOUT },
      )
      .toBe('ready')

    // Verify CSS links are inside the shadow root
    const shadowCssLinks = await page.evaluate(() => {
      const host = document.querySelector('[data-testid="shadow-chart-host"]')
      const shadow = host?.shadowRoot
      if (!shadow) return []
      return Array.from(shadow.querySelectorAll('link[rel="stylesheet"]')).map(
        (l) => l.getAttribute('href') || '',
      )
    })
    expect(shadowCssLinks.length).toBeGreaterThan(0)
    expect(shadowCssLinks.some((href) => href.includes('localhost:3051'))).toBe(true)

    // Verify CSS links are NOT in document.head for the shadow chart
    // (the normal chart test above may have injected its own links, so
    // we only check that shadow CSS injection didn't also add to head)
    const headCssAfterShadow = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('head link[rel="stylesheet"]'))
      return links
        .map((l) => l.getAttribute('href') || '')
        .filter((href) => href.includes('localhost:3051'))
    })
    // Since we haven't clicked "Load Remote Chart" (only shadow), head should have 0 remote links
    expect(headCssAfterShadow.length).toBe(0)

    // Verify computed styles are applied inside the shadow DOM
    const borderColor = await page.evaluate(() => {
      const host = document.querySelector('[data-testid="shadow-chart-host"]')
      const counter = host?.shadowRoot
        ?.querySelector('[data-mount]')
        ?.querySelector('[data-testid="remote-counter"]')
      if (!counter) return ''
      return getComputedStyle(counter).borderColor
    })
    expect(borderColor).toBe('rgb(59, 130, 246)')

    const borderRadius = await page.evaluate(() => {
      const host = document.querySelector('[data-testid="shadow-chart-host"]')
      const counter = host?.shadowRoot
        ?.querySelector('[data-mount]')
        ?.querySelector('[data-testid="remote-counter"]')
      if (!counter) return ''
      return getComputedStyle(counter).borderRadius
    })
    expect(borderRadius).toBe('8px')
  })

  test('shadow DOM: host page styles do not affect shadow content', async ({ page }) => {
    await page.goto('/')

    // Inject a hostile global style that would break counter styling
    await page.evaluate(() => {
      const style = document.createElement('style')
      style.textContent = `
        [data-testid="remote-counter"] {
          border-color: red !important;
          border-radius: 0 !important;
        }
      `
      document.head.appendChild(style)
    })

    await page.getByTestId('load-shadow-chart').click()

    // Wait for chart to render in shadow DOM
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const host = document.querySelector('[data-testid="shadow-chart-host"]')
            if (!host?.shadowRoot) return 'no shadow'
            return host.shadowRoot.querySelector('[data-testid="remote-counter"]')
              ? 'ready'
              : 'no counter'
          }),
        { timeout: DECODE_TIMEOUT },
      )
      .toBe('ready')

    // The hostile global style should NOT penetrate the shadow boundary
    const borderColor = await page.evaluate(() => {
      const host = document.querySelector('[data-testid="shadow-chart-host"]')
      const counter = host?.shadowRoot
        ?.querySelector('[data-mount]')
        ?.querySelector('[data-testid="remote-counter"]')
      if (!counter) return ''
      return getComputedStyle(counter).borderColor
    })
    // Should still be the original blue, not red
    expect(borderColor).toBe('rgb(59, 130, 246)')
  })

  test('shadow DOM: client component hydrates and is interactive', async ({ page }) => {
    await page.goto('/')

    await page.getByTestId('load-shadow-chart').click()

    // Wait for counter inside shadow DOM
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const host = document.querySelector('[data-testid="shadow-chart-host"]')
            const counter = host?.shadowRoot
              ?.querySelector('[data-mount]')
              ?.querySelector('[data-testid="remote-counter"]')
            return counter?.textContent?.includes('counter: 0') ?? false
          }),
        { timeout: DECODE_TIMEOUT },
      )
      .toBe(true)

    // Click + button inside shadow DOM
    await page.evaluate(() => {
      const host = document.querySelector('[data-testid="shadow-chart-host"]')
      const btn = host?.shadowRoot
        ?.querySelector('[data-mount]')
        ?.querySelector('[data-testid="remote-counter"] button')
      if (btn instanceof HTMLElement) btn.click()
    })

    await expect
      .poll(() =>
        page.evaluate(() => {
          const host = document.querySelector('[data-testid="shadow-chart-host"]')
          const counter = host?.shadowRoot
            ?.querySelector('[data-mount]')
            ?.querySelector('[data-testid="remote-counter"]')
          return counter?.textContent ?? ''
        }),
      )
      .toContain('counter: 1')
  })

  test('no React errors in console', async ({ page }) => {
    const errors: string[] = []
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        errors.push(msg.text())
      }
    })

    await page.goto('/')

    await page.getByTestId('load-chart').click()
    await expect(page.getByTestId('remote-chart')).toBeVisible({ timeout: DECODE_TIMEOUT })

    const realErrors = errors.filter(
      (e) => !e.includes('favicon.ico') && !e.includes('the server responded with a status of'),
    )
    expect(realErrors).toEqual([])
  })
})
