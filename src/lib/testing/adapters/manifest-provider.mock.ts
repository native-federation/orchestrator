import { ForProvidingManifest } from 'lib/core/2.app/driving-ports/for-providing-manifest.port';
import { mockManifest } from '../domain/manifest.mock';
import { FederationManifest } from 'lib/core/1.domain';

export const mockManifestProvider = (): jest.Mocked<ForProvidingManifest> => ({
  provide: jest.fn((manifest: string | FederationManifest) => {
    return Promise.resolve(typeof manifest === 'string' ? mockManifest() : manifest);
  }),
});
