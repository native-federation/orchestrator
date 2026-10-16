import type { DenseSharedInfo, RemoteEntry } from 'lib/core/1.domain';
import { portfolio } from 'lib/testing/pooling/portfolio';

/**
 * A runtime load decides each package from the committed claims of that package alone. These fixtures reach
 * the paths the generated portfolios barely do: a root-less package claimed at two tags, every branch of the
 * cold-election check behind a strict rejection, a pool label only the loader carries, and a package whose
 * claims all come from another external's entries.
 */

let storage = 0;

const file = (s: string) => `${s.replace(/^@/, '').replace(/\//g, '_')}.js`;

// One unpooled, singleton external; `with` adds entrypoints to its entries (a dense build).
const flat = (
  name: string,
  version: string,
  range: string,
  o: { strict?: boolean; with?: string[]; pool?: string; shareScope?: string } = {}
): DenseSharedInfo =>
  ({
    packageName: name,
    version,
    requiredVersion: range,
    singleton: true,
    strictVersion: o.strict ?? false,
    ...(o.pool ? { pool: o.pool } : {}),
    ...(o.shareScope ? { shareScope: o.shareScope } : {}),
    entries: Object.fromEntries([name, ...(o.with ?? [])].map(s => [s, file(s)])),
  }) as DenseSharedInfo;

const entry = (name: string, ...shared: DenseSharedInfo[]): RemoteEntry =>
  ({ name, url: `http://${name}/remoteEntry.json`, exposes: [], shared }) as unknown as RemoteEntry;

type Shape = {
  init: RemoteEntry[];
  load: RemoteEntry;
  hosts: string[];
  latest?: boolean;
};

// The load's actions and its warnings and errors, or what it threw.
async function load(c: Shape, strict: boolean) {
  const p = portfolio(
    {},
    {
      storage: `nf-update-cache-claims-${storage++}`,
      realRepositories: true,
      assertNoTear: false,
      hosts: c.hosts,
      strict,
      latestSharedExternal: c.latest ?? false,
    }
  );
  await p.runInit(c.init);
  const logged = () =>
    [...vi.mocked(p.config.log.warn).mock.calls, ...vi.mocked(p.config.log.error).mock.calls]
      .map(([, message]) => String(message))
      .filter(message => message.includes('Is not compatible'));
  try {
    const { actions } = await p.runDynamic(c.load);
    const decided = Object.fromEntries(Object.entries(actions).map(([k, a]) => [k, a.action]));
    return { actions: decided, logged: logged() };
  } catch (e) {
    return { threw: String(e), logged: logged() };
  }
}

const REFUSED = "NFError: Could not process remote 'r1'";

describe('update-cache: decisions read per package', () => {
  // The host claims @x/a/s1 at 1.0.0 and @x/a/s2 at 2.0.0, with no root: the load's serving tag is the first
  // claim's. r1's strict ~2.0.0 rejects s1's 1.0.0, and r1 ships nothing the map lacks, so it would not split
  // the package: the rejection stands.
  const rootless: Shape = {
    init: [entry('h', flat('@x/a/s1', '1.0.0', '^1.0.0'), flat('@x/a/s2', '2.0.0', '^2.0.0'))],
    load: entry(
      'r1',
      flat('@x/a/s1', '2.0.0', '~2.0.0', { strict: true }),
      flat('@x/a/s2', '2.0.0', '~2.0.0')
    ),
    hosts: ['h'],
  };
  const rootlessWarning =
    "[__GLOBAL__][r1] @x/a/s1@2.0.0 Is not compatible with existing @x/a/s1@1.0.0 requiredRange '~2.0.0'";

  it('refuses a strict rejection in a root-less package the host claims at two tags', async () => {
    expect(await load(rootless, true)).toEqual({ threw: REFUSED, logged: [rootlessWarning] });
  });

  it('scopes the whole root-less package when the rejection only warns', async () => {
    expect(await load(rootless, false)).toEqual({
      actions: { '@x/a/s1': 'scope', '@x/a/s2': 'scope' },
      logged: [rootlessWarning],
    });
  });

  // The same host, loaded by a remote whose strict copy accepts the tag claimed for it: it runs both files from
  // the host, at the two tags the host ships.
  it('skips a root-less package claimed at two tags where no range rejects its claim', async () => {
    const c: Shape = {
      ...rootless,
      load: entry(
        'r1',
        flat('@x/a/s2', '2.0.0', '~2.0.0', { strict: true }),
        flat('@x/a/s1', '2.0.0', '~2.0.0')
      ),
    };
    expect(await load(c, true)).toEqual({
      actions: { '@x/a/s2': 'skip', '@x/a/s1': 'skip' },
      logged: [],
    });
  });

  // Each branch of the cold-election check, for an unpooled package that the load would split (r1 ships a
  // specifier the map lacks): it refuses only where a cold init keeping the committed builds would.
  const branches: Record<string, Shape & { refuses: boolean }> = {
    // a strict at ~2.2.0 and r1 strict at ~2.1.0 reject each other's tag.
    'no tag pleases every strict copy': {
      init: [entry('a', flat('p', '2.2.0', '~2.2.0', { strict: true }))],
      load: entry('r1', flat('p', '2.1.0', '~2.1.0', { strict: true, with: ['p/x'] })),
      hosts: [],
      refuses: true,
    },
    'a host row at the claimed tag': {
      init: [entry('h', flat('p', '1.0.0', '^1.0.0'))],
      load: entry('r1', flat('p', '1.1.0', '~1.1.0', { strict: true, with: ['p/x'] })),
      hosts: ['h'],
      refuses: true,
    },
    // a's root makes it p's serving build, so p/x is claimed at a's 1.0.0 beside h's host row at 2.0.0.
    'a host row at another tag than the claimed one': {
      init: [
        entry('a', flat('p', '1.0.0', '^1.0.0'), flat('p/x', '1.0.0', '^1.0.0')),
        entry('h', flat('p/x', '2.0.0', '^2.0.0')),
      ],
      load: entry(
        'r1',
        flat('p/x', '2.0.0', '~2.0.0', { strict: true }),
        flat('p/y', '2.0.0', '~2.0.0')
      ),
      hosts: ['h'],
      refuses: false,
    },
    'latestSharedExternal, with the claimed tag the newest': {
      init: [entry('a', flat('p', '2.0.0', '^2.0.0'), flat('p/x', '2.0.0', '^2.0.0'))],
      load: entry(
        'r1',
        flat('p/x', '1.0.0', '~1.0.0', { strict: true }),
        flat('p/y', '1.0.0', '~1.0.0')
      ),
      hosts: [],
      latest: true,
      refuses: true,
    },
    'latestSharedExternal, with the claimed tag not the newest': {
      init: [entry('a', flat('p', '1.0.0', '^1.0.0'), flat('p/x', '1.0.0', '^1.0.0'))],
      load: entry(
        'r1',
        flat('p/x', '2.0.0', '~2.0.0', { strict: true }),
        flat('p/y', '2.0.0', '~2.0.0')
      ),
      hosts: [],
      latest: true,
      refuses: false,
    },
    'no host and no latestSharedExternal': {
      init: [entry('a', flat('p', '2.0.0', '^2.0.0'), flat('p/x', '2.0.0', '^2.0.0'))],
      load: entry(
        'r1',
        flat('p/x', '1.0.0', '~1.0.0', { strict: true }),
        flat('p/y', '1.0.0', '~1.0.0')
      ),
      hosts: [],
      refuses: false,
    },
    // r1's dense p is rejected on p/x, which the map serves from h's flat p/x external: not r1's own external.
    "a claim of another external than the loader's": {
      init: [entry('h', flat('p', '1.0.0', '^1.0.0'), flat('p/x', '2.0.0', '^2.0.0'))],
      load: entry('r1', flat('p', '1.0.0', '~1.0.0', { strict: true, with: ['p/x'] })),
      hosts: ['h'],
      refuses: false,
    },
  };
  for (const [name, c] of Object.entries(branches))
    it(`${c.refuses ? 'refuses' : 'runs from its own build, silently,'} a strict rejection with ${name}`, async () => {
      const outcome = await load(c, true);
      if (c.refuses) {
        expect(outcome).toEqual({ threw: REFUSED, logged: [expect.any(String)] });
      } else {
        expect(outcome).toHaveProperty('logged', []);
        expect(Object.values((outcome as { actions: object }).actions)).toEqual(
          c.load.shared.map(() => 'scope')
        );
      }
    });

  // The record holds no pool and only the loader's copy carries a label: the package counts as pooled, so the
  // rejection stands although the load would split it, as in "a claim of another external than the loader's".
  it('refuses a rejection where only the loading copy is labelled', async () => {
    const c: Shape = {
      init: [entry('h', flat('p', '1.0.0', '^1.0.0'), flat('p/x', '2.0.0', '^2.0.0'))],
      load: entry('r1', flat('p', '1.0.0', '~1.0.0', { strict: true, with: ['p/x'], pool: 'fw' })),
      hosts: ['h'],
    };
    expect(await load(c, true)).toEqual({
      threw: REFUSED,
      logged: [
        "[__GLOBAL__][r1] p/x@1.0.0 Is not compatible with existing p/x@2.0.0 requiredRange '~1.0.0'",
      ],
    });
  });

  // h's dense p claims p/x under the external p; r1's flat p/x finds them in p's bucket, and its override maps
  // the whole package to h's files.
  it("skips a flat secondary that a dense root serves, mapping the root's build in a named scope", async () => {
    const p = portfolio(
      {},
      {
        storage: `nf-update-cache-claims-${storage++}`,
        realRepositories: true,
        assertNoTear: false,
        hosts: ['h'],
        scope: 'team',
      }
    );
    await p.runInit([
      entry('h', flat('p', '2.0.0', '^2.0.0', { with: ['p/x'], shareScope: 'team' })),
    ]);
    const { actions } = await p.runDynamic(
      entry('r1', flat('p/x', '2.0.0', '^2.0.0', { shareScope: 'team' }))
    );
    expect(actions).toEqual({
      'p/x': { action: 'skip', override: { p: 'http://h/p.js', 'p/x': 'http://h/p_x.js' } },
    });
  });
});
