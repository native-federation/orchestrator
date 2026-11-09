import { normalizeRemoteEntry } from './normalize-remote-entry';
import { createModeConfig } from 'lib/core/4.config/mode/mode.config';
import type { RawRemoteEntry } from 'lib/core/1.domain';

/**
 * Core writes a flat preload package's chunk list as the package's union, on every entry point
 * (docs/architecture/chunks.md in core). Densifying compares every field, so equal lists are what keep
 * the package one record here, and the list rides along unchanged.
 */
describe('normalizeRemoteEntry: chunk lists', () => {
  const union = ['chunk-C.js', 'chunk-H.js'];

  const flat = (packageName: string, chunks?: string[]) => ({
    packageName,
    singleton: true,
    strictVersion: false,
    requiredVersion: '^17.0.0',
    version: '17.0.0',
    outFileName: `${packageName.replace(/\W/g, '_')}.js`,
    ...(chunks ? { preload: true as const, chunks } : {}),
  });

  const normalize = (shared: RawRemoteEntry['shared'], convertFlatSharedInfo: boolean) =>
    normalizeRemoteEntry(
      { name: 'r0', exposes: [], shared },
      'http://r0/remoteEntry.json',
      createModeConfig({ feature: { convertFlatSharedInfo } })
    ).shared;

  it('groups the entry points of a flat preload package into one record with its list', () => {
    const shared = normalize(
      [flat('@angular/common', union), flat('@angular/common/http', union)],
      true
    );

    expect(shared).toHaveLength(1);
    expect(shared[0]).toMatchObject({
      packageName: '@angular/common',
      preload: true,
      chunks: union,
    });
  });

  it('keeps the list on each flat entry without grouping', () => {
    const shared = normalize([flat('@angular/common', union), flat('rxjs')], false);

    expect(shared.map(s => s.chunks)).toEqual([union, undefined]);
  });

  it('leaves the list of a published dense record as it is', () => {
    const dense = {
      packageName: '@angular/common',
      singleton: true,
      strictVersion: false,
      requiredVersion: '^17.0.0',
      version: '17.0.0',
      entries: { '@angular/common': 'common.js' },
      preload: true as const,
      chunks: ['chunk-D.js'],
    };

    expect(normalize([dense], true)[0]).toMatchObject({ dense: true, chunks: ['chunk-D.js'] });
  });
});
