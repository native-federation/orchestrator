/**
 * @vitest-environment node
 */
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

// Runs the real hooks in a child Node process (Node >= 23.6 strips the loader's types). The
// federated bundles sit under "type": "commonjs", so they only load as ESM because the loader
// marks import-map targets (and their relative chunks) as modules.
describe('node-loader in a real Node process', () => {
  let dir: string;
  const loaderURL = pathToFileURL(resolve(__dirname, 'node-loader.ts')).href;

  const write = (path: string, content: string) => {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), content);
  };

  // Writes a host script that registers the loader with `data`, then runs `body`. Async on
  // purpose: a test may hold the child's event loop for seconds.
  const runHost = async (name: string, data: object, body: string[]): Promise<string> => {
    write(
      name,
      [
        "import { register } from 'node:module';",
        `register(${JSON.stringify(loaderURL)}, { data: ${JSON.stringify(data)} });`,
        ...body,
      ].join('\n')
    );
    const { stdout } = await promisify(execFile)(process.execPath, ['--no-warnings', name], {
      cwd: dir,
      encoding: 'utf8',
    });
    return stdout;
  };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'nf-loader-'));
    write('dist/package.json', JSON.stringify({ type: 'commonjs' }));
    write('dist/exposed/List.js', "export { list } from './chunk.js';\n");
    write('dist/exposed/chunk.js', "export const list = 'exposed';\n");
    write('dist/exposed dir/List.js', "export { list } from './chunk.js';\n");
    write('dist/exposed dir/chunk.js', "export const list = 'exposed';\n");
    symlinkSync(join(dir, 'dist/exposed'), join(dir, 'dist/exposed-link'), 'dir');
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  // #79: the CJS package mirrors rxjs 7, whose `node` export condition points at dist/cjs.
  it('loads a CJS host dependency and a federated ESM bundle side by side', async () => {
    write(
      'node_modules/fakerx/package.json',
      JSON.stringify({
        name: 'fakerx',
        exports: {
          '.': {
            node: './dist/cjs/index.js',
            require: './dist/cjs/index.js',
            default: './dist/esm/index.js',
          },
        },
      })
    );
    write(
      'node_modules/fakerx/dist/cjs/index.js',
      '"use strict";\nexports.BehaviorSubject = class BehaviorSubject {};\n'
    );
    write('node_modules/fakerx/dist/esm/index.js', 'export class BehaviorSubject {}\n');
    write('dist/mfe/entry.js', "export { chunk } from './chunk.js';\n");
    write('dist/mfe/chunk.js', "export const chunk = 'federated';\n");
    const importMap = { imports: { mfe: pathToFileURL(join(dir, 'dist/mfe/entry.js')).href } };

    const out = await runHost('host-79.mjs', { initialImportMap: importMap }, [
      "const { BehaviorSubject } = await import('fakerx');",
      "const { chunk } = await import('mfe');",
      'console.log(JSON.stringify({ rx: typeof BehaviorSubject, chunk }));',
    ]);

    expect(JSON.parse(out)).toEqual({ rx: 'function', chunk: 'federated' });
  });

  // loadRemoteModule imports an exposed module by its URL (a map value, not a key). Node resolves
  // that URL to its realpath and percent-encodes it, so the match must happen before nextResolve.
  it.each([
    ['a plain dir', 'dist/exposed/'],
    ['a dir with a space', 'dist/exposed dir/'],
    ['a symlinked dir', 'dist/exposed-link/'],
  ])('loads an exposed module imported by its file:// URL from %s', async (_, folder) => {
    const exposedURL = pathToFileURL(join(dir, folder, 'List.js')).href;
    const importMap = { imports: { 'mfe/./List': exposedURL } };

    const out = await runHost('host-exposed.mjs', { initialImportMap: importMap }, [
      `const { list } = await import(${JSON.stringify(exposedURL)});`,
      'console.log(JSON.stringify({ list }));',
    ]);

    expect(JSON.parse(out)).toEqual({ list: 'exposed' });
  });
});
