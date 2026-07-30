import type { SharedVersionAction } from 'lib/core/1.domain';
import { mockVersionRemote } from 'lib/testing/domain/externals/version.mock';
import { createVersionCheck } from 'lib/core/3.adapters/checks/version.check';
import { buildAcceptanceTable, buildInstances, consumedMembers } from './family-instance';
import {
  coveredBySingleInstance,
  currentSharedTags,
  electInstances,
  packageGroups,
  packageOf,
} from './elect-instance';
import type { PoolMember } from './pool.types';

const { isCompatible } = createVersionCheck();

type VersionShape = {
  tag: string;
  action?: SharedVersionAction;
  host?: boolean;
  remotes: { remote: string; req?: string; strict?: boolean }[];
};

const member = (name: string, versions: VersionShape[]): PoolMember => ({
  name,
  external: {
    dirty: false,
    versions: versions.map(v => ({
      tag: v.tag,
      host: v.host ?? false,
      action: v.action ?? 'skip',
      remotes: v.remotes.map(r =>
        mockVersionRemote(r.remote, name, {
          requiredVersion: r.req ?? '^22.0.0',
          strictVersion: r.strict ?? true,
        })
      ),
    })),
  },
});

// Runs election the way the step does.
const elect = (members: PoolMember[]) => {
  const instances = buildInstances(members);
  const acceptance = buildAcceptanceTable(instances, members, isCompatible);
  return Object.fromEntries(
    electInstances(members, instances, acceptance, consumedMembers(members))
  );
};

describe('packageOf', () => {
  it.each([
    ['@angular/core', '@angular/core'],
    ['@angular/core/primitives/di', '@angular/core'],
    ['@angular/cdk/dialog', '@angular/cdk'],
    ['rxjs', 'rxjs'],
    ['rxjs/operators', 'rxjs'],
  ])('%s -> %s', (name, expected) => {
    expect(packageOf(name)).toBe(expected);
  });
});

describe('packageGroups', () => {
  it('groups entrypoints with their package and drops members no live instance ships', () => {
    const members = [
      member('@ng/core', [{ tag: '22.0.8', action: 'share', remotes: [{ remote: 'a' }] }]),
      member('@ng/core/signals', [{ tag: '22.0.8', action: 'share', remotes: [{ remote: 'a' }] }]),
      member('@ng/router', [{ tag: '22.0.8', action: 'share', remotes: [{ remote: 'a' }] }]),
      // Only provider was scoped, so no instance can serve it.
      member('@ng/animations', [{ tag: '21.0.0', action: 'scope', remotes: [{ remote: 'b' }] }]),
    ];

    const groups = packageGroups(members, buildInstances(members));

    expect(Object.fromEntries(groups)).toEqual({
      '@ng/core': ['@ng/core', '@ng/core/signals'],
      '@ng/router': ['@ng/router'],
    });
  });
});

describe('coveredBySingleInstance', () => {
  const members = [
    member('@ng/core', [{ tag: '22.0.0', action: 'share', remotes: [{ remote: 'a' }] }]),
    member('@ng/router', [{ tag: '22.0.0', action: 'share', remotes: [{ remote: 'a' }] }]),
  ];

  it('is true when one build offers every shared member at the shared tag', () => {
    expect(coveredBySingleInstance(buildInstances(members), currentSharedTags(members))).toBe(true);
  });

  it('is false once a member is served from a build that lacks a sibling', () => {
    const split = [
      member('@ng/core', [
        { tag: '22.0.5', action: 'share', remotes: [{ remote: 'b', req: '~22.0.5' }] },
        { tag: '22.1.0', remotes: [{ remote: 'a' }] },
      ]),
      member('@ng/router', [{ tag: '22.1.0', action: 'share', remotes: [{ remote: 'a' }] }]),
    ];

    expect(coveredBySingleInstance(buildInstances(split), currentSharedTags(split))).toBe(false);
  });
});

describe('electInstances', () => {
  it('prefers the instance that serves a whole family over the one that serves more ranges', () => {
    // research.md §1 Case 1. mfe-b's build is acceptable to both remotes, but it does not ship
    // router — electing it would leave mfe-a drawing two builds, which is the bug.
    const members = [
      member('@ng/core', [
        { tag: '22.0.5', action: 'share', remotes: [{ remote: 'mfe-b', req: '~22.0.5' }] },
        { tag: '22.1.0', remotes: [{ remote: 'mfe-a' }] },
      ]),
      member('@ng/router', [{ tag: '22.1.0', action: 'share', remotes: [{ remote: 'mfe-a' }] }]),
    ];

    expect(elect(members)).toEqual({ '@ng/core': '22.1.0', '@ng/router': '22.1.0' });
  });

  it('elects the superset instance when containment is directional (Case 5)', () => {
    const members = [
      member('@ng/core', [
        { tag: '22.0.0', action: 'share', remotes: [{ remote: 'remote1' }, { remote: 'remote2' }] },
      ]),
      member('@ng/common', [
        { tag: '22.0.0', action: 'share', remotes: [{ remote: 'remote1' }, { remote: 'remote2' }] },
      ]),
      member('@ng/material', [
        { tag: '22.0.0', action: 'share', remotes: [{ remote: 'remote1' }] },
      ]),
    ];

    expect(elect(members)).toEqual({
      '@ng/core': '22.0.0',
      '@ng/common': '22.0.0',
      '@ng/material': '22.0.0',
    });
  });

  it('collapses a same-minor split onto one build (Point 4)', () => {
    const members = [
      member('@ng/core', [
        { tag: '21.2.2', action: 'share', remotes: [{ remote: 'r1', req: '~21.2.0' }] },
        { tag: '21.2.3', remotes: [{ remote: 'r2', req: '~21.2.0' }] },
      ]),
      member('@ng/router', [
        { tag: '21.2.3', action: 'share', remotes: [{ remote: 'r2', req: '~21.2.0' }] },
        { tag: '21.2.2', remotes: [{ remote: 'r1', req: '~21.2.0' }] },
      ]),
    ];

    const chosen = elect(members);

    expect(new Set(Object.values(chosen)).size).toBe(1);
    expect(chosen).toEqual({ '@ng/core': '21.2.2', '@ng/router': '21.2.2' });
  });

  it('never re-points a host-pinned member', () => {
    const members = [
      member('@ng/core', [
        { tag: '22.0.5', action: 'share', host: true, remotes: [{ remote: 'host' }] },
        { tag: '22.1.0', remotes: [{ remote: 'mfe-a' }] },
      ]),
      member('@ng/router', [{ tag: '22.1.0', action: 'share', remotes: [{ remote: 'mfe-a' }] }]),
    ];

    expect(elect(members)['@ng/core']).toBe('22.0.5');
  });

  it('refuses an instance that cannot take a package whole', () => {
    // `shell` ships core but not its entrypoint sibling, so electing it would serve
    // core@22.0.6 beside core/primitives@22.0.8 — one package from two builds.
    const members = [
      member('@ng/core', [
        { tag: '22.0.8', action: 'share', remotes: [{ remote: 'app' }] },
        { tag: '22.0.6', remotes: [{ remote: 'shell' }] },
      ]),
      member('@ng/core/primitives', [
        { tag: '22.0.8', action: 'share', remotes: [{ remote: 'app' }] },
      ]),
      member('@ng/material', [
        { tag: '22.0.6', action: 'share', remotes: [{ remote: 'shell' }, { remote: 'app' }] },
      ]),
    ];

    const chosen = elect(members);

    expect(chosen['@ng/core']).toBe('22.0.8');
    expect(chosen['@ng/core/primitives']).toBe('22.0.8');
  });
});
