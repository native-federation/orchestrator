import type {
  RemoteName,
  SharedExternal,
  SharedVersion,
  SharedVersionMeta,
} from 'lib/core/1.domain';
import { mockVersionRemote, newestFirst } from 'lib/testing/domain/externals/version.mock';
import { tagStoredByNpmScope } from './tag-by-npm-scope';

/** Record builders for fixtures that seed stored externals directly rather than register remote entries. */

export type CopySpec = {
  remote: RemoteName;
  req: string;
  strict?: boolean;
  host?: boolean;
  cached?: boolean;
  pool?: string;
  entries?: Record<string, string>;
};

/** One stored version of `external`, a copy per spec; `strictVersion` defaults to true. */
export const version = (
  tag: string,
  external: string,
  copies: CopySpec[],
  action: SharedVersion['action'] = 'skip'
): SharedVersion => ({
  tag,
  host: copies.some(c => c.host),
  action,
  remotes: copies.map(c => {
    const meta: SharedVersionMeta = mockVersionRemote(c.remote, external, {
      requiredVersion: c.req,
      strictVersion: c.strict ?? true,
      cached: c.cached ?? false,
      pool: c.pool,
    });
    return c.entries ? { ...meta, entries: c.entries } : meta;
  }),
});

/**
 * A record as storage would hold it: newest first, as `commit()` sorts it, so a fixture reads in whatever
 * order is clearest without seeding an order production could never hand to determine. A scoped package
 * gets its npm-scope pool tag, as the build adds by default; an explicit `pool` wins.
 */
export const storedRecord = (
  name: string,
  versions: SharedVersion[],
  compare: (a: string, b: string) => number,
  dirty = true
): SharedExternal =>
  tagStoredByNpmScope({ [name]: { dirty, versions: newestFirst(versions, compare) } })[name]!;
