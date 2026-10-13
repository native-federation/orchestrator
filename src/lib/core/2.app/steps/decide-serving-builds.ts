import type { ForDecidingServingBuilds } from '../driver-ports/init/for-deciding-serving-builds.port';
import type { ExternalName, RemoteName, SharedExternal } from 'lib/core/1.domain';
import { type AcceptsTag, createAcceptsTag } from 'lib/core/1.domain/externals/compatibility';
import {
  followServingBuild,
  isPooled,
  packagesOf,
  resolvesAtServingTag,
  servingBuildOf,
  type ServingBuild,
} from 'lib/core/1.domain/externals/serving';
import type { DrivingContract } from '../driving-ports/driving.contract';
import type { LoggingConfig } from '../config/log.contract';
import type { ModeConfig } from '../config/mode.contract';
import { rejectIncompatible } from './apply-winner';

type StoredPackage = (readonly [ExternalName, SharedExternal])[];

// See docs/version-resolver.md §"One build per package".
export function createDecideServingBuilds(
  config: LoggingConfig & ModeConfig,
  ports: Pick<DrivingContract, 'versionCheck' | 'sharedExternalsRepo'>
): ForDecidingServingBuilds {
  return () => {
    const accepts = createAcceptsTag(ports.versionCheck.isCompatible, ports.versionCheck.compare);

    try {
      for (const shareScope of ports.sharedExternalsRepo.getScopes()) {
        const sharedExternals = ports.sharedExternalsRepo.getFromScope(shareScope);
        for (const [pkg, names] of packagesOf(sharedExternals)) {
          const externals = names.map(name => [name, sharedExternals[name]!] as const);
          decidePackage(shareScope, pkg, externals, accepts);
        }
      }
      return Promise.resolve();
    } catch (e) {
      return Promise.reject(e);
    }
  };

  function decidePackage(
    shareScope: string,
    pkg: ExternalName,
    externals: StoredPackage,
    accepts: AcceptsTag
  ): void {
    const serving = servingBuildOf(externals, accepts);
    // The election already placed a pooled package's rows.
    const toFollow = isPooled(externals) ? undefined : serving;
    // Decided before any external moves; an external that would resolve nowhere keeps its own rows.
    const follows = toFollow ? followersOf(externals, toFollow) : new Set<ExternalName>();

    for (const [name, external] of externals) {
      // Taken first: following the serving build rewrites the stored external in place.
      const before = JSON.stringify(external);
      const decided = withServingBuild(
        toFollow && follows.has(name) ? follow(pkg, name, external, toFollow, accepts) : external,
        serving?.remote
      );
      if (JSON.stringify(decided) !== before)
        ports.sharedExternalsRepo.addOrUpdate(name, decided, shareScope);
    }
  }

  function follow(
    pkg: ExternalName,
    name: ExternalName,
    external: SharedExternal,
    serving: ServingBuild,
    accepts: AcceptsTag
  ): SharedExternal {
    const { external: followed, objector } = followServingBuild(external, serving, accepts);
    if (objector && config.strict.strictExternalCompatibility)
      rejectIncompatible(config, objector.copy, `${name}@${objector.tag}`, `${pkg}@${serving.tag}`);
    return followed;
  }
}

function withServingBuild(external: SharedExternal, servingBuild?: RemoteName): SharedExternal {
  if (external.servingBuild === servingBuild) return external;
  const { servingBuild: _, ...rest } = external;
  return servingBuild ? { ...rest, servingBuild } : rest;
}

function followersOf(externals: StoredPackage, serving: ServingBuild): Set<ExternalName> {
  return new Set(
    externals.map(([name]) => name).filter(name => resolvesAtServingTag(externals, serving, name))
  );
}
