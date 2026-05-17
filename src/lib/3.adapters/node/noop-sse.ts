import type { ForSSE } from 'lib/2.app/driving-ports/for-sse.port';

const createNoopSSE = (): ForSSE => ({
  watchRemoteBuilds: () => {
    /* no-op on the server: HMR is a browser concern. */
  },
  closeAll: () => {
    /* no-op */
  },
});

export { createNoopSSE };
