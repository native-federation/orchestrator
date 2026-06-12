import type { Optional } from 'lib/utils/optional';

export type ForSharedChunksStorage = {
  addOrReplace: (remote: string, bundleName: string, chunks: string[]) => ForSharedChunksStorage;
  commit: () => ForSharedChunksStorage;
  tryGet: (remote: string, bundleName: string) => Optional<string[]>;
};
