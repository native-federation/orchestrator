import { StorageEntryHandler } from 'lib/core/2.app/config/storage.contract';
import { localStorageEntry } from './local.storage';
import { RemoteInfo } from 'lib/core/1.domain/remote/remote-info.contract';
import {
  mockRemoteInfo_MFE1,
  mockRemoteInfo_MFE2,
} from 'lib/testing/domain/remote-info/remote-info.mock';

describe('localStorageEntry', () => {
  let mockStorage: any;
  let storageEntryHandler: StorageEntryHandler;
  beforeEach(() => {
    mockStorage = {};
    Object.defineProperty(window, 'localStorage', {
      value: {
        getItem: vi.fn((key: string) => mockStorage[key] || null),
        setItem: vi.fn((key: string, value: string) => {
          mockStorage[key] = value;
        }),
      },
    });
    storageEntryHandler = localStorageEntry('namespace');
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('Create entry with default value on init', () => {
    storageEntryHandler('remotes', { 'team/mfe1': mockRemoteInfo_MFE1() });

    expect(mockStorage[`${'namespace'}.remotes`]).toBeDefined();
    expect(JSON.parse(mockStorage[`${'namespace'}.remotes`])).toEqual({
      'team/mfe1': mockRemoteInfo_MFE1(),
    });
  });

  describe('get', () => {
    it('should return the fallback value', () => {
      const entry = storageEntryHandler('remotes', { 'team/mfe1': mockRemoteInfo_MFE1() });

      const expected = { 'team/mfe1': mockRemoteInfo_MFE1() };

      expect(entry.get()).toEqual(expected);
    });

    it('not allow any mutations', () => {
      const entry = storageEntryHandler('remotes', { 'team/mfe1': mockRemoteInfo_MFE1() });

      const expected = { 'team/mfe1': mockRemoteInfo_MFE1() };

      const keyA = entry.get()!;
      keyA['team/mfe1'] = mockRemoteInfo_MFE2();

      expect(entry.get()).toEqual(expected);
    });

    it('should return undefined if the value doesnt exist', () => {
      const entry = storageEntryHandler('remotes', undefined);

      expect(entry.get()).toEqual(undefined);
    });
  });

  describe('set', () => {
    it('set stores value in namespace', () => {
      const entry = storageEntryHandler<Record<string, RemoteInfo>>('remotes', {
        'team/mfe1': mockRemoteInfo_MFE1(),
      });
      const expected = { 'team/mfe2': mockRemoteInfo_MFE2() };

      entry.set({ 'team/mfe2': mockRemoteInfo_MFE2() });

      expect(entry.get()).toEqual(expected);
    });

    it('not allow any mutations', () => {
      const entry = storageEntryHandler('remotes', { 'team/mfe1': mockRemoteInfo_MFE1() });
      const newEntry = { 'team/mfe2': mockRemoteInfo_MFE2() } as any;
      entry.set(newEntry);

      newEntry['MALICOUS_INJECT'] = 'BAD_SCRIPT.js';

      expect(entry.get()).toEqual({ 'team/mfe2': mockRemoteInfo_MFE2() });
    });
  });

  describe('clear', () => {
    it('clears the entry back to the initialValue', () => {
      mockStorage[`${'namespace'}.remotes`] = JSON.stringify({
        'team/mfe1': mockRemoteInfo_MFE1(),
      });

      const entry = storageEntryHandler<Record<string, RemoteInfo>>('remotes', {});

      expect(entry.get()).toEqual({ 'team/mfe1': mockRemoteInfo_MFE1() });

      entry.clear();

      expect(entry.get()).toEqual({});
    });
  });
});
