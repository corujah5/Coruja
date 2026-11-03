const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const vm = require('node:vm');

const projectDir = path.resolve(__dirname, '..');

async function freePort() {
  const net = require('node:net');
  const socket = net.createServer();
  await new Promise((resolve, reject) => socket.once('error', reject).listen(0, '127.0.0.1', resolve));
  const { port } = socket.address();
  await new Promise((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
  return port;
}

async function startIsolatedServer() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coruja-admin-key-test-'));
  const dataDir = path.join(root, 'data');
  const port = await freePort();
  const key = 'local-admin-test'; // 16-byte synthetic key exercises the configured minimum.
  const child = spawn(process.execPath, [path.join(projectDir, 'server.js')], {
    cwd: projectDir,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      UPLOAD_DIR: path.join(root, 'uploads'),
      ADMIN_KEY: key,
      ADMIN_USERNAME: '',
      ADMIN_BOOTSTRAP_SECRET: '',
      NODE_ENV: 'test'
    },
    stdio: ['ignore', 'ignore', 'ignore']
  });

  assert.equal(Buffer.byteLength(key, 'utf8'), 16);
  const instance = { root, dataDir, port, key, child };
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`);
      if (response.ok) { ready = true; break; }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!ready) {
    child.kill();
    fs.rmSync(root, { recursive: true, force: true });
    throw new Error('isolated server did not become ready');
  }
  return instance;
}

async function stopServer(instance) {
  if (instance.child.exitCode === null) {
    instance.child.kill();
    await Promise.race([
      new Promise(resolve => instance.child.once('exit', resolve)),
      new Promise(resolve => setTimeout(resolve, 3000))
    ]);
  }
  fs.rmSync(instance.root, { recursive: true, force: true });
}

function adminHeaders(key, json = false) {
  return { ...(json ? { 'content-type': 'application/json' } : {}), 'x-admin-key': key };
}

test('ADMIN_KEY protects the admin API and only the server accepts it from the header', async t => {
  const instance = await startIsolatedServer();
  t.after(() => stopServer(instance));
  const base = `http://127.0.0.1:${instance.port}`;

  const anonymous = await fetch(`${base}/api/admin/users`);
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.headers.get('cache-control'), 'no-store');

  const queryKey = await fetch(`${base}/api/admin/users?key=${encodeURIComponent(instance.key)}`);
  assert.equal(queryKey.status, 401);

  const wrongKey = await fetch(`${base}/api/admin/session`, { headers: adminHeaders('synthetic-wrong-key') });
  assert.equal(wrongKey.status, 401);

  const authorized = await fetch(`${base}/api/admin/session`, { headers: adminHeaders(instance.key) });
  assert.equal(authorized.status, 200);
  assert.deepEqual(await authorized.json(), { authorized: true });
  assert.equal(authorized.headers.get('cache-control'), 'no-store');

  const created = await fetch(`${base}/api/admin/users`, {
    method: 'POST',
    headers: adminHeaders(instance.key, true),
    body: JSON.stringify({ name: 'Conta Sintética', username: 'conta_sintetica', password: 'Senha-sintetica-123!' })
  });
  assert.equal(created.status, 201);
  const createdBody = await created.json();
  assert.equal(createdBody.username, 'conta_sintetica');
  assert.equal(JSON.stringify(createdBody).includes(instance.key), false);

  const users = JSON.parse(fs.readFileSync(path.join(instance.dataDir, 'users.json'), 'utf8'));
  assert.equal(users.length, 1);
  assert.notEqual(users[0].password, 'Senha-sintetica-123!');
  assert.equal(users[0].password.algorithm, 'scrypt');

  const listed = await fetch(`${base}/api/admin/users`, { headers: adminHeaders(instance.key) });
  assert.equal(listed.status, 200);
  assert.equal((await listed.json()).users.length, 1);

  const ordinaryLogin = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'conta_sintetica', password: 'Senha-sintetica-123!' })
  });
  assert.equal(ordinaryLogin.status, 200);
  const ordinaryCookie = ordinaryLogin.headers.get('set-cookie')?.split(';')[0];
  assert.ok(ordinaryCookie);
  const ordinaryUserAdminRequest = await fetch(`${base}/api/admin/users`, { headers: { cookie: ordinaryCookie } });
  assert.equal(ordinaryUserAdminRequest.status, 401);

  const reset = await fetch(`${base}/api/admin/users/${encodeURIComponent(createdBody.user.id)}/reset-password`, {
    method: 'POST', headers: adminHeaders(instance.key)
  });
  assert.equal(reset.status, 200);
  const resetBody = await reset.json();
  assert.equal(typeof resetBody.temporaryPassword, 'string');
  assert.ok(resetBody.temporaryPassword.length >= 8);

  const deleted = await fetch(`${base}/api/admin/users/${encodeURIComponent(createdBody.user.id)}`, {
    method: 'DELETE', headers: adminHeaders(instance.key)
  });
  assert.equal(deleted.status, 200);
  assert.deepEqual(await deleted.json(), { ok: true });
});


test('classic admin client authenticates API requests with the protected header and keeps the key in memory', async t => {
  const instance = await startIsolatedServer();
  t.after(() => stopServer(instance));
  const base = `http://127.0.0.1:${instance.port}`;
  const calls = [];
  const source = fs.readFileSync(path.join(projectDir, 'public', 'admin-classic-auth.js'), 'utf8');
  const sandbox = {
    window: {},
    Headers,
    fetch: (url, options) => { calls.push({ url: String(url), options }); return fetch(new URL(String(url), base), options); }
  };
  vm.runInNewContext(source, sandbox, { filename: 'admin-classic-auth.js' });
  const auth = sandbox.window.CorujaClassicAdminAuth;
  assert.ok(auth);
  assert.equal(auth.isAuthorized(), false);
  assert.deepEqual(await auth.authorize(instance.key), { authorized: true });
  assert.equal(auth.isAuthorized(), true);
  assert.equal(calls[0].options.headers.get('x-admin-key'), instance.key);
  assert.equal(calls[0].options.credentials, 'same-origin');
  assert.equal(JSON.stringify(auth).includes(instance.key), false);

  const listed = await auth.request('/api/admin/users');
  assert.equal(listed.users.length, 0);
  assert.equal(calls[1].options.headers.get('x-admin-key'), instance.key);

  const beforeUnauthenticatedAttempt = calls.length;
  auth.clear();
  assert.equal(auth.isAuthorized(), false);
  await assert.rejects(() => auth.request('/api/admin/users'), /Informe a chave administrativa/);
  assert.equal(calls.length, beforeUnauthenticatedAttempt);

  const html = fs.readFileSync(path.join(projectDir, 'public', 'index.html'), 'utf8');
  assert.match(html, /async function adminJson\(url,options=\{\}\)\{try\{return await window\.CorujaClassicAdminAuth\.request\(url,options\)/);
  assert.match(html, /id="adminClassicAccessForm"/);
});
