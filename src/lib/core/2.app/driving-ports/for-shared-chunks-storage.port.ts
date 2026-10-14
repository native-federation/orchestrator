import type { Optional } from 'lib/utils/optional';

export type ForSharedChunksStorage = {
  addOrReplace: (remote: string, bundleName: string, chunks: string[]) => ForSharedChunksStorage;
  remove: (remote: string) => ForSharedChunksStorage;
  commit: () => ForSharedChunksStorage;
  rollback: () => ForSharedChunksStorage;
  tryGet: (remote: string, bundleName: string) => Optional<string[]>;
};
