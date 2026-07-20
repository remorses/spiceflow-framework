// Build a path string from a pattern and params.
// Substitutes :param segments and appends remaining params as query string.
// Empty path is normalized to '/' so anchor hrefs point to the site root.
export function buildHref(
  path: string,
  allParams: object | undefined,
): string {
  let result = path || '/'
  if (!allParams || typeof allParams !== 'object') return result

  const pathParamNames = new Set<string>()
  const paramMatches = path.matchAll(/:(\w+)/g)
  for (const m of paramMatches) {
    pathParamNames.add(m[1])
  }
  const hasWildcard = path.includes('*')
  if (hasWildcard) pathParamNames.add('*')

  const searchParams = new URLSearchParams()
  for (const [key, value] of Object.entries(allParams)) {
    if (value === undefined || value === null) continue
    if (key === '*' && hasWildcard) {
      result = result.replace(/\*/, String(value))
    } else if (pathParamNames.has(key)) {
      result = result.replace(new RegExp(`:${key}`, 'g'), String(value))
    } else {
      searchParams.set(key, String(value))
    }
  }

  const qs = searchParams.toString()
  if (qs) result += '?' + qs
  return result
}
