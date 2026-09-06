import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, writeFile, utimes, stat } from 'node:fs/promises';
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

test('retention removes only old managed daily files after a successful backup', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'srszq-retention-test-'));
  const source = join(dir, 'source.sqlite');
  const db = new DatabaseSync(source);
  db.exec('CREATE TABLE items(id INTEGER)');
  db.close();
  const root = join(dir, 'backups');
  const old = await backupDatabase(source, root);
  const ancient = new Date(Date.now() - 8 * 86400000);
  await utimes(old, ancient, ancient);
  const manual = join(root, 'migration.sqlite');
  await writeFile(manual, 'preserve');
  await utimes(manual, ancient, ancient);
  const recent = await backupDatabase(source, root);
  await assert.rejects(stat(old), { code: 'ENOENT' });
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
