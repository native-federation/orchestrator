import type { SharedVersionAction } from 'lib/core/1.domain';
import { mockVersionRemote } from 'lib/testing/domain/externals/version.mock';
import { createVersionCheck } from 'lib/core/3.adapters/checks/version.check';
import {
  buildAcceptanceTable,
  buildInstances,
  canTakeAllFrom,
  consumedMembers,
  hostPinnedTags,
  singleProviderMembers,
} from './family-instance';
import type { ChosenTags, PoolMember } from './pool.types';

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

// research.md §1 Case 1: mfe-b pins core to ~22.0.5, so determine shares core from mfe-b's build
// while router - which only mfe-a provides - stays on mfe-a's 22.1.0.
const CASE_1: PoolMember[] = [
  member('@angular/core', [
    { tag: '22.0.5', action: 'share', remotes: [{ remote: 'mfe-b', req: '~22.0.5' }] },
    { tag: '22.1.0', remotes: [{ remote: 'mfe-a' }] },
  ]),
  member('@angular/router', [{ tag: '22.1.0', action: 'share', remotes: [{ remote: 'mfe-a' }] }]),
];

// research.md §1 Case 2: the host ships core and no router, so host precedence pins core.
const CASE_2: PoolMember[] = [
  member('@angular/core', [
    { tag: '22.0.5', action: 'share', host: true, remotes: [{ remote: 'host' }] },
    { tag: '22.1.0', remotes: [{ remote: 'mfe-a' }] },
  ]),
  member('@angular/router', [{ tag: '22.1.0', action: 'share', remotes: [{ remote: 'mfe-a' }] }]),
];

// research.md §1 Case 3, reduced: the Angular-21 remote is islanded on core (determine marked it
// `scope`) but is the SOLE provider of animations, which it still shares at 21.2.18.
const CASE_3: PoolMember[] = [
  member('@angular/core', [
    { tag: '22.0.8', action: 'share', remotes: [{ remote: 'approve' }, { remote: 'mutations' }] },
    { tag: '21.2.18', action: 'scope', remotes: [{ remote: 'form-overview', req: '^21.0.0' }] },
  ]),
  member('@angular/animations', [
    { tag: '21.2.18', action: 'share', remotes: [{ remote: 'form-overview', req: '^21.0.0' }] },
  ]),
];

// research.md §15.2 Case 5: remote1 = {core, common, material}, remote2 = {core, common}.
const CASE_5: PoolMember[] = [
  member('@ng/core', [
    { tag: '22.0.0', action: 'share', remotes: [{ remote: 'remote1' }, { remote: 'remote2' }] },
  ]),
  member('@ng/common', [
    { tag: '22.0.0', action: 'share', remotes: [{ remote: 'remote1' }, { remote: 'remote2' }] },
  ]),
  member('@ng/material', [{ tag: '22.0.0', action: 'share', remotes: [{ remote: 'remote1' }] }]),
];

// research.md §13.3 Point 4: r1 core+router@21.2.2, r2 core+router@21.2.3, both require ~21.2.0,
// winners split across the two builds.
const POINT_4: PoolMember[] = [
  member('@ng/core', [
    { tag: '21.2.2', action: 'share', remotes: [{ remote: 'r1', req: '~21.2.0' }] },
    { tag: '21.2.3', remotes: [{ remote: 'r2', req: '~21.2.0' }] },
  ]),
  member('@ng/router', [
    { tag: '21.2.3', action: 'share', remotes: [{ remote: 'r2', req: '~21.2.0' }] },
    { tag: '21.2.2', remotes: [{ remote: 'r1', req: '~21.2.0' }] },
  ]),
];

// research.md §15.1 rule 4: `loose` declared `strictVersion: false`, i.e. it would rather be deduped
// than hold its own copy. determine marks such a version `skip` even when its range rejects the
// winner, so pooling must not island it either.
const LOOSE = (strict: boolean): PoolMember[] => [
  member('@ng/core', [
    { tag: '22.0.8', action: 'share', remotes: [{ remote: 'up-to-date' }] },
    { tag: '21.2.18', remotes: [{ remote: 'loose', req: '^21.0.0', strict }] },
  ]),
  member('@ng/router', [
    { tag: '22.0.8', action: 'share', remotes: [{ remote: 'up-to-date' }] },
    { tag: '21.2.18', remotes: [{ remote: 'loose', req: '^21.0.0', strict }] },
  ]),
];

const shape = (instances: Map<string, Map<string, string>>) =>
  Object.fromEntries([...instances].map(([remote, i]) => [remote, Object.fromEntries(i)]));

describe('buildInstances', () => {
  it('maps every remote to the members it ships and the tag it ships them at', () => {
    expect(shape(buildInstances(CASE_1))).toEqual({
      'mfe-a': { '@angular/core': '22.1.0', '@angular/router': '22.1.0' },
      'mfe-b': { '@angular/core': '22.0.5' },
    });
  });

  it('never counts a `scope` version: determine refused it, pooling does not promote it', () => {
    expect(shape(buildInstances(CASE_3))['form-overview']).toEqual({
      '@angular/animations': '21.2.18',
    });
  });

  it('drops an islanded remote entirely, including members it solely provides', () => {
    // The capture's failure: without this, animations@21.2.18 stays shared beside core@22.0.8.
    const instances = buildInstances(CASE_3, new Set(['form-overview']));

    expect(instances.has('form-overview')).toBe(false);
    expect(shape(instances)).toEqual({
      approve: { '@angular/core': '22.0.8' },
      mutations: { '@angular/core': '22.0.8' },
    });
  });

  it('keeps the asymmetric shapes distinguishable (Case 5)', () => {
    expect(shape(buildInstances(CASE_5))).toEqual({
      remote1: { '@ng/core': '22.0.0', '@ng/common': '22.0.0', '@ng/material': '22.0.0' },
      remote2: { '@ng/core': '22.0.0', '@ng/common': '22.0.0' },
    });
  });
});

describe('consumedMembers', () => {
  it('lists what a remote must be served', () => {
    expect(Object.fromEntries(consumedMembers(CASE_1))).toEqual({
      'mfe-a': ['@angular/core', '@angular/router'],
      'mfe-b': ['@angular/core'],
    });
  });

  it('includes members whose copy was scoped, which the instance excludes', () => {
    expect(consumedMembers(CASE_3).get('form-overview')).toEqual([
      '@angular/core',
      '@angular/animations',
    ]);
  });
});

describe('buildAcceptanceTable', () => {
  it('records which offered tags each remote can take, per member', () => {
    const table = buildAcceptanceTable(buildInstances(CASE_1), CASE_1, isCompatible);

    // mfe-a's ^22.0.0 accepts both offered core tags...
    expect([...table.get('mfe-a')!.get('@angular/core')!].sort()).toEqual(['22.0.5', '22.1.0']);
    // ...while mfe-b's ~22.0.5 rejects mfe-a's build. This is what islands mfe-b in Case 1.
    expect([...table.get('mfe-b')!.get('@angular/core')!]).toEqual(['22.0.5']);
  });

  it('asks only about tags an instance actually offers', () => {
    const table = buildAcceptanceTable(buildInstances(CASE_1), CASE_1, isCompatible);

    expect([...table.get('mfe-a')!.get('@angular/router')!]).toEqual(['22.1.0']);
    expect(table.get('mfe-b')!.has('@angular/router')).toBe(false);
  });

  it('accepts both directions when the ranges are honest about the drift (Point 4)', () => {
    const table = buildAcceptanceTable(buildInstances(POINT_4), POINT_4, isCompatible);

    for (const remote of ['r1', 'r2']) {
      for (const name of ['@ng/core', '@ng/router']) {
        expect([...table.get(remote)!.get(name)!].sort()).toEqual(['21.2.2', '21.2.3']);
      }
    }
  });

  it('lets a `strictVersion: false` remote accept every offered tag', () => {
    const members = LOOSE(false);
    const table = buildAcceptanceTable(buildInstances(members), members, isCompatible);

    // Its ^21.0.0 rejects 22.0.8, but it declared it would rather dedup than hold its own copy.
    expect([...table.get('loose')!.get('@ng/core')!].sort()).toEqual(['21.2.18', '22.0.8']);
    expect(isCompatible('22.0.8', '^21.0.0')).toBe(false);
  });

  it('holds the same remote to its range once it declares `strictVersion: true`', () => {
    const members = LOOSE(true);
    const table = buildAcceptanceTable(buildInstances(members), members, isCompatible);

    expect([...table.get('loose')!.get('@ng/core')!]).toEqual(['21.2.18']);
  });

  it('asks only about offered tags, so repeats collapse onto the resolver memo', () => {
    const asked: string[] = [];
    const counting = (tag: string, requiredVersion: string) => {
      asked.push(`${tag}|${requiredVersion}`);
      return isCompatible(tag, requiredVersion);
    };

    buildAcceptanceTable(buildInstances(CASE_5), CASE_5, counting);

    // 3 members x 1 offered tag x (2, 2, 1) remotes = 5 calls, all on one distinct question.
    expect(asked).toHaveLength(5);
    expect(new Set(asked).size).toBe(1);
  });
});

describe('singleProviderMembers', () => {
  it('finds members with nothing to decide', () => {
    expect(Object.fromEntries(singleProviderMembers(buildInstances(CASE_1)))).toEqual({
      '@angular/router': 'mfe-a',
    });
  });

  it('treats a member two instances ship as contested, even at the same tag', () => {
    const sole = singleProviderMembers(buildInstances(CASE_5));

    expect(sole.has('@ng/core')).toBe(false);
    expect(sole.has('@ng/common')).toBe(false);
    expect(sole.get('@ng/material')).toBe('remote1');
  });
});

describe('canTakeAllFrom', () => {
  const consumed = consumedMembers(CASE_1);
  const acceptance = buildAcceptanceTable(buildInstances(CASE_1), CASE_1, isCompatible);
  const take = (remote: string, chosen: ChosenTags) =>
    canTakeAllFrom(acceptance, chosen, remote, consumed.get(remote)!);

  it('accepts a remote whose range covers every chosen tag', () => {
    const chosen: ChosenTags = new Map([
      ['@angular/core', '22.1.0'],
      ['@angular/router', '22.1.0'],
    ]);

    expect(take('mfe-a', chosen)).toBe(true);
  });

  it('rejects the strict pin that cannot follow the family (Case 1)', () => {
    const chosen: ChosenTags = new Map([
      ['@angular/core', '22.1.0'],
      ['@angular/router', '22.1.0'],
    ]);

    expect(take('mfe-b', chosen)).toBe(false);
  });

  it('rejects when a consumed member is served by nobody: it would have to mix in its own build', () => {
    const chosen: ChosenTags = new Map([['@angular/core', '22.1.0']]);

    expect(take('mfe-a', chosen)).toBe(false);
    // mfe-b does not consume router, so a missing router does not concern it.
    expect(take('mfe-b', new Map([['@angular/core', '22.0.5']]))).toBe(true);
  });

  it('lets a loose remote follow the family it cannot satisfy, but not a strict one', () => {
    const chosen: ChosenTags = new Map([
      ['@ng/core', '22.0.8'],
      ['@ng/router', '22.0.8'],
    ]);
    const verdict = (strict: boolean) => {
      const members = LOOSE(strict);
      const consumed = consumedMembers(members).get('loose')!;
      const acceptance = buildAcceptanceTable(buildInstances(members), members, isCompatible);
      return canTakeAllFrom(acceptance, chosen, 'loose', consumed);
    };

    expect(verdict(false)).toBe(true);
    expect(verdict(true)).toBe(false);
  });

  it('rejects the superset remote against the subset instance (Case 5)', () => {
    const consumed5 = consumedMembers(CASE_5);
    const acceptance5 = buildAcceptanceTable(buildInstances(CASE_5), CASE_5, isCompatible);
    const remote2Instance: ChosenTags = new Map([
      ['@ng/core', '22.0.0'],
      ['@ng/common', '22.0.0'],
    ]);

    // Containment is directional: remote2 fits inside remote1's instance, not the other way round.
    expect(canTakeAllFrom(acceptance5, remote2Instance, 'remote2', consumed5.get('remote2')!)).toBe(
      true
    );
    expect(canTakeAllFrom(acceptance5, remote2Instance, 'remote1', consumed5.get('remote1')!)).toBe(
      false
    );
  });
});

describe('hostPinnedTags', () => {
  it('pins every member the host declared, at the host tag', () => {
    expect(Object.fromEntries(hostPinnedTags(CASE_2))).toEqual({ '@angular/core': '22.0.5' });
  });

  it('pins nothing when no host version is present', () => {
    expect(hostPinnedTags(CASE_1).size).toBe(0);
  });
});
