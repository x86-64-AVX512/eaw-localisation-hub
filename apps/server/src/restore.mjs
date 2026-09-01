import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { restoreBackupBundle } from './backup.mjs';
import { decryptBackup, isEncryptedBackup } from '../../../packages/shared/src/backup-crypto.mjs';

function parseArguments(argv) {
  const options = { backup: null, data: null, force: false, passphrase: process.env.EAW_HUB_BACKUP_PASSPHRASE ?? '' };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--backup') options.backup = path.resolve(argv[++index]);
    else if (argument === '--data') options.data = path.resolve(argv[++index]);
    else if (argument === '--force') options.force = true;
    else if (argument === '--passphrase-file') options.passphraseFile = path.resolve(argv[++index]);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!options.backup || !options.data) throw new Error('--backup and --data are required');
  return options;
}

async function atomicWrite(targetPath, data) {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const temporary = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, data, { mode: 0o600 });
  try {
    await fs.rename(temporary, targetPath);
    await fs.chmod(targetPath, 0o600);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

const options = parseArguments(process.argv.slice(2));
if (options.passphraseFile) options.passphrase = (await fs.readFile(options.passphraseFile, 'utf8')).trimEnd();
const root = path.parse(options.data).root;
if (options.data === root || options.data.length < root.length + 4) {
  throw new Error(`Refusing to restore into a broad path: ${options.data}`);
}
const existing = [];
for (const name of ['auth.json', 'tickets.json', 'documents']) {
  try {
    await fs.access(path.join(options.data, name));
    existing.push(name);
  } catch {}
}
let recoveryDirectory = null;
if (existing.length > 0) {
  if (!options.force) throw new Error('Target already contains server state; stop the server and pass --force to create a recovery copy');
  recoveryDirectory = path.join(
    options.data,
    `.before-restore-${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}`,
  );
  await fs.mkdir(recoveryDirectory, { recursive: true });
  for (const name of existing) {
    await fs.rename(path.join(options.data, name), path.join(recoveryDirectory, name));
  }
}
await fs.mkdir(options.data, { recursive: true });
try {
  const sourceBundle = await fs.readFile(options.backup);
  if (isEncryptedBackup(sourceBundle) && !options.passphrase) {
    throw new Error('Encrypted backup requires EAW_HUB_BACKUP_PASSPHRASE or --passphrase-file');
  }
  const restored = await restoreBackupBundle(
    await decryptBackup(sourceBundle, options.passphrase),
    options.data,
    atomicWrite,
  );
  console.log(JSON.stringify({ restored, data: options.data, recoveryDirectory }, null, 2));
} catch (error) {
  for (const name of ['auth.json', 'tickets.json', 'documents']) {
    await fs.rm(path.join(options.data, name), { recursive: true, force: true });
  }
  if (recoveryDirectory) {
    for (const name of existing) {
      await fs.rename(path.join(recoveryDirectory, name), path.join(options.data, name));
    }
    await fs.rm(recoveryDirectory, { recursive: true, force: true });
  }
  throw error;
}
