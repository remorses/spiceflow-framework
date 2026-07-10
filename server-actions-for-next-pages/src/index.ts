import * as path from 'path';
import * as fs from 'fs';
import type * as webpack from 'webpack';
import { NextConfig } from 'next';
import { PluginOptions as RpcPluginOptions } from './babelTransformRpc';
import { PluginOptions as ContextPluginOptions } from './babelTransformContext';
import { WrapMethod } from './server';

export interface WithRpcConfig {}

export { WrapMethod };

export function withServerActions(withRpcConfig: WithRpcConfig = {}) {
  return (nextConfig: NextConfig = {}): NextConfig => {
    applyTurbopackOptions(nextConfig);
    return {
      ...nextConfig,

      webpack(config: webpack.Configuration, options) {
        const { isServer, dev, dir } = options;
        const pagesDir = findPagesDir(dir);

        const appDir = path.resolve(pagesDir, '../app');
        config.module = config.module || {};
        config.module.rules = config.module.rules || [];
        config.module.rules.push({
          test: /\.(tsx|ts|js|mjs|jsx)$/,
          include: [pagesDir],
          use: [
            options.defaultLoaders.babel,
            {
              loader: 'babel-loader',
              options: {
                sourceMaps: dev,
                plugins: plugins({
                  isServer,
                  pagesDir,
                  isAppDir: false,
                  basePath: (nextConfig.basePath as string) || '/',
                }),
              },
            },
          ],
        });
        config.module.rules.push({
          test: /route\.(tsx|ts|js|mjs|jsx)$/,
          include: [appDir],
          use: [
            options.defaultLoaders.babel,
            {
              loader: 'babel-loader',
              options: {
                sourceMaps: dev,
                plugins: plugins({
                  isServer,
                  pagesDir,
                  isAppDir: true,
                  basePath: (nextConfig.basePath as string) || '/',
                }),
              },
            },
          ],
        });

        if (typeof nextConfig.webpack === 'function') {
          return nextConfig.webpack(config, options);
        } else {
          return config;
        }
      },
    };
  };
}

export function plugins({
  isServer,
  pagesDir,
  isAppDir,
  basePath,
}: RpcPluginOptions) {
  const apiDir = path.resolve(pagesDir, './api');
  const rpcPluginOptions: RpcPluginOptions = {
    isServer,
    pagesDir,

    isAppDir,
    basePath: basePath || '/',
  };

  const contextPluginOptions: ContextPluginOptions = { apiDir, isServer };
  return [
    require.resolve('@babel/plugin-syntax-jsx'),
    [require.resolve('@babel/plugin-transform-typescript'), { isTSX: true }],
    [require.resolve('../dist/babelTransformRpc'), rpcPluginOptions],
    [require.resolve('../dist/babelTransformContext'), contextPluginOptions],
    process.env.DEBUG_ACTIONS && [
      require.resolve('../dist/babelDebugOutputs'),
      contextPluginOptions,
    ],
  ].filter(Boolean) as any[];
}

function applyTurbopackOptions(nextConfig: NextConfig): void {
  (nextConfig as any).turbopack ??= {};
  (nextConfig as any).turbopack.rules ??= {};

  const rules = (nextConfig as any).turbopack.rules;

  const pagesDir = findPagesDir(process.cwd());
  const basePath = (nextConfig.basePath as string) || '/';
  const loaderPath = require.resolve('../dist/turbopackLoader');

  const glob = '{./src/pages,./pages/}/**/*.{ts,tsx,js,jsx}';

  // Use Next.js 16 condition syntax with array of rules
  rules[glob] = [
    {
      condition: {
        all: ['browser', { not: 'foreign' }],
      },
      loaders: [
        {
          loader: loaderPath,
          options: {
            isServer: false,
            pagesDir,
            isAppDir: false,
            basePath,
          },
        },
      ],
      // The babel transform includes @babel/plugin-transform-typescript which
      // strips TypeScript syntax, so the loader output is valid JS. Using
      // '*.tsx' here would cause turbopack to mangle virtual filenames (e.g.
      // `[...nextauth].ts.tsx.js`), breaking dynamic/catch-all route resolution
      // in Next.js 16 turbopack.
      as: '*.js',
    },
    {
      condition: {
        all: [{ not: 'browser' }, { not: 'foreign' }],
      },
      loaders: [
        {
          loader: loaderPath,
          options: {
            isServer: true,
            pagesDir,
            isAppDir: false,
            basePath,
          },
        },
      ],
      as: '*.js',
    },
  ];
}

// taken from https://github.com/vercel/next.js/blob/v12.1.5/packages/next/lib/find-pages-dir.ts
function findPagesDir(dir: string): string {
  // prioritize ./pages over ./src/pages
  let curDir = path.join(dir, 'pages');
  if (fs.existsSync(curDir)) return curDir;

  curDir = path.join(dir, 'src/pages');
  if (fs.existsSync(curDir)) return curDir;

  // Check one level up the tree to see if the pages directory might be there
  if (fs.existsSync(path.join(dir, '..', 'pages'))) {
    throw new Error(
      'No `pages` directory found. Did you mean to run `next` in the parent (`../`) directory?',
    );
  }

  throw new Error(
    "Couldn't find a `pages` directory. Please create one under the project root",
  );
}
