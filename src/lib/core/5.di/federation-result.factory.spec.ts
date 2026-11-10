import { createFederationResult } from './federation-result.factory';
import { mockConfig } from 'lib/testing/config.mock';
import { mockAdapters } from 'lib/testing/adapters.mock';

describe('createFederationResult', () => {
  // The main entry exports this factory; a host composing init by hand, as before preloading existed, passes
  // no preloadRemoteModule and must still get a result whose preloadRemoteModule is callable.
  it('defaults preloadRemoteModule to a no-op', () => {
    const result = createFederationResult({
      config: mockConfig(),
      adapters: mockAdapters(),
      loadRemoteModule: vi.fn(),
      initRemoteEntryFlow: vi.fn(),
    });

    expect(() => result.preloadRemoteModule('team/mfe1', './x')).not.toThrow();
  });

  it('exposes the preloadRemoteModule it is given', () => {
    const preloadRemoteModule = vi.fn();

    const result = createFederationResult({
      config: mockConfig(),
      adapters: mockAdapters(),
      loadRemoteModule: vi.fn(),
      preloadRemoteModule,
      initRemoteEntryFlow: vi.fn(),
    });

    expect(result.preloadRemoteModule).toBe(preloadRemoteModule);
  });
});
