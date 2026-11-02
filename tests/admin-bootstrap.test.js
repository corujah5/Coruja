const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { afterEach, test } = require('node:test');

const projectDir = path.resolve(__dirname, '..');
const activeServers = new Set();

async function freePort() {
  const socket = net.createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
  return port;
}

async function launchServer(instance, nodeEnv = 'test') {
  const child = spawn(process.execPath, [path.join(projectDir, 'server.js')], {
    cwd: projectDir,
    env: {
      ...process.env,
      PORT: String(instance.port),
      DATA_DIR: instance.dataDir,
      UPLOAD_DIR: path.join(instance.root, 'uploads'),
      ADMIN_USERNAME: 'bootstrap_admin',
      ADMIN_BOOTSTRAP_SECRET: instance.secret,
      NODE_ENV: nodeEnv
    },
    stdio: ['ignore', 'ignore', 'ignore']
  });
  instance.child = child;

  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(`http://127.0.0.1:${instance.port}/`);
      if (response.ok) { ready = true; break; }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(ready, true, 'isolated server did not become ready');
  return instance;
}

async function startIsolatedServer({ seedUsers, nodeEnv = 'test' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coruja-bootstrap-test-'));
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  if (seedUsers) fs.writeFileSync(path.join(dataDir, 'users.json'), JSON.stringify(seedUsers));

  const instance = { root, dataDir, port: await freePort(), secret: `synthetic-bootstrap-secret-${cryptoRandom()}` };
  activeServers.add(instance);
  return launchServer(instance, nodeEnv);
}

async function stopServer(instance) {
  if (!instance.child || instance.child.exitCode !== null) return;
  const exited = once(instance.child, 'exit');
  instance.child.kill();
  await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 3000))]);
}

function cryptoRandom() {
  return require('node:crypto').randomBytes(24).toString('hex');
}

async function bootstrap(instance, { secret = instance.secret, username = 'bootstrap_admin', password = 'Synthetic-only-password-483!' } = {}) {
  return fetch(`http://127.0.0.1:${instance.port}/api/bootstrap/admin`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-bootstrap': secret },
    body: JSON.stringify({ name: 'Synthetic Admin', username, password })
  });
}

afterEach(async () => {
  for (const instance of activeServers) {
    await stopServer(instance);
    fs.rmSync(instance.root, { recursive: true, force: true });
    activeServers.delete(instance);
  }
});

test('creates the first admin with the existing scrypt hash format and consumes bootstrap', async () => {
  const instance = await startIsolatedServer();
  const response = await bootstrap(instance);
  const body = await response.json();
  assert.equal(response.status, 201);
  assert.equal(body.ok, true);
  assert.equal(body.user.username, 'bootstrap_admin');
  assert.equal(Object.hasOwn(body.user, 'password'), false);

  const users = JSON.parse(fs.readFileSync(path.join(instance.dataDir, 'users.json'), 'utf8'));
  assert.equal(users.length, 1);
  assert.equal(users[0].password.algorithm, 'scrypt');
  assert.equal(typeof users[0].password.hash, 'string');
  assert.equal(users[0].password.hash.length, 128);
  assert.equal(users[0].password.salt.length, 32);
  assert.equal(fs.existsSync(path.join(instance.dataDir, 'admin-bootstrap.json')), true);
});

test('rejects an incorrect bootstrap secret without creating a user', async () => {
  const instance = await startIsolatedServer();
  const response = await bootstrap(instance, { secret: 'incorrect-synthetic-secret' });
  assert.equal(response.status, 403);
  assert.equal(JSON.parse(fs.readFileSync(path.join(instance.dataDir, 'users.json'), 'utf8')).length, 0);
});

test('refuses bootstrap when users already exist', async () => {
  const instance = await startIsolatedServer({ seedUsers: [{ id: 'synthetic-existing-user', username: 'existing' }] });
  const response = await bootstrap(instance);
  assert.equal(response.status, 409);
  assert.equal(JSON.parse(fs.readFileSync(path.join(instance.dataDir, 'users.json'), 'utf8')).length, 1);
});

test('persistent consumed marker prevents reuse even if the user file is later emptied', async () => {
  const instance = await startIsolatedServer();
  const first = await bootstrap(instance);
  assert.equal(first.status, 201);
  fs.writeFileSync(path.join(instance.dataDir, 'users.json'), '[]');

  const second = await bootstrap(instance);
  assert.equal(second.status, 410);
  assert.equal(JSON.parse(fs.readFileSync(path.join(instance.dataDir, 'users.json'), 'utf8')).length, 0);
});

test('production rejects plain HTTP but accepts HTTPS forwarded by the trusted proxy', async () => {
  const instance = await startIsolatedServer({ nodeEnv: 'production' });
  const insecure = await bootstrap(instance);
  assert.equal(insecure.status, 426);
  assert.equal(JSON.parse(fs.readFileSync(path.join(instance.dataDir, 'users.json'), 'utf8')).length, 0);

  const forwardedHttps = await fetch(`http://127.0.0.1:${instance.port}/api/bootstrap/admin`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-admin-bootstrap': instance.secret,
      'x-forwarded-proto': 'https'
    },
    body: JSON.stringify({ name: 'Synthetic Admin', username: 'bootstrap_admin', password: 'Synthetic-only-password-486!' })
  });
  assert.equal(forwardedHttps.status, 201);
});

test('persistence failure leaves a recoverable journal and cannot reopen bootstrap', async () => {
  const instance = await startIsolatedServer();
  const usersTempBlocker = path.join(instance.dataDir, 'users.json.tmp');
  fs.mkdirSync(usersTempBlocker);

  const failed = await bootstrap(instance);
  assert.equal(failed.status, 500);
  assert.equal(JSON.parse(fs.readFileSync(path.join(instance.dataDir, 'users.json'), 'utf8')).length, 0);
  const journalPath = path.join(instance.dataDir, 'admin-bootstrap.json');
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
  assert.equal(journal.status, 'provisioning');
  assert.equal(JSON.stringify(journal).includes('Synthetic-only-password-483!'), false);

  const retry = await bootstrap(instance);
  assert.equal(retry.status, 410);

  await stopServer(instance);
  fs.rmdirSync(usersTempBlocker);
  await launchServer(instance);
  const users = JSON.parse(fs.readFileSync(path.join(instance.dataDir, 'users.json'), 'utf8'));
  const recoveredJournal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
  assert.equal(users.length, 1);
  assert.equal(users[0].username, 'bootstrap_admin');
  assert.equal(recoveredJournal.status, 'consumed');
  assert.equal((await bootstrap(instance)).status, 410);
});

test('concurrent requests cannot provision two first accounts', async () => {
  const instance = await startIsolatedServer();
  const [first, second] = await Promise.all([
    bootstrap(instance, { password: 'Synthetic-only-password-484!' }),
    bootstrap(instance, { password: 'Synthetic-only-password-485!' })
  ]);
  const statuses = [first.status, second.status];
  assert.equal(statuses.filter(status => status === 201).length, 1);
  assert.equal(statuses.some(status => status === 409 || status === 410), true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(instance.dataDir, 'users.json'), 'utf8')).length, 1);
});
