import { RemoteEntry } from 'lib/core/1.domain';
import { mockScopeUrl_HOST, mockScopeUrl_MFE1, mockScopeUrl_MFE2 } from '../scope-url.mock';
import {
  mockFederationInfo_HOST,
  mockFederationInfo_MFE1,
  mockFederationInfo_MFE2,
} from './federation-info.mock';

// Local federation-info shape: like upstream FederationInfo but carrying the local SharedInfo
// union (which allows the transitional `entries` prop in place of `outFileName`).
type LocalFederationInfo = Omit<RemoteEntry, 'url' | 'host' | 'override'>;

type MockRemoteEntryOptions = Partial<LocalFederationInfo> & {
  host?: boolean;
  override?: boolean;
};
/**
 * --------------------------------------
 *  REMOTE_ENTRY
 * --------------------------------------
 */
export const mockRemoteEntry = (
  scopeUrl: (o: { file: string }) => string,
  federationInfo: LocalFederationInfo = mockFederationInfo_MFE1(),
  opts: MockRemoteEntryOptions = {}
): RemoteEntry => ({
  ...federationInfo,
  ...opts,
  url: scopeUrl({ file: 'remoteEntry.json' }),
});

export const mockRemoteEntry_MFE1 = (opts: MockRemoteEntryOptions = {}): RemoteEntry =>
  mockRemoteEntry(mockScopeUrl_MFE1, mockFederationInfo_MFE1(), opts);

export const mockRemoteEntry_MFE2 = (opts: MockRemoteEntryOptions = {}): RemoteEntry =>
  mockRemoteEntry(mockScopeUrl_MFE2, mockFederationInfo_MFE2(), opts);

export const mockRemoteEntry_HOST = (opts: MockRemoteEntryOptions = {}): RemoteEntry =>
  mockRemoteEntry(mockScopeUrl_HOST, mockFederationInfo_HOST(), { host: true, ...opts });
