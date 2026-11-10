import { normalizeRemoteEntry } from './normalize-remote-entry';
import { createModeConfig } from 'lib/core/4.config/mode/mode.config';
import type { RawRemoteEntry } from 'lib/core/1.domain';

/**
 * Densifying compares every field, so a flat package stays one record only while its entry points agree on
 * `preload`. Core sets it on every entry point of a package once one sets it.
 */
describe('normalizeRemoteEntry: preload', () => {
  const flat = (packageName: string, preload?: true) => ({
    packageName,
    singleton: true,
    strictVersion: false,
    requiredVersion: '^17.0.0',
    version: '17.0.0',
    outFileName: `${packageName.replace(/\W/g, '_')}.js`,
    ...(preload ? { preload } : {}),
  });

  const normalize = (shared: RawRemoteEntry['shared']) =>
    normalizeRemoteEntry(
      { name: 'r0', exposes: [], shared },
      'http://r0/remoteEntry.json',
      createModeConfig({ feature: { convertFlatSharedInfo: true } })
    ).shared;

  it('groups the flat entry points of a preload package into one record that keeps preload', () => {
    const shared = normalize([flat('@angular/common', true), flat('@angular/common/http', true)]);

    expect(shared).toHaveLength(1);
    expect(shared[0]).toMatchObject({ packageName: '@angular/common', preload: true });
  });
});
