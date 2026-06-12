/**
 * @vitest-environment node
 */
import type { RemoteEntry, SharedInfo } from 'lib/core/1.domain';
import type { LogHandler } from 'lib/core/2.app/config/log.contract';
import type { ForProvidingRemoteEntries } from 'lib/core/2.app/driving-ports/for-providing-remote-entries.port';
import { resolveHostInstances } from './resolve-host-instances';

const shared = (packageName: string, singleton: boolean): SharedInfo =>
  ({
    packageName,
    singleton,
    outFileName: `${packageName}.js`,
    requiredVersion: '*',
  }) as SharedInfo;

const makeDeps = (
  sharedInfos: SharedInfo[],
  hostRemoteEntry: Parameters<
    typeof resolveHostInstances
  >[1]['hostRemoteEntry'] = './remoteEntry.json'
) => {
  const provide = vi.fn(
    async (url: string): Promise<RemoteEntry> => ({ url, shared: sharedInfos }) as RemoteEntry
  );
  const log = {
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    level: 'debug',
  } as unknown as LogHandler;
  return {
    provide,
    log,
    deps: {
      remoteEntryProvider: { provide } as ForProvidingRemoteEntries,
      hostRemoteEntry,
      log,
    },
  };
};

describe('resolveHostInstances', () => {
  it('returns undefined when no option is given', async () => {
    const { deps } = makeDeps([]);
    await expect(resolveHostInstances(undefined, deps)).resolves.toBeUndefined();
  });

  it('passes an explicit map through unchanged, without touching the remoteEntry', async () => {
    const ns = { Component: class {} };
    const { deps, provide } = makeDeps([]);

    const result = await resolveHostInstances({ '@angular/core': ns }, deps);

    expect(result).toEqual({ '@angular/core': ns });
    expect(provide).not.toHaveBeenCalled();
  });

  it('in auto mode, derives every shared singleton and imports each in the host realm', async () => {
    const core = { Component: 1 };
    const common = { NgIf: 1 };
    const { deps } = makeDeps([
      shared('@angular/core', true),
      shared('@angular/common', true),
      shared('only-scoped', false),
    ]);
    const load = vi.fn(
      async (s: string) => ({ '@angular/core': core, '@angular/common': common })[s]!
    );

    const result = await resolveHostInstances({ load }, deps);

    expect(result).toEqual({ '@angular/core': core, '@angular/common': common });
    expect(load).not.toHaveBeenCalledWith('only-scoped');
  });

  it('include filters by exact or prefix match', async () => {
    const { deps } = makeDeps([
      shared('@angular/core', true),
      shared('@angular/common', true),
      shared('rxjs', true),
      shared('lodash', true),
    ]);
    const load = vi.fn(async (s: string) => ({ name: s }));

    const result = await resolveHostInstances({ include: ['@angular/', 'rxjs'], load }, deps);

    expect(Object.keys(result!).sort()).toEqual(['@angular/common', '@angular/core', 'rxjs']);
    expect(result!['lodash']).toBeUndefined();
  });

  it('exclude drops matches', async () => {
    const { deps } = makeDeps([shared('@angular/core', true), shared('zone.js', true)]);
    const load = vi.fn(async (s: string) => ({ name: s }));

    const result = await resolveHostInstances({ exclude: ['zone.js'], load }, deps);

    expect(Object.keys(result!)).toEqual(['@angular/core']);
  });

  it('deduplicates repeated package names', async () => {
    const { deps } = makeDeps([shared('@angular/core', true), shared('@angular/core', true)]);
    const load = vi.fn(async (s: string) => ({ name: s }));

    const result = await resolveHostInstances({ load }, deps);

    expect(Object.keys(result!)).toEqual(['@angular/core']);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('skips a specifier that fails to load and warns, keeping the rest', async () => {
    const { deps, log } = makeDeps([shared('@angular/core', true), shared('broken', true)]);
    const load = vi.fn(async (s: string) => {
      if (s === 'broken') throw new Error('cannot resolve');
      return { name: s };
    });

    const result = await resolveHostInstances({ load }, deps);

    expect(Object.keys(result!)).toEqual(['@angular/core']);
    expect(log.warn).toHaveBeenCalledWith(0, expect.stringContaining("could not load 'broken'"));
  });

  it('warns and returns undefined when auto mode has no hostRemoteEntry', async () => {
    const { deps, log, provide } = makeDeps([], false);

    const result = await resolveHostInstances('all', deps);

    expect(result).toBeUndefined();
    expect(provide).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(0, expect.stringContaining('needs a hostRemoteEntry'));
  });

  it('passes the host remoteEntry integrity through to the provider', async () => {
    const { deps, provide } = makeDeps([shared('@angular/core', true)], {
      url: 'file:///remoteEntry.json',
      integrity: 'sha384-abc',
    });
    const load = vi.fn(async (s: string) => ({ name: s }));

    await resolveHostInstances({ load }, deps);

    expect(provide).toHaveBeenCalledWith('file:///remoteEntry.json', { integrity: 'sha384-abc' });
  });
});
