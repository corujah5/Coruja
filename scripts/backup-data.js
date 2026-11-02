require('dotenv').config();
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, '..', 'public', 'uploads'));
const BACKUP_DIR = path.resolve(process.env.BACKUP_DIR || path.join(DATA_DIR, 'backups'));

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function timestamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

if (!fs.existsSync(DATA_DIR)) throw new Error('O diretório de dados não existe.');

const destination = path.join(BACKUP_DIR, `snapshot-${timestamp()}`);
fs.mkdirSync(destination, { recursive: true, mode: 0o700 });

const copied = [];
const dataDestination = path.join(destination, 'data');
fs.cpSync(DATA_DIR, dataDestination, {
  recursive: true,
  errorOnExist: true,
  force: false,
  filter(source) {
    const resolved = path.resolve(source);
    if (isInside(BACKUP_DIR, resolved)) return false;
    if (resolved.endsWith('.tmp')) return false;
    return true;
  }
});
copied.push('data');

if (fs.existsSync(UPLOAD_DIR) && !isInside(DATA_DIR, UPLOAD_DIR)) {
  fs.cpSync(UPLOAD_DIR, path.join(destination, 'uploads'), { recursive: true, errorOnExist: true, force: false });
  copied.push('uploads');
}

fs.writeFileSync(path.join(destination, 'manifest.json'), JSON.stringify({
  createdAt: new Date().toISOString(),
  contents: copied
}, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' });

console.log(`Backup de dados criado em: ${destination}`);
