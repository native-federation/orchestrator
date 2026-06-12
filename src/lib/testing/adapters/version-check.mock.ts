import { ForVersionChecking } from 'lib/core/2.app/driving-ports/for-version-checking.port';

export const mockVersionCheck = (): ForVersionChecking => ({
  isCompatible: vi.fn(),
  isValidSemver: vi.fn(),
  compare: vi.fn(),
  smallestVersion: vi.fn(),
});
