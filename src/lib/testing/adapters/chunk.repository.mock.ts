import type { Mocked } from 'vitest';
import { ForSharedChunksStorage } from 'lib/core/2.app/driving-ports/for-shared-chunks-storage.port';
import { Optional } from 'lib/utils/optional';

export const mockChunkRepository = (): Mocked<ForSharedChunksStorage> => ({
  addOrReplace: vi.fn(),
  commit: vi.fn(),
  tryGet: vi.fn((_a, _b) => Optional.empty<string[]>()),
});
