import type { ForDecidingServingBuilds } from '../driver-ports/init/for-deciding-serving-builds.port';
import type { ExternalName, RemoteName, SharedExternal } from 'lib/core/1.domain';
import { type AcceptsTag, createAcceptsTag } from 'lib/core/1.domain/externals/compatibility';
import { scopeRemote } from 'lib/core/1.domain/externals/rows';
import {
  fallbacksOf,
  followServingBuild,
  isPooled,
  packagesOf,
  servingBuildOf,
  shareServingCopies,
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
        if (ports.sharedExternalsRepo.scopeType(shareScope) === 'strict') continue;
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
    // Taken first: falling back and following the serving build rewrite the stored externals in place.
    const before = externals.map(([, external]) => JSON.stringify(external));
    const serving = servingBuildOf(externals, accepts);
    // The election already placed a pooled package's rows.
    const pooled = isPooled(externals);
    const toFollow = pooled ? undefined : serving;
    if (!pooled) fallBack(externals, serving);

    externals.forEach(([name, external], i) => {
      const decided = withServingBuild(
        toFollow ? follow(pkg, name, external, toFollow, accepts) : external,
        serving?.remote
      );
      if (JSON.stringify(decided) !== before[i])
        ports.sharedExternalsRepo.addOrUpdate(name, decided, shareScope);
    });
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

// The serving copy publishes first, so a remote it covers stays; one it does not runs the package from its own
// build.
function fallBack(externals: StoredPackage, serving?: ServingBuild): void {
  if (serving) for (const [, external] of externals) shareServingCopies(external, serving);
  for (const remote of fallbacksOf(externals, serving))
    for (const [, external] of externals)
      external.versions = scopeRemote(external.versions, remote);
}
