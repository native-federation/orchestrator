import { test as base, expect, type Browser, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import type { SseApi } from './boot';

/**
 * Real tabs, one real origin, one real event stream. The claim the election makes is that a second
 * tab opens no connection at all, and that is a fact about the browser's Web Locks and about the
 * server's count of open responses — neither of which a mocked `LockManager` can show.
 */

const HERE = __dirname;

type Net = {
  port: number;
  /** Responses held open on the stream: the connections the per-origin cap counts. */
  open: () => number;
  /** Every request for the stream since start, including ones since closed. */
  attempts: () => number;
  send: (payload: unknown) => void;
  close: () => Promise<void>;
};

const ENDPOINT = '/events';

const startNet = async (boot: string): Promise<Net> => {
  let streams: ServerResponse[] = [];
  let attempts = 0;

  const server: Server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];

    if (path === ENDPOINT) {
      attempts++;
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      // Something has to be written before the browser reports the stream as open.
      res.write(': open\n\n');
      streams.push(res);
      req.on('close', () => {
        streams = streams.filter(stream => stream !== res);
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
    open: () => streams.length,
    attempts: () => attempts,
    send: payload => {
      for (const stream of streams) stream.write(`data: ${JSON.stringify(payload)}\n\n`);
    },
    close: async () => {
      for (const stream of streams) stream.end();
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

  // One browser context, so the tabs share the origin's Web Locks and BroadcastChannel exactly as
  // two tabs pointed at the same dev server would.
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

// The API `boot.ts` installs on the page. Only ever touched inside `page.evaluate`.
declare global {
  // eslint-disable-next-line no-var
  var __sse: SseApi;
}

const watch = (page: Page, port: number) =>
  page.evaluate(url => globalThis.__sse.watch(url), `http://127.0.0.1:${port}${ENDPOINT}`);

const reloads = (page: Page) => page.evaluate(() => globalThis.__sse.reloads());

const holding = (page: Page) => page.evaluate(() => globalThis.__sse.holding());

const closeAll = (page: Page) => page.evaluate(() => globalThis.__sse.closeAll());

/** Open a tab, wait until it has won the election, and only then open the next one. */
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
  // Not merely "one is open": the follower must never have dialled at all, which is the whole
  // point — a connection that is opened and then closed has already consumed a slot.
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

/**
 * The election makes one tab responsible for telling the others, so the message has to outlive
 * that tab: it broadcasts and reloads itself in the same turn. A stubbed reload would not show it.
 */
test('the broadcast lands even though the leader reloads itself', async ({ net, tab }) => {
  const { leader, follower } = await leaderThenFollower(tab, net, true);

  const navigated = leader.waitForEvent('load');
  net.send({ type: 'federation-rebuild-complete' });

  await navigated;
  await expect.poll(() => reloads(follower)).toBe(1);
});
