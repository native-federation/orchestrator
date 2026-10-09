import type { SharedVersion } from 'lib/core/1.domain';
import { mockVersionRemote } from 'lib/testing/domain/externals/version.mock';
import { acceptsTag } from 'lib/core/1.domain/externals/compatibility';
import { createVersionCheck } from 'lib/core/3.adapters/checks/version.check';
import { electVariants } from './election';
import type { PoolMember } from './membership';
import { memberRecord, type PlacedPool } from './placement';
import { hostRemotes } from './builds';

/**
 * The records the init step writes are computed here, before any write, and nothing here may change what it
 * reads. Which rows they hold is the step's spec (`pool-shared-externals.spec.ts`).
 */
const { compare, isCompatible } = createVersionCheck();

// A pool already elected once: copies carry the verdicts of last time, which a new record must not keep and
// the read must not strip from the stored one.
const pool = (): PoolMember[] =>
  ['@x/core', '@x/common'].map(name => ({
    name,
    external: {
      dirty: true,
      poolName: 'x',
      poolWinner: 'team/a',
      versions: [
        {
          tag: '17.0.0',
          host: true,
          action: 'share',
          remotes: [
            mockVersionRemote('team/h', name, { requiredVersion: '^17.0.0' }),
            mockVersionRemote('team/a', name, { requiredVersion: '^17.0.0' }),
          ],
        },
        {
          tag: '16.0.0',
          host: false,
          action: 'scope',
          remotes: [
            mockVersionRemote('team/b', name, {
              requiredVersion: '~16.0.0',
              poolCause: 'incompatible',
            }),
            mockVersionRemote('team/c', name, { requiredVersion: '~16.0.0', servedBy: 'team/b' }),
          ],
        },
      ] satisfies SharedVersion[],
    },
  }));

describe('placement', () => {
  it('memberRecord reads an elected pool without changing it', () => {
    const members = pool();
    const before = structuredClone(members);
    const hosts = hostRemotes(members);
    const election = electVariants({
      members,
      acceptsTag: acceptsTag(isCompatible, compare),
      hosts,
      compare,
      latestFirst: false,
    });
    const placed: PlacedPool = { ...election, poolName: 'x', hosts, compare };

    const records = members.map(m => memberRecord(m, placed));

    expect(members).toEqual(before);
    // b and c run one build at 16.0.0: a subpool, so the record is new and not a copy of the stored one.
    expect(records[0]!.versions.map(v => `${v.tag}:${v.action}`)).toEqual([
      '17.0.0:share',
      '16.0.0:skip',
    ]);
  });
});
