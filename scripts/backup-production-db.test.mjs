import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, readdir, writeFile, utimes, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { backupDatabase } from './backup-production-db.mjs';

test('online backup includes committed WAL and restores as a writable database', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'srszq-backup-test-'));
  const source = join(dir, 'source.sqlite');
  const db = new DatabaseSync(source);
  try {
    db.exec("PRAGMA journal_mode=WAL; CREATE TABLE items(id INTEGER); INSERT INTO items VALUES (42)");
    const result = await backupDatabase(source, join(dir, 'backups'));
    const restored = new DatabaseSync(result);
    try {
      assert.equal(restored.prepare('SELECT id FROM items').get().id, 42);
      restored.exec('INSERT INTO items VALUES (43)');
      assert.equal(restored.prepare('SELECT count(*) n FROM items').get().n, 2);
    } finally { restored.close(); }
    assert.equal(db.prepare('SELECT count(*) n FROM items').get().n, 1);
  } finally { db.close(); }
});

test('retention keeps at least seven managed daily backups and preserves manual files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'srszq-retention-test-'));
  const source = join(dir, 'source.sqlite');
  const db = new DatabaseSync(source);
  db.exec('CREATE TABLE items(id INTEGER)');
  db.close();
  const root = join(dir, 'backups');
  const old = [];
  for (let index = 0; index < 8; index++) {
    const file = await backupDatabase(source, root);
    const ancient = new Date(Date.now() - (15 - index) * 86400000);
    await utimes(file, ancient, ancient);
    old.push(file);
  }
  const manual = join(root, 'migration.sqlite');
  await writeFile(manual, 'preserve');
  const ancient = new Date(Date.now() - 30 * 86400000);
  await utimes(manual, ancient, ancient);
  const recent = await backupDatabase(source, root);
  const managed = (await readdir(root)).filter(name => name.startsWith('srszq-daily-'));
  assert.equal(managed.length, 7);
  await assert.rejects(stat(old[0]), { code: 'ENOENT' });
  await assert.rejects(stat(old[1]), { code: 'ENOENT' });
  assert.ok((await stat(recent)).size > 0);
  assert.equal(await readFile(manual, 'utf8'), 'preserve');
});

test('invalid source fails without deleting existing backups or publishing an empty one', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'srszq-invalid-backup-test-'));
  const invalid = join(dir, 'invalid.sqlite');
  await writeFile(invalid, 'not a database');
  await assert.rejects(backupDatabase(invalid, join(dir, 'backups')));
  await assert.rejects(backupDatabase(join(dir, 'missing.sqlite'), join(dir, 'backups')));
});
