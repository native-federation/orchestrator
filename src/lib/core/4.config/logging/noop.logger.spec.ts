import { noopLogger } from './noop.logger';

describe('consoleLogger', () => {
  beforeEach(() => {
    noopLogger.debug = vi.fn();
    noopLogger.warn = vi.fn();
    noopLogger.error = vi.fn();
  });

  it('should call appropriate console methods for each level', () => {
    noopLogger.debug(0, 'debug');
    noopLogger.error(0, 'error');
    noopLogger.warn(0, 'warn');

    expect(noopLogger.debug).toHaveBeenCalledTimes(1);
    expect(noopLogger.error).toHaveBeenCalledTimes(1);
    expect(noopLogger.warn).toHaveBeenCalledTimes(1);
  });
});
