/**
 * Resolves the bundled loader location relative to this module.
 *
 * Isolated in its own file so tests can jest.mock() this without having to
 * teach babel-jest about `import.meta`.
 */
export const getLoaderUrl = (): URL =>
  new URL('../node-loader/loader.mjs', import.meta.url);
