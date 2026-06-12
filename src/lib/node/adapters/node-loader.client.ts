import { register } from 'node:module';
import { MessageChannel } from 'node:worker_threads';
import type { ImportMap } from 'lib/core/1.domain';
import { getLoaderUrl } from './loader-url';

/** Per-specifier list of export names to bridge from the host's instances. */
export type HostInstanceKeys = Record<string, string[]>;

type IncomingMessage = { type: 'import-map-applied' } | { type: 'host-instances-applied' };
type OutgoingMessage =
  | { type: 'set-import-map'; map: ImportMap }
  | { type: 'set-host-instances'; keys: HostInstanceKeys };

export type NodeLoaderClient = {
  setMap: (map: ImportMap) => Promise<void>;
  setHostInstances: (keys: HostInstanceKeys) => Promise<void>;
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

  // Specifiers bridged to host instances. The loader resolves these ahead of
  // the import map, so we strip them from the map we post — no dead entries.
  const bridged = new Set<string>();
  const omitBridged = (map: ImportMap): ImportMap => {
    if (bridged.size === 0) return map;
    const drop = (imports: ImportMap['imports']): ImportMap['imports'] =>
      Object.fromEntries(Object.entries(imports).filter(([specifier]) => !bridged.has(specifier)));
    const scopes = map.scopes
      ? Object.fromEntries(Object.entries(map.scopes).map(([scope, imports]) => [scope, drop(imports)]))
      : map.scopes;
    return { ...map, imports: drop(map.imports), ...(scopes ? { scopes } : {}) };
  };

  const postAndAwaitAck = (
    message: OutgoingMessage,
    ackType: IncomingMessage['type']
  ): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const cleanup = (): void => {
        port1.off('message', onMessage);
        if (timer !== null) clearTimeout(timer);
      };
      const onMessage = (msg: IncomingMessage): void => {
        if (msg?.type === ackType) {
          cleanup();
          resolve();
        }
      };
      port1.on('message', onMessage);
      timer = setTimeout(() => {
        cleanup();
        reject(
          new Error(
            `node-loader.client: loader did not acknowledge ${message.type} within ${NODE_LOADER_CLIENT_ACK_TIMEOUT_MS}ms`
          )
        );
      }, NODE_LOADER_CLIENT_ACK_TIMEOUT_MS);
      (timer as { unref?: () => void }).unref?.();
      try {
        port1.postMessage(message);
      } catch (err) {
        cleanup();
        reject(err);
      }
    });

  // Serialize every post on a single chain so set-import-map and
  // set-host-instances can never race each other on the loader thread.
  const enqueue = (message: OutgoingMessage, ackType: IncomingMessage['type']): Promise<void> => {
    const next = pending.catch(() => undefined).then(() => postAndAwaitAck(message, ackType));
    pending = next;
    return next;
  };

  const setMap = (map: ImportMap): Promise<void> =>
    enqueue({ type: 'set-import-map', map: omitBridged(map) }, 'import-map-applied');

  const setHostInstances = (keys: HostInstanceKeys): Promise<void> => {
    Object.keys(keys).forEach(specifier => bridged.add(specifier));
    return enqueue({ type: 'set-host-instances', keys }, 'host-instances-applied');
  };

  return {
    setMap,
    setHostInstances,
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
