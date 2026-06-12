import type { LoadRemoteModule } from 'lib/core/init-federation.contract';

export type ForExposingModuleLoader = () => Promise<LoadRemoteModule>;
