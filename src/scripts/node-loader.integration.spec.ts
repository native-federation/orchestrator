/**
 * @vitest-environment node
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Regression for #79: runs the real hooks in a child Node process (Node >= 23.6 strips the
// loader's types). The CJS package mirrors rxjs 7, whose `node` export condition points at
// dist/cjs; the federated bundle sits under "type": "commonjs" so it only loads as ESM
// because the loader marks import-map targets (and their relative chunks) as modules.
describe('node-loader in a real Node process', () => {
  let dir: string;

  const write = (path: string, content: string) => {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), content);
  };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'nf-loader-'));
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
    write('dist/mfe/package.json', JSON.stringify({ type: 'commonjs' }));
    write('dist/mfe/entry.js', "export { chunk } from './chunk.js';\n");
    write('dist/mfe/chunk.js', "export const chunk = 'federated';\n");

    const loaderURL = pathToFileURL(resolve(__dirname, 'node-loader.ts')).href;
    const importMap = { imports: { mfe: pathToFileURL(join(dir, 'dist/mfe/entry.js')).href } };
    write(
      'host.mjs',
      [
        "import { register } from 'node:module';",
        `register(${JSON.stringify(loaderURL)}, { data: { initialImportMap: ${JSON.stringify(importMap)} } });`,
        "const { BehaviorSubject } = await import('fakerx');",
        "const { chunk } = await import('mfe');",
        'console.log(JSON.stringify({ rx: typeof BehaviorSubject, chunk }));',
      ].join('\n')
    );
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('loads a CJS host dependency and a federated ESM bundle side by side', () => {
    const out = execFileSync(process.execPath, ['--no-warnings', 'host.mjs'], {
      cwd: dir,
      encoding: 'utf8',
    });

    expect(JSON.parse(out)).toEqual({ rx: 'function', chunk: 'federated' });
  });
});
