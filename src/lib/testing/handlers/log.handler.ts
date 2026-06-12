import type { Mocked } from 'vitest';
import type { LogHandler, LogType } from 'lib/core/2.app/config/log.contract';

export const createMockLogHandler = (level: LogType = 'debug'): Mocked<LogHandler> => ({
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  level,
});
