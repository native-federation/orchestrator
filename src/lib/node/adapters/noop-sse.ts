import type { ForSSE } from 'lib/core/2.app/driving-ports/for-sse.port';

const createNoopSSE = (): ForSSE => ({
  watchRemoteBuilds: () => {
    /* no-op */
  },
  closeAll: () => {
    /* no-op */
  },
});

export { createNoopSSE };
