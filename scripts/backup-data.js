const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function timestamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function statSignature(stat) {
  return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(':');
}

function addSourceFiles(sourceRoot, outputPrefix, excludedRoots, inventory) {
  const root = path.resolve(sourceRoot);
  if (!fs.existsSync(root)) return;

  function walk(current) {
    const absolute = path.resolve(current);
    if (excludedRoots.some(excluded => isInside(excluded, absolute))) return;
    if (path.basename(absolute).endsWith('.tmp')) return;

    const stat = fs.lstatSync(absolute, { bigint: true });
    if (stat.isSymbolicLink()) throw new Error('O backup encontrou um link simbólico e foi interrompido.');

    const relative = path.relative(root, absolute);
    if (relative) {
      const outputPath = path.posix.join(outputPrefix, relative.split(path.sep).join('/'));
      inventory.set(outputPath, {
        sourcePath: absolute,
        signature: statSignature(stat),
        type: stat.isDirectory() ? 'directory' : 'file',
        mode: stat.mode,
        size: stat.size
      });
    }

    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(absolute).sort()) walk(path.join(absolute, name));
    } else if (!stat.isFile()) {
      throw new Error('O backup encontrou um tipo de arquivo não suportado e foi interrompido.');
    }
  }

  for (const name of fs.readdirSync(root).sort()) walk(path.join(root, name));
}

function createBackup({ dataDir, uploadDir, backupDir, now = new Date(), randomSuffix = () => crypto.randomBytes(5).toString('hex') }) {
  const dataRoot = path.resolve(dataDir);
  const uploadsRoot = path.resolve(uploadDir);
  const backupsRoot = path.resolve(backupDir);

  if (!fs.existsSync(dataRoot) || !fs.statSync(dataRoot).isDirectory()) {
    throw new Error('O diretório de dados não existe ou não é válido.');
  }
  if (backupsRoot === dataRoot) throw new Error('A pasta de backups não pode ser o próprio diretório de dados.');
  if (uploadsRoot !== dataRoot && isInside(uploadsRoot, dataRoot)) {
    throw new Error('Os diretórios de dados e uploads não podem se sobrepor dessa forma.');
  }

  fs.mkdirSync(backupsRoot, { recursive: true, mode: 0o700 });
  const stamp = timestamp(now);
  let finalName;
  let destination;
  let staging;
  for (let attempt = 0; attempt < 5; attempt++) {
    finalName = `snapshot-${stamp}-${randomSuffix()}`;
    destination = path.join(backupsRoot, finalName);
    staging = path.join(backupsRoot, `.${finalName}.partial`);
    if (!fs.existsSync(destination) && !fs.existsSync(staging)) break;
    destination = undefined;
    staging = undefined;
  }
  if (!destination || !staging) throw new Error('Não foi possível reservar um nome único para o backup.');

  const excludedRoots = [backupsRoot, destination, staging].map(root => path.resolve(root));
  const initialInventory = new Map();
  addSourceFiles(dataRoot, 'data', excludedRoots, initialInventory);

  const uploadsAreInsideData = isInside(dataRoot, uploadsRoot);
  const uploadsExist = fs.existsSync(uploadsRoot);
  if (uploadsExist && !uploadsAreInsideData) addSourceFiles(uploadsRoot, 'uploads', excludedRoots, initialInventory);

  fs.mkdirSync(staging, { recursive: false, mode: 0o700 });
  const copiedFiles = [];

  try {
    const directories = [...initialInventory.entries()]
      .filter(([, item]) => item.type === 'directory')
      .sort((a, b) => a[0].length - b[0].length);
    for (const [relative] of directories) fs.mkdirSync(path.join(staging, ...relative.split('/')), { recursive: true, mode: 0o700 });

    for (const [relative, item] of initialInventory) {
      if (item.type !== 'file') continue;
      const target = path.join(staging, ...relative.split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.copyFileSync(item.sourcePath, target, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(target, Number(item.mode & 0o777n));
      const copiedStat = fs.statSync(target, { bigint: true });
      if (copiedStat.size !== item.size) {
        throw new Error('Um arquivo mudou durante a cópia; o backup foi interrompido.');
      }
      copiedFiles.push({ path: relative, sizeBytes: Number(copiedStat.size) });
    }

    const finalInventory = new Map();
    addSourceFiles(dataRoot, 'data', excludedRoots, finalInventory);
    if (uploadsExist && !uploadsAreInsideData) addSourceFiles(uploadsRoot, 'uploads', excludedRoots, finalInventory);

    if (initialInventory.size !== finalInventory.size) throw new Error('Os dados mudaram durante a cópia; o backup foi interrompido.');
    for (const [relative, before] of initialInventory) {
      const after = finalInventory.get(relative);
      if (!after || before.signature !== after.signature || before.type !== after.type) {
        throw new Error('Os dados mudaram durante a cópia; o backup foi interrompido.');
      }
    }

    copiedFiles.sort((a, b) => a.path.localeCompare(b.path));
    const manifest = {
      createdAt: now.toISOString(),
      files: copiedFiles,
      totalBytes: copiedFiles.reduce((total, file) => total + file.sizeBytes, 0)
    };
    fs.writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2), {
      encoding: 'utf8', mode: 0o600, flag: 'wx'
    });
    fs.renameSync(staging, destination);
    return destination;
  } catch (error) {
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch {}
    throw error;
  }
}

function main() {
  require('dotenv').config();
  const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
  const uploadDir = path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, '..', 'public', 'uploads'));
  const backupDir = path.resolve(process.env.BACKUP_DIR || path.join(dataDir, 'backups'));

  try {
    const destination = createBackup({ dataDir, uploadDir, backupDir });
    console.log(`Backup de dados criado em: ${destination}`);
  } catch {
    console.error('Falha ao criar o backup. Nenhum backup foi declarado como concluído. Verifique o espaço em disco e a estabilidade dos arquivos e tente novamente.');
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { createBackup, isInside };
