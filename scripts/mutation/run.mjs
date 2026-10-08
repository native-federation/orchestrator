#!/usr/bin/env node
// Mutation runner: applies each mutant patch to a clean checkout, runs the suite with the JSON reporter and
// reverts. Usage and the mutant format: scripts/mutation/README.md.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    mutants: { type: 'string' },
    out: { type: 'string' },
    root: { type: 'string' },
    only: { type: 'string' },
    seeds: { type: 'string', default: '1,2,3' },
    suite: { type: 'string', default: 'src/lib/core,src/lib/testing' },
    properties: {
      type: 'string',
      default:
        'src/lib/core/2.app/steps/pooling/pooling.property.init.spec.ts,src/lib/core/2.app/steps/pooling/pooling.property.dynamic.spec.ts',
    },
    force: { type: 'boolean', default: false },
  },
});

// No defaults: a bare run must not apply mutants to the checkout it was started from.
if (!values.root || !values.mutants || !values.out)
  throw new Error('--root <clean checkout>, --mutants <dir> and --out <dir> are required');
const root = resolve(values.root);
const out = resolve(values.out);
const mutantsDir = resolve(values.mutants);
mkdirSync(out, { recursive: true });

const only = values.only?.split(',');
const ids = [
  'NONE',
  ...readdirSync(mutantsDir)
    .filter(f => f.endsWith('.diff'))
    .map(f => basename(f, '.diff'))
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true })),
].filter(id => !only || only.includes(id));

const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });

// Tracked files only: untracked result or scratch files in the checkout don't make it dirty.
const assertClean = when => {
  const dirty = git('status', '--porcelain', '--untracked-files=no').trim();
  if (dirty) throw new Error(`checkout not clean ${when}:\n${dirty}`);
};

function vitest(paths, outputFile, env) {
  return new Promise(done => {
    const started = Date.now();
    const child = spawn(
      'npx',
      [
        'vitest',
        'run',
        '--coverage.enabled=false',
        '--reporter=json',
        `--outputFile=${outputFile}`,
        ...paths,
      ],
      { cwd: root, env: { ...process.env, ...env }, stdio: 'ignore' }
    );
    child.on('exit', code => done({ code, ms: Date.now() - started }));
  });
}

delete process.env.POOLING_PROPERTY_SEED;
delete process.env.POOLING_PROPERTY_SCALE;

assertClean('before the run');
for (const id of ids) {
  const ci = join(out, `${id}.ci.json`);
  const seeds = values.seeds ? values.seeds.split(',') : [];
  const seedFiles = seeds.map(s => join(out, `${id}.s${s}.json`));
  // An empty --suite reruns only the seeds, keeping the full-suite report.
  const wanted = values.suite ? [ci, ...seedFiles] : seedFiles;
  if (!values.force && wanted.every(existsSync)) {
    console.log(`${id}: cached`);
    continue;
  }
  const patch = join(mutantsDir, `${id}.diff`);
  if (id !== 'NONE') {
    try {
      git('apply', patch);
    } catch (error) {
      console.log(
        `${id}: does not apply (${
          String(error.stderr ?? error)
            .trim()
            .split('\n')[0]
        })`
      );
      continue;
    }
  }
  try {
    wanted.forEach(f => rmSync(f, { force: true }));
    // The full suite alone, as CI runs it: the properties' time-boxed runs are load sensitive.
    const full = values.suite
      ? await vitest(values.suite.split(','), ci, {})
      : { code: '-', ms: 0 };
    // Two property files per seed only occupy a few cores, so the seeds run side by side.
    const deep = await Promise.all(
      seeds.map((s, i) =>
        vitest(values.properties.split(','), seedFiles[i], { POOLING_PROPERTY_SEED: s })
      )
    );
    console.log(
      `${id}: ci ${full.ms} ms (exit ${full.code}); seeds ${deep.map(d => `${d.ms} ms`).join(', ')}`
    );
  } finally {
    if (id !== 'NONE') git('apply', '-R', patch);
    assertClean(`after ${id}`);
  }
}
