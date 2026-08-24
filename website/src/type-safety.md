---
title: Type-Safe Routing
description: Compile-time route validation with the register pattern.
icon: check-check
---

# Type-Safe Routing

Spiceflow provides **compile-time route validation** for paths, params, query schemas, and loader data. This document explains how the type registry works, when to use it, and how to handle workspaces with multiple apps.

## The register pattern

Add a `declare module` block at the bottom of your app entry file:

```tsx
// src/main.tsx
import { Spiceflow } from 'spiceflow'

export const app = new Spiceflow()
  .page('/login', async () => 'login')
  .page('/users/:id', async ({ params }) => <div>{params.id}</div>)
  .listen(3000)

declare module 'spiceflow/react' {
  interface SpiceflowRegister {
    app: typeof app
  }
}
```

This registers your app's route types **globally** within the TypeScript project. Every typed API picks them up automatically:

```tsx
import { router, useLoaderData } from 'spiceflow/react'
import { createSpiceflowFetch } from 'spiceflow/client'

router.href('/users/:id', { id: '42' }) // params validated
router.href('/nonexistent')              // compile error

const data = useLoaderData('/login')     // typed loader data
const f = createSpiceflowFetch('http://localhost:3000') // typed fetch
```

Without the `declare module` block, all APIs still work at runtime. They just accept any string without compile-time validation.

## Why not generics?

Before the register pattern, every call needed an explicit generic:

```tsx
import { createSpiceflowFetch } from 'spiceflow/client'
import type { app } from './main'

// old way: pass the app type everywhere
const f = createSpiceflowFetch<typeof app>('http://localhost:3000')
useLoaderData<typeof app>('/login')
```

Problems with the generic approach:

- **Repetitive.** Every file that uses typed routing must import `typeof app` and pass it as a generic.
- **Viral imports.** Client-side code ends up importing the server app type, which can pull server-only modules into the client bundle if not carefully managed.
- **Easy to forget.** Missing the generic gives you `any` types silently, so you lose safety without a warning.

The register pattern solves all three: register once, typed everywhere, no imports needed.

## One app per TypeScript project

The register pattern uses TypeScript's **interface declaration merging**. When you write `interface SpiceflowRegister { app: typeof app }` in a `declare module` block, TypeScript adds the `app` property to the global `SpiceflowRegister` interface for that entire compilation unit.

This means **only one app can be registered per `tsconfig.json` project**. If two files in the same project both declare `SpiceflowRegister` with different app types, TypeScript raises a compile error:

```
error TS2717: Subsequent property declarations must have the same type.
  Property 'app' must be of type 'typeof appA',
  but here has type 'typeof appB'.
```

This is not a silent corruption. It's a hard error that tells you exactly what's wrong.

## Multiple apps in a workspace

In a monorepo with multiple spiceflow apps, the register pattern works fine **as long as each app is a separate TypeScript project** (its own `tsconfig.json`) and they don't import each other's entry files.

```
workspace/
  packages/
    admin/           # tsconfig.json, declares SpiceflowRegister for adminApp
    customer/        # tsconfig.json, declares SpiceflowRegister for customerApp
    shared/          # shared utils, no SpiceflowRegister
```

Each app is compiled independently. No collision.

### When apps import each other

The problem appears when one workspace package **imports** from another that also has a `declare module` block. TypeScript follows import chains and pulls in all module augmentations it finds.

If `admin` imports anything from `customer` (even a utility function that lives in the same package as `customer/src/main.tsx`), TypeScript sees both `SpiceflowRegister` declarations and raises the compile error.

This also happens transitively. If `admin` imports `shared`, and `shared` imports `customer`, the augmentation from `customer` leaks into `admin`'s compilation.

### Solutions for cross-importing apps

**Option 1: Only one app registers globally.** The "main" app uses the `declare module` pattern. Other apps that get imported into it use explicit generics instead:

```tsx
// packages/admin/src/main.tsx (the main app, registers globally)
export const adminApp = new Spiceflow()
  .use(customerApp)
  .page('/admin', async () => <Admin />)
  .listen(3000)

declare module 'spiceflow/react' {
  interface SpiceflowRegister { app: typeof adminApp }
}

// packages/customer/src/main.tsx (imported by admin, no register)
export const customerApp = new Spiceflow()
  .page('/shop', async () => <Shop />)

// packages/customer/src/some-client.ts (uses generics)
import { createSpiceflowFetch } from 'spiceflow/client'
import type { customerApp } from './main'

const f = createSpiceflowFetch<typeof customerApp>('http://localhost:3001')
```

The customer app loses the ergonomic register pattern but gains the ability to be imported by admin without type conflicts.

**Option 2: Use the parent app's type.** If a sub-app is mounted into a larger app via `.use()`, it can use the parent's registered type. Since the parent app includes all routes from the sub-app, the parent's type is a superset:

```tsx
// packages/customer/src/nav.tsx
// The admin app mounts customerApp, so adminApp's routes include /shop
// The global register has adminApp, so router.href('/shop') just works
import { router } from 'spiceflow/react'

router.href('/shop')  // valid because adminApp includes customerApp's routes
```

**Option 3: No type safety for the imported app.** If a sub-app doesn't need typed routing in its own package (it just defines routes and exports the app), skip both the register and the generics. The routes are still type-safe in the parent app that mounts them.

### Summary

| Setup | Register pattern | Generics | Notes |
|---|---|---|---|
| Single app | Yes | Not needed | Best DX |
| Multiple apps, separate tsconfigs, no cross-imports | Yes (each app) | Not needed | Each project is isolated |
| Multiple apps, one imports the other | Only the main app | Other apps use generics | Avoids declaration conflict |
| Sub-app mounted via `.use()` | Only the parent | Sub-app uses parent's type or generics | Parent's type covers sub-app routes |

## Type safety inside inline handlers

A common pattern in spiceflow is calling `router.href()` or `throw redirect(router.href('/path'))` inside `.page()` handlers:

```tsx
import { Spiceflow, redirect } from 'spiceflow'
import { router } from 'spiceflow/react'

export const app = new Spiceflow()
  .page('/login', async () => 'login')
  .page('/dashboard', async () => {
    throw redirect(router.href('/login'))  // fully type-safe
  })
  .page('/users/:id', async ({ params }) => {
    return <a href={router.href('/dashboard')}>Back</a>
  })

declare module 'spiceflow/react' {
  interface SpiceflowRegister { app: typeof app }
}
```

Always use `throw redirect(...)`, never `return redirect(...)`. `throw` prevents the redirect from contributing to the handler's return type, which avoids circular TypeScript errors (TS7022) when the app uses `SpiceflowRegister`.

The `router` import reads from `SpiceflowRegister`, which is resolved by TypeScript **independently** from the `const app = ...` expression. The handler body references `router` (a module-level import), not `typeof app`, so there's no circular dependency.

Without the register pattern, using `getRouter<typeof app>()` inside handlers creates a circular type reference. The handler's body is part of the expression that defines `app`, and it also references `typeof app` — TypeScript can't resolve both simultaneously and widens the path type to `string`, losing all validation. The register pattern breaks this cycle.

## Autocomplete limitation

TypeScript's **compiler** (tsc) resolves the full registered type correctly — invalid paths, missing params, and wrong param keys all produce compile errors as expected. But the **language server** (IDE autocomplete/IntelliSense) resolves types incrementally for performance.

When you're typing inside a `.page()` handler that's part of the `const app = ...` chain, autocomplete may only show paths defined **above** the current handler position, not the full route table. This is because:

1. The language server needs to resolve `RegisteredApp` → `SpiceflowRegister['app']` → `typeof app`
2. `typeof app` depends on the full builder chain, which is still being typed
3. The language server falls back to whatever it has resolved so far

This is the same limitation TanStack Router has. Their workaround is code generation (a Vite plugin pre-generates the route tree). In spiceflow, this only affects autocomplete **inside the app chain** — it does not affect type errors or autocomplete in separate component files.

| Location | Compile errors (tsc) | Autocomplete |
|---|---|---|
| Inside `.page()` handler in the chain | ✅ All paths validated | Partial (only paths above) |
| Separate component file | ✅ All paths validated | ✅ Full autocomplete |
| Separate server component | ✅ All paths validated | ✅ Full autocomplete |

For the best DX, use `router.href()` in component files where autocomplete is fully functional. Inside the chain, the compiler still catches all errors even if autocomplete is incomplete.

## How it works internally

The `SpiceflowRegister` interface starts empty:

```ts
export interface SpiceflowRegister {}
```

The `RegisteredApp` type checks if the interface has been augmented:

```ts
export type RegisteredApp = SpiceflowRegister extends {
  app: infer App extends AnySpiceflow
}
  ? App
  : AnySpiceflow
```

If `SpiceflowRegister` has an `app` property that extends `AnySpiceflow`, the type resolves to that specific app type. Otherwise it falls back to `AnySpiceflow`, which gives `any`-like behavior (all strings accepted, no validation).

Every typed API defaults its generic parameter to `RegisteredApp`:

```ts
export const router: RouterBase<RegisteredApp> = { ... }
export function useLoaderData<App extends AnySpiceflow = RegisteredApp>() { ... }
export function createSpiceflowFetch(domain: string): SpiceflowFetch<RegisteredApp>
```

This is why the register pattern is "register once, typed everywhere". The conditional type `RegisteredApp` threads the app type through every API automatically.
