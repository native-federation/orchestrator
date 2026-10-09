import type { RemoteEntry, SharedVersion } from 'lib/core/1.domain';
import { mockSharedInfo } from 'lib/testing/domain/remote-entry/shared-info.mock';
import { type CopySpec, portfolio } from 'lib/testing/pooling/portfolio';
import { labelSharedInfoByNpmScope } from 'lib/testing/pooling/label-by-npm-scope';

/**
 * A copy always runs the build it ships, so a range that excludes its own version — package.json drifted
 * from the lockfile, e.g. `~19.1.0` while shipping 19.2.15 — must never make that version "incompatible"
 * with it. Before this rule each resolver punished it differently: pooled strict init threw `Could not pool`,
 * unpooled strict init threw once the external had a second version, and the dynamic path scoped the copy —
 * loading a second instance of the identical singleton build — or threw under strict. All fixtures run with
 * `strictExternalCompatibility` on, since that is where the old behaviour threw.
 */
describe('a copy accepts its own version (integration)', () => {
  const SCOPE = {
    'team/mfe-a': 'http://mfe-a/',
    'team/mfe-b': 'http://mfe-b/',
    'team/mfe-c': 'http://mfe-c/',
  };

  let p: ReturnType<typeof portfolio>;
  beforeEach(() => {
    p = portfolio(SCOPE, { storage: 'nf-own-tag-integration' });
    p.config.strict.strictExternalCompatibility = true;
  });

  // A committed `share` copy is the one the map already publishes.
  const version = (
    tag: string,
    external: string,
    remotes: CopySpec[],
    action: SharedVersion['action'] = 'skip'
  ): SharedVersion =>
    p.version(
      tag,
      external,
      remotes.map(r => ({ ...r, cached: action === 'share' })),
      action
    );

  const scopedCopies = (name: string) =>
    p
      .record(name)
      .versions.filter(v => v.action === 'scope')
      .flatMap(v => v.remotes);

  const drifted = [
    { remote: 'team/mfe-a', req: '~19.1.0' },
    { remote: 'team/mfe-b', req: '~19.1.0' },
  ];

  describe('init', () => {
    it('pools two remotes that ship one build under a range excluding it, without throwing', async () => {
      for (const name of ['@framework/core', '@framework/common'])
        p.seed(name, [version('19.2.15', name, drifted)]);

      const importMap = await p.runInit();

      expect(importMap.imports['@framework/core']).toBe('http://mfe-a/@framework/core.js');
      expect(importMap.scopes ?? {}).toEqual({});
      for (const name of ['@framework/core', '@framework/common']) {
        expect(scopedCopies(name)).toEqual([]);
        expect(
          p
            .record(name)
            .versions.flatMap(v => v.remotes)
            .some(r => r.poolCause)
        ).toBe(false);
      }
      expect(p.islands()).toEqual({});
    });

    it('shares the drifted build unpooled, once the external has a second version too', async () => {
      p.seed('dep', [
        version('19.2.15', 'dep', drifted),
        version('19.0.0', 'dep', [{ remote: 'team/mfe-c', req: '^19.0.0' }]),
      ]);

      const importMap = await p.runInit();

      expect(importMap.imports['dep']).toBe('http://mfe-a/dep.js');
      expect(importMap.scopes ?? {}).toEqual({});
      expect(p.record('dep').versions.map(v => `${v.tag}:${v.action}`)).toEqual([
        '19.2.15:share',
        '19.0.0:skip',
      ]);
    });

    it('counts a `v`-prefixed tag as the same version as its plain spelling', async () => {
      p.seed('dep', [
        version('v19.2.15', 'dep', [{ remote: 'team/mfe-a', req: '~19.1.0' }]),
        version('19.2.15', 'dep', [{ remote: 'team/mfe-b', req: '^19.2.0' }]),
      ]);

      await p.runInit();

      expect(scopedCopies('dep')).toEqual([]);
    });

    it('still refuses a strict range rejecting a version it does not ship', async () => {
      p.seed('dep', [
        version('19.2.15', 'dep', [{ remote: 'team/mfe-a', req: '^19.0.0' }]),
        version('18.0.0', 'dep', [
          { remote: 'team/mfe-b', req: '~18.0.0' },
          { remote: 'team/mfe-c', req: '~18.0.0' },
        ]),
      ]);

      // 18.0.0 costs one download against 19.2.15's two, and mfe-a's strict ^19 rejects it.

      await expect(p.runInit()).rejects.toThrow('Could not determine shared externals');
    });
  });

  describe('dynamic init', () => {
    const entryB = (names: string[]): RemoteEntry =>
      ({
        name: 'team/mfe-b',
        url: 'http://mfe-b/remoteEntry.json',
        exposes: [],
        shared: labelSharedInfoByNpmScope(
          names.map(name =>
            mockSharedInfo(name, {
              requiredVersion: '~19.1.0',
              version: '19.2.15',
              singleton: true,
              strictVersion: true,
            })
          )
        ),
      }) as RemoteEntry;

    it('dedups a joiner onto the shared build it ships itself, not a second instance of it', async () => {
      p.seed(
        'dep',
        [version('19.2.15', 'dep', [{ remote: 'team/mfe-a', req: '^19.0.0' }], 'share')],
        false
      );

      const { actions, importMap } = await p.runDynamic(entryB(['dep']));

      expect(actions['dep']!.action).toBe('skip');
      expect(importMap.scopes?.[SCOPE['team/mfe-b']]?.['dep']).toBeUndefined();
      expect(scopedCopies('dep')).toEqual([]);
      // The drift stays visible, it just no longer costs anything.
      expect(p.config.log.warn).toHaveBeenCalledWith(
        8,
        "[team/mfe-b][dep] requiredVersion '~19.1.0' excludes its own version '19.2.15'; '19.2.15' is still accepted for it."
      );
    });

    it('lets a pooled joiner resolve its family through the committed map', async () => {
      for (const name of ['@framework/core', '@framework/common'])
        p.seed(
          name,
          [version('19.2.15', name, [{ remote: 'team/mfe-a', req: '^19.0.0' }], 'share')],
          false
        );

      const { actions, importMap } = await p.runDynamic(
        entryB(['@framework/core', '@framework/common'])
      );

      for (const name of ['@framework/core', '@framework/common']) {
        expect(actions[name]!.action).toBe('skip');
        expect(importMap.scopes?.[SCOPE['team/mfe-b']]?.[name]).toBeUndefined();
        expect(scopedCopies(name)).toEqual([]);
      }
      expect(p.islands()).toEqual({});
    });
  });
});
