import type { Mocked } from 'vitest';
import { ForBrowserTasks } from 'lib/core/2.app/driving-ports/for-browser-tasks';

export const mockBrowser = (): Mocked<ForBrowserTasks> => ({
  setImportMapFn: vi.fn(),
  importModule: vi.fn(),
});
