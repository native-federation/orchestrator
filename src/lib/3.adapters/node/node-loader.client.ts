import { register } from 'node:module';
import { MessageChannel } from 'node:worker_threads';
import type { ImportMap } from 'lib/1.domain';
import { getLoaderUrl } from './loader-url';

type IncomingMessage = { type: 'import-map-applied' };
type OutgoingMessage = { type: 'set-import-map'; map: ImportMap };

export type NodeLoaderClient = {
  setMap: (map: ImportMap) => Promise<void>;
  ready: () => Promise<void>;
};

export const NODE_LOADER_CLIENT_ACK_TIMEOUT_MS = 10_000;

let cached: NodeLoaderClient | null = null;

const createClient = (): NodeLoaderClient => {
  const { port1, port2 } = new MessageChannel();
  register(getLoaderUrl(), {
    data: { port: port2 },
    transferList: [port2],
  });

  // Don't let the client keep the process alive on its own.
  port1.unref();

  let pending: Promise<void> = Promise.resolve();

  const postAndAwaitAck = (map: ImportMap): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const cleanup = (): void => {
        port1.off('message', onMessage);
        if (timer !== null) clearTimeout(timer);
      };
      const onMessage = (msg: IncomingMessage): void => {
        if (msg?.type === 'import-map-applied') {
          cleanup();
          resolve();
        }
      };
      port1.on('message', onMessage);
      timer = setTimeout(() => {
        cleanup();
        reject(
          new Error(
            `node-loader.client: loader did not acknowledge set-import-map within ${NODE_LOADER_CLIENT_ACK_TIMEOUT_MS}ms`
          )
        );
      }, NODE_LOADER_CLIENT_ACK_TIMEOUT_MS);
      (timer as { unref?: () => void }).unref?.();
      try {
        const outgoing: OutgoingMessage = { type: 'set-import-map', map };
        port1.postMessage(outgoing);
      } catch (err) {
        cleanup();
        reject(err);
      }
    });

  const setMap = (map: ImportMap): Promise<void> => {
    const next = pending.catch(() => undefined).then(() => postAndAwaitAck(map));
    pending = next;
    return next;
  };

  return {
    setMap,
    ready: () => pending,
  };
};

export const getNodeLoaderClient = (): NodeLoaderClient => {
  if (!cached) cached = createClient();
  return cached;
};

/** Only used by tests. */
export const _resetNodeLoaderClient = (): void => {
  cached = null;
};
