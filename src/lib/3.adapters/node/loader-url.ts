import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { NFError } from 'lib/native-federation.error';

/**
 * Resolves the bundled Node loader (`dist/node-loader/loader.mjs`) via the
 * package's own `exports` map. Self-resolving by name (rather than a relative
 * URL from `import.meta.url`) keeps this working under bundlers, pnpm, Yarn
 * PnP, and monorepo symlinks where the on-disk layout of the installed package
 * is not predictable.
 */
export const getLoaderUrl = () => {
  try {
    const require = createRequire(import.meta.url);
    return pathToFileURL(
      require.resolve('@softarc/native-federation-orchestrator/node-loader/loader.mjs')
    );
  } catch (err) {
    const cause = err instanceof Error ? err : new Error(String(err));
    throw new NFError(
      `Could not locate the bundled node-loader at '@softarc/native-federation-orchestrator/node-loader/loader.mjs'. Ensure it is installed, and that its 'exports' map exposes this subpath: ${cause.message}`,
      cause
    );
  }
};
