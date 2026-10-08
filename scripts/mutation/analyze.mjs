#!/usr/bin/env node
// Builds the kill matrix from run.mjs's JSON reports: which test kills which mutant, unique kills, survivors
// and per-seed flakiness. Writes matrix.json and prints a summary.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    out: { type: 'string' },
    root: { type: 'string' },
  },
});
if (!values.root || !values.out)
  throw new Error('--root <checkout run.mjs ran in> and --out <dir> are required');
const out = resolve(values.out);
const root = resolve(values.root);

// testId -> status, file-level load failures included as `<file> > (file)`.
function statuses(path) {
  const report = JSON.parse(readFileSync(path, 'utf8'));
  const result = new Map();
  for (const file of report.testResults) {
    const rel = file.name.startsWith(root) ? file.name.slice(root.length + 1) : file.name;
    if (file.assertionResults.length === 0 || (file.status === 'failed' && file.message))
      result.set(`${rel} > (file)`, file.status === 'failed' ? 'failed' : 'passed');
    for (const a of file.assertionResults) {
      // Two tests of one file can share a name.
      let id = `${rel} > ${a.fullName}`;
      for (let n = 2; result.has(id); n++) id = `${rel} > ${a.fullName} #${n}`;
      // A property cut short by its time limit says the machine was loaded, not that the mutant broke a rule.
      const interrupted = a.failureMessages?.some(m => m.includes('Property interrupted after'));
      result.set(id, interrupted ? 'interrupted' : a.status);
    }
  }
  return result;
}

const runs = new Map();
for (const f of readdirSync(out)) {
  const m = /^(.+)\.(ci|s\d+)\.json$/.exec(f);
  if (!m) continue;
  if (!runs.has(m[1])) runs.set(m[1], {});
  runs.get(m[1])[m[2]] = statuses(join(out, f));
}

const none = runs.get('NONE');
if (!none?.ci) throw new Error('NONE.ci.json missing: run the baseline first');
const phases = Object.keys(none);
// A test red without any mutant tells nothing.
const flakyBaseline = new Set();
for (const p of phases)
  for (const [t, s] of none[p]) if (s === 'failed') flakyBaseline.add(`${p}:${t}`);

const killed = (id, phase) => {
  const r = runs.get(id)?.[phase];
  if (!r) return undefined;
  return [...r]
    .filter(([t, s]) => s === 'failed' && !flakyBaseline.has(`${phase}:${t}`))
    .map(([t]) => t);
};

const interrupts = [...runs].flatMap(([id, r]) =>
  Object.entries(r).flatMap(([p, s]) =>
    [...s].filter(([, v]) => v === 'interrupted').map(([t]) => `${id}.${p}: ${t}`)
  )
);
if (interrupts.length)
  console.log(`interrupted, rerun on an idle machine:\n  ${interrupts.join('\n  ')}\n`);

const mutants = [...runs.keys()]
  .filter(id => id !== 'NONE')
  .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
const byMutant = {};
const byTest = new Map([...none.ci.keys()].map(t => [t, []]));
for (const id of mutants) {
  const ci = killed(id, 'ci') ?? [];
  const seeds = phases
    .filter(p => p !== 'ci')
    .map(p => ({ seed: p, killers: killed(id, p) ?? [] }));
  byMutant[id] = { ci, seeds };
  for (const t of ci) {
    if (!byTest.has(t)) byTest.set(t, []);
    byTest.get(t).push(id);
  }
}

const unique = new Map();
for (const id of mutants) if (byMutant[id].ci.length === 1) unique.set(id, byMutant[id].ci[0]);

writeFileSync(
  join(out, 'matrix.json'),
  JSON.stringify({ byMutant, byTest: Object.fromEntries(byTest) }, null, 1)
);

console.log(`tests ${byTest.size}, mutants ${mutants.length}, baseline red ${flakyBaseline.size}`);
console.log('\n# mutants: CI killers (count) | seeds: property killers per seed');
for (const id of mutants) {
  const { ci, seeds } = byMutant[id];
  const seedCol = seeds.map(s => `${s.seed}:${s.killers.length}`).join(' ');
  console.log(
    `${id}\t${ci.length}\t${seedCol}${ci.length === 0 ? '\tSURVIVES CI' : ''}${ci.length === 1 ? `\tUNIQUE ${ci[0]}` : ''}`
  );
}
const zero = [...byTest].filter(([, ids]) => ids.length === 0).map(([t]) => t);
const killingNothingUnique = [...byTest]
  .filter(([t]) => ![...unique.values()].includes(t))
  .map(([t]) => t);
console.log(
  `\ntests killing nothing: ${zero.length}; killing nothing unique: ${killingNothingUnique.length}`
);
