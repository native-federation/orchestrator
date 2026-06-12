import { StorageEntry } from 'lib/core/2.app/config/storage.contract';

export const createStorageHandlerMock = (storageRef: any) =>
  vi.fn(<TValue>(key: string, fallback: TValue) => {
    if (!storageRef[key]) storageRef[key] = fallback;

    const mockStorageEntry = {
      get: vi.fn(() => JSON.parse(JSON.stringify(storageRef[key]))),
      set: vi.fn(value => {
        storageRef[key] = value;
        return mockStorageEntry;
      }),
      clear: vi.fn(() => {
        storageRef[key] = fallback;
        return mockStorageEntry;
      }),
    } as StorageEntry<any>;

    return mockStorageEntry;
  });
