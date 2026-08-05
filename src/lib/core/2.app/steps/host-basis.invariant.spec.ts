import { createProcessRemoteEntries } from './process-remote-entries';
import { createDetermineSharedExternals } from './determine-shared-externals';
import { createMarkPoolsForReelection } from './pooling/mark-pools-for-reelection';
import { createPoolSharedExternals } from './pooling/pool-shared-externals';
import { createChunkRepository } from 'lib/core/3.adapters/storage/chunk.repository';
import { createRemoteInfoRepository } from 'lib/core/3.adapters/storage/remote-info.repository';
import { createScopedExternalsRepository } from 'lib/core/3.adapters/storage/scoped-externals.repository';
import { createSharedExternalsRepository } from 'lib/core/3.adapters/storage/shared-externals.repository';
import { createVersionCheck } from 'lib/core/3.adapters/checks/version.check';
import { createStorageHandlerMock } from 'lib/testing/handlers/storage.mock';
import { mockConfig } from 'lib/testing/config.mock';
import type { DrivingContract } from '../driving-ports/driving.contract';
import type { RemoteEntry } from 'lib/core/1.domain';

/**
 * On a version flagged `host`, `remotes[0]` is the host's copy — what the import map publishes and what
 * eviction reads to decide when the flag lapses (`shared-externals.repository.ts`).
 *
 * Nothing enforces it locally; it is the product of three decisions this spec pulls at in turn:
 * `addRemoteToVersion` unshifts the host and then freezes the leader, `applyWinner` never splits the winner
 * (host precedence always makes the host's version the winner), and pooling's `rebuildMember` sorts the
 * elected basis first — the host, since a host is never islanded, torn, or anchored elsewhere.
 */

type Dep = { pkg: string; version: string; req?: string; strict?: boolean };

const entry = (
  name: string,
  deps: Dep[],
  o: { host?: boolean; override?: boolean } = {}
): RemoteEntry =>
  ({
    name,
    url: `http://${name.replace('/', '-')}/remoteEntry.json`,
    exposes: [],
    shared: deps.map(d => ({
      packageName: d.pkg,
      singleton: true,
      strictVersion: d.strict ?? true,
      requiredVersion: d.req ?? `^${d.version}`,
      version: d.version,
      entries: { [d.pkg]: `${d.pkg.replace(/[@/]/g, '_')}-${d.version}.js` },
    })),
    ...(o.host ? { host: true } : {}),
    ...(o.override ? { override: true } : {}),
  }) as unknown as RemoteEntry;

function setup(pooling: boolean) {
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
  config.feature.useAutoExternalPooling = pooling;

  ports.remoteInfoRepo.addOrUpdate('host', { scopeUrl: 'http://host/', exposes: [] });
  for (const n of ['team/mfe1', 'team/mfe2', 'team/mfe3']) {
    ports.remoteInfoRepo.addOrUpdate(n, { scopeUrl: `http://${n.replace('/', '-')}/`, exposes: [] });
  }

  return {
    ports,
    process: createProcessRemoteEntries(config, ports),
    mark: createMarkPoolsForReelection(config, ports),
    determine: createDetermineSharedExternals(config, ports),
    pool: createPoolSharedExternals(config, ports),
  };
}

const violations = (ports: DrivingContract, host = 'host') => {
  const out: string[] = [];
  for (const scope of ports.sharedExternalsRepo.getScopes()) {
    for (const [name, external] of Object.entries(ports.sharedExternalsRepo.getFromScope(scope))) {
      for (const v of external.versions) {
        const at = v.remotes.findIndex(r => r.name === host);
        const label = `${scope}/${name}@${v.tag} (${v.action})`;
        if (v.host && at !== 0) {
          out.push(`${label} is flagged but leads with ${v.remotes[0]?.name ?? '∅'} (host at ${at})`);
        }
        if (!v.host && at !== -1) {
          out.push(`${label} carries the host at ${at} but is not flagged`);
        }
      }
    }
  }
  return out;
};

const FAMILY = '@framework';

describe('the host stays at remotes[0]', () => {
  it('host arrives last, on a tag other remotes already hold', async () => {
    const { ports, process, determine } = setup(false);

    await process([
      entry('team/mfe1', [{ pkg: 'dep-a', version: '2.0.0' }]),
      entry('team/mfe2', [{ pkg: 'dep-a', version: '2.0.0' }]),
      entry('host', [{ pkg: 'dep-a', version: '2.0.0' }], { host: true }),
    ]);
    await determine();

    expect(violations(ports)).toEqual([]);
  });

  it('host is outranked on coverage by a wider copy of its own tag', async () => {
    const { ports, process, determine } = setup(false);

    // mfe1 declares two entrypoints of dep-a, the host only one. Coverage would promote mfe1.
    const wide = entry('team/mfe1', [{ pkg: 'dep-a', version: '2.0.0' }]);
    (wide.shared[0] as { entries: Record<string, string> }).entries['dep-a/sub'] = 'sub.js';

    await process([wide, entry('host', [{ pkg: 'dep-a', version: '2.0.0' }], { host: true })]);
    await determine();

    expect(violations(ports)).toEqual([]);
  });

  it('a non-host remote on the host version is evicted', async () => {
    const { ports, process, determine } = setup(false);

    await process([
      entry('host', [{ pkg: 'dep-a', version: '2.0.0' }], { host: true }),
      entry('team/mfe1', [{ pkg: 'dep-a', version: '2.0.0' }]),
    ]);
    await process([entry('team/mfe1', [{ pkg: 'dep-a', version: '3.0.0' }], { override: true })]);
    await determine();

    expect(violations(ports)).toEqual([]);
  });

  it('pooled family, host present, one remote islanded across a major gap', async () => {
    const { ports, process, mark, determine, pool } = setup(true);

    await process([
      entry(
        'host',
        [
          { pkg: `${FAMILY}/core`, version: '22.0.5' },
          { pkg: `${FAMILY}/router`, version: '22.0.5' },
        ],
        { host: true }
      ),
      entry('team/mfe1', [
        { pkg: `${FAMILY}/core`, version: '22.0.5' },
        { pkg: `${FAMILY}/router`, version: '22.0.5' },
      ]),
      entry('team/mfe2', [
        { pkg: `${FAMILY}/core`, version: '22.1.0' },
        { pkg: `${FAMILY}/router`, version: '22.1.0' },
      ]),
      // Previous major: incompatible, so gate 1 islands it family-wide.
      entry('team/mfe3', [
        { pkg: `${FAMILY}/core`, version: '21.0.0', req: '~21.0.0' },
        { pkg: `${FAMILY}/router`, version: '21.0.0', req: '~21.0.0' },
      ]),
    ]);
    await mark();
    await determine();
    await pool();

    expect(violations(ports)).toEqual([]);
  });

  it('pooled family where the host is not the widest build', async () => {
    const { ports, process, mark, determine, pool } = setup(true);

    // The host ships only core; mfe1 ships the whole family and is the better anchor for mfe2.
    await process([
      entry('host', [{ pkg: `${FAMILY}/core`, version: '22.0.5' }], { host: true }),
      entry('team/mfe1', [
        { pkg: `${FAMILY}/core`, version: '22.0.5' },
        { pkg: `${FAMILY}/router`, version: '22.0.5' },
        { pkg: `${FAMILY}/forms`, version: '22.0.5' },
      ]),
      entry('team/mfe2', [
        { pkg: `${FAMILY}/core`, version: '22.0.5' },
        { pkg: `${FAMILY}/router`, version: '22.0.5' },
      ]),
    ]);
    await mark();
    await determine();
    await pool();

    expect(violations(ports)).toEqual([]);
  });

  // The shape eviction has to handle: the host leaves a version whose other copies stay.
  it('host moves off a tag it shared with another remote', async () => {
    const { ports, process, determine } = setup(false);

    await process([
      entry('host', [{ pkg: 'dep-a', version: '2.0.0' }], { host: true }),
      entry('team/mfe1', [{ pkg: 'dep-a', version: '2.0.0' }]),
      entry('team/mfe2', [{ pkg: 'dep-a', version: '1.0.0' }]),
    ]);
    await process([
      entry('host', [{ pkg: 'dep-a', version: '1.0.0' }], { host: true, override: true }),
    ]);
    await determine();

    expect(violations(ports)).toEqual([]);
    const versions = ports.sharedExternalsRepo.tryGet('dep-a').get()!.versions;
    expect(versions.find(v => v.host)?.tag).toBe('1.0.0');
  });

  it('host downgrades onto a tag another remote already leads', async () => {
    const { ports, process, mark, determine, pool } = setup(true);

    await process([
      entry('host', [{ pkg: `${FAMILY}/core`, version: '22.1.0' }], { host: true }),
      entry('team/mfe1', [{ pkg: `${FAMILY}/core`, version: '22.0.5' }]),
      entry('team/mfe2', [{ pkg: `${FAMILY}/core`, version: '22.0.5' }]),
    ]);
    await process([
      entry('host', [{ pkg: `${FAMILY}/core`, version: '22.0.5' }], { host: true, override: true }),
    ]);
    await mark();
    await determine();
    await pool();

    expect(violations(ports)).toEqual([]);
  });
});
