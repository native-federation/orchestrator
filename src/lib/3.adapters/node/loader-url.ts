import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

/**
 * Resolves the bundled loader location relative to this module.
 *
 * Isolated in its own file so tests can jest.mock() this without having to
 * teach babel-jest about `import.meta`.
 */
export const getLoaderUrl = () => {
  const require = createRequire(import.meta.url);
  return pathToFileURL(
    require.resolve('@softarc/native-federation-orchestrator/node-loader/loader.mjs')
  );
};
