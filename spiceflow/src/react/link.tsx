'use client'

import React from 'react'
import type { AnySpiceflow } from '../spiceflow.js'
import type { AllHrefPaths, PathParamsProp, ValidatedHref } from '../types.js'
import { getBasePath } from '../base-path.js'
import { buildHref } from './loader-utils.js'
import {
  type RegisteredApp,
  type RouterPaths,
  type RouterQuerySchemas,
  router,
} from 'spiceflow/react'

function getBase(): string {
  return getBasePath()
}

function hasBasePrefix(path: string, base: string): boolean {
  if (path === base) return true
  const next = path.charAt(base.length)
  return path.startsWith(base) && (next === '/' || next === '?' || next === '#')
}

function withBase(href: string | undefined): string | undefined {
  if (!href) return href
  const base = getBase()
  if (!base) return href
  if (!href.startsWith('/') || href.startsWith('//')) return href
  if (hasBasePrefix(href, base)) return href
  return base + href
}

export type LinkProps<
  App extends AnySpiceflow = RegisteredApp,
  Paths extends string = RouterPaths<App>,
  QS extends object = RouterQuerySchemas<App>,
  Path extends string = AllHrefPaths<Paths>,
> = Omit<React.ComponentPropsWithRef<'a'>, 'href'> & {
  rawHref?: boolean
  href?: ValidatedHref<Paths, Path, QS>
} & PathParamsProp<Path>

export function Link<
  App extends AnySpiceflow = RegisteredApp,
  Paths extends string = RouterPaths<App>,
  QS extends object = RouterQuerySchemas<App>,
  const Path extends string = AllHrefPaths<Paths>,
>(props: LinkProps<App, Paths, QS, Path>) {
  const { rawHref, params, href: hrefProp, ...rest } = props
  const resolved = params && hrefProp ? buildHref(hrefProp, params) : hrefProp
  const href = rawHref ? resolved : withBase(resolved)

  return (
    <a
      {...rest}
      href={href}
      onClick={(e) => {
        if (
          e.metaKey ||
          e.ctrlKey ||
          e.shiftKey ||
          e.altKey ||
          (props.target && props.target === '_blank') ||
          e.currentTarget.origin !== window.location.origin
        ) {
          props.onClick?.(e)
          return
        }
        e.preventDefault()

        props.onClick?.(e)
        router.push(
          e.currentTarget.pathname +
            e.currentTarget.search +
            e.currentTarget.hash,
        )
      }}
    />
  )
}
