import type { SharedVersionAction } from 'lib/core/1.domain';
import { mockVersionRemote } from 'lib/testing/domain/externals/version.mock';
import {
  buildInstances,
  consumedMembers,
  findDisagreement,
  minorLine,
  servingBuilds,
} from './family-instance';
import type { PoolMember } from './pool.types';

type VersionShape = {
  tag: string;
  action?: SharedVersionAction;
  host?: boolean;
  remotes: { remote: string; req?: string }[];
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
        mockVersionRemote(r.remote, name, { requiredVersion: r.req ?? '^22.0.0' })
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

describe('servingBuilds', () => {
  const none = new Set<string>();

  it('names the build behind each shared member', () => {
    expect(Object.fromEntries(servingBuilds(CASE_1, none))).toEqual({
      '@angular/core': 'mfe-b',
      '@angular/router': 'mfe-a',
    });
  });

  it('leaves a member unserved once islanding took every copy that could serve it', () => {
    const serving = servingBuilds(CASE_1, new Set(['mfe-a']));

    expect(serving.get('@angular/core')).toBe('mfe-b');
    expect(serving.has('@angular/router')).toBe(false);
  });
});

describe('minorLine', () => {
  it.each([
    ['22.0.5', '22.0'],
    ['22.1.0', '22.1'],
    ['21.2.18', '21.2'],
    ['1.2.3-beta.1', '1.2'],
    ['17', '17'],
  ])('%s -> %s', (tag, line) => {
    expect(minorLine(tag)).toBe(line);
  });
});

describe('findDisagreement', () => {
  const instances = (shapes: Record<string, Record<string, string>>) =>
    new Map(Object.entries(shapes).map(([remote, i]) => [remote, new Map(Object.entries(i))]));

  it('accepts patch drift within one minor line', () => {
    // The benign shape: two builds a remote may safely draw on (research.md §14).
    const found = findDisagreement(
      instances({ a: { core: '22.0.8', cdk: '22.0.8' }, b: { core: '22.0.6' } }),
      ['a', 'b']
    );

    expect(found).toBeUndefined();
  });

  it('reports a member the builds place on different minor lines', () => {
    expect(
      findDisagreement(
        instances({ 'mfe-a': { core: '22.1.0', router: '22.1.0' }, 'mfe-b': { core: '22.0.5' } }),
        ['mfe-a', 'mfe-b']
      )
    ).toEqual({ member: 'core', tag: '22.1.0', other: '22.0.5' });
  });

  it('reports a cross-major split', () => {
    expect(
      findDisagreement(instances({ ng21: { core: '21.2.18' }, ng22: { core: '22.0.8' } }), [
        'ng21',
        'ng22',
      ])
    ).toEqual({ member: 'core', tag: '21.2.18', other: '22.0.8' });
  });

  it('ignores members the two builds do not share', () => {
    expect(
      findDisagreement(instances({ a: { core: '22.0.8' }, b: { material: '21.0.0' } }), ['a', 'b'])
    ).toBeUndefined();
  });

  it('compares every pair, not just neighbours', () => {
    expect(
      findDisagreement(
        instances({ a: { core: '22.0.8' }, b: { material: '3.0.0' }, c: { core: '21.2.0' } }),
        ['a', 'b', 'c']
      )
    ).toEqual({ member: 'core', tag: '22.0.8', other: '21.2.0' });
  });
});
