import fc from 'fast-check';
import {
  extraRemotesArbitrary,
  portfolioArbitrary,
  redeployArbitrary,
  redeployedEntries,
  toRemoteEntry,
} from 'lib/testing/pooling/generate-portfolio';
import { TIMEOUT, initOrRefuse, lenient, run } from 'lib/testing/pooling/property-harness';
import { auditedRuns, resetAuditedRuns } from 'lib/testing/decide-write-audit';

/**
 * The serving-build step writes an external when the structure of its rows changed while deciding; it used to
 * compare a JSON snapshot taken before and after. `auditDecideWrites` (lib/testing/decide-write-audit.ts) holds
 * every decide that `portfolio()` runs to the old rule, and so every pooling fixture and property spec, and
 * decide-serving-builds.spec.ts holds its own fixtures to it. This spec adds generated page sequences that
 * reach the shapes decide rewrites most: runtime loads (a loader-opened share row, follow/skip copies, an
 * unpooled scope fallback), the warm init that re-decides after them, and redeploys that evict copies.
 */
describe(
  'decide writes exactly what its JSON snapshots would have written',
  { timeout: TIMEOUT },
  () => {
    for (const [offset, shareScope] of [
      [501, undefined],
      [502, 'team'],
    ] as const)
      it(`over cold, loaded, warm and redeployed pages (${shareScope ?? 'global'} share scope)`, async () => {
        resetAuditedRuns();
        await run(
          offset,
          portfolioArbitrary({
            maxRemotes: 10,
            labelNoise: true,
            flat: true,
            chunks: true,
            latestSharedExternal: true,
            ...(shareScope === undefined ? {} : { shareScope }),
          }).chain(spec =>
            fc.tuple(fc.constant(spec), extraRemotesArbitrary(spec), redeployArbitrary(spec))
          ),
          60,
          async ([spec, extras, redeploys]) => {
            const init = await initOrRefuse(lenient(spec));
            if (!init.ok) return;
            const { rig, entries } = init;
            const loaded = extras.map((extra, i) =>
              toRemoteEntry(extra, entries.length + i, 0, spec.shareScope)
            );
            for (const added of loaded) await rig.load(added);
            await rig.init([...entries, ...loaded]);
            await rig.init([...redeployedEntries(spec, redeploys), ...loaded]);
          }
        );
        // The audit compared real writes and real keeps, not empty runs.
        expect(auditedRuns.decides).toBeGreaterThan(100);
        expect(auditedRuns.writes).toBeGreaterThan(100);
        expect(auditedRuns.kept).toBeGreaterThan(100);
      });
  }
);
