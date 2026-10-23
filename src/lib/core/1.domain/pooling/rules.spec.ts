import { packageOfIn, SpecifierTags } from 'lib/core/1.domain/externals/specifier';

const byName = packageOfIn({});
import { buildOf, type Copy } from './builds';
import { unwitnessedGap } from './rules';

const copy = (member: string, tag: string, specifiers: string[]): Copy => ({
  member,
  tag,
  requiredVersion: `^${tag}`,
  strict: false,
  host: false,
  specifiers,
});

describe('unwitnessedGap', () => {
  // mfe-s ships `@fw/core` at 1.0.1 but never lists `@fw/core/testing`; copies of one version merge their
  // entries, so its core build still witnesses that entrypoint at 1.0.1, not at any other tag.
  const builds = [
    buildOf(
      'team/mfe-s',
      [copy('@fw/core', '1.0.1', ['@fw/core']), copy('@fw/common', '1.0.0', ['@fw/common'])],
      byName
    ),
  ];
  const loaded = [
    copy('@fw/core', '1.0.1', ['@fw/core/testing']),
    copy('@fw/common', '1.0.0', ['@fw/common']),
  ];

  it("witnesses an entrypoint a build does not list by its package's tag", () => {
    const tags = new SpecifierTags(byName, [
      ['@fw/core/testing', '1.0.1'],
      ['@fw/common', '1.0.0'],
    ]);
    expect(unwitnessedGap(loaded, tags, builds)).toBeUndefined();
  });

  it("does not witness it at another tag than the package's", () => {
    const tags = new SpecifierTags(byName, [
      ['@fw/core/testing', '1.0.0'],
      ['@fw/common', '1.0.0'],
    ]);
    expect(unwitnessedGap(loaded, tags, builds)).toBe('@fw/core/testing');
  });
});
