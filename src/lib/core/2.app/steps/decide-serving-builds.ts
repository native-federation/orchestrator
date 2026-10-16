import type { ForDecidingServingBuilds } from '../driver-ports/init/for-deciding-serving-builds.port';
import type { ExternalName, RemoteName, SharedExternal, SharedVersion } from 'lib/core/1.domain';
import { type AcceptsTag, createAcceptsTag } from 'lib/core/1.domain/externals/compatibility';
import { scopeRemote } from 'lib/core/1.domain/externals/rows';
import {
  fallbacksOf,
  followServingBuild,
  isPooled,
  packagesOf,
  servingBuildOf,
  shareServingCopies,
  strictObjectorOf,
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
    const serving = servingBuildOf(externals, accepts);
    // Taken before falling back and following rewrite the stored externals in place.
    const before = externals.map(([, external]) => shapeOf(external));
    // The election already placed a pooled package's rows.
    const pooled = isPooled(externals);
    const toFollow = pooled ? undefined : serving;
    if (!pooled) fallBack(pkg, externals, accepts, serving);

    externals.forEach(([name, external], i) => {
      const decided = withServingBuild(
        toFollow ? follow(pkg, name, external, toFollow, accepts) : external,
        serving?.remote
      );
      if (!sameShape(before[i]!, decided))
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

  // The serving copy publishes first, so a remote it covers stays; one it does not runs the package from its own
  // build.
  function fallBack(
    pkg: ExternalName,
    externals: StoredPackage,
    accepts: AcceptsTag,
    serving?: ServingBuild
  ): void {
    if (serving) {
      for (const [, external] of externals) shareServingCopies(external, serving);
      const objector =
        config.strict.strictExternalCompatibility && strictObjectorOf(externals, serving, accepts);
      if (objector)
        rejectIncompatible(
          config,
          objector.copy,
          `${objector.external}@${objector.tag}`,
          `${pkg}@${serving.tag}`
        );
    }
    for (const remote of fallbacksOf(externals, serving, accepts))
      for (const [, external] of externals)
        external.versions = scopeRemote(external.versions, remote);
  }
}

function withServingBuild(external: SharedExternal, servingBuild?: RemoteName): SharedExternal {
  if (external.servingBuild === servingBuild) return external;
  const { servingBuild: _, ...rest } = external;
  return servingBuild ? { ...rest, servingBuild } : rest;
}

// What deciding can change: the serving build, and every field of each row. The helpers reorder, move and merge
// copies but never edit one, so copies compare by identity.
type Shape = { servingBuild?: RemoteName; rows: SharedVersion[] };

const shapeOf = (external: SharedExternal): Shape => ({
  servingBuild: external.servingBuild,
  rows: external.versions.map(
    ({ tag, action, host, remotes }) =>
      ({ tag, action, host, remotes: [...remotes] }) satisfies Required<SharedVersion>
  ),
});

const sameRow = (was: SharedVersion, row: SharedVersion): boolean =>
  (Object.keys(was) as (keyof SharedVersion)[]).every(key =>
    key === 'remotes'
      ? was.remotes.length === row.remotes.length &&
        row.remotes.every((copy, j) => copy === was.remotes[j])
      : was[key] === row[key]
  );

const sameShape = (shape: Shape, external: SharedExternal): boolean =>
  shape.servingBuild === external.servingBuild &&
  shape.rows.length === external.versions.length &&
  external.versions.every((row, i) => sameRow(shape.rows[i]!, row));
