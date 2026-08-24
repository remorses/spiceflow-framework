// Type-level repro for registered app inference when route handlers render client components.
import fs from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vitest'
import ts from 'typescript'

function getDiagnosticsForCircularFixture(appSource?: string) {
  const srcDir = path.dirname(new URL(import.meta.url).pathname)
  const packageDir = path.join(srcDir, '..', '..')
  const fixtureDir = fs.mkdtempSync(path.join(srcDir, '__tmp-register-repro-'))
  const appPath = path.join(fixtureDir, 'app.tsx')
  const componentPath = path.join(fixtureDir, 'project-page.tsx')

  fs.writeFileSync(
    componentPath,
    `
import { Link, router, useLoaderData, useRouterState } from 'spiceflow/react'

export function ProjectPage() {
  const data = useLoaderData('/projects/:projectId')
  const state = useRouterState()
  data.projectId.toUpperCase()
  // @ts-expect-error unknown loader fields stay rejected through the register pattern
  data.missing
  const projectHref = router.href('/projects/:projectId', { projectId: data.projectId })
  const loginHref = router.href('/login')
  // @ts-expect-error invalid router hrefs stay rejected
  router.href('/missing')
  // @ts-expect-error missing params stay rejected
  router.href('/projects/:projectId')
  return (
    <nav>
      <Link href={loginHref}>{state.pathname}</Link>
      <Link href={projectHref}>Project</Link>
      <Link href="/login">Raw login</Link>
      <Link href="/projects/:projectId" params={{ projectId: data.projectId }}>Pattern project</Link>
      {/* @ts-expect-error invalid Link hrefs stay rejected */}
      <Link href="/missing">Missing</Link>
      {/* @ts-expect-error Link params stay checked */}
      <Link href="/projects/:projectId" params={{ slug: data.projectId }}>Bad params</Link>
    </nav>
  )
}
`,
  )

  fs.writeFileSync(
    appPath,
    appSource ?? `
import { Spiceflow } from 'spiceflow'
import { ProjectPage } from './project-page.tsx'
import type { IsAny } from '../../types.ts'

type ProjectLoaderData = { projectId: string }

export const app = new Spiceflow()
  .page('/login', async () => 'login')
  .loader('/projects/:projectId', async ({ params }): Promise<ProjectLoaderData> => ({
    projectId: params.projectId,
  }))
  .page('/projects/:projectId', async () => <ProjectPage />)

type AppMustNotBecomeAny = IsAny<typeof app>
const appMustNotBecomeAny: AppMustNotBecomeAny = false
void appMustNotBecomeAny

declare module 'spiceflow/react' {
  interface SpiceflowRegister { app: typeof app }
}
`,
  )

  try {
    const configFile = ts.readConfigFile(
      path.join(packageDir, 'tsconfig.json'),
      ts.sys.readFile,
    )
    const parsedConfig = ts.parseJsonConfigFileContent(
      configFile.config,
      ts.sys,
      packageDir,
      { noEmit: true },
      path.join(packageDir, 'tsconfig.json'),
    )
    const program = ts.createProgram({
      rootNames: [appPath],
      options: parsedConfig.options,
    })

    return ts
      .getPreEmitDiagnostics(program)
      .filter((diagnostic) => diagnostic.file?.fileName.startsWith(fixtureDir))
      .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
  } finally {
    fs.rmSync(fixtureDir, { recursive: true, force: true })
  }
}

test('registered app type does not make the app initializer circular', () => {
  expect(getDiagnosticsForCircularFixture()).toEqual([])
})

test('router.href inside page handlers does not make the app initializer circular', () => {
  expect(getDiagnosticsForCircularFixture(`
import { Spiceflow } from 'spiceflow'
import { router } from 'spiceflow/react'
import type { IsAny } from '../../types.ts'

export const app = new Spiceflow()
  .page('/login', async () => 'login')
  .page('/dashboard', async () => {
    const href = router.href('/login')
    return <a href={href}>Login</a>
  })

type AppMustNotBecomeAny = IsAny<typeof app>
const appMustNotBecomeAny: AppMustNotBecomeAny = false
void appMustNotBecomeAny

declare module 'spiceflow/react' {
  interface SpiceflowRegister { app: typeof app }
}
`)).toEqual([])
})

test('router.href inside page redirect handlers can still be circular when app metadata includes loaders', () => {
  expect(getDiagnosticsForCircularFixture(`
import { Spiceflow } from 'spiceflow'
import { router } from 'spiceflow/react'
import type { IsAny } from '../../types.ts'

export const app = new Spiceflow()
  .page('/login', async () => 'login')
  .loader('/dashboard', async () => ({ user: { id: '1' } }))
  .page('/dashboard', async ({ redirect }) => {
    const href = router.href('/login')
    return redirect(href)
  })

type AppMustNotBecomeAny = IsAny<typeof app>
const appMustNotBecomeAny: AppMustNotBecomeAny = false
void appMustNotBecomeAny

declare module 'spiceflow/react' {
  interface SpiceflowRegister { app: typeof app }
}
`)).toMatchInlineSnapshot(`
  [
    "Type 'false' is not assignable to type 'true'.",
    "'app' is referenced directly or indirectly in its own type annotation.",
  ]
`)
})

test('router.href inside page handlers with context and loaders does not make the app initializer circular', () => {
  expect(getDiagnosticsForCircularFixture(`
import { Spiceflow } from 'spiceflow'
import { router } from 'spiceflow/react'
import type { IsAny } from '../../types.ts'

export const app = new Spiceflow()
  .page('/login', async () => 'login')
  .loader('/dashboard/:id', async () => ({ user: { id: '1' } }))
  .page('/dashboard/:id', async ({ params }) => {
    const href = router.href('/login')
    return <a href={href}>{params.id}</a>
  })

type AppMustNotBecomeAny = IsAny<typeof app>
const appMustNotBecomeAny: AppMustNotBecomeAny = false
void appMustNotBecomeAny

declare module 'spiceflow/react' {
  interface SpiceflowRegister { app: typeof app }
}
`)).toEqual([])
})

test('router.href inside layout handlers does not make the app initializer circular', () => {
  expect(getDiagnosticsForCircularFixture(`
import { Spiceflow } from 'spiceflow'
import { router } from 'spiceflow/react'
import type { IsAny } from '../../types.ts'

export const app = new Spiceflow()
  .page('/login', async () => 'login')
  .layout('/dashboard/*', async ({ children }) => {
    const href = router.href('/login')
    return <main><a href={href}>Login</a>{children}</main>
  })
  .page('/dashboard', async () => 'dashboard')

type AppMustNotBecomeAny = IsAny<typeof app>
const appMustNotBecomeAny: AppMustNotBecomeAny = false
void appMustNotBecomeAny

declare module 'spiceflow/react' {
  interface SpiceflowRegister { app: typeof app }
}
`)).toEqual([])
})

test('router.href inside loader handlers still makes the app initializer circular', () => {
  expect(getDiagnosticsForCircularFixture(`
import { Spiceflow } from 'spiceflow'
import { router } from 'spiceflow/react'
import type { IsAny } from '../../types.ts'

export const app = new Spiceflow()
  .page('/login', async () => 'login')
  .loader('/dashboard', async () => {
    const href = router.href('/login')
    return { href }
  })
  .page('/dashboard', async () => 'dashboard')

type AppMustNotBecomeAny = IsAny<typeof app>
const appMustNotBecomeAny: AppMustNotBecomeAny = false
void appMustNotBecomeAny

declare module 'spiceflow/react' {
  interface SpiceflowRegister { app: typeof app }
}
`)).toMatchInlineSnapshot(`
  [
    "Type 'false' is not assignable to type 'true'.",
    "'app' is referenced directly or indirectly in its own type annotation.",
  ]
`)
})

test('router.href inside get handlers still makes the app initializer circular', () => {
  expect(getDiagnosticsForCircularFixture(`
import { Spiceflow } from 'spiceflow'
import { router } from 'spiceflow/react'
import type { IsAny } from '../../types.ts'

export const app = new Spiceflow()
  .page('/login', async () => 'login')
  .get('/api/login-url', async () => {
    const href = router.href('/login')
    return { href }
  })

type AppMustNotBecomeAny = IsAny<typeof app>
const appMustNotBecomeAny: AppMustNotBecomeAny = false
void appMustNotBecomeAny

declare module 'spiceflow/react' {
  interface SpiceflowRegister { app: typeof app }
}
`)).toMatchInlineSnapshot(`
  [
    "Type 'false' is not assignable to type 'true'.",
    "'app' is referenced directly or indirectly in its own type annotation.",
  ]
`)
})

test('throw redirect(router.href()) inside get handlers does not make the app circular', () => {
  expect(getDiagnosticsForCircularFixture(`
import { Spiceflow } from 'spiceflow'
import { redirect } from 'spiceflow'
import { router } from 'spiceflow/react'
import type { IsAny } from '../../types.ts'

export const app = new Spiceflow()
  .page('/login', async () => 'login')
  .get('/signup', async () => {
    throw redirect(router.href('/login'))
  })

type AppMustNotBecomeAny = IsAny<typeof app>
const appMustNotBecomeAny: AppMustNotBecomeAny = false
void appMustNotBecomeAny

declare module 'spiceflow/react' {
  interface SpiceflowRegister { app: typeof app }
}
`)).toMatchInlineSnapshot(`[]`)
})

test('throw redirect(router.href()) inside page handler with loaders does not make the app circular', () => {
  expect(getDiagnosticsForCircularFixture(`
import { Spiceflow } from 'spiceflow'
import { redirect } from 'spiceflow'
import { router } from 'spiceflow/react'
import type { IsAny } from '../../types.ts'

export const app = new Spiceflow()
  .page('/login', async () => 'login')
  .loader('/dashboard', async () => ({ user: { id: '1' } }))
  .page('/dashboard', async () => {
    throw redirect(router.href('/login'))
  })

type AppMustNotBecomeAny = IsAny<typeof app>
const appMustNotBecomeAny: AppMustNotBecomeAny = false
void appMustNotBecomeAny

declare module 'spiceflow/react' {
  interface SpiceflowRegister { app: typeof app }
}
`)).toMatchInlineSnapshot(`[]`)
})

test('throw redirect(router.href()) inside post handler does not make the app circular', () => {
  expect(getDiagnosticsForCircularFixture(`
import { Spiceflow } from 'spiceflow'
import { redirect } from 'spiceflow'
import { router } from 'spiceflow/react'
import type { IsAny } from '../../types.ts'

export const app = new Spiceflow()
  .page('/login', async () => 'login')
  .page('/dashboard', async () => 'dashboard')
  .post('/api/logout', async () => {
    throw redirect(router.href('/login'))
  })

type AppMustNotBecomeAny = IsAny<typeof app>
const appMustNotBecomeAny: AppMustNotBecomeAny = false
void appMustNotBecomeAny

declare module 'spiceflow/react' {
  interface SpiceflowRegister { app: typeof app }
}
`)).toMatchInlineSnapshot(`[]`)
})

test('throw redirect(router.href()) inside loader does not make the app circular', () => {
  expect(getDiagnosticsForCircularFixture(`
import { Spiceflow } from 'spiceflow'
import { redirect } from 'spiceflow'
import { router } from 'spiceflow/react'
import type { IsAny } from '../../types.ts'

export const app = new Spiceflow()
  .page('/login', async () => 'login')
  .loader('/dashboard', async () => {
    throw redirect(router.href('/login'))
  })
  .page('/dashboard', async () => 'dashboard')

type AppMustNotBecomeAny = IsAny<typeof app>
const appMustNotBecomeAny: AppMustNotBecomeAny = false
void appMustNotBecomeAny

declare module 'spiceflow/react' {
  interface SpiceflowRegister { app: typeof app }
}
`)).toMatchInlineSnapshot(`[]`)
})

test('conditional throw + return: get handler with throw redirect and data return is still circular', () => {
  expect(getDiagnosticsForCircularFixture(`
import { Spiceflow } from 'spiceflow'
import { redirect } from 'spiceflow'
import { router } from 'spiceflow/react'
import type { IsAny } from '../../types.ts'

export const app = new Spiceflow()
  .page('/login', async () => 'login')
  .get('/api/check', async () => {
    if (Math.random() > 0.5) {
      throw redirect(router.href('/login'))
    }
    return { ok: true, url: router.href('/login') }
  })

type AppMustNotBecomeAny = IsAny<typeof app>
const appMustNotBecomeAny: AppMustNotBecomeAny = false
void appMustNotBecomeAny

declare module 'spiceflow/react' {
  interface SpiceflowRegister { app: typeof app }
}
`)).toMatchInlineSnapshot(`
  [
    "Type 'false' is not assignable to type 'true'.",
    "'app' is referenced directly or indirectly in its own type annotation.",
  ]
`)
})

test('conditional throw + return: get handler with throw redirect and plain data return is safe', () => {
  expect(getDiagnosticsForCircularFixture(`
import { Spiceflow } from 'spiceflow'
import { redirect } from 'spiceflow'
import { router } from 'spiceflow/react'
import type { IsAny } from '../../types.ts'

export const app = new Spiceflow()
  .page('/login', async () => 'login')
  .get('/api/check', async () => {
    if (Math.random() > 0.5) {
      throw redirect(router.href('/login'))
    }
    return { ok: true }
  })

type AppMustNotBecomeAny = IsAny<typeof app>
const appMustNotBecomeAny: AppMustNotBecomeAny = false
void appMustNotBecomeAny

declare module 'spiceflow/react' {
  interface SpiceflowRegister { app: typeof app }
}
`)).toMatchInlineSnapshot(`[]`)
})

test('router.href referencing a route defined AFTER the current handler is still safe with throw', () => {
  expect(getDiagnosticsForCircularFixture(`
import { Spiceflow } from 'spiceflow'
import { redirect } from 'spiceflow'
import { router } from 'spiceflow/react'
import type { IsAny } from '../../types.ts'

export const app = new Spiceflow()
  .get('/go-to-settings', async () => {
    throw redirect(router.href('/settings'))
  })
  .page('/login', async () => 'login')
  .loader('/settings', async () => ({ theme: 'dark' }))
  .page('/settings', async () => 'settings')

type AppMustNotBecomeAny = IsAny<typeof app>
const appMustNotBecomeAny: AppMustNotBecomeAny = false
void appMustNotBecomeAny

declare module 'spiceflow/react' {
  interface SpiceflowRegister { app: typeof app }
}
`)).toMatchInlineSnapshot(`[]`)
})

test('loader defined AFTER page: return redirect(router.href()) is still circular', () => {
  expect(getDiagnosticsForCircularFixture(`
import { Spiceflow } from 'spiceflow'
import { router } from 'spiceflow/react'
import type { IsAny } from '../../types.ts'

export const app = new Spiceflow()
  .page('/login', async () => 'login')
  .page('/dashboard', async ({ redirect }) => {
    return redirect(router.href('/login'))
  })
  .loader('/dashboard', async () => ({ user: { id: '1' } }))

type AppMustNotBecomeAny = IsAny<typeof app>
const appMustNotBecomeAny: AppMustNotBecomeAny = false
void appMustNotBecomeAny

declare module 'spiceflow/react' {
  interface SpiceflowRegister { app: typeof app }
}
`)).toMatchInlineSnapshot(`
  [
    "Type 'false' is not assignable to type 'true'.",
    "'app' is referenced directly or indirectly in its own type annotation.",
  ]
`)
})

test('multiple loaders on different paths: throw redirect(router.href()) stays safe', () => {
  expect(getDiagnosticsForCircularFixture(`
import { Spiceflow } from 'spiceflow'
import { redirect } from 'spiceflow'
import { router } from 'spiceflow/react'
import type { IsAny } from '../../types.ts'

export const app = new Spiceflow()
  .page('/login', async () => 'login')
  .loader('/*', async () => ({ session: null as { id: string } | null }))
  .loader('/dashboard', async () => ({ stats: { posts: 42 } }))
  .page('/dashboard', async () => {
    throw redirect(router.href('/login'))
  })
  .loader('/settings', async () => ({ prefs: { theme: 'dark' } }))
  .page('/settings', async () => {
    throw redirect(router.href('/login'))
  })

type AppMustNotBecomeAny = IsAny<typeof app>
const appMustNotBecomeAny: AppMustNotBecomeAny = false
void appMustNotBecomeAny

declare module 'spiceflow/react' {
  interface SpiceflowRegister { app: typeof app }
}
`)).toMatchInlineSnapshot(`[]`)
})

test('router.href in JSX attribute inside page with loaders does not make the app circular', () => {
  expect(getDiagnosticsForCircularFixture(`
import { Spiceflow } from 'spiceflow'
import { router } from 'spiceflow/react'
import type { IsAny } from '../../types.ts'

export const app = new Spiceflow()
  .page('/login', async () => 'login')
  .loader('/dashboard', async () => ({ user: { name: 'Ada' } }))
  .page('/dashboard', async () => {
    return <a href={router.href('/login')}>Sign out</a>
  })

type AppMustNotBecomeAny = IsAny<typeof app>
const appMustNotBecomeAny: AppMustNotBecomeAny = false
void appMustNotBecomeAny

declare module 'spiceflow/react' {
  interface SpiceflowRegister { app: typeof app }
}
`)).toMatchInlineSnapshot(`[]`)
})

// ── Other APIs that read from RegisteredApp ──────────────────────────
// Test whether useLoaderData, Link, useRouterState, router.push,
// router.getLoaderData, and createSpiceflowFetch cause circular issues
// when used inside app-entry handlers.

test('useLoaderData inside page handler causes circular', () => {
  expect(getDiagnosticsForCircularFixture(`
import { Spiceflow } from 'spiceflow'
import { useLoaderData } from 'spiceflow/react'
import type { IsAny } from '../../types.ts'

export const app = new Spiceflow()
  .page('/login', async () => 'login')
  .loader('/dashboard', async () => ({ user: { id: '1' } }))
  .page('/dashboard', async () => {
    const data = useLoaderData('/dashboard')
    return <div>{data.user.id}</div>
  })

type AppMustNotBecomeAny = IsAny<typeof app>
const appMustNotBecomeAny: AppMustNotBecomeAny = false
void appMustNotBecomeAny

declare module 'spiceflow/react' {
  interface SpiceflowRegister { app: typeof app }
}
`)).toMatchInlineSnapshot(`[]`)
})

test('Link with typed href inside page handler with loaders', () => {
  expect(getDiagnosticsForCircularFixture(`
import { Spiceflow } from 'spiceflow'
import { Link } from 'spiceflow/react'
import type { IsAny } from '../../types.ts'

export const app = new Spiceflow()
  .page('/login', async () => 'login')
  .loader('/dashboard', async () => ({ user: { id: '1' } }))
  .page('/dashboard', async () => {
    return <Link href="/login">Go to login</Link>
  })

type AppMustNotBecomeAny = IsAny<typeof app>
const appMustNotBecomeAny: AppMustNotBecomeAny = false
void appMustNotBecomeAny

declare module 'spiceflow/react' {
  interface SpiceflowRegister { app: typeof app }
}
`)).toMatchInlineSnapshot(`[]`)
})

test('router.push inside page handler with loaders', () => {
  expect(getDiagnosticsForCircularFixture(`
import { Spiceflow } from 'spiceflow'
import { router } from 'spiceflow/react'
import type { IsAny } from '../../types.ts'

export const app = new Spiceflow()
  .page('/login', async () => 'login')
  .loader('/dashboard', async () => ({ user: { id: '1' } }))
  .page('/dashboard', async () => {
    return <button onClick={() => router.push('/login')}>Go</button>
  })

type AppMustNotBecomeAny = IsAny<typeof app>
const appMustNotBecomeAny: AppMustNotBecomeAny = false
void appMustNotBecomeAny

declare module 'spiceflow/react' {
  interface SpiceflowRegister { app: typeof app }
}
`)).toMatchInlineSnapshot(`[]`)
})

test('router.getLoaderData inside loader return causes circular', () => {
  expect(getDiagnosticsForCircularFixture(`
import { Spiceflow } from 'spiceflow'
import { router } from 'spiceflow/react'
import type { IsAny } from '../../types.ts'

export const app = new Spiceflow()
  .page('/login', async () => 'login')
  .loader('/dashboard', async () => {
    const data = await router.getLoaderData('/dashboard')
    return { user: data }
  })
  .page('/dashboard', async () => 'dashboard')

type AppMustNotBecomeAny = IsAny<typeof app>
const appMustNotBecomeAny: AppMustNotBecomeAny = false
void appMustNotBecomeAny

declare module 'spiceflow/react' {
  interface SpiceflowRegister { app: typeof app }
}
`)).toMatchInlineSnapshot(`
  [
    "Type 'false' is not assignable to type 'true'.",
    "'app' is referenced directly or indirectly in its own type annotation.",
  ]
`)
})

test('useRouterState inside page handler with loaders', () => {
  expect(getDiagnosticsForCircularFixture(`
import { Spiceflow } from 'spiceflow'
import { useRouterState } from 'spiceflow/react'
import type { IsAny } from '../../types.ts'

export const app = new Spiceflow()
  .page('/login', async () => 'login')
  .loader('/dashboard', async () => ({ user: { id: '1' } }))
  .page('/dashboard', async () => {
    const state = useRouterState()
    return <div>{state.pathname}</div>
  })

type AppMustNotBecomeAny = IsAny<typeof app>
const appMustNotBecomeAny: AppMustNotBecomeAny = false
void appMustNotBecomeAny

declare module 'spiceflow/react' {
  interface SpiceflowRegister { app: typeof app }
}
`)).toMatchInlineSnapshot(`[]`)
})

test('createSpiceflowFetch inside get handler return causes circular', () => {
  expect(getDiagnosticsForCircularFixture(`
import { Spiceflow } from 'spiceflow'
import { createSpiceflowFetch } from 'spiceflow/client'
import type { IsAny } from '../../types.ts'

export const app = new Spiceflow()
  .page('/login', async () => 'login')
  .get('/api/proxy', async () => {
    const f = createSpiceflowFetch('http://localhost')
    const result = await f('/login')
    return { result }
  })

type AppMustNotBecomeAny = IsAny<typeof app>
const appMustNotBecomeAny: AppMustNotBecomeAny = false
void appMustNotBecomeAny

declare module 'spiceflow/react' {
  interface SpiceflowRegister { app: typeof app }
}
`)).toMatchInlineSnapshot(`
  [
    "Type 'false' is not assignable to type 'true'.",
    "'app' is referenced directly or indirectly in its own type annotation.",
  ]
`)
})
