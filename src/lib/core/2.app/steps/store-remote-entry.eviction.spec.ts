import { createProcessRemoteEntries } from './process-remote-entries';
import { createDetermineSharedExternals } from './determine-shared-externals';
import { createGenerateImportMap } from './generate-import-map';
import { createUpdateCache } from './update-cache';
import { createConvertToImportMap } from './convert-to-import-map';
import { createChunkRepository } from 'lib/core/3.adapters/storage/chunk.repository';
import { createRemoteInfoRepository } from 'lib/core/3.adapters/storage/remote-info.repository';
import { createScopedExternalsRepository } from 'lib/core/3.adapters/storage/scoped-externals.repository';
import { createSharedExternalsRepository } from 'lib/core/3.adapters/storage/shared-externals.repository';
import { createVersionCheck } from 'lib/core/3.adapters/checks/version.check';
import { createStorageHandlerMock } from 'lib/testing/handlers/storage.mock';
import { mockConfig } from 'lib/testing/config.mock';
import type { DrivingContract } from '../driving-ports/driving.contract';
import type { RemoteEntry } from 'lib/core/1.domain';

// Against the real repositories, not `remove()` call assertions: both cases are about state surviving the
// purge and reaching the import map, which a mocked repository cannot show.

const remotes = { host: 3000, 'team/mfe1': 3001, 'team/mfe2': 3002 } as const;
type Name = keyof typeof remotes;

const scopeOf = (name: Name) => `http://localhost:${remotes[name]}/`;

const entry = (
  name: Name,
  o: {
    dep?: string;
    chunks?: Record<string, string[]>;
    exposes?: { key: string; outFileName: string }[];
    host?: boolean;
    override?: boolean;
  } = {}
): RemoteEntry =>
  ({
    name,
    url: `${scopeOf(name)}remoteEntry.json`,
    exposes: o.exposes ?? [],
    shared: o.dep
      ? [
          {
            packageName: 'dep-a',
            singleton: true,
            strictVersion: true,
            requiredVersion: `~${o.dep}`,
            version: o.dep,
            entries: { 'dep-a': `dep-a-${o.dep}.js` },
          },
        ]
      : [],
    ...(o.chunks ? { chunks: o.chunks } : {}),
    ...(o.host ? { host: true } : {}),
    ...(o.override ? { override: true } : {}),
  }) as unknown as RemoteEntry;

function setup() {
  const storageRef: Record<string, unknown> = {};
  const storage = { storage: createStorageHandlerMock(storageRef), clearStorage: false };
  const ports = {
    remoteInfoRepo: createRemoteInfoRepository(storage),
    scopedExternalsRepo: createScopedExternalsRepository(storage),
    sharedExternalsRepo: createSharedExternalsRepository(storage),
    sharedChunksRepo: createChunkRepository(storage),
    versionCheck: createVersionCheck(),
  } as unknown as DrivingContract;
  const config = mockConfig();

  return {
    ports,
    processRemoteEntries: createProcessRemoteEntries(config, ports),
    determineSharedExternals: createDetermineSharedExternals(config, ports),
    generateImportMap: createGenerateImportMap(config, ports),
    updateCache: createUpdateCache(config, ports),
    convertToImportMap: createConvertToImportMap(config, ports),
  };
}

describe('evicting an overridden remote', () => {
  describe('shared chunks', () => {
    // `mapping-or-exposed` is registered for every remote, and a build with no chunk for it omits the key
    // rather than sending an empty list — so merging the replacement clears nothing.
    const withChunk = () =>
      entry('team/mfe1', {
        exposes: [{ key: './comp', outFileName: 'comp-V1.js' }],
        chunks: { 'mapping-or-exposed': ['chunk-OLD.js'] },
      });
    const withoutChunk = () =>
      entry('team/mfe1', {
        exposes: [{ key: './comp', outFileName: 'comp-V2.js' }],
        override: true,
      });

    it('drops the chunks of the replaced build on the init path', async () => {
      const { processRemoteEntries, generateImportMap } = setup();

      await processRemoteEntries([withChunk()]);
      await processRemoteEntries([withoutChunk()]);

      const importMap = await generateImportMap();

      expect(importMap.imports['team/mfe1/./comp']).toBe(`${scopeOf('team/mfe1')}comp-V2.js`);
      expect(importMap.scopes?.[scopeOf('team/mfe1')]).toBeUndefined();
    });

    it('drops the chunks of the replaced build on the dynamic path', async () => {
      const { processRemoteEntries, updateCache, convertToImportMap } = setup();

      await processRemoteEntries([withChunk()]);
      const importMap = await convertToImportMap(await updateCache(withoutChunk()));

      expect(importMap.scopes?.[scopeOf('team/mfe1')]).toBeUndefined();
    });

    it('keeps the chunks a remote no override touched', async () => {
      const { processRemoteEntries, generateImportMap } = setup();

      await processRemoteEntries([
        withChunk(),
        entry('team/mfe2', { chunks: { 'mapping-or-exposed': ['chunk-MFE2.js'] } }),
      ]);
      await processRemoteEntries([withoutChunk()]);

      const importMap = await generateImportMap();

      expect(importMap.scopes?.[scopeOf('team/mfe2')]).toEqual({
        '@nf-internal/chunk-MFE2': `${scopeOf('team/mfe2')}chunk-MFE2.js`,
      });
    });
  });

  describe('the host flag', () => {
    // A version the host shares keeps its copies when the host leaves, so unless the flag leaves too,
    // `determine` keeps electing the tag it moved off. See host-basis.invariant.spec.ts for the rule.
    const portfolio = () => [
      entry('host', { dep: '2.0.0', host: true }),
      entry('team/mfe1', { dep: '1.0.0' }),
      entry('team/mfe2', { dep: '2.0.0' }),
    ];

    it('follows the host onto the version it moves to', async () => {
      const { ports, processRemoteEntries, determineSharedExternals } = setup();

      await processRemoteEntries(portfolio());
      await processRemoteEntries([entry('host', { dep: '1.0.0', host: true, override: true })]);
      await determineSharedExternals();

      const versions = ports.sharedExternalsRepo.tryGet('dep-a').get()!.versions;
      expect(versions.find(v => v.host)?.tag).toBe('1.0.0');
      expect(versions.find(v => v.tag === '1.0.0')!.action).toBe('share');
      expect(versions.find(v => v.tag === '2.0.0')!.action).not.toBe('share');
    });

    it('leaves no host version behind when the host stops declaring the external', async () => {
      const { ports, processRemoteEntries } = setup();

      await processRemoteEntries(portfolio());
      await processRemoteEntries([entry('host', { host: true, override: true })]);

      const versions = ports.sharedExternalsRepo.tryGet('dep-a').get()!.versions;
      expect(versions.some(v => v.host)).toBe(false);
      expect(versions.map(v => v.tag)).toEqual(['2.0.0', '1.0.0']);
    });

    it('keeps the flag on a version the host stays on', async () => {
      const { ports, processRemoteEntries } = setup();

      await processRemoteEntries(portfolio());
      await processRemoteEntries([entry('host', { dep: '2.0.0', host: true, override: true })]);

      const versions = ports.sharedExternalsRepo.tryGet('dep-a').get()!.versions;
      expect(versions.find(v => v.host)?.tag).toBe('2.0.0');
    });
  });
});
