import type { Logger } from '../config/log.contract';
import type { ForBrowserTasks } from '../driving-ports/for-browser-tasks';

export type PreloadHint = (collectUrls: () => string[]) => void;

// Collecting runs inside the guard too: a hint never fails the load or commit that sends it.
export function createPreloadHint(
  log: Logger,
  browser: Pick<ForBrowserTasks, 'preloadModules'>,
  logStep: number
): PreloadHint {
  return collectUrls => {
    if (!browser.preloadModules) return;
    try {
      const urls = collectUrls();
      if (urls.length > 0) browser.preloadModules?.(urls);
    } catch (error) {
      log.debug(logStep, 'Ignored a failing preload hint.', error);
    }
  };
}
