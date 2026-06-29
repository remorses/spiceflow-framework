// Trace externalized npm dependencies from Vite server bundles using nf3,
// then copy the runtime-only node_modules subset into the standalone output.
import { access, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { traceNodeModules } from 'nf3'
import { formatDuration, logger } from './logger.js'

export type NftOptions = {
  /** Controls @vercel/nft static analysis depth.
   *  - `false` disables all analysis (emitGlobs, computeFileReferences, evaluatePureExpressions).
   *  - `true` enables all analysis features (original @vercel/nft default).
   *  - An object lets you enable specific features: `{ emitGlobs, computeFileReferences, evaluatePureExpressions }`.
   *
   *  By default, `emitGlobs` is disabled while the other features stay enabled. emitGlobs
   *  triggers glob() filesystem scans when nft detects wildcard require patterns like
   *  `require('./' + name)` or `fs.readdirSync(__dirname)`. These scans pull entire
   *  directories of files into the trace, which cascades into more AST parsing and caching
   *  until the process OOMs on large projects (4GB+ heap). Disabling only emitGlobs keeps
   *  native addon detection, pino transport tracing, and __dirname file references working.
   */
  analysis?: boolean | {
    emitGlobs?: boolean
    computeFileReferences?: boolean
    evaluatePureExpressions?: boolean
  }
  /** Max concurrent filesystem operations. Default is 1024. Lower values reduce peak memory. */
  fileIOConcurrency?: number
}

export async function traceAndCopyDependencies({
  outDir,
  rootDir,
  targetDir,
  nftOptions,
}: {
  outDir: string
  rootDir: string
  targetDir: string
  nftOptions?: NftOptions
}) {
  logger.info('tracing standalone dependencies...')

  const rscEntry = await resolveBuiltEntry(path.resolve(outDir, 'rsc'))
  const ssrEntry = await resolveBuiltEntry(path.resolve(outDir, 'ssr'), true)
  const entries = [rscEntry]
  if (ssrEntry) entries.push(ssrEntry)

  const start = performance.now()
  await traceNodeModules(entries, {
    outDir: targetDir,
    rootDir,
    writePackageJson: false,
    nft: {
      // nf3/nft calls readFile on every traced path including Unix domain sockets
      // (e.g. Playwright Chromium SingletonSocket in /tmp/). Reading a socket throws
      // "Unknown system error -102". Return null for non-regular files to skip them.
      // https://github.com/unjs/nf3/issues/44
      readFile: safeReadFile,
      // Default: disable emitGlobs only. Glob expansion is the main source of OOM
      // because wildcard require patterns (require('./' + x), fs.readdirSync(__dirname))
      // trigger glob() scans that pull entire directories into the trace, cascading into
      // more AST parsing and unbounded cache growth. Keeping computeFileReferences and
      // evaluatePureExpressions enabled preserves native addon detection, pino transport
      // tracing, and __dirname-based file references.
      analysis: nftOptions?.analysis ?? { emitGlobs: false },
      ...(nftOptions?.fileIOConcurrency != null
        ? { fileIOConcurrency: nftOptions.fileIOConcurrency }
        : {}),
    },
    hooks: {
      traceResult: pruneMissingTraceReasons,
    },
  })

  const nodeModulesPath = path.relative(rootDir, path.join(targetDir, 'node_modules'))
  logger.success(
    `nf3 traced standalone dependencies in ${formatDuration(performance.now() - start)}`,
    `standalone deps: ${nodeModulesPath}`,
  )
}

// Return Buffer for regular files, empty Buffer for non-regular files (sockets,
// FIFOs, device files). We return empty instead of null because @vercel/nft's
// emitDependency throws "File does not exist" on null, killing the entire trace.
// An empty buffer just produces zero deps from the analyzer, which is correct.
async function safeReadFile(filePath: string): Promise<Buffer | string | null> {
  try {
    const s = await stat(filePath)
    if (!s.isFile()) return ''
    return await readFile(filePath)
  } catch {
    return null
  }
}

// TODO: remove this workaround once https://github.com/unjs/nf3/pull/43 is merged
export async function pruneMissingTraceReasons(result: {
  reasons: Map<string, { ignored?: boolean; parents: Set<string> }>
}) {
  const existingPaths = new Map<string, boolean>()

  for (const [p, reason] of result.reasons) {
    if (!reason.ignored && !(await tracePathExists(p, existingPaths))) {
      result.reasons.delete(p)
      continue
    }

    for (const parent of reason.parents) {
      if (!(await tracePathExists(parent, existingPaths))) {
        reason.parents.delete(parent)
      }
    }
  }
}

async function tracePathExists(p: string, cache: Map<string, boolean>) {
  const fullPath = path.resolve('/', p)
  const cached = cache.get(fullPath)
  if (cached !== undefined) return cached

  const exists = await realpathExists(fullPath)
  cache.set(fullPath, exists)
  return exists
}

async function realpathExists(p: string) {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

export async function exists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

export async function resolveBuiltEntry(dir: string): Promise<string>
export async function resolveBuiltEntry(dir: string, optional: true): Promise<string | undefined>
export async function resolveBuiltEntry(
  dir: string,
  optional = false,
): Promise<string | undefined> {
  for (const ext of ['js', 'mjs']) {
    const entry = path.resolve(dir, `index.${ext}`)
    if (await exists(entry)) return entry
  }

  if (optional) return undefined

  throw new Error(
    `[spiceflow] Expected a built server entry at ${path.join(dir, 'index.{js,mjs}')}`,
  )
}
