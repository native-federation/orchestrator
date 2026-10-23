import fc from 'fast-check';
import type { RemoteSpec } from './generate-portfolio';
import {
  generatedImports,
  portfolioArbitrary,
  toRemoteEntries,
  toRemoteEntry,
} from './generate-portfolio';

// One pool (`@p0/m0` with its `sub`, `@p0/m1` root only) and the unpooled `extra`.
const remote = (spec: Partial<RemoteSpec> = {}): RemoteSpec => ({
  pools: [{ major: 0, minor: 0, patch: 0, range: 'caret', members: ['root+sub', 'root'] }],
  strictVersion: false,
  extra: 0,
  ...spec,
});

const shape = (spec: Partial<RemoteSpec>) => {
  const entry = toRemoteEntry(remote(spec), 0);
  return {
    shared: entry.shared.map(s => [s.packageName, s.bundle, Object.keys(s.entries)]),
    chunks: entry.chunks,
  };
};

describe('toRemoteEntry with chunks', () => {
  it('leaves an unchunked build without bundles or chunks', () => {
    expect(shape({})).toEqual({
      shared: [
        ['@p0/m0', undefined, ['@p0/m0', '@p0/m0/sub']],
        ['@p0/m1', undefined, ['@p0/m1']],
        ['extra', undefined, ['extra']],
      ],
      chunks: undefined,
    });
  });

  // Chunk names follow content (package and tag), so two builds of one tag emit the same chunk specifier.
  it('gives each package a bundle and a chunk of its own when dense', () => {
    expect(shape({ chunks: 'dense' })).toEqual({
      shared: [
        ['@p0/m0', 'browser-p0_m0', ['@p0/m0', '@p0/m0/sub']],
        ['@p0/m1', 'browser-p0_m1', ['@p0/m1']],
        ['extra', 'browser-extra', ['extra']],
      ],
      chunks: {
        'browser-p0_m0': ['chunk-p0_m0-17.0.0.js'],
        'browser-p0_m1': ['chunk-p0_m1-17.0.0.js'],
        'browser-extra': ['chunk-extra-1.0.0.js'],
      },
    });
  });

  // A flat secondary entrypoint shares its package's bundle, so one chunk serves both.
  it('ships one @nf-internal external per package bundle when flat', () => {
    expect(shape({ chunks: 'flat', flat: true })).toEqual({
      shared: [
        ['@p0/m0', 'browser-p0_m0', ['@p0/m0']],
        ['@p0/m0/sub', 'browser-p0_m0', ['@p0/m0/sub']],
        ['@p0/m1', 'browser-p0_m1', ['@p0/m1']],
        ['extra', 'browser-extra', ['extra']],
        ['@nf-internal/chunk-p0_m0-17.0.0', 'browser-p0_m0', ['@nf-internal/chunk-p0_m0-17.0.0']],
        ['@nf-internal/chunk-p0_m1-17.0.0', 'browser-p0_m1', ['@nf-internal/chunk-p0_m1-17.0.0']],
        ['@nf-internal/chunk-extra-1.0.0', 'browser-extra', ['@nf-internal/chunk-extra-1.0.0']],
      ],
      chunks: undefined,
    });
  });
});

describe('generatedImports', () => {
  it("imports the pool's first member and `extra`, when the build ships them", () => {
    const importsOf = generatedImports([
      toRemoteEntry(remote(), 0),
      toRemoteEntry(remote({ extra: null }), 1),
    ]);

    expect(importsOf('r0', '@p0/m1')).toEqual(['@p0/m0', 'extra']);
    expect(importsOf('r0', '@p0/m0/sub')).toEqual(['extra']);
    expect(importsOf('r0', '@p0/m0')).toEqual(['extra']);
    expect(importsOf('r0', 'extra')).toEqual([]);
    expect(importsOf('r1', '@p0/m1')).toEqual(['@p0/m0']);
  });
});

describe('toRemoteEntry with declared packages', () => {
  const marked = (spec: Partial<RemoteSpec>) =>
    toRemoteEntry(remote(spec), 0).shared.map(s => [
      s.packageName,
      Object.keys(s.entries),
      s.dense,
    ]);

  // The portfolio's provider skips intake, so the generator marks what intake would: every dense entry.
  it('marks a dense build and leaves a flat one unmarked', () => {
    expect(marked({})).toEqual([
      ['@p0/m0', ['@p0/m0', '@p0/m0/sub'], true],
      ['@p0/m1', ['@p0/m1'], true],
      ['extra', ['extra'], true],
    ]);
    expect(marked({ flat: true }).map(([, , dense]) => dense)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });

  // `build: 'paths'`: each entrypoint its own dense package, a secondary without its root included.
  it('ships each entrypoint as a package of its own, over flat', () => {
    expect(
      marked({
        dense: true,
        flat: true,
        pools: [{ major: 0, minor: 0, patch: 0, range: 'caret', members: ['root+sub', 'sub'] }],
      })
    ).toEqual([
      ['@p0/m0', ['@p0/m0'], true],
      ['@p0/m0/sub', ['@p0/m0/sub'], true],
      ['@p0/m1/sub', ['@p0/m1/sub'], true],
      ['extra', ['extra'], true],
    ]);
  });

  it('gives a declared secondary a chunk of its own', () => {
    const { chunks } = toRemoteEntry(remote({ dense: true, chunks: 'dense' }), 0);
    expect(Object.keys(chunks!)).toEqual([
      'browser-p0_m0',
      'browser-p0_m0_sub',
      'browser-p0_m1',
      'browser-extra',
    ]);
  });

  // Fixed seed: guards that the opt-in dimension reaches the case the declared-package rule is about, a
  // declared `/sub` package beside another build's copy of the same `/sub` as an entry of its package.
  it('draws declared and undeclared copies of one secondary in one portfolio', () => {
    const portfolios = fc.sample(portfolioArbitrary({ flat: true, dense: true }), {
      seed: 42,
      numRuns: 100,
    });
    const mixed = portfolios.filter(spec => {
      const infos = toRemoteEntries(spec).flatMap(e => e.shared);
      return infos.some(
        declared =>
          declared.dense &&
          declared.packageName.endsWith('/sub') &&
          infos.some(
            other =>
              other.packageName !== declared.packageName && declared.packageName in other.entries
          )
      );
    });
    expect(mixed.length).toBeGreaterThan(25);
  });
});
