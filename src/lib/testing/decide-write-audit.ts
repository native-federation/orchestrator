import { GLOBAL_SCOPE } from 'lib/core/1.domain';
import type { ForDecidingServingBuilds } from 'lib/core/2.app/driver-ports/init/for-deciding-serving-builds.port';
import type { ForSharedExternalsStorage } from 'lib/core/2.app/driving-ports/for-shared-externals-storage.port';

// Holds each decide run to: the externals it writes are exactly those whose stored JSON differs afterwards.
export const auditDecideWrites =
  (repo: ForSharedExternalsStorage, decide: ForDecidingServingBuilds): ForDecidingServingBuilds =>
  async () => {
    const snapshot = () =>
      new Map(
        repo
          .getScopes()
          .flatMap(scope =>
            Object.entries(repo.getFromScope(scope)).map(
              ([name, external]) => [`${scope}|${name}`, JSON.stringify(external)] as const
            )
          )
      );
    const before = snapshot();
    const written = new Set<string>();
    const addOrUpdate = repo.addOrUpdate;
    repo.addOrUpdate = function (name, external, shareScope) {
      written.add(`${shareScope ?? GLOBAL_SCOPE}|${name}`);
      return addOrUpdate.call(this, name, external, shareScope);
    };
    try {
      await decide();
    } finally {
      repo.addOrUpdate = addOrUpdate;
    }
    const changed = [...snapshot()].filter(([key, json]) => before.get(key) !== json);
    expect([...written].sort()).toEqual(changed.map(([key]) => key).sort());
    auditedRuns.decides++;
    auditedRuns.writes += written.size;
    auditedRuns.kept += before.size - written.size;
  };

// For a spec that must show the audit ran on writes and on externals left as they were.
export const auditedRuns = { decides: 0, writes: 0, kept: 0 };

export const resetAuditedRuns = (): void => {
  auditedRuns.decides = auditedRuns.writes = auditedRuns.kept = 0;
};
