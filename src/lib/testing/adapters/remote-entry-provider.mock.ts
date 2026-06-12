import type { Mocked } from 'vitest';
import { ForProvidingRemoteEntries } from 'lib/core/2.app/driving-ports/for-providing-remote-entries.port';

export const mockRemoteEntryProvider = (): Mocked<ForProvidingRemoteEntries> => ({
  provide: vi.fn(),
});
