import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/store/db.js';
import { installUsers } from '../src/store/users.js';
import { createWebServer } from '../src/web/server.js';

async function fixture(t) {
  const db = openDb(':memory:');
  const users = installUsers(db, { onBootstrap: () => {} });
  const admin = users.getUserByUsername('admin');
  users.setPassword(admin.id, 'ephemeral-admin-password');
  const viewer = users.createUser({ username: 'viewer', password: 'ephemeral-viewer-password' });
  const first = db.createMeeting({ guildId: 'guild-a', channelId: 'channel-a', channelName: 'Private A', startedAt: '2026-01-01T00:00:00Z' });
  const other = db.createMeeting({ guildId: 'guild-b', channelId: 'channel-b', channelName: 'Private B', startedAt: '2026-01-01T00:00:00Z' });
  db.seedTodos(other, 'guild-b', [{ assignee: 'Private person', task: 'Private task' }], '2026-01-01');
  const server = createWebServer({ db }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); db.sql.close(); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  async function request(path, { method = 'GET', cookie, body } = {}) {
    const response = await fetch(base + path, { method, headers: {
      ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}),
    }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, cookie: response.headers.get('set-cookie')?.split(';')[0], body: await response.json() };
  }
  const login = (username, password) => request('/auth/login', { method: 'POST', body: { username, password } });
  return { db, users, admin, viewer, first, other, request, login };
}

test('mandatory password rotation blocks every user management operation, then unlocks safely', async t => {
  const { db, users, admin, viewer, request, login } = await fixture(t);
  db.sql.prepare('UPDATE users SET must_change_password = 1 WHERE id = ?').run(admin.id);
  const session = await login('admin', 'ephemeral-admin-password');
  assert.equal(session.status, 200);
  assert.equal(session.body.user.mustChangePassword, true);
  for (const [path, method, body] of [
    ['/users', 'GET'],
    ['/users', 'POST', { username: 'persistent-admin', password: 'attacker-password', isAdmin: true }],
    [`/users/${viewer.id}/password`, 'POST', { password: 'attacker-password' }],
    [`/users/${viewer.id}`, 'PATCH', { isAdmin: true }],
    [`/users/${admin.id}`, 'PATCH', { isAdmin: false }],
    [`/users/${viewer.id}`, 'DELETE'],
    ['/guilds', 'GET'],
  ]) {
    const result = await request(path, { method, body, cookie: session.cookie });
    assert.equal(result.status, 403, `${method} ${path}`);
    assert.equal(result.body.code, 'PASSWORD_CHANGE_REQUIRED');
  }
  assert.equal(users.getUserByUsername('persistent-admin'), undefined);
  assert.equal(users.getUser(viewer.id).isAdmin, false);
  assert.ok(users.authenticate('viewer', 'ephemeral-viewer-password'));
  const rotated = await request('/auth/password', { method: 'POST', cookie: session.cookie, body: { newPassword: 'rotated-admin-password' } });
  assert.equal(rotated.status, 200);
  assert.equal((await request('/users', { cookie: session.cookie })).status, 401);
  assert.equal((await login('admin', 'ephemeral-admin-password')).status, 401);
  const created = await request('/users', { method: 'POST', cookie: rotated.cookie, body: { username: 'authorized-admin', password: 'authorized-password', isAdmin: true } });
  assert.equal(created.status, 201);
  assert.equal(created.body.user.isAdmin, true);
});

test('non-admin sessions cannot discover, read, export, search, or control any guild', async t => {
  const { db, users, admin, first, other, request, login } = await fixture(t);
  const session = await login('viewer', 'ephemeral-viewer-password');
  const todo = db.listTodos('guild-b')[0];
  const routes = [
    ['/guilds'], ['/system/status'], ['/commands'], ['/users'],
    ...['guild-a', 'guild-b'].flatMap(g => ['meetings', 'live', 'stats', 'todos', 'assignees', 'search?q=Private', 'config'].map(s => [`/guilds/${g}/${s}`])),
    ...[first, other].flatMap(id => [[`/meetings/${id}`], [`/meetings/${id}/export`], [`/meetings/${id}/export?format=md`], [`/meetings/${id}/retry`, 'POST'], [`/meetings/${id}`, 'DELETE']]),
    ['/guilds/guild-b/config', 'PATCH', { autoJoin: true }],
    ['/guilds/guild-b/live/channel-b/stop', 'POST'],
    [`/guilds/guild-b/meetings/${other}/ask`, 'POST', { question: 'Private?' }],
    [`/meetings/${first}/merge`, 'POST', { sourceIds: [other] }],
    [`/todos/${todo.id}`, 'PATCH', { done: true }],
    ['/system/bot/stop', 'POST'], ['/system/sidecar/stop', 'POST'],
    ['/system/connection', 'PUT', {}], ['/providers/gemini/key', 'PUT', {}], ['/providers/gemini/models'],
  ];
  for (const [path, method = 'GET', body] of routes) {
    const result = await request(path, { method, body, cookie: session.cookie });
    assert.equal(result.status, 403, `${method} ${path}`);
    assert.deepEqual(result.body, { error: 'Admin access required.' });
  }
  // Authorization is resolved from the current DB role, not frozen into cookies.
  users.updateUser(admin.id, { isAdmin: true });
  users.updateUser(session.body.user.id, { isAdmin: true });
  assert.equal((await request(`/meetings/${other}`, { cookie: session.cookie })).status, 200);
  users.updateUser(session.body.user.id, { isAdmin: false });
  assert.equal((await request(`/meetings/${other}`, { cookie: session.cookie })).status, 403);
});

test('admins retain cross-guild reads/config controls but cannot mix guild and meeting IDs', async t => {
  const { first, other, request, login } = await fixture(t);
  const { cookie } = await login('admin', 'ephemeral-admin-password');
  const guilds = await request('/guilds', { cookie });
  assert.deepEqual(guilds.body.map(g => g.id).sort(), ['guild-a', 'guild-b']);
  for (const id of [first, other]) {
    const meeting = await request(`/meetings/${id}`, { cookie });
    assert.equal(meeting.status, 200);
    assert.equal(meeting.body.meeting.id, id);
    const exported = await request(`/meetings/${id}/export`, { cookie });
    assert.equal(exported.body.meeting.id, id);
  }
  const patch = await request('/guilds/guild-b/config', { method: 'PATCH', cookie, body: { autoJoin: true } });
  assert.equal(patch.status, 200);
  assert.equal(patch.body.config.autoJoin, true);
  assert.equal((await request(`/guilds/guild-a/meetings/${other}/ask`, { method: 'POST', cookie, body: { question: 'wrong guild' } })).status, 404);
  // Matching IDs reach normal request validation, without calling a provider.
  assert.equal((await request(`/guilds/guild-b/meetings/${other}/ask`, { method: 'POST', cookie, body: {} })).status, 400);
  assert.equal((await request(`/meetings/${first}/merge`, { method: 'POST', cookie, body: { sourceIds: [other] } })).status, 400);
});

test('random local bootstrap is single-delivery, rotates over HTTP, and never accepts admin/admin', async t => {
  const db = openDb(':memory:');
  let password;
  const users = installUsers(db, { onBootstrap: value => { password = value; } });
  assert.equal(users.authenticate('admin', 'admin'), null);
  assert.ok(users.authenticate('admin', password));
  installUsers(db, { onBootstrap: () => assert.fail('must not re-deliver a setup credential') });
  const server = createWebServer({ db }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); db.sql.close(); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const post = (path, body, cookie) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
  assert.equal((await post('/auth/login', { username: 'admin', password: 'admin' })).status, 401);
  const login = await post('/auth/login', { username: 'admin', password });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await post('/users', { username: 'intruder', password: 'not-permitted', isAdmin: true }, cookie)).status, 403);
  const rotated = await post('/auth/password', { newPassword: 'operator-chosen-password' }, cookie);
  assert.equal(rotated.status, 200);
  assert.equal((await post('/auth/login', { username: 'admin', password })).status, 401);
  assert.equal((await fetch(base + '/guilds', { headers: { cookie } })).status, 401);
  const nextCookie = rotated.headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(base + '/guilds', { headers: { cookie: nextCookie } })).status, 200);
  const me = await (await fetch(base + '/auth/me')).json();
  assert.deepEqual(me, { authEnabled: true, user: null, defaultPasswordActive: false });
});
