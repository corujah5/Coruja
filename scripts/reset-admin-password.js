#!/usr/bin/env node
'use strict';

// One-time operational recovery utility for the configured administrator.
// It intentionally does not load .env, start the application, or log account
// contents, hashes, session tokens, or the generated password to app logs.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const readline = require('node:readline/promises');

const scryptAsync = promisify(crypto.scrypt);
const SCRYPT = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
const DATA_DIR_CONFIG = String(process.env.DATA_DIR || '').trim();
const DATA_DIR = DATA_DIR_CONFIG ? path.resolve(DATA_DIR_CONFIG) : '';
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups', 'admin-password-reset');
const LOCK_FILE = path.join(BACKUP_DIR, '.admin-password-reset.lock');
const ADMIN_USERNAME = String(process.env.ADMIN_USERNAME || '').trim();
const CONFIRMATION = 'REDEFINIR SENHA ADMINISTRATIVA';

function normalizeUsername(value) {
  return String(value || '').trim().replace(/^@/, '').toLowerCase().replace(/[^a-z0-9_.]/g, '').slice(0, 30);
}

function readJsonStrict(file, description) {
  let value;
  try {
    value = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new Error(`${description} ausente ou inválido.`);
  }
  return value;
}

function sessionUserId(record) {
  if (typeof record === 'string') return record;
  if (record && typeof record === 'object' && Number(record.expiresAt) > Date.now()) {
    return String(record.userId || '');
  }
  return '';
}

function writeJsonAtomic(file, value) {
  const tempFile = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  let fd;
  try {
    fd = fs.openSync(tempFile, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(value, null, 2), 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tempFile, file);
    // The rename is the commit point. A directory fsync is best-effort so a
    // post-rename durability warning cannot be mistaken for a failed write.
    let dirFd;
    try {
      dirFd = fs.openSync(path.dirname(file), 'r');
      fs.fsyncSync(dirFd);
    } catch {
      // File data is already atomically replaced; do not trigger a false rollback.
    } finally {
      if (dirFd !== undefined) {
        try { fs.closeSync(dirFd); } catch {}
      }
    }
  } catch (error) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
    try { fs.unlinkSync(tempFile); } catch {}
    throw error;
  }
}

function makePrivateBackup(file, backupDir, label, stamp) {
  const destination = path.join(backupDir, `${label}-${stamp}-${crypto.randomBytes(4).toString('hex')}.json`);
  fs.copyFileSync(file, destination, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(destination, 0o600);
  return destination;
}

async function makePasswordHash(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = await scryptAsync(password, salt, 64, SCRYPT);
  return {
    algorithm: 'scrypt',
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    salt,
    hash: hash.toString('hex')
  };
}

async function main() {
  if (process.argv.includes('--help')) {
    console.log('Uso: node scripts/reset-admin-password.js [--apply]');
    console.log('Sem --apply, somente valida os pré-requisitos. Com --apply, exige confirmação interativa antes de alterar dados.');
    return;
  }

  if (!normalizeUsername(ADMIN_USERNAME)) {
    throw new Error('ADMIN_USERNAME não está configurado.');
  }
  if (!DATA_DIR_CONFIG) {
    throw new Error('DATA_DIR não está configurado. O script não usa um diretório local padrão.');
  }
  if (!fs.existsSync(DATA_DIR) || !fs.statSync(DATA_DIR).isDirectory()) {
    throw new Error('DATA_DIR não existe ou não está acessível.');
  }
  if (!fs.existsSync(USERS_FILE) || !fs.existsSync(SESSIONS_FILE)) {
    throw new Error('Os arquivos de contas ou sessões não existem. Nenhum arquivo foi criado.');
  }

  const users = readJsonStrict(USERS_FILE, 'Arquivo de contas');
  const sessions = readJsonStrict(SESSIONS_FILE, 'Arquivo de sessões');
  if (!Array.isArray(users)) throw new Error('Arquivo de contas inválido.');
  if (!sessions || typeof sessions !== 'object' || Array.isArray(sessions)) {
    throw new Error('Arquivo de sessões inválido.');
  }

  const targetName = normalizeUsername(ADMIN_USERNAME);
  const matches = users.filter(user => normalizeUsername(user?.username) === targetName);
  if (matches.length !== 1) {
    throw new Error('Não foi possível identificar uma única conta administradora. Nenhum dado foi alterado.');
  }
  const target = matches[0];
  if (target.blocked) {
    throw new Error('A conta administradora está bloqueada. Este procedimento não altera o estado de bloqueio.');
  }

  console.log('Pré-verificação concluída: conta e arquivos de dados válidos.');
  console.log('O script preservará as demais contas e dados, salvará backups privados e revogará as sessões da conta alvo.');

  if (!process.argv.includes('--apply')) {
    console.log('Nenhuma alteração realizada. Para prosseguir, execute novamente com --apply em uma janela de manutenção.');
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('A aplicação exige um terminal interativo para confirmação explícita.');
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let confirmed = false;
  try {
    console.log('Confirme que o serviço está em janela de manutenção e que ninguém está alterando contas ou iniciando sessões.');
    const answer = await rl.question(`Digite exatamente "${CONFIRMATION}" para continuar: `);
    confirmed = answer === CONFIRMATION;
  } finally {
    rl.close();
  }
  if (!confirmed) {
    console.log('Confirmação não recebida. Nenhum dado foi alterado.');
    return;
  }

  fs.mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o700 });
  fs.chmodSync(BACKUP_DIR, 0o700);
  let lockFd;
  try {
    lockFd = fs.openSync(LOCK_FILE, 'wx', 0o600);
  } catch {
    throw new Error('Já existe um bloqueio de manutenção. Verifique se outra execução está ativa antes de prosseguir.');
  }

  let backupUsers;
  let backupSessions;
  let sessionsWritten = false;
  try {
    fs.writeFileSync(lockFd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), 'utf8');
    fs.fsyncSync(lockFd);
    fs.closeSync(lockFd);
    lockFd = undefined;

    // Re-read after acquiring the script lock so stale preflight data is not used.
    const currentUsers = readJsonStrict(USERS_FILE, 'Arquivo de contas');
    const currentSessions = readJsonStrict(SESSIONS_FILE, 'Arquivo de sessões');
    if (!Array.isArray(currentUsers) || !currentSessions || typeof currentSessions !== 'object' || Array.isArray(currentSessions)) {
      throw new Error('Os arquivos de dados mudaram ou são inválidos. Nenhum dado foi alterado.');
    }
    const currentMatches = currentUsers.filter(user => normalizeUsername(user?.username) === targetName);
    if (currentMatches.length !== 1 || currentMatches[0].id !== target.id || currentMatches[0].blocked) {
      throw new Error('A conta alvo mudou desde a pré-verificação. Nenhum dado foi alterado.');
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    backupUsers = makePrivateBackup(USERS_FILE, BACKUP_DIR, 'users', stamp);
    backupSessions = makePrivateBackup(SESSIONS_FILE, BACKUP_DIR, 'sessions', stamp);

    const temporaryPassword = crypto.randomBytes(32).toString('base64url');
    const passwordHash = await makePasswordHash(temporaryPassword);
    const updatedSessions = { ...currentSessions };
    for (const token of Object.keys(updatedSessions)) {
      if (sessionUserId(updatedSessions[token]) === String(target.id)) delete updatedSessions[token];
    }
    const updatedUsers = currentUsers.map(user => user.id === target.id
      ? { ...user, password: passwordHash, passwordResetAt: new Date().toISOString() }
      : user);

    // Revoke sessions first. If the following account write fails, restore the
    // original sessions file; atomic renames prevent partially written JSON.
    writeJsonAtomic(SESSIONS_FILE, updatedSessions);
    sessionsWritten = true;
    try {
      writeJsonAtomic(USERS_FILE, updatedUsers);
    } catch (error) {
      writeJsonAtomic(SESSIONS_FILE, currentSessions);
      sessionsWritten = false;
      throw error;
    }

    console.log('Senha redefinida e sessões anteriores revogadas.');
    console.log(`Senha temporária (copie agora; ela não será salva em arquivo): ${temporaryPassword}`);
    console.log('Guarde-a com segurança: ela será a senha de acesso. O app atual não oferece troca de senha pelo perfil.');
  } catch {
    console.error('Falha durante a manutenção. Consulte os backups privados em DATA_DIR/backups/admin-password-reset; nenhum conteúdo sensível foi exibido.');
    if (sessionsWritten) console.error('As sessões podem ter sido revogadas; verifique o acesso antes de repetir.');
    process.exitCode = 1;
  } finally {
    if (lockFd !== undefined) {
      try { fs.closeSync(lockFd); } catch {}
    }
    try { fs.unlinkSync(LOCK_FILE); } catch {}
    // Backup names identify only the type and timestamp; paths are intentionally
    // not printed because the backup directory may contain private data.
    void backupUsers;
    void backupSessions;
  }
}

main().catch(error => {
  console.error(error.message || 'Não foi possível preparar a manutenção.');
  process.exitCode = 1;
});
