'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const net = require('node:net');
const { spawn } = require('node:child_process');

const projectDir = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(projectDir, 'public', 'index.html'), 'utf8');

function clientSyncHarness(storage = new Map()) {
  const start = html.indexOf('  function pendingCustomListOperationsKey(');
  const end = html.indexOf('\n  async function syncMergedAccountState(', start);
  assert.notEqual(start, -1, 'pending custom-list sync helpers should exist');
  assert.notEqual(end, -1, 'pending custom-list sync helpers should be followed by account merge');
  const section = html.slice(start, end);
  const mediaTypeOf = item => item?.media_type || (item?.title ? 'movie' : 'tv');
  const context = {
    KEY: 'coruja_time_state_v2',
    user: { userId: 'synthetic-account', sessionToken: 'cookie-session', customLists: [] },
    syncTimer: null,
    clearTimeout() {},
    clearPendingAccountMerge() {},
    localStorage: {
      getItem(key) { return storage.has(key) ? storage.get(key) : null; },
      setItem(key, value) { storage.set(key, String(value)); },
      removeItem(key) { storage.delete(key); }
    },
    mediaTypeOf,
    profileCustomListItemKey(item) { return item?.id == null ? '' : `${mediaTypeOf(item)}:${item.id}`; },
    profileCustomListMediaType(list) {
      if (list?.mediaType === 'movie' || list?.mediaType === 'tv') return list.mediaType;
      const types = new Set((Array.isArray(list?.items) ? list.items : []).map(mediaTypeOf));
      return types.size === 1 ? [...types][0] : types.size > 1 ? 'mixed' : '';
    },
    async syncStateToServer() { return true; }
  };
  vm.createContext(context);
  vm.runInContext(`${section}\nthis.api = { pendingCustomListOperationsKey, readPendingCustomListOperations, enqueuePendingCustomListOperation, applyPendingCustomListOperations, clearPendingCustomListOperations, customListOperationConfirmed, syncPendingCustomListOperations };`, context);
  return { api: context.api, context, storage };
}

function installProfileCustomListAdd(context) {
  const start = html.indexOf('  function profileCustomListAdd(');
  const end = html.indexOf('\n  function removeProfileCustomListItem(', start);
  assert.notEqual(start, -1, 'custom-list add helper should exist');
  assert.notEqual(end, -1, 'custom-list remove helper should follow add helper');
  vm.runInContext(`${html.slice(start, end)}\nthis.profileCustomListAdd = profileCustomListAdd;`, context);
}

function installSyncFunction(context) {
  const start = html.indexOf('  async function syncStateToServer(){');
  const end = html.indexOf('\n  const save=', start);
  assert.notEqual(start, -1, 'the server sync function should exist');
  assert.notEqual(end, -1, 'the save function should follow server sync');
  vm.runInContext(html.slice(start, end), context);
}

async function startIsolatedServer(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coruja-custom-list-sync-'));
  const dataDir = path.join(root, 'data');
  const uploadDir = path.join(root, 'uploads');
  const socket = net.createServer();
  await new Promise((resolve, reject) => socket.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
  const adminKey = 'synthetic-custom-list-test-key';
  const child = spawn(process.execPath, [path.join(projectDir, 'server.js')], {
    cwd: projectDir,
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, UPLOAD_DIR: uploadDir, ADMIN_KEY: adminKey, ADMIN_USERNAME: '', ADMIN_BOOTSTRAP_SECRET: '', NODE_ENV: 'test' },
    stdio: ['ignore', 'ignore', 'ignore']
  });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    if (child.exitCode !== null) break;
    try { if ((await fetch(base)).ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!ready) {
    child.kill();
    fs.rmSync(root, { recursive: true, force: true });
    throw new Error('isolated custom-list test server did not become ready');
  }
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill();
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 3000))]);
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { base, adminKey };
}

test('recovers an acknowledged custom-list addition after reload without adding it to the main library', async t => {
  const { api, storage } = clientSyncHarness();
  const id = api.enqueuePendingCustomListOperation('synthetic-list', 'add', {
    id: 424242,
    media_type: 'movie',
    title: 'Synthetic film outside library',
    poster_path: '/synthetic.jpg',
    addedAt: '2026-11-10T12:00:00.000Z'
  });
  assert.ok(id);

  const serverState = {
    list: [{ id: 987654, media_type: 'movie', title: 'Existing library film' }],
    favorites: { movies: [987654], series: [] },
    customLists: [{ id: 'synthetic-list', name: 'Filmes', mediaType: 'movie', items: [] }]
  };
  const restored = api.applyPendingCustomListOperations(serverState, 'synthetic-account');
  assert.deepEqual(JSON.parse(JSON.stringify(restored.customLists[0].items)).map(item => [item.id, item.media_type]), [[424242, 'movie']]);
  assert.deepEqual(JSON.parse(JSON.stringify(restored.list)).map(item => item.id), [987654], 'custom-list recovery must not add the item to user.list');
  assert.deepEqual(JSON.parse(JSON.stringify(restored.favorites)), serverState.favorites, 'other account fields must be preserved');

  const server = await startIsolatedServer(t);
  const created = await fetch(`${server.base}/api/admin/users`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-key': server.adminKey },
    body: JSON.stringify({ name: 'Synthetic Lists', username: 'synthetic_lists', password: 'Synthetic-password-123!' })
  });
  assert.equal(created.status, 201);
  const login = await fetch(`${server.base}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'synthetic_lists', password: 'Synthetic-password-123!' })
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie);
  const headers = { 'content-type': 'application/json', cookie };
  const save = await fetch(`${server.base}/api/me/state`, { method: 'POST', headers, body: JSON.stringify({ state: restored, baseState: {} }) });
  assert.equal(save.status, 200);
  const afterReload = await fetch(`${server.base}/api/me`, { headers: { cookie } });
  assert.equal(afterReload.status, 200);
  const persisted = (await afterReload.json()).state;
  assert.deepEqual(persisted.customLists[0].items.map(item => [item.id, item.media_type]), [[424242, 'movie']]);
  assert.deepEqual(persisted.list.map(item => item.id), [987654]);
  assert.deepEqual(persisted.favorites, serverState.favorites);
  assert.equal(storage.size, 1, 'pending intent remains until an authenticated save is confirmed');
});

test('adding a title absent from the library queues only its custom-list membership', () => {
  const { api, context } = clientSyncHarness();
  context.user.list = [];
  context.user.customLists = [{ id: 'synthetic-list', name: 'Filmes', mediaType: 'movie', items: [] }];
  let saves = 0;
  context.save = () => { saves++; };
  installProfileCustomListAdd(context);
  const item = { id: 424243, media_type: 'movie', title: 'Outside the library', poster_path: '/poster.jpg' };
  assert.equal(context.profileCustomListAdd(context.user.customLists[0], [item]), 1);
  assert.equal(saves, 1);
  assert.equal(context.user.list.length, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(context.user.customLists[0].items)).map(entry => entry.id), [424243]);
  assert.deepEqual(JSON.parse(JSON.stringify(api.readPendingCustomListOperations('synthetic-account'))).map(operation => [operation.action, operation.listId, operation.item.id]), [['add', 'synthetic-list', 424243]]);
});

test('keeps pending operations account-scoped, idempotent, and bounded to lists that still exist', () => {
  const { api } = clientSyncHarness();
  api.enqueuePendingCustomListOperation('synthetic-list', 'add', { id: 12, media_type: 'tv', name: 'Synthetic series' });
  api.enqueuePendingCustomListOperation('deleted-list', 'add', { id: 13, media_type: 'movie', title: 'Must not recreate a deleted list' });
  api.enqueuePendingCustomListOperation('synthetic-list', 'remove', 'movie:21');
  const state = {
    list: [],
    customLists: [
      { id: 'synthetic-list', name: 'Séries', mediaType: 'tv', items: [{ id: 21, media_type: 'movie', title: 'Not a series entry' }] },
      { id: 'deleted-list', name: 'Removed list', items: [] }
    ]
  };
  const first = api.applyPendingCustomListOperations(state, 'synthetic-account');
  const second = api.applyPendingCustomListOperations(first, 'synthetic-account');
  assert.deepEqual(JSON.parse(JSON.stringify(second.customLists[0].items)).map(item => item.id), [12]);
  assert.equal(second.customLists.length, 2, 'operations must not recreate a list deleted on the server');
  assert.deepEqual(JSON.parse(JSON.stringify(api.applyPendingCustomListOperations(state, 'other-account'))), state, 'another account must not see this account’s queued operations');
});

test('preserves pending list intent after failed saves and removes only confirmed operations', async () => {
  const { api, context, storage } = clientSyncHarness();
  const firstId = api.enqueuePendingCustomListOperation('list-a', 'add', { id: 1, media_type: 'movie', title: 'One' });
  context.user.customLists = [{ id: 'list-a', mediaType: 'movie', items: [{ id: 1, media_type: 'movie' }] }];
  context.fetch = async () => ({ ok: false, status: 409 });
  installSyncFunction(context);
  assert.equal(await api.syncPendingCustomListOperations(), false);
  assert.deepEqual(JSON.parse(JSON.stringify(api.readPendingCustomListOperations('synthetic-account'))).map(operation => operation.id), [firstId]);

  let successfulFetches = 0;
  context.fetch = async () => { successfulFetches++; return { ok: true, json: async () => ({ state: { customLists: [{ id: 'list-a', mediaType: 'movie', items: [{ id: 1, media_type: 'movie' }] }] } }) }; };
  assert.equal(api.customListOperationConfirmed({ customLists: [{ id: 'list-a', mediaType: 'movie', items: [{ id: 1, media_type: 'movie' }] }] }, api.readPendingCustomListOperations('synthetic-account')[0]), true);
  const syncResult = await context.syncStateToServer();
  assert.ok(successfulFetches > 0);
  assert.equal(syncResult, true, `the sync function must accept a server-confirmed addition; fetches=${successfulFetches}; pending=${JSON.stringify(api.readPendingCustomListOperations('synthetic-account'))}; mock=${String(context.fetch)}`);
  assert.equal(await api.syncPendingCustomListOperations(), true);
  assert.equal(api.readPendingCustomListOperations('synthetic-account').length, 0, 'a server response containing the item confirms and clears it');

  const secondId = api.enqueuePendingCustomListOperation('list-a', 'add', { id: 2, media_type: 'movie', title: 'Two' });
  context.fetch = async () => {
    api.enqueuePendingCustomListOperation('list-a', 'add', { id: 3, media_type: 'movie', title: 'Three' });
    return { ok: true, json: async () => ({ state: { customLists: [{ id: 'list-a', mediaType: 'movie', items: [{ id: 1, media_type: 'movie' }] }] } }) };
  };
  assert.equal(await api.syncPendingCustomListOperations(), false, 'an OK response that omits the title is not treated as saved');
  const remaining = api.readPendingCustomListOperations('synthetic-account');
  assert.equal(remaining.length, 2, 'unconfirmed and later concurrent changes must remain queued');
  assert.equal(remaining[0].id, secondId);
  assert.equal(remaining[1].item.id, 3);
  assert.ok(storage.size > 0);
});
