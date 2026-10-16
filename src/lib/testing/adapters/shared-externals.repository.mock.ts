import type { Mocked } from 'vitest';
import { GLOBAL_SCOPE } from 'lib/core/1.domain';
import { ForSharedExternalsStorage } from 'lib/core/2.app/driving-ports/for-shared-externals-storage.port';
import type { ForUpdatingCache } from 'lib/core/2.app/driver-ports/init/for-updating-cache';

export const mockSharedExternalsRepository = (): Mocked<ForSharedExternalsStorage> => ({
  addOrUpdate: vi.fn(),
  getFromScope: vi.fn(),
  commit: vi.fn(),
  rollback: vi.fn(),
  removeFromAllScopes: vi.fn(),
  scopeType: vi.fn(),
  getScopes: vi.fn((o = { includeGlobal: true }) => (o.includeGlobal ? [GLOBAL_SCOPE] : [])),
  tryGet: vi.fn(),
  uncommittedScopes: vi.fn(() => []),
  markUndecided: vi.fn(),
  isUndecided: vi.fn(() => false),
  markDecided: vi.fn(),
});

// Specs mock `tryGet` per external; a step that reads a whole scope sees what `tryGet` holds for each external
// the loaded entry ships there.
export const readScopeThroughTryGet =
  (repo: ForSharedExternalsStorage, load: ForUpdatingCache): ForUpdatingCache =>
  entry => {
    repo.getFromScope = vi.fn((shareScope?: string) =>
      Object.fromEntries(
        entry.shared
          .filter(external => external.shareScope === shareScope)
          .flatMap(({ packageName }) => {
            const external = repo.tryGet(packageName, shareScope).get();
            return external ? [[packageName, external] as const] : [];
          })
      )
    );
    return load(entry);
  };
