import type { NativeFederationResult } from 'lib/core/init-federation.contract';

type BusLike = { emit(channel: string, value: unknown): void };
type RegistryLike = { register(name: string, value: unknown): unknown };

// duck-typed: no dependency on the communication package
export function announceInitReady(loaders: NativeFederationResult): void {
  const { __NF_REGISTRY__: registry, __NF_BUS__: bus } = globalThis as {
    __NF_REGISTRY__?: Partial<RegistryLike>;
    __NF_BUS__?: Partial<BusLike>;
  };

  if (typeof registry?.register === 'function') {
    registry.register('orch.init-ready', { ...loaders });
  }
  if (typeof bus?.emit === 'function') {
    bus.emit('orch.init-ready', { ...loaders });
  }
}
