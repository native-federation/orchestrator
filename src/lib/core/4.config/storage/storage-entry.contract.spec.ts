import type { StorageEntryCreator } from 'lib/core/2.app/config/storage.contract';
import { globalThisStorageEntry } from './global-this.storage';
import { localStorageEntry } from './local.storage';
import { sessionStorageEntry } from './session.storage';

// The repositories edit the value `get` returned and hand their cache to `set`, so every built-in entry must
// copy both ways: otherwise uncommitted in-memory edits would already sit in storage. The values are nested,
// as the repositories' records are, so a shallow copy fails these cases. Runs against jsdom's own
// localStorage and sessionStorage.
describe.each([
  ['globalThis', globalThisStorageEntry],
  ['localStorage', localStorageEntry],
  ['sessionStorage', sessionStorageEntry],
] as [string, StorageEntryCreator][])(
  '%s storage entry: copies, never aliases',
  (name, creator) => {
    const fresh = () =>
      creator(`nf-contract-${name}-${Math.random()}`)<{ list: number[] }>('k', { list: [] });

    it('keeps what was set when the given object changes afterwards', () => {
      const entry = fresh();
      const value = { list: [1] };

      entry.set(value);
      value.list.push(2);

      expect(entry.get()).toEqual({ list: [1] });
    });

    it('keeps what was set when a value it returned changes', () => {
      const entry = fresh();
      entry.set({ list: [1] });

      entry.get()!.list.push(2);

      expect(entry.get()).toEqual({ list: [1] });
    });

    it('keeps the initial value when a value it returned changes before any set', () => {
      const entry = fresh();

      entry.get()!.list.push(2);

      expect(entry.get()).toEqual({ list: [] });
    });
  }
);
