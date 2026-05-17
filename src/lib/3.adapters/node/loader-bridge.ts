import { register } from 'node:module';
import { MessageChannel } from 'node:worker_threads';
import type { ImportMap } from 'lib/1.domain';
import { getLoaderUrl } from './loader-url';

type IncomingMessage = { type: 'import-map-applied' };
type OutgoingMessage = { type: 'set-import-map'; map: ImportMap };

export type LoaderBridge = {
  setMap: (map: ImportMap) => Promise<void>;
  ready: () => Promise<void>;
};

let cached: LoaderBridge | null = null;

const createBridge = (): LoaderBridge => {
  const { port1, port2 } = new MessageChannel();
  register(getLoaderUrl(), {
    data: { port: port2 },
    transferList: [port2],
  });

  // Don't let the bridge keep the process alive on its own.
  port1.unref();

  let pending: Promise<void> = Promise.resolve();

  const setMap = (map: ImportMap): Promise<void> => {
    pending = new Promise<void>((resolve, reject) => {
      const onMessage = (msg: IncomingMessage): void => {
        if (msg?.type === 'import-map-applied') {
          port1.off('message', onMessage);
          resolve();
        }
      };
      port1.on('message', onMessage);
      try {
        const outgoing: OutgoingMessage = { type: 'set-import-map', map };
        port1.postMessage(outgoing);
      } catch (err) {
        port1.off('message', onMessage);
        reject(err);
      }
    });
    return pending;
  };

  return {
    setMap,
    ready: () => pending,
  };
};

export const getLoaderBridge = (): LoaderBridge => {
  if (!cached) cached = createBridge();
  return cached;
};

/** Only used by tests. */
export const __resetLoaderBridgeForTests = (): void => {
  cached = null;
};
