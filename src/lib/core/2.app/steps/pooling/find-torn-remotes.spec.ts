import type { ExternalName, RemoteName, SharedVersion, SharedVersionMeta } from 'lib/core/1.domain';
import { mockVersionRemote } from 'lib/testing/domain/externals/version.mock';
import { findTornRemotes } from './pool-shared-externals';
import type { PoolMember } from './pool.types';

/**
 * I3's enforcement, on hand-built input. `poolFamily` cannot reach a tear — gate 1 islands anything with a
 * `scope` copy, gate 2 anchors what a build covers and leaves witnessed remotes alone — so the only way to
 * pin the contract is to hand it the state directly. What it guards is the one decision taken after gate 2
 * stops looking: `rebuildMember` self-serves a copy whose member lost its basis, which is what `basis`
 * missing an entry stands for below.
 */
describe('findTornRemotes', () => {
  const CORE = '@a/core';
  const ROUTER = '@a/router';

  const meta = (name: string): SharedVersionMeta => mockVersionRemote(name, 'ext');

  const row = (
    tag: string,
    remotes: string[],
    action: SharedVersion['action'] = 'skip'
  ): SharedVersion => ({ tag, host: false, action, remotes: remotes.map(meta) });

  /**
   * W ships core only, Q router only, V both — so V is the one build that witnesses the shared pair — and
   * R sits a major below on both, deduping.
   */
  const members = (): PoolMember[] => [
    {
      name: CORE,
      external: {
        dirty: false,
        versions: [row('2.0.0', ['team/W', 'team/V'], 'share'), row('1.0.0', ['team/R'])],
      },
    },
    {
      name: ROUTER,
      external: {
        dirty: false,
        versions: [row('2.0.0', ['team/Q', 'team/V'], 'share'), row('1.0.0', ['team/R'])],
      },
    },
  ];

  const consumed = new Map<RemoteName, ExternalName[]>([
    ['team/W', [CORE]],
    ['team/Q', [ROUTER]],
    ['team/V', [CORE, ROUTER]],
    ['team/R', [CORE, ROUTER]],
  ]);

  const bothBases = new Map<ExternalName, RemoteName>([
    [CORE, 'team/W'],
    [ROUTER, 'team/Q'],
  ]);

  // core's basis is gone: every remote in its share row either islanded or dedups elsewhere, which is the
  // state `rebuildMember` turns into a self-serve for any copy without a `servedBy`.
  const routerOnly = new Map<ExternalName, RemoteName>([[ROUTER, 'team/Q']]);

  it('catches a remote left holding its own copy of one member and a foreign build of another', () => {
    const torn = findTornRemotes(members(), new Map(), consumed, routerOnly, new Map(), new Set());

    // R would run its own core@1.0.0 beside router@2.0.0 from Q. Nobody built that pair.
    expect(torn).toEqual([{ remote: 'team/R', combination: '@a/core@1.0.0, @a/router@2.0.0' }]);
  });

  it('accepts tags one build shipped, whichever remotes served them', () => {
    // R draws core from W and router from Q — two origins, and that is fine: V shipped this pair of tags,
    // so the combination is one that was built and tested together. I3 reads tags, not origins.
    const torn = findTornRemotes(members(), new Map(), consumed, bothBases, new Map(), new Set());

    expect(torn).toEqual([]);
  });

  it('reads an explicit anchor in preference to the global mapping', () => {
    const served = new Map([
      [
        'team/R',
        new Map([
          [CORE, 'team/V'],
          [ROUTER, 'team/V'],
        ]),
      ],
    ]);

    // Even with core's basis gone, an anchored copy resolves the anchor's build rather than its own.
    const torn = findTornRemotes(members(), new Map(), consumed, routerOnly, served, new Set());

    expect(torn).toEqual([]);
  });

  it('never judges a host', () => {
    const torn = findTornRemotes(
      members(),
      new Map(),
      consumed,
      routerOnly,
      new Map(),
      new Set(['team/R'])
    );

    expect(torn).toEqual([]);
  });

  it('never judges a remote that is already islanded', () => {
    const islanded = new Map<RemoteName, { kind: 'incompatible'; member: string; tag: string }>([
      ['team/R', { kind: 'incompatible', member: CORE, tag: '1.0.0' }],
    ]);

    const torn = findTornRemotes(members(), islanded, consumed, routerOnly, new Map(), new Set());

    expect(torn).toEqual([]);
  });
});
