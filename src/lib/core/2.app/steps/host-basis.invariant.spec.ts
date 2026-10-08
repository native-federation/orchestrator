import type { RemoteEntry } from 'lib/core/1.domain';
import { portfolio } from 'lib/testing/pooling/portfolio';
import { tagSharedInfoByNpmScope } from 'lib/testing/pooling/tag-by-npm-scope';

/**
 * On a version flagged `host`, `remotes[0]` is the host's copy — what the import map publishes and what
 * eviction reads to decide when the flag lapses (`shared-externals.repository.ts`).
 *
 * Nothing enforces it locally; it is the product of three decisions this spec pulls at in turn:
 * `addRemoteToVersion` unshifts the host and then freezes the leader, `applyWinner` never splits the winner
 * (host precedence always makes the host's version the winner), and pooling's `memberRecord` sorts the
 * elected basis first — the host, since a host is never islanded, torn, or placed in a subpool.
 */

type Dep = { pkg: string; version: string; req?: string; strict?: boolean };

// `v2` is a redeploy at a new URL, which a warm page fetches again as an override of the cached remote.
const entry = (name: string, deps: Dep[], o: { v2?: boolean } = {}): RemoteEntry =>
  ({
    name,
    url: `http://${name.replace('/', '-')}/${o.v2 ? 'v2/' : ''}remoteEntry.json`,
    exposes: [],
    shared: deps.map(d => ({
      packageName: d.pkg,
      singleton: true,
      strictVersion: d.strict ?? true,
      requiredVersion: d.req ?? `^${d.version}`,
      version: d.version,
      entries: { [d.pkg]: `${d.pkg.replace(/[@/]/g, '_')}-${d.version}.js` },
    })),
  }) as unknown as RemoteEntry;

// The init flow, start to commit, on real repositories; a second page opens over what the first committed.
// With pooling, entries arrive tagged by npm scope — the build's default for scoped packages.
function setup(pooling: boolean) {
  const p = portfolio({}, { hosts: ['host'], storage: 'nf-host-basis', realRepositories: true });
  const tagged = (entries: RemoteEntry[]) =>
    pooling ? entries.map(e => ({ ...e, shared: tagSharedInfoByNpmScope(e.shared) })) : entries;
  return {
    p,
    init: (entries: RemoteEntry[]) => p.runInit(tagged(entries)),
    nextPage: (entries: RemoteEntry[]) => {
      p.reload();
      return p.runInit(tagged(entries));
    },
  };
}

const violations = ({ p }: ReturnType<typeof setup>, host = 'host') => {
  const repo = p.adapters.sharedExternalsRepo;
  const out: string[] = [];
  for (const scope of repo.getScopes()) {
    for (const [name, external] of Object.entries(repo.getFromScope(scope))) {
      for (const v of external.versions) {
        const at = v.remotes.findIndex(r => r.name === host);
        const label = `${scope}/${name}@${v.tag} (${v.action})`;
        if (v.host && at !== 0) {
          out.push(
            `${label} is flagged but leads with ${v.remotes[0]?.name ?? '∅'} (host at ${at})`
          );
        }
        if (!v.host && at !== -1) {
          out.push(`${label} carries the host at ${at} but is not flagged`);
        }
      }
    }
  }
  return out;
};

const FAMILY = '@framework';

describe('the host stays at remotes[0]', () => {
  it('host arrives last, on a tag other remotes already hold', async () => {
    const page = setup(false);

    await page.init([
      entry('team/mfe1', [{ pkg: 'dep-a', version: '2.0.0' }]),
      entry('team/mfe2', [{ pkg: 'dep-a', version: '2.0.0' }]),
      entry('host', [{ pkg: 'dep-a', version: '2.0.0' }]),
    ]);

    expect(violations(page)).toEqual([]);
  });

  it('host is outranked on coverage by a wider copy of its own tag', async () => {
    const page = setup(false);

    // mfe1 declares two entrypoints of dep-a, the host only one. Coverage would promote mfe1.
    const wide = entry('team/mfe1', [{ pkg: 'dep-a', version: '2.0.0' }]);
    (wide.shared[0] as { entries: Record<string, string> }).entries['dep-a/sub'] = 'sub.js';

    await page.init([wide, entry('host', [{ pkg: 'dep-a', version: '2.0.0' }])]);

    expect(violations(page)).toEqual([]);
  });

  it('a non-host remote on the host version is evicted', async () => {
    const page = setup(false);
    const host = entry('host', [{ pkg: 'dep-a', version: '2.0.0' }]);

    await page.init([host, entry('team/mfe1', [{ pkg: 'dep-a', version: '2.0.0' }])]);
    await page.nextPage([
      host,
      entry('team/mfe1', [{ pkg: 'dep-a', version: '3.0.0' }], { v2: true }),
    ]);

    expect(violations(page)).toEqual([]);
  });

  it('pooled family, host present, one remote islanded across a major gap', async () => {
    const page = setup(true);

    await page.init([
      entry('host', [
        { pkg: `${FAMILY}/core`, version: '22.0.5' },
        { pkg: `${FAMILY}/router`, version: '22.0.5' },
      ]),
      entry('team/mfe1', [
        { pkg: `${FAMILY}/core`, version: '22.0.5' },
        { pkg: `${FAMILY}/router`, version: '22.0.5' },
      ]),
      entry('team/mfe2', [
        { pkg: `${FAMILY}/core`, version: '22.1.0' },
        { pkg: `${FAMILY}/router`, version: '22.1.0' },
      ]),
      // Previous major: its range rejects the elected build, so it serves its whole family itself.
      entry('team/mfe3', [
        { pkg: `${FAMILY}/core`, version: '21.0.0', req: '~21.0.0' },
        { pkg: `${FAMILY}/router`, version: '21.0.0', req: '~21.0.0' },
      ]),
    ]);

    // mfe2's ^22.1.0 rejects the host's 22.0.5 too.
    expect(page.p.islands()).toEqual({
      'team/mfe2': 'incompatible',
      'team/mfe3': 'incompatible',
    });
    expect(violations(page)).toEqual([]);
  });

  it('pooled family where the host is not the widest build', async () => {
    const page = setup(true);

    // The host ships only core; mfe1 ships the whole family and is the better build for mfe2.
    await page.init([
      entry('host', [{ pkg: `${FAMILY}/core`, version: '22.0.5' }]),
      entry('team/mfe1', [
        { pkg: `${FAMILY}/core`, version: '22.0.5' },
        { pkg: `${FAMILY}/router`, version: '22.0.5' },
        { pkg: `${FAMILY}/forms`, version: '22.0.5' },
      ]),
      entry('team/mfe2', [
        { pkg: `${FAMILY}/core`, version: '22.0.5' },
        { pkg: `${FAMILY}/router`, version: '22.0.5' },
      ]),
    ]);

    expect(violations(page)).toEqual([]);
  });

  // The shape eviction has to handle: the host leaves a version whose other copies stay.
  it('host moves off a tag it shared with another remote', async () => {
    const page = setup(false);
    const others = [
      entry('team/mfe1', [{ pkg: 'dep-a', version: '2.0.0' }]),
      entry('team/mfe2', [{ pkg: 'dep-a', version: '1.0.0' }]),
    ];

    await page.init([entry('host', [{ pkg: 'dep-a', version: '2.0.0' }]), ...others]);
    await page.nextPage([
      entry('host', [{ pkg: 'dep-a', version: '1.0.0' }], { v2: true }),
      ...others,
    ]);

    expect(violations(page)).toEqual([]);
    expect(page.p.record('dep-a').versions.find(v => v.host)?.tag).toBe('1.0.0');
  });

  it('host downgrades onto a tag another remote already leads', async () => {
    const page = setup(true);
    const others = [
      entry('team/mfe1', [{ pkg: `${FAMILY}/core`, version: '22.0.5' }]),
      entry('team/mfe2', [{ pkg: `${FAMILY}/core`, version: '22.0.5' }]),
    ];

    await page.init([entry('host', [{ pkg: `${FAMILY}/core`, version: '22.1.0' }]), ...others]);
    await page.nextPage([
      entry('host', [{ pkg: `${FAMILY}/core`, version: '22.0.5' }], { v2: true }),
      ...others,
    ]);

    expect(violations(page)).toEqual([]);
  });
});
