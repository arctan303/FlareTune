import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

// esbuild bundles JavaScript, while workerd must receive Wasm as a separate
// precompiled module. A file/binary/empty JS loader would change that contract.
// Keep all module contents in memory: no generated test bundle to clean up.
export async function bundleWorkerModules({ esbuild, entryPoint, buildOptions = {} }) {
  const workingDirectory = resolve(buildOptions.absWorkingDir || process.cwd());
  const entry = resolve(workingDirectory, entryPoint);
  const modulesRoot = dirname(entry);
  const bundlePath = resolve(modulesRoot, '__flaretune-preview-entry.mjs');
  const compiled = new Map();
  const wasmPlugin = {
    name: 'workerd-precompiled-wasm',
    setup(build) {
      build.onResolve({ filter: /\.wasm$/ }, async args => {
        const source = resolve(args.resolveDir || workingDirectory, args.path);
        const bytes = new Uint8Array(await readFile(source));
        const hash = createHash('sha256').update(bytes).digest('hex');
        const specifier = './__compiled_wasm__/' + hash + '.wasm';
        compiled.set(specifier, { type: 'CompiledWasm', path: resolve(modulesRoot, specifier), contents: bytes });
        return { path: specifier, external: true };
      });
    },
  };
  const { plugins = [], conditions = [], ...options } = buildOptions;
  const bundle = await esbuild.build({ ...options, entryPoints: [entry], outfile: bundlePath,
    bundle: true, write: false, splitting: false, format: 'esm', platform: 'browser',
    conditions: [...new Set(['workerd', 'browser', ...conditions])], plugins: [wasmPlugin, ...plugins] });
  const script = bundle.outputFiles?.find(file => file.path === bundlePath) || bundle.outputFiles?.[0];
  if (typeof script?.text !== 'string') throw new Error('Preview bundler did not return an ES module');
  return { modulesRoot, modules: [{ type: 'ESModule', path: bundlePath, contents: script.text },
    ...Array.from(compiled.values()).sort((a, b) => a.path.localeCompare(b.path))] };
}
