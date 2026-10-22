// test/users.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/store/db.js';
import { installUsers, hashPassword, verifyPassword } from '../src/store/users.js';

test('hashPassword + verifyPassword round-trips and rejects wrong passwords', () => {
  const h = hashPassword('hunter2');
  assert.ok(h.startsWith('scrypt$'));
  assert.equal(verifyPassword('hunter2', h), true);
  assert.equal(verifyPassword('nope', h), false);
  assert.equal(verifyPassword('hunter2', 'garbage'), false);
});


test('installUsers does not duplicate the admin on re-install', () => {
  const db = openDb(':memory:');
  installUsers(db);
  installUsers(db);
  const users = installUsers(db);
  assert.equal(users.countUsers(), 1);
});

test('username lookup is case-insensitive', () => {
  const db = openDb(':memory:');
  const users = installUsers(db);
  users.setPassword(users.getUserByUsername('admin').id, 'test-password');
  assert.ok(users.authenticate('ADMIN', 'test-password'));
});

test('createUser enforces unique usernames', () => {
  const db = openDb(':memory:');
  const users = installUsers(db);
  users.createUser({ username: 'jane', email: 'jane@x.com', password: 'pw1234' });
  assert.throws(() => users.createUser({ username: 'Jane', password: 'other' }), /taken/i);
});

test('setPassword clears must_change_password and changes the credential', () => {
  const db = openDb(':memory:');
  const users = installUsers(db);
  const admin = users.getUserByUsername('admin');
  users.setPassword(admin.id, 'newsecret');
  assert.equal(users.authenticate('admin', 'admin'), null);
  const after = users.authenticate('admin', 'newsecret');
  assert.ok(after);
  assert.equal(after.mustChangePassword, false);
});

test('sessions resolve to a user and expire', () => {
  const db = openDb(':memory:');
  const users = installUsers(db);
  const admin = users.getUserByUsername('admin');
  const { token } = users.createSession(admin.id);
  assert.equal(users.getSessionUser(token).username, 'admin');
  users.deleteSession(token);
  assert.equal(users.getSessionUser(token), null);
  // An already-expired session is rejected and cleaned up.
  const { token: t2 } = users.createSession(admin.id, -1000);
  assert.equal(users.getSessionUser(t2), null);
});

test('admin counting protects against locking everyone out', () => {
  const db = openDb(':memory:');
  const users = installUsers(db);
  assert.equal(users.countAdmins(), 1);
  const u = users.createUser({ username: 'bob', password: 'pw1234', isAdmin: true });
  assert.equal(users.countAdmins(), 2);
  users.updateUser(u.id, { isAdmin: false });
  assert.equal(users.countAdmins(), 1);
});

test('createUser stores email and is queryable via listUsers', () => {
  const db = openDb(':memory:');
  const users = installUsers(db);
  users.createUser({ username: 'kim', email: 'kim@example.com', password: 'pw1234' });
  const list = users.listUsers();
  const kim = list.find((u) => u.username === 'kim');
  assert.equal(kim.email, 'kim@example.com');
  assert.equal(kim.isAdmin, false);
  // Public shape never leaks the hash.
  assert.equal('password_hash' in kim, false);
});

test('defaultPasswordActive is true for the seeded admin, false after change', () => {
  const db = openDb(':memory:');
  const users = installUsers(db);
  assert.equal(users.defaultPasswordActive(), true); // seeded admin/admin
  const admin = users.getUserByUsername('admin');
  users.setPassword(admin.id, 'a-real-password');
  assert.equal(users.defaultPasswordActive(), false);
});

test('legacy admin/admin is replaced once and its sessions are revoked; chosen passwords survive reinstall', () => {
  const db = openDb(':memory:');
  const users = installUsers(db, { onBootstrap: () => {} });
  const admin = users.getUserByUsername('admin');
  users.setPassword(admin.id, 'admin');
  db.sql.prepare('UPDATE users SET must_change_password = 1 WHERE id = ?').run(admin.id);
  const { token } = users.createSession(admin.id);
  let bootstrap;
  installUsers(db, { onBootstrap: password => { bootstrap = password; } });
  assert.equal(users.authenticate('admin', 'admin'), null);
  assert.equal(users.getSessionUser(token), null);
  assert.equal(users.authenticate('admin', bootstrap).mustChangePassword, true);
  installUsers(db, { onBootstrap: () => assert.fail('must not rotate again') });
  users.setPassword(admin.id, 'chosen-password');
  installUsers(db, { onBootstrap: () => assert.fail('must preserve chosen password') });
  assert.equal(users.authenticate('admin', bootstrap), null);
  assert.equal(users.authenticate('admin', 'chosen-password').mustChangePassword, false);
  db.sql.close();
});
