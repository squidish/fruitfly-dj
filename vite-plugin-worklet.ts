/**
 * Bundles the AudioWorklet into one self-contained file.
 *
 * `audioWorklet.addModule()` cannot be relied on to resolve bare or relative
 * imports across browsers, but src/core/ear.ts has to be shared between the
 * worklet, the worker and the Node harness — that sharing is the whole point of
 * a pure core. So the worklet gets esbuild-bundled into a single module with
 * every dependency inlined, in dev and in build alike.
 *
 * Import the URL as `virtual:ear-worklet-url`.
 */

import { build } from 'esbuild';
import { resolve } from 'node:path';
import type { Plugin } from 'vite';

const SPECIFIER = 'virtual:ear-worklet-url';
const RESOLVED = '\0virtual:ear-worklet-url';
const DEV_PATH = '/@fly-dj/ear-worklet.js';
const ENTRY = 'src/audio/earWorklet.ts';

async function bundleWorklet(root: string, minify: boolean): Promise<string> {
  const result = await build({
    entryPoints: [resolve(root, ENTRY)],
    bundle: true,
    write: false,
    format: 'esm',
    target: 'es2022',
    minify,
    legalComments: 'none',
  });
  return result.outputFiles[0].text;
}

export function earWorkletPlugin(): Plugin {
  let root = process.cwd();
  let isBuild = false;
  let base = '/';

  return {
    name: 'fly-dj:ear-worklet',

    configResolved(config) {
      root = config.root;
      isBuild = config.command === 'build';
      base = config.base;
    },

    resolveId(id) {
      return id === SPECIFIER ? RESOLVED : null;
    },

    async load(id) {
      if (id !== RESOLVED) return null;
      if (!isBuild) {
        return `export default ${JSON.stringify(base.replace(/\/$/, '') + DEV_PATH)};`;
      }
      const source = await bundleWorklet(root, true);
      const ref = this.emitFile({ type: 'asset', name: 'ear-worklet.js', source });
      return `export default import.meta.ROLLUP_FILE_URL_${ref};`;
    },

    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = (req.url ?? '').split('?')[0];
        if (!url.endsWith(DEV_PATH)) return next();
        try {
          const source = await bundleWorklet(root, false);
          res.setHeader('Content-Type', 'text/javascript');
          res.setHeader('Cache-Control', 'no-cache');
          res.end(source);
        } catch (err) {
          res.statusCode = 500;
          res.end(`// worklet bundle failed\n${String(err)}`);
        }
      });
    },
  };
}
