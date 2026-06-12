import type { Mocked } from 'vitest';
import { ForSSE } from 'lib/core/2.app/driving-ports/for-sse.port';

export const mockSSE = (): Mocked<ForSSE> => ({
  watchRemoteBuilds: vi.fn(),
  closeAll: vi.fn(),
});
