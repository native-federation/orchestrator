import type { ForVersionChecking } from '../../driving-ports/for-version-checking.port';
import type { SharedVersion } from 'lib/core/1.domain';
import { mockVersionCheck } from 'lib/testing/adapters/version-check.mock';
import { mockVersionRemote } from 'lib/testing/domain/externals/version.mock';
import { classifyRemote } from './pool-classify';
import type { PoolAnchor, PoolMember } from './pool.types';

type RemoteSpec = { name: string; req?: string; strict?: boolean; cached?: boolean };

const version = (tag: string, remotes: RemoteSpec[], host = false): SharedVersion => ({
  tag,
  host,
  action: 'skip',
  remotes: remotes.map(r =>
    mockVersionRemote(r.name, 'ext', {
      requiredVersion: r.req ?? `~${tag}`,
      strictVersion: r.strict ?? true,
      cached: r.cached ?? false,
    })
  ),
});

const member = (name: string, versions: SharedVersion[]): PoolMember => ({
  name,
  external: { dirty: false, versions },
});

describe('classifyRemote', () => {
  let versionCheck: ForVersionChecking;

  beforeEach(() => {
    versionCheck = mockVersionCheck();
  });

  it('follows when compatible with the anchor tag on every member', () => {
    versionCheck.isCompatible = vi.fn(() => true);
    const members = [member('dep-a', [version('17.0.0', [{ name: 'anchor' }, { name: 'mfe1' }])])];
    const anchor: PoolAnchor = { anchorRemote: 'anchor', tagPerMember: { 'dep-a': '17.0.0' } };

    expect(classifyRemote('mfe1', members, anchor, versionCheck)).toBe('follow');
  });

  it('scopes when strict-incompatible with the anchor on a member', () => {
    versionCheck.isCompatible = vi.fn(() => false);
    const members = [
      member('dep-a', [
        version('17.0.0', [{ name: 'anchor' }]),
        version('18.0.0', [{ name: 'mfe1', strict: true }]),
      ]),
    ];
    const anchor: PoolAnchor = { anchorRemote: 'anchor', tagPerMember: { 'dep-a': '17.0.0' } };

    expect(classifyRemote('mfe1', members, anchor, versionCheck)).toBe('scope');
  });

  it('is all-or-nothing: scopes the whole family when incompatible on ANY member', () => {
    // mfe1 is compatible on dep-a (req 'ok') but strict-incompatible on dep-b (req 'bad').
    versionCheck.isCompatible = vi.fn((_v, r) => r === 'ok');
    const members = [
      member('dep-a', [version('17.0.0', [{ name: 'anchor' }, { name: 'mfe1', req: 'ok' }])]),
      member('dep-b', [
        version('17.0.0', [{ name: 'anchor' }]),
        version('18.0.0', [{ name: 'mfe1', req: 'bad', strict: true }]),
      ]),
    ];
    const anchor: PoolAnchor = {
      anchorRemote: 'anchor',
      tagPerMember: { 'dep-a': '17.0.0', 'dep-b': '17.0.0' },
    };

    expect(classifyRemote('mfe1', members, anchor, versionCheck)).toBe('scope');
  });

  it('tolerates a non-strict incompatibility (follow)', () => {
    versionCheck.isCompatible = vi.fn(() => false);
    const members = [
      member('dep-a', [
        version('17.0.0', [{ name: 'anchor' }]),
        version('18.0.0', [{ name: 'mfe1', strict: false }]),
      ]),
    ];
    const anchor: PoolAnchor = { anchorRemote: 'anchor', tagPerMember: { 'dep-a': '17.0.0' } };

    expect(classifyRemote('mfe1', members, anchor, versionCheck)).toBe('follow');
  });

  it('skips members the remote does not provide', () => {
    versionCheck.isCompatible = vi.fn(() => true);
    const members = [
      member('dep-a', [version('17.0.0', [{ name: 'anchor' }, { name: 'mfe1' }])]),
      member('dep-b', [version('17.0.0', [{ name: 'anchor' }])]), // mfe1 absent
    ];
    const anchor: PoolAnchor = {
      anchorRemote: 'anchor',
      tagPerMember: { 'dep-a': '17.0.0', 'dep-b': '17.0.0' },
    };

    expect(classifyRemote('mfe1', members, anchor, versionCheck)).toBe('follow');
  });

  it('scopes when the anchor does not cover a member', () => {
    versionCheck.isCompatible = vi.fn(() => true);
    const members = [member('dep-a', [version('17.0.0', [{ name: 'anchor' }, { name: 'mfe1' }])])];
    const anchor: PoolAnchor = { anchorRemote: 'anchor', tagPerMember: {} };

    expect(classifyRemote('mfe1', members, anchor, versionCheck)).toBe('scope');
  });

  it('ignores the cached flag (deterministic)', () => {
    versionCheck.isCompatible = vi.fn(() => false);
    const anchor: PoolAnchor = { anchorRemote: 'anchor', tagPerMember: { 'dep-a': '17.0.0' } };
    const scenario = (cached: boolean) =>
      classifyRemote(
        'mfe1',
        [
          member('dep-a', [
            version('17.0.0', [{ name: 'anchor' }]),
            version('18.0.0', [{ name: 'mfe1', strict: true, cached }]),
          ]),
        ],
        anchor,
        versionCheck
      );

    expect(scenario(true)).toBe(scenario(false));
    expect(scenario(true)).toBe('scope');
  });
});
