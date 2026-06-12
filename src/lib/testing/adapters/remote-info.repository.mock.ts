import type { Mocked } from 'vitest';
import { ForRemoteInfoStorage } from 'lib/core/2.app/driving-ports/for-remote-info-storage.port';

export const mockRemoteInfoRepository = (): Mocked<ForRemoteInfoStorage> => ({
  contains: vi.fn(),
  addOrUpdate: vi.fn(),
  tryGetModule: vi.fn(),
  remove: vi.fn(),
  tryGet: vi.fn(),
  getAll: vi.fn(),
  commit: vi.fn(),
});
