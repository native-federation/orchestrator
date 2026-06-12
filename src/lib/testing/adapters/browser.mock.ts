import { ForBrowserTasks } from 'lib/core/2.app/driving-ports/for-browser-tasks';

export const mockBrowser = (): jest.Mocked<ForBrowserTasks> => ({
  setImportMapFn: jest.fn(),
  importModule: jest.fn(),
});
