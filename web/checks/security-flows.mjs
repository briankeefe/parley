import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const web = process.env.PARLEY_UI_SOURCE || dirname(dirname(fileURLToPath(import.meta.url)));
let temp, ui, openDb, installUsers, createWebServer;
const require = createRequire(join(web, 'package.json'));
before(async () => {
  temp = await mkdtemp(join(tmpdir(), 'parley-ui-test-'));
  await build({
    stdin: { contents: `import React from 'react'; import {create,act} from 'react-test-renderer'; import {MemoryRouter,Routes,Route} from 'react-router-dom'; import {Gate} from './src/App.jsx'; import {Ctx as AuthCtx} from './src/AuthContext.jsx'; import {Ctx as GuildCtx} from './src/GuildContext.jsx'; import Reading from './src/pages/Reading.jsx'; import {api} from './src/api.js'; export {React,create,act,MemoryRouter,Routes,Route,Gate,AuthCtx,GuildCtx,Reading,api};`, resolveDir: web },
    bundle: true, platform: 'node', format: 'esm', jsx: 'automatic', outfile: join(temp, 'ui.mjs'),
    banner: { js: "import {createRequire} from 'node:module'; const require=createRequire(import.meta.url);" },
    plugins: [{ name: 'internal-test-exports', setup(b) {
      // Keep React's real CommonJS module context: bundling React breaks act's
      // timers lookup and leaves its fallback MessageChannel alive in Node.
      b.onResolve({ filter: /^(react(?:\/.*)?|react-dom(?:\/.*)?|react-test-renderer|react-router-dom)$/ },
        ({ path }) => ({ path: require.resolve(path), external: true }));
      b.onLoad({ filter: /\/(App|AuthContext|GuildContext)\.jsx$/ }, async ({ path }) => ({
        contents: await readFile(path, 'utf8') + (path.endsWith('App.jsx') ? '\nexport {Gate};' : '\nexport {Ctx};'), loader: 'jsx',
      }));
    } }],
  });
  ui = await import(pathToFileURL(join(temp, 'ui.mjs')));
  // Prevent the application dotenv loader from consulting deployment config.
  const cwd = process.cwd();
  const oldDataDir = process.env.DATA_DIR, oldEnvFile = process.env.PARLEY_ENV_FILE;
  process.env.DATA_DIR = temp;
  process.env.PARLEY_ENV_FILE = join(temp, '.env');
  process.chdir(temp);
  try {
    ({ openDb } = await import('../../src/store/db.js'));
    ({ installUsers } = await import('../../src/store/users.js'));
    ({ createWebServer } = await import('../../src/web/server.js'));
  } finally {
    process.chdir(cwd);
    if (oldDataDir === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = oldDataDir;
    if (oldEnvFile === undefined) delete process.env.PARLEY_ENV_FILE; else process.env.PARLEY_ENV_FILE = oldEnvFile;
  }
});
after(async () => { if (temp) await rm(temp, { recursive: true, force: true }); });

async function fixture(t) {
  const db = openDb(':memory:');
  const users = installUsers(db, { onBootstrap() {} });
  users.setPassword(users.getUserByUsername('admin').id, 'test-admin-password');
  users.createUser({ username: 'viewer', password: 'test-viewer-password' });
  db.createMeeting({ guildId: 'guild-a', channelId: 'a', channelName: 'A', startedAt: '2026-01-01T00:00:00Z' });
  const meeting = db.createMeeting({ guildId: 'guild-b', channelId: 'b', channelName: 'B', startedAt: '2026-01-01T00:00:00Z' });
  db.sql.prepare("INSERT INTO guild_config (guild_id, summarizer_provider) VALUES ('guild-b', 'fake')").run();
  const server = createWebServer({ db }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const realFetch = globalThis.fetch;
  const pending = new Set(), requests = [];
  let cookie, renderer;
  globalThis.fetch = (url, options = {}) => {
    const target = new URL(url, origin);
    assert.equal(target.origin, origin, 'UI must never call external providers');
    const job = realFetch(target, { ...options, headers: { ...options.headers, ...(cookie ? { cookie } : {}) } }).then(response => {
      const next = response.headers.get('set-cookie');
      if (next) cookie = next.split(';')[0];
      requests.push({ path: target.pathname, status: response.status });
      return response;
    });
    pending.add(job);
    job.then(() => pending.delete(job), () => pending.delete(job));
    return job;
  };
  t.after(async () => {
    if (renderer) await ui.act(async () => renderer.unmount());
    globalThis.fetch = realFetch;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    db.sql.close();
  });
  const auth = user => ({ user, authEnabled: true, loading: false, error: null, refresh: () => ui.api.me(), logout() {} });
  async function render(element) {
    await ui.act(async () => { if (renderer) renderer.update(element); else renderer = ui.create(element); });
    do { await ui.act(async () => { await Promise.all([...pending]); await new Promise(setImmediate); }); } while (pending.size);
    return renderer;
  }
  return { db, meeting, auth, render, requests, get cookie() { return cookie; }, realFetch, origin };
}

// Actual components, hooks, form handlers, browser API helper and HTTP auth stack.
// Only session/guild context state is injected; no API or provider forwarding mocks.
test('non-admin account form changes its password without mounting privileged providers', async t => {
  const f = await fixture(t);
  const { user } = await ui.api.login('viewer', 'test-viewer-password');
  const oldCookie = f.cookie;
  const element = ui.React.createElement(ui.AuthCtx.Provider, { value: f.auth(user) }, ui.React.createElement(ui.Gate));
  const renderer = await f.render(element);
  const forms = renderer.root.findAllByType('form');
  assert.equal(forms.length, 1, 'ordinary non-admin /account must retain its password form');
  const fields = renderer.root.findAllByType('input');
  assert.equal(fields.filter(input => input.props.type === 'password').length, 3);
  await ui.act(async () => {
    fields[0].props.onChange({ target: { value: 'test-viewer-password' } });
    fields[1].props.onChange({ target: { value: 'test-viewer-rotated' } });
    fields[2].props.onChange({ target: { value: 'test-viewer-rotated' } });
  });
  await ui.act(async () => renderer.root.findByType('form').props.onSubmit({ preventDefault() {} }));
  assert.equal((await ui.api.me()).user.username, 'viewer');
  assert.equal((await f.realFetch(f.origin + '/api/auth/me', { headers: { cookie: oldCookie } }).then(r => r.json())).user, null);
  await assert.rejects(ui.api.login('viewer', 'test-viewer-password'), e => e.status === 401);
  assert.equal((await ui.api.login('viewer', 'test-viewer-rotated')).user.isAdmin, false);
  assert.ok(f.requests.every(r => r.path.startsWith('/api/auth/')), 'account screen must not fetch system/guild/user-management data');
  assert.equal(JSON.stringify(renderer.toJSON()).includes(f.cookie), false, 'session cookie must not appear in the rendered UI');
  await assert.rejects(ui.api.guilds(), e => e.status === 403);
  await assert.rejects(ui.api.users(), e => e.status === 403);
});

test('admin saved meeting link, refresh and selector changes Ask using the fetched meeting guild', async t => {
  const f = await fixture(t);
  const { user } = await ui.api.login('admin', 'test-admin-password');
  const { React: R, AuthCtx, GuildCtx, MemoryRouter, Routes, Route, Reading } = ui;
  const element = (selected, key) => R.createElement(AuthCtx.Provider, { value: f.auth(user) },
    R.createElement(GuildCtx.Provider, { value: { guildId: selected } },
      R.createElement(MemoryRouter, { key, initialEntries: [`/meetings/${f.meeting}`], future: { v7_startTransition: true, v7_relativeSplatPath: true } },
        R.createElement(Routes, null, R.createElement(Route, { path: '/meetings/:id', element: R.createElement(Reading) })))));
  for (const [selected, key] of [['guild-a', 'saved-link'], ['guild-a', 'refresh'], ['guild-c', 'refresh']]) {
    const renderer = await f.render(element(selected, key));
    await ui.act(async () => renderer.root.findByType('form').findByType('input').props.onChange({ target: { value: 'What was decided?' } }));
    await ui.act(async () => renderer.root.findByType('form').props.onSubmit({ preventDefault() {} }));
    await f.render(element(selected, key));
    const ask = f.requests.filter(r => r.path.endsWith('/ask')).at(-1);
    assert.deepEqual(ask, { path: `/api/guilds/guild-b/meetings/${f.meeting}/ask`, status: 200 }, `${key}, selector ${selected}`);
    assert.match(JSON.stringify(renderer.toJSON()), /Fake answer/, 'successful Ask must be shown, not a hidden request failure');
  }
  await assert.rejects(ui.api.ask('guild-a', f.meeting, 'wrong tuple'), e => e.status === 404);
});
