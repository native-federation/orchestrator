import { FederationManifest } from 'lib/1.domain';
import { mockScopeUrl_MFE1, mockScopeUrl_MFE2 } from './scope-url.mock';

export const mockManifest = (): FederationManifest => ({
  'team/mfe1': `${mockScopeUrl_MFE1()}remoteEntry.json`,
  'team/mfe2': `${mockScopeUrl_MFE2()}remoteEntry.json`,
});
