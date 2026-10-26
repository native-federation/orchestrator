import semverSatisfies from 'semver/functions/satisfies';
import semverValid from 'semver/functions/valid';
import { createVersionCheck } from './version.check';

// The resolver and the pooling election ask the same (version, range) pair many times per init; the adapter
// answers each one once.
vi.mock('semver/functions/satisfies', async importOriginal => {
  const actual = await importOriginal<typeof import('semver/functions/satisfies')>();
  return { default: vi.fn(actual.default) };
});

// Intake validates every shared external's version, and a portfolio ships few distinct ones.
vi.mock('semver/functions/valid', async importOriginal => {
  const actual = await importOriginal<typeof import('semver/functions/valid')>();
  return { default: vi.fn(actual.default) };
});

describe('createVersionCheck memoization', () => {
  it('should ask semver each distinct isCompatible question once per instance', () => {
    const versionCheck = createVersionCheck();
    const satisfies = vi.mocked(semverSatisfies);
    satisfies.mockClear();

    for (let round = 0; round < 3; round++) {
      versionCheck.isCompatible('2.1.2', '~2.1.0');
      versionCheck.isCompatible('2.1.1', '~2.1.0');
    }

    expect(satisfies.mock.calls.map(([version, range]) => `${version}|${range}`)).toEqual([
      '2.1.2|~2.1.0',
      '2.1.1|~2.1.0',
    ]);
  });

  it('should ask semver each distinct isValidSemver question once per instance', () => {
    const versionCheck = createVersionCheck();
    const valid = vi.mocked(semverValid);
    valid.mockClear();

    for (let round = 0; round < 3; round++) {
      versionCheck.isValidSemver('2.1.2');
      versionCheck.isValidSemver('not-a-version');
    }

    expect(valid.mock.calls.map(([version]) => version)).toEqual(['2.1.2', 'not-a-version']);
  });
});
