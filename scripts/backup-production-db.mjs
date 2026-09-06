import { DatabaseSync, backup } from 'node:sqlite';
import { mkdir, readdir, lstat, chmod, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

// Uses SQLite's online backup API, including committed WAL pages.
// https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html
export async function backupDatabase(databasePath, backupRoot) {
  const source = new DatabaseSync(resolve(databasePath), { readOnly: true, timeout: 5000 });
  let temporary;
  try {
    await mkdir(backupRoot, { recursive: true, mode: 0o700 });
    const filename = `srszq-daily-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.sqlite`;
    const destination = join(backupRoot, filename);
    temporary = `${destination}.partial`;
    await backup(source, temporary);
    await chmod(temporary, 0o600);
    const restored = new DatabaseSync(temporary, { readOnly: true });
    try {
      const results = restored.prepare('PRAGMA integrity_check').all();
      if (results.length !== 1 || results[0].integrity_check !== 'ok') throw Error('Backup integrity check failed');
    } finally { restored.close(); }
    await rename(temporary, destination);
    temporary = undefined;
    // Only files created by this script expire. Legacy/migration backups stay untouched.
    const cutoff = Date.now() - 7 * 86400000;
    const managed = /^srszq-daily-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-f0-9-]{36}\.sqlite$/;
    for (const entry of await readdir(backupRoot, { withFileTypes: true })) {
      if (!entry.isFile() || !managed.test(entry.name)) continue;
      const file = join(backupRoot, entry.name);
      const info = await lstat(file);
      if (info.isFile() && info.mtimeMs < cutoff) await unlink(file);
    }
    return destination;
  } finally {
    source.close();
    if (temporary) await unlink(temporary).catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.umask(0o077);
  const destination = await backupDatabase(
    process.argv[2] ?? '/var/www/SRSZQ/data/srszq.sqlite',
    process.argv[3] ?? '/var/backups/srszq/daily',
  );
  console.log(`Verified SQLite backup: ${destination}`);
}
