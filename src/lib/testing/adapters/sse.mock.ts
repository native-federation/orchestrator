import { ForSSE } from 'lib/core/2.app/driving-ports/for-sse.port';

export const mockSSE = (): jest.Mocked<ForSSE> => ({
  watchRemoteBuilds: jest.fn(),
  closeAll: jest.fn(),
});
