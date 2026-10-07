import type { SharedVersion } from 'lib/core/1.domain';
import { portfolio } from 'lib/testing/pooling/portfolio';

/**
 * Pooling in a named share scope, through to the import map. `generate-import-map.ts` maps a subpool's
 * `servedBy` copies for named scopes in `processshareScope`, a re-implementation of the global path's
 * `collectServed`/`flushServed`. Nothing else covers it.
 *
 * This pins today's behaviour, quirks included. Reusing the global helpers there would change the
 * expectations marked QUIRK, and only those.
 */
describe('pooling in a named share scope', () => {
  const SCOPE = {
    'team/a': 'http://a/',
    'team/b': 'http://b/',
    'team/legacy-a': 'http://legacy-a/',
    'team/legacy-b': 'http://legacy-b/',
  };

  let p: ReturnType<typeof portfolio>;
  beforeEach(() => {
    p = portfolio(SCOPE, { scope: 'team-x', storage: 'nf-pooling-sharescope' });
  });

  // Two 21 remotes beside a 22 majority: legacy-a's build serves legacy-b (~21.2.0 takes 21.2.18), so
  // they form a subpool on legacy-a's build.
  const seedSubpool = () => {
    p.seed('@framework/core', [
      p.version('22.0.8', '@framework/core', [
        { remote: 'team/a', req: '^22.0.0' },
        { remote: 'team/b', req: '^22.0.0' },
      ]),
      p.version('21.2.18', '@framework/core', [{ remote: 'team/legacy-a', req: '~21.2.0' }]),
      p.version('21.2.15', '@framework/core', [{ remote: 'team/legacy-b', req: '~21.2.0' }]),
    ]);
    p.seed('@framework/router', [
      p.version('22.0.8', '@framework/router', [{ remote: 'team/a', req: '^22.0.0' }]),
      p.version('21.2.18', '@framework/router', [{ remote: 'team/legacy-a', req: '~21.2.0' }]),
    ]);
  };

  // A stored copy of a legacy remote, running legacy-a's build.
  const servedByLegacyA = (version: SharedVersion): SharedVersion => ({
    ...version,
    remotes: version.remotes.map(r =>
      r.name.startsWith('team/legacy') ? { ...r, servedBy: 'team/legacy-a' } : r
    ),
  });

  it('maps each subpool member onto its build in its own scope', async () => {
    seedSubpool();

    const importMap = await p.runInit();

    expect(p.islands()).toEqual({
      'team/legacy-a': 'subpool team/legacy-a',
      'team/legacy-b': 'subpool team/legacy-a',
    });
    // A named scope publishes nothing in `imports`: every remote, the elected build's included, gets its
    // mappings in its own scope.
    expect(importMap).toEqual({
      imports: {},
      scopes: {
        'http://a/': {
          '@framework/core': 'http://a/@framework/core.js',
          '@framework/router': 'http://a/@framework/router.js',
        },
        'http://b/': { '@framework/core': 'http://a/@framework/core.js' },
        'http://legacy-a/': {
          '@framework/core': 'http://legacy-a/@framework/core.js',
          '@framework/router': 'http://legacy-a/@framework/router.js',
        },
        'http://legacy-b/': { '@framework/core': 'http://legacy-a/@framework/core.js' },
      },
    });
  });

  it('drops a servedBy specifier its build does not ship, without a warning', async () => {
    // A stored subpool whose build no longer ships router: legacy-b still names legacy-a for it. Warm, so
    // nothing re-elects the record and the map is generated from it as stored. Generated directly: the
    // unmapped specifier is the point, and the harness would refuse it.
    const stored = { poolName: 'framework', poolWinner: 'team/a' };
    p.seed(
      '@framework/core',
      [
        p.version('22.0.8', '@framework/core', [{ remote: 'team/a', req: '^22.0.0' }], 'share'),
        p.version('21.2.18', '@framework/core', [
          { remote: 'team/legacy-a', req: '~21.2.0' },
          { remote: 'team/legacy-b', req: '~21.2.0' },
        ]),
      ].map(servedByLegacyA),
      false,
      stored
    );
    p.seed(
      '@framework/router',
      [
        p.version('22.0.8', '@framework/router', [{ remote: 'team/a', req: '^22.0.0' }], 'share'),
        p.version('21.2.18', '@framework/router', [{ remote: 'team/legacy-b', req: '~21.2.0' }]),
      ].map(servedByLegacyA),
      false,
      stored
    );

    const importMap = await p.drivers.generateImportMap();

    // QUIRK: the global path warns "'team/legacy-a' does not serve '@framework/router'"; this one is silent.
    // Either way the specifier is left unmapped for legacy-b.
    expect(importMap.scopes?.['http://legacy-b/']).toEqual({
      '@framework/core': 'http://legacy-a/@framework/core.js',
    });
    expect(p.config.log.warn).not.toHaveBeenCalled();
  });
});
