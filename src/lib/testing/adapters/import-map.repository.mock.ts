import type { Mocked } from 'vitest';
import { ForImportMapStorage } from 'lib/core/2.app/driving-ports/for-import-map-storage.port';

export const mockImportMapRepository = (): Mocked<ForImportMapStorage> => {
  const repo: Mocked<ForImportMapStorage> = {
    get: vi.fn(() => ({ imports: {} })),
    set: vi.fn(() => repo),
    merge: vi.fn(() => repo),
    commit: vi.fn(() => repo),
  };
  return repo;
};
