import type { Mocked } from 'vitest';
import { ForScopedExternalsStorage } from 'lib/core/2.app/driving-ports/for-scoped-externals-storage.port';

export const mockScopedExternalsRepository = (): Mocked<ForScopedExternalsStorage> => ({
  addExternal: vi.fn(),
  getAll: vi.fn(),
  remove: vi.fn(),
  tryGet: vi.fn(),
  commit: vi.fn(),
});
