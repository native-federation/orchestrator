import type { Mocked } from 'vitest';
import { ForScopedExternalsStorage } from 'lib/core/2.app/driving-ports/for-scoped-externals-storage.port';
import type { ScopedExternal } from 'lib/core/1.domain';
import { Optional } from 'lib/utils/optional';

export const mockScopedExternalsRepository = (): Mocked<ForScopedExternalsStorage> => ({
  addExternal: vi.fn(),
  getAll: vi.fn(),
  remove: vi.fn(),
  tryGet: vi.fn(_remote => Optional.empty<ScopedExternal>()),
  commit: vi.fn(),
});
