import { test as base, expect, type Browser, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import type { SseApi } from './boot';

// Real tabs against real Web Locks: the claim is that a second tab opens no connection at all,
// which is only visible as the server's count of requests for the stream.

const HERE = __dirname;

type Net = {
  port: number;
  open: (path?: string) => number;
  /** Requests for a stream since start, including ones since closed. */
  attempts: (path?: string) => number;
  send: (payload: unknown, path?: string) => void;
  close: () => Promise<void>;
};

const ENDPOINT = '/events';
const OTHER_ENDPOINT = '/events-other';
/** Answers 404, which an EventSource treats as fatal: it closes rather than reconnecting. */
const DEAD_ENDPOINT = '/dead';

const startNet = async (boot: string): Promise<Net> => {
  let streams: { path: string; res: ServerResponse }[] = [];
  const attempts = new Map<string, number>();

  const server: Server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]!;

    if (path === DEAD_ENDPOINT) {
      attempts.set(path, (attempts.get(path) ?? 0) + 1);
      res.writeHead(404);
      res.end('no such stream');
      return;
    }

    if (path.startsWith('/events')) {
      attempts.set(path, (attempts.get(path) ?? 0) + 1);
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      // The browser does not report the stream as open until something is written.
      res.write(': open\n\n');
      streams.push({ path, res });
      req.on('close', () => {
        streams = streams.filter(stream => stream.res !== res);
      });
      return;
    }

    if (path === '/sse-boot.js') {
      res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' });
      res.end(boot);
      return;
    }

    res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
    res.end(
      `<!doctype html><html><head><meta charset="utf-8"><title>nfo sse e2e</title>` +
        `<script src="/sse-boot.js"></script></head><body></body></html>`
    );
  });

  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as { port: number };

  return {
    port,
    open: (path = ENDPOINT) => streams.filter(stream => stream.path === path).length,
    attempts: (path = ENDPOINT) => attempts.get(path) ?? 0,
    send: (payload, path = ENDPOINT) => {
      for (const stream of streams)
        if (stream.path === path) stream.res.write(`data: ${JSON.stringify(payload)}\n\n`);
    },
    close: async () => {
      for (const stream of streams) stream.res.end();
      await new Promise<void>(done => server.close(() => done()));
    },
  };
};

const bundleBoot = async () => {
  const out = await build({
    entryPoints: [resolve(HERE, 'boot.ts')],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: 'chrome120',
    alias: { lib: resolve(HERE, '../../src/lib') },
  });
  return out.outputFiles[0]!.text;
};

type Fixtures = { net: Net; tab: (real?: boolean) => Promise<Page> };

const test = base.extend<Fixtures, { boot: string }>({
  boot: [async ({}, use) => use(await bundleBoot()), { scope: 'worker' }],

  net: async ({ boot }, use) => {
    const net = await startNet(boot);
    await use(net);
    await net.close();
  },

  // One context, so tabs share the origin's Web Locks and BroadcastChannel as real tabs would.
  tab: async ({ browser, net }: { browser: Browser; net: Net }, use) => {
    const context = await browser.newContext();
    const open = async (real = false) => {
      const page = await context.newPage();
      await page.goto(`http://127.0.0.1:${net.port}/`);
      await page.evaluate(withRealReload => globalThis.__sse.create(withRealReload), real);
      return page;
    };
    await use(open);
    await context.close();
  },
});

declare global {
  // eslint-disable-next-line no-var
  var __sse: SseApi;
}

const watch = (page: Page, port: number, path = ENDPOINT) =>
  page.evaluate(url => globalThis.__sse.watch(url), `http://127.0.0.1:${port}${path}`);

const reloads = (page: Page) => page.evaluate(() => globalThis.__sse.reloads());

const holding = (page: Page) => page.evaluate(() => globalThis.__sse.holding());

const closeAll = (page: Page) => page.evaluate(() => globalThis.__sse.closeAll());

/** Waits for the first tab to win the election, so the roles are known rather than raced for. */
const leaderThenFollower = async (tab: Fixtures['tab'], net: Net, realReload = false) => {
  const leader = await tab(realReload);
  await watch(leader, net.port);
  await expect.poll(() => holding(leader)).toBe(true);

  const follower = await tab();
  await watch(follower, net.port);
  return { leader, follower };
};

test('a second tab opens no connection of its own', async ({ net, tab }) => {
  const { follower } = await leaderThenFollower(tab, net);

  await expect.poll(() => net.open()).toBe(1);
  // Not merely "one is open": a connection opened and then closed has already spent a slot.
  expect(net.attempts()).toBe(1);
  expect(await holding(follower)).toBe(false);
});

test('a completed build reloads every tab', async ({ net, tab }) => {
  const { leader, follower } = await leaderThenFollower(tab, net);

  net.send({ type: 'federation-rebuild-complete' });

  await expect.poll(() => reloads(leader)).toBe(1);
  await expect.poll(() => reloads(follower)).toBe(1);
});

test('the follower takes over when the leader tab closes', async ({ net, tab }) => {
  const { leader, follower } = await leaderThenFollower(tab, net);

  await leader.close();

  await expect.poll(() => holding(follower)).toBe(true);
  await expect.poll(() => net.open()).toBe(1);
  expect(net.attempts()).toBe(2);
});

test('the follower takes over when the leader calls closeAll', async ({ net, tab }) => {
  const { leader, follower } = await leaderThenFollower(tab, net);

  await closeAll(leader);

  await expect.poll(() => holding(follower)).toBe(true);
  await expect.poll(() => net.open()).toBe(1);
});

// The relay is one channel per origin, so a tab is told about every endpoint, not just its own.
test('a rebuild leaves tabs watching another endpoint alone', async ({ net, tab }) => {
  const mine = await tab();
  await watch(mine, net.port);
  await expect.poll(() => holding(mine)).toBe(true);

  const other = await tab();
  await watch(other, net.port, OTHER_ENDPOINT);
  await expect.poll(() => holding(other)).toBe(true);

  net.send({ type: 'federation-rebuild-complete' }, OTHER_ENDPOINT);

  await expect.poll(() => reloads(other)).toBe(1);
  await expect.poll(() => reloads(mine), { timeout: 2000 }).toBe(0);
});

// The leader broadcasts and reloads itself in the same turn; a stubbed reload would hide whether
// the message survives that.
test('the broadcast lands even though the leader reloads itself', async ({ net, tab }) => {
  const { leader, follower } = await leaderThenFollower(tab, net, true);

  const navigated = leader.waitForEvent('load');
  net.send({ type: 'federation-rebuild-complete' });

  await navigated;
  await expect.poll(() => reloads(follower)).toBe(1);
});

// Before the election every tab had its own stream, so one dead connection cost one tab. A leader
// that kept the lock on a dead stream would cost every tab, including ones opened afterwards.
test('a leader whose stream will not reopen lets another tab try', async ({ net, tab }) => {
  const leader = await tab();
  await watch(leader, net.port, DEAD_ENDPOINT);
  await expect.poll(() => holding(leader)).toBe(true);

  const follower = await tab();
  await watch(follower, net.port, DEAD_ENDPOINT);

  // The follower fails and releases in turn; that it got a turn at all is the point.
  await expect.poll(() => net.attempts(DEAD_ENDPOINT)).toBe(2);
  await expect.poll(() => holding(follower)).toBe(true);
});
