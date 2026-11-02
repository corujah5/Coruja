const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, test } = require('node:test');
const { createBackup } = require('../scripts/backup-data');

const temporaryRoots = new Set();

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coruja-backup-test-'));
  temporaryRoots.add(root);
  return root;
}

function writeFile(root, relative, contents) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
  return file;
}

afterEach(() => {
  for (const root of temporaryRoots) fs.rmSync(root, { recursive: true, force: true });
  temporaryRoots.clear();
});

test('backs up data and nested uploads without copying backups into themselves', () => {
  const root = makeRoot();
  const dataDir = path.join(root, 'data');
  const uploadDir = path.join(dataDir, 'uploads');
  const backupDir = path.join(dataDir, 'backups');
  const privateContents = 'synthetic-private-content';
  writeFile(dataDir, 'users.json', privateContents);
  writeFile(dataDir, 'states/account-a.json', '{"list":[]}');
  writeFile(uploadDir, 'poster.png', 'synthetic-image-bytes');
  writeFile(backupDir, 'old/snapshot.json', 'old-backup');
  writeFile(dataDir, 'in-progress.tmp', 'partial-write');

  const backup = createBackup({ dataDir, uploadDir, backupDir, now: new Date('2026-11-02T12:00:00.000Z'), randomSuffix: () => 'test-one' });
  const manifestText = fs.readFileSync(path.join(backup, 'manifest.json'), 'utf8');
  const manifest = JSON.parse(manifestText);

  assert.equal(fs.readFileSync(path.join(backup, 'data/users.json'), 'utf8'), privateContents);
  assert.equal(fs.readFileSync(path.join(backup, 'data/uploads/poster.png'), 'utf8'), 'synthetic-image-bytes');
  assert.equal(fs.existsSync(path.join(backup, 'data/backups')), false);
  assert.equal(fs.existsSync(path.join(backup, 'data/in-progress.tmp')), false);
  assert.deepEqual(manifest.files.map(file => file.path), [
    'data/states/account-a.json',
    'data/uploads/poster.png',
    'data/users.json'
  ]);
  assert.equal(manifest.files.find(file => file.path === 'data/users.json').sizeBytes, Buffer.byteLength(privateContents));
  assert.equal(manifest.totalBytes, manifest.files.reduce((sum, file) => sum + file.sizeBytes, 0));
  assert.equal(manifestText.includes(privateContents), false);
  assert.equal(manifestText.includes('synthetic-image-bytes'), false);
});

test('backs up uploads stored outside DATA_DIR', () => {
  const root = makeRoot();
  const dataDir = path.join(root, 'data');
  const uploadDir = path.join(root, 'uploads');
  const backupDir = path.join(root, 'archives');
  writeFile(dataDir, 'users.json', '[]');
  writeFile(uploadDir, 'nested/file.bin', 'upload-data');

  const backup = createBackup({ dataDir, uploadDir, backupDir });
  const manifest = JSON.parse(fs.readFileSync(path.join(backup, 'manifest.json'), 'utf8'));

  assert.equal(fs.readFileSync(path.join(backup, 'uploads/nested/file.bin'), 'utf8'), 'upload-data');
  assert.ok(manifest.files.some(file => file.path === 'uploads/nested/file.bin' && file.sizeBytes === 11));
});

test('uses a unique destination and preserves previous backups', () => {
  const root = makeRoot();
  const dataDir = path.join(root, 'data');
  const uploadDir = path.join(dataDir, 'uploads');
  const backupDir = path.join(dataDir, 'backups');
  const now = new Date('2026-11-02T12:00:00.000Z');
  writeFile(dataDir, 'users.json', '[]');

  const first = createBackup({ dataDir, uploadDir, backupDir, now, randomSuffix: () => 'first' });
  fs.writeFileSync(path.join(first, 'keep.txt'), 'previous snapshot');
  const second = createBackup({ dataDir, uploadDir, backupDir, now, randomSuffix: () => 'second' });

  assert.notEqual(first, second);
  assert.equal(fs.readFileSync(path.join(first, 'keep.txt'), 'utf8'), 'previous snapshot');
  assert.ok(fs.existsSync(path.join(second, 'manifest.json')));
});

test('fails and removes the partial snapshot if source data changes during copying', () => {
  const root = makeRoot();
  const dataDir = path.join(root, 'data');
  const uploadDir = path.join(dataDir, 'uploads');
  const backupDir = path.join(dataDir, 'backups');
  const sourceFile = writeFile(dataDir, 'users.json', 'before');
  const originalCopyFileSync = fs.copyFileSync;
  let changed = false;

  fs.copyFileSync = function (...args) {
    const result = originalCopyFileSync.apply(this, args);
    if (!changed && args[0] === sourceFile) {
      changed = true;
      fs.writeFileSync(sourceFile, 'changed-during-copy');
    }
    return result;
  };
  try {
    assert.throws(() => createBackup({ dataDir, uploadDir, backupDir }), /mudaram durante a cópia/);
  } finally {
    fs.copyFileSync = originalCopyFileSync;
  }

  assert.deepEqual(fs.readdirSync(backupDir), []);
});

test('does not print a success message or exit successfully when backup fails', () => {
  const root = makeRoot();
  const result = spawnSync(process.execPath, [path.resolve(__dirname, '../scripts/backup-data.js')], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8',
    env: {
      ...process.env,
      DATA_DIR: path.join(root, 'missing-data'),
      UPLOAD_DIR: path.join(root, 'uploads'),
      BACKUP_DIR: path.join(root, 'backups')
    }
  });

  assert.equal(result.status, 1);
  assert.equal(result.stdout.includes('Backup de dados criado'), false);
  assert.match(result.stderr, /Falha ao criar o backup/);
});
