import type { Mocked } from 'vitest';
import { GLOBAL_SCOPE } from 'lib/core/1.domain';
import { ForSharedExternalsStorage } from 'lib/core/2.app/driving-ports/for-shared-externals-storage.port';

export const mockSharedExternalsRepository = (): Mocked<ForSharedExternalsStorage> => ({
  addOrUpdate: vi.fn(),
  getFromScope: vi.fn(),
  commit: vi.fn(),
  removeFromAllScopes: vi.fn(),
  scopeType: vi.fn(),
  getScopes: vi.fn((o = { includeGlobal: true }) => (o.includeGlobal ? [GLOBAL_SCOPE] : [])),
  tryGet: vi.fn(),
  markPoolTagPresent: vi.fn(),
  // Default to "a tag was seen" so behaviour specs that seed pooled externals directly (bypassing
  // store-remote-entry) exercise the full pooling logic; the early-out is asserted by opting out.
  hasPoolTag: vi.fn(() => true),
});
