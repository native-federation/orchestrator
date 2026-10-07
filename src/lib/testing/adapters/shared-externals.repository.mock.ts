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
});
