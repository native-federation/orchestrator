import { ForDeterminingSharedExternals } from '../driver-ports/init/for-determining-shared-externals.port';
import { DrivingContract } from '../driving-ports/driving.contract';
import { createDetermineSharedExternals } from './determine-shared-externals';
import { NFError } from 'lib/core/native-federation.error';
import { mockAdapters } from 'lib/testing/adapters.mock';
import { ConfigContract } from 'lib/core/2.app/config';
import { mockConfig } from 'lib/testing/config.mock';
import { mockExternal_A, mockExternal_B } from 'lib/testing/domain/externals/external.mock';
import { mockVersion_A, mockVersion_B } from 'lib/testing/domain/externals/version.mock';

describe('createDetermineSharedExternals', () => {
  let determineSharedExternals: ForDeterminingSharedExternals;
  let config: ConfigContract;
  let adapters: Pick<DrivingContract, 'versionCheck' | 'sharedExternalsRepo'>;

  beforeEach(() => {
    config = mockConfig();
    adapters = mockAdapters();

    adapters.sharedExternalsRepo.scopeType = vi.fn(() => 'global');

    determineSharedExternals = createDetermineSharedExternals(config, adapters);
  });

  describe("default scenario's", () => {
    it('should set available version to share', async () => {
      adapters.sharedExternalsRepo.getFromScope = vi.fn(() => ({
        'dep-a': mockExternal_A({
          dirty: true,
          versions: [mockVersion_A.v2_1_1({ remotes: ['team/mfe1'], action: 'skip' })],
        }),
      }));

      await determineSharedExternals();

      expect(adapters.sharedExternalsRepo.addOrUpdate).toHaveBeenCalledWith(
        'dep-a',
        mockExternal_A({
          dirty: false,
          versions: [mockVersion_A.v2_1_1({ remotes: ['team/mfe1'], action: 'share' })],
        }),
        '__GLOBAL__'
      );
    });

    it('should skip if not dirty', async () => {
      adapters.sharedExternalsRepo.getFromScope = vi.fn(() => ({
        'dep-a': mockExternal_A({
          dirty: false,
          versions: [mockVersion_A.v2_1_1({ remotes: ['team/mfe1'], action: 'skip' })],
        }),
      }));

      await determineSharedExternals();

      expect(adapters.sharedExternalsRepo.addOrUpdate).not.toHaveBeenCalled();
    });

    it('should reject with the original error as its cause', async () => {
      const inner = new Error('storage unavailable');
      adapters.sharedExternalsRepo.getFromScope = vi.fn(() => ({
        'dep-a': mockExternal_A({
          dirty: true,
          versions: [mockVersion_A.v2_1_1({ remotes: ['team/mfe1'], action: 'skip' })],
        }),
      }));
      adapters.sharedExternalsRepo.addOrUpdate = vi.fn(() => {
        throw inner;
      });

      const rejection = await determineSharedExternals().catch((e: unknown) => e);

      expect(rejection).toBeInstanceOf(NFError);
      expect((rejection as NFError).cause).toBe(inner);
    });
  });

  describe('handle version incompatibilities', () => {
    it('should set "skip" if incompatible, strictVersion is false and in non-strict mode', async () => {
      config.strict.strictExternalCompatibility = false;

      adapters.sharedExternalsRepo.getFromScope = vi.fn(() => ({
        'dep-b': mockExternal_B({
          dirty: true,
          versions: [
            mockVersion_B.v2_2_2({ remotes: ['team/mfe1'], action: 'skip' }),
            mockVersion_B.v2_1_1({
              remotes: { 'team/mfe2': { strictVersion: false } },
              action: 'skip',
            }),
          ],
        }),
      }));

      await determineSharedExternals();

      expect(adapters.sharedExternalsRepo.addOrUpdate).toHaveBeenCalledWith(
        'dep-b',
        mockExternal_B({
          dirty: false,
          versions: [
            mockVersion_B.v2_2_2({ remotes: ['team/mfe1'], action: 'share' }),
            mockVersion_B.v2_1_1({
              remotes: { 'team/mfe2': { strictVersion: false } },
              action: 'skip',
            }),
          ],
        }),
        '__GLOBAL__'
      );
    });

    it('should set "scoped" if incompatible, strictVersion is true and in non-strict mode', async () => {
      config.strict.strictExternalCompatibility = false;

      adapters.sharedExternalsRepo.getFromScope = vi.fn(() => ({
        'dep-b': mockExternal_B({
          dirty: true,
          versions: [
            mockVersion_B.v2_2_2({ remotes: ['team/mfe1'], action: 'skip' }),
            mockVersion_B.v2_1_1({
              remotes: { 'team/mfe2': { strictVersion: true } },
              action: 'skip',
            }),
          ],
        }),
      }));

      await determineSharedExternals();

      expect(adapters.sharedExternalsRepo.addOrUpdate).toHaveBeenCalledWith(
        'dep-b',
        mockExternal_B({
          dirty: false,
          versions: [
            mockVersion_B.v2_2_2({ remotes: ['team/mfe1'], action: 'share' }),
            mockVersion_B.v2_1_1({
              remotes: { 'team/mfe2': { strictVersion: true } },
              action: 'scope',
            }),
          ],
        }),
        '__GLOBAL__'
      );
    });

    it('should throw error if incompatible, strictVersion is true and in strict mode', async () => {
      config.strict.strictExternalCompatibility = true;

      adapters.sharedExternalsRepo.getFromScope = vi.fn(() => ({
        'dep-b': mockExternal_B({
          dirty: true,
          versions: [
            mockVersion_B.v2_2_2({ remotes: ['team/mfe1'], action: 'skip' }),
            mockVersion_B.v2_1_1({
              remotes: { 'team/mfe2': { strictVersion: true } },
              action: 'skip',
            }),
          ],
        }),
      }));

      await expect(determineSharedExternals()).rejects.toEqual(
        new NFError('Could not determine shared externals in scope __GLOBAL__.', expect.any(Error))
      );
    });

    // `remotes[0]` is the serving basis, ordered by coverage — it says nothing about what the
    // version demands. Reading `strictVersion` off it would let a wide non-strict sibling
    // redirect a pinned remote to a version its range rejects.
    describe('when only a non-basis remote pinned the version', () => {
      beforeEach(() => {
        // Range-aware, so 2.2.2 stays self-compatible and only 2.1.1's remotes reject it.
        adapters.versionCheck.isCompatible = vi.fn(
          (tag: string, range: string) => range === `~${tag.slice(0, 3)}.0`
        );
      });

      // Both versions carry two copies, so the two candidates cost the same two extra downloads and
      // the newest wins the tie. That keeps 2.1.1 the redirected version, which is what this
      // describe is about — with one copy on 2.2.2, 2.1.1 would simply be the cheaper winner and
      // nothing would be redirected onto a tag a non-basis remote pinned.
      const WIDE = ['team/mfe1', 'team/mfe4'];

      const withStrictSibling = (remotes: Record<string, { strictVersion: boolean }>) =>
        vi.fn(() => ({
          'dep-b': mockExternal_B({
            dirty: true,
            versions: [
              mockVersion_B.v2_2_2({ remotes: WIDE, action: 'skip' }),
              mockVersion_B.v2_1_1({ remotes, action: 'skip' }),
            ],
          }),
        }));

      const LOOSE = { 'team/mfe2': { strictVersion: false } };
      const STRICT = { 'team/mfe3': { strictVersion: true } };

      // The basis is the widest copy, so either remote can hold that slot — and which one holds it must
      // not change the outcome, since the verdict follows each copy's own settings.
      it.each([
        ['non-strict remote as basis', { ...LOOSE, ...STRICT }],
        ['strict remote as basis', { ...STRICT, ...LOOSE }],
      ])('should scope only the strict copy, with the %s', async (_label, remotes) => {
        config.strict.strictExternalCompatibility = false;
        adapters.sharedExternalsRepo.getFromScope = withStrictSibling(remotes);

        await determineSharedExternals();

        // 2.1.1 splits rather than scoping whole: `team/mfe2` declared `strictVersion: false`, which
        // means "serve me the shared version even where my range rejects it", so it dedups onto 2.2.2
        // instead of being dragged into its sibling's verdict. See F-F-per-version-verdicts.md.
        expect(adapters.sharedExternalsRepo.addOrUpdate).toHaveBeenCalledWith(
          'dep-b',
          mockExternal_B({
            dirty: false,
            versions: [
              mockVersion_B.v2_2_2({ remotes: WIDE, action: 'share' }),
              mockVersion_B.v2_1_1({ remotes: LOOSE, action: 'skip' }),
              mockVersion_B.v2_1_1({ remotes: STRICT, action: 'scope' }),
            ],
          }),
          '__GLOBAL__'
        );
      });

      it('should throw in strict mode even though the basis is not strict', async () => {
        config.strict.strictExternalCompatibility = true;
        adapters.sharedExternalsRepo.getFromScope = withStrictSibling({ ...LOOSE, ...STRICT });

        await expect(determineSharedExternals()).rejects.toEqual(
          new NFError(
            'Could not determine shared externals in scope __GLOBAL__.',
            expect.any(Error)
          )
        );
      });
    });
  });

  describe('Custom scope', () => {
    beforeEach(() => {
      adapters.sharedExternalsRepo.getScopes = vi.fn(() => ['custom-scope']);
      adapters.sharedExternalsRepo.scopeType = vi.fn(() => 'shareScope');
    });

    it('should set only one version to share when compatible, the rest to skip', async () => {
      adapters.versionCheck.isCompatible = vi.fn(() => true);
      adapters.sharedExternalsRepo.getFromScope = vi.fn(() => ({
        'dep-b': mockExternal_B({
          dirty: true,
          versions: [
            mockVersion_B.v2_1_2({ remotes: ['team/mfe1'], action: 'skip' }),
            mockVersion_B.v2_1_1({ remotes: ['team/mfe2'], action: 'skip' }),
          ],
        }),
      }));

      await determineSharedExternals();

      expect(adapters.sharedExternalsRepo.addOrUpdate).toHaveBeenCalledWith(
        'dep-b',
        mockExternal_B({
          dirty: false,
          versions: [
            mockVersion_B.v2_1_2({ remotes: ['team/mfe1'], action: 'share' }),
            mockVersion_B.v2_1_1({ remotes: ['team/mfe2'], action: 'skip' }),
          ],
        }),
        'custom-scope'
      );
    });
  });

  describe('entrypoint coverage tiebreaker', () => {
    it('should break a download tie toward the version with the richest entrypoint coverage', async () => {
      // Both versions compatible => equal (zero) extra downloads. The lower-semver version
      // covers every entrypoint, so it wins the tie over the higher-semver poorer one.
      adapters.versionCheck.isCompatible = vi.fn(() => true);
      adapters.sharedExternalsRepo.getFromScope = vi.fn(() => ({
        'dep-b': mockExternal_B({
          dirty: true,
          versions: [
            mockVersion_B.v2_1_2({ remotes: ['team/mfe1'], action: 'skip' }),
            mockVersion_B.v2_1_1({
              remotes: {
                'team/mfe2': { entries: { 'dep-b': 'dep-b.js', 'dep-b/sub': 'dep-b-sub.js' } },
              },
              action: 'skip',
            }),
          ],
        }),
      }));

      await determineSharedExternals();

      expect(adapters.sharedExternalsRepo.addOrUpdate).toHaveBeenCalledWith(
        'dep-b',
        mockExternal_B({
          dirty: false,
          versions: [
            mockVersion_B.v2_1_2({ remotes: ['team/mfe1'], action: 'skip' }),
            mockVersion_B.v2_1_1({
              remotes: {
                'team/mfe2': { entries: { 'dep-b': 'dep-b.js', 'dep-b/sub': 'dep-b-sub.js' } },
              },
              action: 'share',
            }),
          ],
        }),
        '__GLOBAL__'
      );
    });

    it('should not let coverage override a decisive extra-downloads winner', async () => {
      // Only 2.2.2 is compatible with the others => it has zero extra downloads while 2.1.1
      // has more. It wins on downloads despite covering fewer entrypoints.
      adapters.versionCheck.isCompatible = vi.fn((tag: string) => tag === '2.2.2');
      adapters.sharedExternalsRepo.getFromScope = vi.fn(() => ({
        'dep-b': mockExternal_B({
          dirty: true,
          versions: [
            mockVersion_B.v2_2_2({ remotes: ['team/mfe1'], action: 'skip' }),
            mockVersion_B.v2_1_1({
              remotes: {
                'team/mfe2': { entries: { 'dep-b': 'dep-b.js', 'dep-b/sub': 'dep-b-sub.js' } },
              },
              action: 'skip',
            }),
          ],
        }),
      }));

      await determineSharedExternals();

      expect(adapters.sharedExternalsRepo.addOrUpdate).toHaveBeenCalledWith(
        'dep-b',
        mockExternal_B({
          dirty: false,
          versions: [
            mockVersion_B.v2_2_2({ remotes: ['team/mfe1'], action: 'share' }),
            mockVersion_B.v2_1_1({
              remotes: {
                'team/mfe2': { entries: { 'dep-b': 'dep-b.js', 'dep-b/sub': 'dep-b-sub.js' } },
              },
              action: 'skip',
            }),
          ],
        }),
        '__GLOBAL__'
      );
    });
  });

  describe('entrypoint coverage', () => {
    beforeEach(() => {
      adapters.versionCheck.isCompatible = vi.fn(() => true);
    });

    // The host version (poorer basis) is pinned as the winner so the verdict is isolated
    // from the §4 coverage tiebreaker, which would otherwise pick the richer version.
    const externalWithUncoveredSkip = () => ({
      'dep-b': mockExternal_B({
        dirty: true,
        versions: [
          mockVersion_B.v2_1_2({ remotes: ['team/host'], action: 'skip' }),
          mockVersion_B.v2_1_1({
            remotes: {
              'team/mfe2': { entries: { 'dep-b': 'dep-b.js', 'dep-b/sub': 'dep-b-sub.js' } },
            },
            action: 'skip',
          }),
        ],
      }),
    });

    it('should leave a skip version whose entrypoints the shared winner lacks as skip', async () => {
      adapters.sharedExternalsRepo.getFromScope = vi.fn(externalWithUncoveredSkip);

      await determineSharedExternals();

      expect(adapters.sharedExternalsRepo.addOrUpdate).toHaveBeenCalledWith(
        'dep-b',
        mockExternal_B({
          dirty: false,
          versions: [
            mockVersion_B.v2_1_2({ remotes: ['team/host'], action: 'share' }),
            mockVersion_B.v2_1_1({
              remotes: {
                'team/mfe2': { entries: { 'dep-b': 'dep-b.js', 'dep-b/sub': 'dep-b-sub.js' } },
              },
              action: 'skip',
            }),
          ],
        }),
        '__GLOBAL__'
      );
    });
  });
});
