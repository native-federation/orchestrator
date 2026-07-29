import { StorageEntry } from 'lib/core/2.app/config/storage.contract';

export const createStorageHandlerMock = (storageRef: any) =>
  vi.fn(<TValue>(key: string, fallback: TValue) => {
    const mockStorageEntry = {
      get: vi.fn(() => {
        const raw = storageRef[key] ?? fallback;
        return raw === undefined ? undefined : JSON.parse(JSON.stringify(raw));
      }),
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
