import type { ForVersionChecking } from '../../driving-ports/for-version-checking.port';
import type { SharedVersion } from 'lib/core/1.domain';
import { mockVersionCheck } from 'lib/testing/adapters/version-check.mock';
import { mockVersionRemote } from 'lib/testing/domain/externals/version.mock';
import type { PoolMember } from './pool.types';
import { selectAnchor } from './pool-anchor';

type RemoteSpec = { name: string; req?: string; strict?: boolean; cached?: boolean };

const version = (tag: string, remotes: RemoteSpec[], host = false): SharedVersion => ({
  tag,
  host,
  action: 'skip',
  remotes: remotes.map(r =>
    mockVersionRemote(r.name, 'ext', {
      requiredVersion: r.req ?? tag,
      strictVersion: r.strict ?? true,
      cached: r.cached ?? false,
    })
  ),
});

const member = (name: string, versions: SharedVersion[]): PoolMember => ({
  name,
  external: { dirty: false, versions },
});

describe('selectAnchor', () => {
  let versionCheck: ForVersionChecking;

  beforeEach(() => {
    versionCheck = mockVersionCheck();
    // default: exact-tag equality; overridden per test where needed.
    versionCheck.isCompatible = vi.fn((v, r) => v === r);
    versionCheck.compare = vi.fn((a, b) => a.localeCompare(b));
  });

  it('returns undefined when no single remote provides every member', () => {
    const members = [
      member('dep-a', [version('17', [{ name: 'r1' }])]),
      member('dep-b', [version('17', [{ name: 'r2' }])]),
    ];

    expect(selectAnchor(members, { versionCheck, latestSharedExternal: false })).toBeUndefined();
  });

  it('maps each member to the version tag the anchor provides', () => {
    const members = [
      member('dep-a', [version('17', [{ name: 'r1' }])]),
      member('dep-b', [version('18', [{ name: 'r1' }])]),
    ];

    expect(selectAnchor(members, { versionCheck, latestSharedExternal: false })).toEqual({
      anchorRemote: 'r1',
      tagPerMember: { 'dep-a': '17', 'dep-b': '18' },
    });
  });

  it('prefers the host candidate over an otherwise-optimal one', () => {
    // r1 serves both members via host versions; r2 also serves both but non-host.
    const members = [
      member('dep-a', [version('17', [{ name: 'r1' }], true), version('18', [{ name: 'r2' }])]),
      member('dep-b', [version('17', [{ name: 'r1' }], true), version('18', [{ name: 'r2' }])]),
    ];

    expect(selectAnchor(members, { versionCheck, latestSharedExternal: false })?.anchorRemote).toBe(
      'r1'
    );
  });

  it('prefers the newest-providing candidate when latestSharedExternal is set', () => {
    const members = [
      member('dep-a', [version('17', [{ name: 'r1' }]), version('18', [{ name: 'r2' }])]),
      member('dep-b', [version('17', [{ name: 'r1' }]), version('18', [{ name: 'r2' }])]),
    ];

    expect(selectAnchor(members, { versionCheck, latestSharedExternal: true })?.anchorRemote).toBe(
      'r2'
    );
  });

  it('picks the candidate forcing the fewest remotes to scope (min-scoped)', () => {
    // r1@17, r2@18 both serve dep-a+dep-b; mfe@17 serves only dep-a (not a candidate).
    // Anchoring r1 scopes only r2; anchoring r2 scopes both r1 and mfe.
    const members = [
      member('dep-a', [
        version('17', [{ name: 'r1' }, { name: 'mfe' }]),
        version('18', [{ name: 'r2' }]),
      ]),
      member('dep-b', [version('17', [{ name: 'r1' }]), version('18', [{ name: 'r2' }])]),
    ];

    expect(selectAnchor(members, { versionCheck, latestSharedExternal: false })?.anchorRemote).toBe(
      'r1'
    );
  });

  it('breaks ties by remote name, not insertion order', () => {
    // Both candidates equally optimal (everything compatible) — 'alpha' sorts before 'zeta'.
    versionCheck.isCompatible = vi.fn(() => true);
    const members = [
      member('dep-a', [version('17', [{ name: 'zeta' }, { name: 'alpha' }])]),
      member('dep-b', [version('17', [{ name: 'zeta' }, { name: 'alpha' }])]),
    ];

    expect(selectAnchor(members, { versionCheck, latestSharedExternal: false })?.anchorRemote).toBe(
      'alpha'
    );
  });

  it('ignores the cached flag (deterministic across reloads)', () => {
    const build = (cached: boolean) => [
      member('dep-a', [
        version('17', [{ name: 'r1', cached }, { name: 'mfe' }]),
        version('18', [{ name: 'r2', cached }]),
      ]),
      member('dep-b', [
        version('17', [{ name: 'r1', cached }]),
        version('18', [{ name: 'r2', cached }]),
      ]),
    ];

    const withCache = selectAnchor(build(true), { versionCheck, latestSharedExternal: false });
    const withoutCache = selectAnchor(build(false), { versionCheck, latestSharedExternal: false });
    expect(withCache).toEqual(withoutCache);
  });
});
