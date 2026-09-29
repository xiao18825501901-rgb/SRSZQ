/**
 * SRSZQ P4(B7) —— 运维门禁：备份恢复演练 / 就绪探针 / 迁移向后兼容。
 *   npm run test:ops   （scripts/product/run-tests.mjs --suite ops 调用）
 *
 * 规格 7.3；验收 O05（一致性快照 + restore + integrity_check + 关键行数与最近 resultId 核对）、
 * O10（预生产门禁、版本校验、回滚办法齐全）。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import type { AddressInfo } from 'node:net';
import { openDb, type Db } from '../src/db.js';
import { createApi } from '../src/api.js';
import { checkDbWritable, checkMigrations, checkWorker, buildReadyReport, livenessPayload, REQUIRED_TABLES } from '../src/readiness.js';
import { buildSettlement } from '../../shared/src/product/resultModel.js';
import { PROTOCOL_INFO } from '../../shared/src/product/protocol.js';

let failures = 0;
const observed: Record<string, unknown> = {};

async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  const only = process.env.ONLY;
  if (only && !name.includes(only)) return;
  try { await fn(); console.log('PASS  ' + name); }
  catch (e) { failures++; console.log('FAIL  ' + name + '  [' + (e instanceof Error ? e.message : String(e)) + ']'); }
}

const count = (db: Db, table: string): number => Number((db.raw.prepare('SELECT COUNT(*) AS n FROM ' + table).get() as { n: number }).n);

/** 造一条真实结算：三个真人参与者 + 名次行 + 账本 + 棋谱事件。 */
function settleGame(db: Db, gameId: string, users: string[]): void {
  const plan = buildSettlement({
    gameId, mode: 'online', boardSize: 13, status: 'won', boardWinner: 'A',
    endReason: 'NORMAL_WIN', isRanked: true,
    participants: [
      { seat: 'A', kind: 'human', userId: users[0] },
      { seat: 'B', kind: 'human', userId: users[1] },
      { seat: 'C', kind: 'human', userId: users[2] },
    ],
  });
  db.settleMatch({ ...plan, matchId: 'match-' + gameId, movesJson: '[]', players: users });
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'srszq-ops-'));
  const dbPath = join(dir, 'live.sqlite');
  const db = openDb(dbPath);

  const mkUser = (name: string): string => {
    const u = db.createUser({ email: name + '@t.local', username: name, passwordHash: 'h', salt: 's' });
    return u.id;
  };
  const users = [mkUser('OpsA'), mkUser('OpsB'), mkUser('OpsC')];
  settleGame(db, 'ops-game-1', users);
  db.insertProductEvent({ eventId: 'ops-evt-1', name: 'match_finish', source: 'HUMAN' });
  db.grantConsent({ userId: users[0], kind: 'TRAINING', version: 'train-consent-v1' });
  db.createDataTask({ userId: users[1], kind: 'EXPORT' });

  const before = {
    users: count(db, 'users'),
    results: count(db, 'match_results'),
    participants: count(db, 'match_participants'),
    ledger: count(db, 'rating_ledger'),
    events: count(db, 'product_events'),
    consents: count(db, 'user_consents'),
    latest: db.raw.prepare('SELECT game_id, settled_at, settlement_digest FROM match_results ORDER BY settled_at DESC LIMIT 1').get() as Record<string, unknown>,
    ratings: db.raw.prepare('SELECT id, rating FROM users ORDER BY id').all() as Array<Record<string, unknown>>,
  };

  console.log('--- O05 备份恢复演练 ---');

  await check('O05a 用 SQLite 在线备份 API 取一致性快照（含已提交的 WAL 页）', async () => {
    const backupPath = join(dir, 'snapshot.sqlite');
    const source = new DatabaseSync(dbPath, { readOnly: true, timeout: 5000 });
    try {
      await backup(source, backupPath);
    } finally {
      source.close();
    }
    assert.ok(existsSync(backupPath), '快照文件必须存在');
    assert.ok(statSync(backupPath).size > 0, '快照不能为空');
    observed.o05_backupBytes = statSync(backupPath).size;
  });

  await check('O05b 在隔离目录恢复：integrity_check=ok 且关键行数、最近 resultId、评分全部一致', async () => {
    const backupPath = join(dir, 'snapshot.sqlite');
    const restoreDir = mkdtempSync(join(tmpdir(), 'srszq-restore-'));
    const restoredPath = join(restoreDir, 'restored.sqlite');
    // 真的复制到隔离目录再打开（不是就地读原库）
    const bytes = (await import('node:fs')).readFileSync(backupPath);
    (await import('node:fs')).writeFileSync(restoredPath, bytes);
    assert.ok(existsSync(restoredPath));

    const restored = new DatabaseSync(restoredPath, { readOnly: true });
    try {
      const integrity = restored.prepare('PRAGMA integrity_check').all() as Array<{ integrity_check?: string }>;
      assert.equal(integrity.length, 1);
      assert.equal(integrity[0].integrity_check, 'ok', '恢复后的库必须通过完整性检查');
      const n = (table: string): number => Number((restored.prepare('SELECT COUNT(*) AS n FROM ' + table).get() as { n: number }).n);
      assert.equal(n('users'), before.users, 'users 行数必须一致');
      assert.equal(n('match_results'), before.results, 'match_results 行数必须一致');
      assert.equal(n('match_participants'), before.participants, 'match_participants 行数必须一致');
      assert.equal(n('rating_ledger'), before.ledger, 'rating_ledger 行数必须一致');
      assert.equal(n('product_events'), before.events, '最新写入的事件必须包含在快照里（否则就是忽略了 WAL）');
      assert.equal(n('user_consents'), before.consents, '许可记录必须包含在快照里');
      const latest = restored.prepare('SELECT game_id, settled_at, settlement_digest FROM match_results ORDER BY settled_at DESC LIMIT 1').get() as Record<string, unknown>;
      assert.equal(latest.game_id, before.latest.game_id, '最近一局的 gameId 必须一致');
      assert.equal(Number(latest.settled_at), Number(before.latest.settled_at));
      assert.equal(latest.settlement_digest, before.latest.settlement_digest, '结算摘要必须逐字一致');
      const ratings = restored.prepare('SELECT id, rating FROM users ORDER BY id').all() as Array<Record<string, unknown>>;
      assert.deepEqual(ratings, before.ratings, '评分必须与备份时一致');
      observed.o05 = { restoredBytes: statSync(restoredPath).size, results: n('match_results'), latestGame: String(latest.game_id) };
    } finally {
      restored.close();
    }
  });

  console.log('--- 就绪探针 ---');

  await check('R1 /health 只表示存活：不依赖 DB 与 worker 也能回 200', async () => {
    const payload = livenessPayload();
    assert.equal(payload.ok, true);
    assert.equal(payload.status, 'alive');
    assert.equal(typeof payload.serverTime, 'number');
    // 就绪报告即便全挂，存活语义也不受影响（两者刻意解耦）
    const report = buildReadyReport(db, { worker: undefined, version: { ...PROTOCOL_INFO }, startedAt: Date.now() });
    assert.equal(report.ready, false, '没有 worker 时不应就绪');
    assert.equal(livenessPayload().ok, true);
  });

  await check('R2 /ready 三项检查齐备，全通过时 200 且给出 worker 预热数', async () => {
    const report = buildReadyReport(db, {
      worker: { poolSize: 2, warm: 2 },
      version: { ...PROTOCOL_INFO },
      source: { backendSourceSha: 'sha-backend', frontendSourceSha: 'sha-frontend' },
      startedAt: Date.now() - 1234,
    });
    assert.equal(report.ready, true, JSON.stringify(report.checks));
    assert.deepEqual(report.checks.map((c) => c.name), ['MIGRATIONS', 'DB_WRITABLE', 'AI_WORKER']);
    assert.ok(report.checks.every((c) => c.state === 'ok'));
    assert.ok(report.uptimeMs >= 1234);
    assert.equal(report.source.backendSourceSha, 'sha-backend');
    observed.r2 = report.checks.map((c) => c.name + '=' + c.detail);
  });

  await check('R3 迁移缺表 -> MIGRATIONS failed 且整体不就绪（/ready 会返回 503）', async () => {
    const brokenDir = mkdtempSync(join(tmpdir(), 'srszq-broken-'));
    const broken = openDb(join(brokenDir, 'broken.sqlite'));
    try {
      broken.raw.exec('DROP TABLE admin_audit');
      const migration = checkMigrations(broken);
      assert.equal(migration.state, 'failed');
      assert.ok(migration.detail.includes('admin_audit'), '必须指出缺哪张表：' + migration.detail);
      const report = buildReadyReport(broken, { worker: { poolSize: 1, warm: 1 }, version: { ...PROTOCOL_INFO }, startedAt: Date.now() });
      assert.equal(report.ready, false);
    } finally {
      broken.close();
    }
  });

  await check('R4 DB 不可写 -> DB_WRITABLE failed（写路径真的被走过）', async () => {
    const closed = openDb(join(mkdtempSync(join(tmpdir(), 'srszq-closed-')), 'c.sqlite'));
    const okProbe = checkDbWritable(closed);
    assert.equal(okProbe.state, 'ok', '正常库写探针必须成功：' + okProbe.detail);
    closed.close();
    const failed = checkDbWritable(closed);
    assert.equal(failed.state, 'failed', '库关闭后写探针必须失败而不是假装可用');
    // worker 检查的三种情况
    assert.equal(checkWorker(undefined).state, 'failed');
    assert.equal(checkWorker({ poolSize: 0, warm: 0 }).state, 'failed');
    assert.equal(checkWorker({ poolSize: 2, warm: 0 }).state, 'failed', '池冷时不得宣称就绪（首局会降级）');
    assert.equal(checkWorker({ poolSize: 2, warm: 1 }).state, 'ok');
  });

  await check('R5 /version 给出协议三元组与前后端源码标识，且不含任何密钥', async () => {
    const apiDir = mkdtempSync(join(tmpdir(), 'srszq-api-'));
    const apiDb = openDb(join(apiDir, 'api.sqlite'));
    const { server } = createApi(apiDb, { readiness: () => ({ worker: { poolSize: 1, warm: 1 } }) });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
    try {
      const health = await (await fetch(base + '/health')).json() as Record<string, unknown>;
      assert.equal(health.status, 'alive');
      const readyRes = await fetch(base + '/ready');
      const ready = await readyRes.json() as Record<string, unknown>;
      assert.equal(readyRes.status, 200, JSON.stringify(ready));
      assert.equal(ready.ready, true);
      const versionRes = await fetch(base + '/api/version');
      const version = await versionRes.json() as Record<string, unknown>;
      const protocol = version.protocol as Record<string, unknown>;
      assert.equal(protocol.protocolVersion, PROTOCOL_INFO.protocolVersion);
      assert.equal(protocol.rulesetVersion, PROTOCOL_INFO.rulesetVersion);
      assert.equal(protocol.releaseId, PROTOCOL_INFO.releaseId);
      assert.ok('source' in version, '/version 必须带源码标识字段');
      const blob = JSON.stringify(version) + JSON.stringify(ready);
      for (const bad of ['password', 'secret', 'token', 'PRIVATE KEY', 'ghp_']) {
        assert.equal(blob.includes(bad), false, '版本/就绪响应不得包含 ' + bad);
      }
      observed.r5 = { releaseId: protocol.releaseId, checks: (ready.checks as Array<{ name: string }>).map((c) => c.name) };
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      apiDb.close();
    }
  });

  console.log('--- 迁移向后兼容 ---');

  await check('M1 旧库（只有 P0A 之前的表）用当前代码打开：补表补列、旧数据一行不丢', async () => {
    const legacyDir = mkdtempSync(join(tmpdir(), 'srszq-legacy-'));
    const legacyPath = join(legacyDir, 'legacy.sqlite');
    const legacy = new DatabaseSync(legacyPath);
    legacy.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, username TEXT NOT NULL UNIQUE,
        avatar TEXT NOT NULL DEFAULT '', password_hash TEXT NOT NULL, salt TEXT NOT NULL,
        created_at INTEGER NOT NULL, tutorial_completed INTEGER NOT NULL DEFAULT 0,
        online_status TEXT NOT NULL DEFAULT 'offline', rating INTEGER NOT NULL DEFAULT 1200
      );
      CREATE TABLE ranking (user_id TEXT PRIMARY KEY, wins INTEGER NOT NULL DEFAULT 0, games INTEGER NOT NULL DEFAULT 0, score INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE games (id TEXT PRIMARY KEY, board_size INTEGER NOT NULL, mode TEXT NOT NULL, winner TEXT, created_at INTEGER NOT NULL, moves_json TEXT NOT NULL DEFAULT '[]');
      CREATE TABLE matches (id TEXT PRIMARY KEY, game_id TEXT NOT NULL, player_a TEXT, player_b TEXT, player_c TEXT, result TEXT, is_ranked INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
      CREATE TABLE sessions (token TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE friends (user_id TEXT NOT NULL, friend_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'accepted', PRIMARY KEY (user_id, friend_id));
      CREATE TABLE invitations (id TEXT PRIMARY KEY, sender TEXT NOT NULL, receiver TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL);
      CREATE TABLE tutorial_progress (user_id TEXT PRIMARY KEY, step INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL);
      INSERT INTO users (id,email,username,password_hash,salt,created_at,rating) VALUES ('legacy-1','legacy@old.local','LegacyPlayer','h','s',123,1450);
      INSERT INTO ranking (user_id,wins,games,score) VALUES ('legacy-1',7,10,70);
      INSERT INTO games (id,board_size,mode,winner,created_at,moves_json) VALUES ('legacy-game',13,'online','A',999,'[]');
    `);
    legacy.close();

    // 用当前代码打开旧库：迁移必须向后兼容地补齐结构，且不动旧数据。
    const upgraded = openDb(legacyPath);
    try {
      const user = upgraded.raw
        .prepare("SELECT id,email,username,rating,COALESCE(source,'HUMAN') AS source,COALESCE(role,'USER') AS role,deleted_at FROM users WHERE id = ?")
        .get('legacy-1') as Record<string, unknown>;
      assert.equal(user.email, 'legacy@old.local', '旧账号邮箱不得被改写');
      assert.equal(user.username, 'LegacyPlayer');
      assert.equal(Number(user.rating), 1450, '旧评分不得被重置');
      assert.equal(user.source, 'HUMAN', '新列必须有正确默认值');
      assert.equal(user.role, 'USER');
      assert.equal(user.deleted_at, null);
      assert.equal(count(upgraded, 'ranking'), 1);
      assert.equal(count(upgraded, 'games'), 1, '旧棋谱不得丢失');
      const ranking = upgraded.raw.prepare('SELECT wins,games,score FROM ranking WHERE user_id = ?').get('legacy-1') as Record<string, unknown>;
      assert.deepEqual([Number(ranking.wins), Number(ranking.games), Number(ranking.score)], [7, 10, 70], '旧战绩不得被重置');
      // 新表全部补齐
      const missing: string[] = [];
      for (const t of REQUIRED_TABLES) {
        const row = upgraded.raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t) as { name?: string } | undefined;
        if (!row) missing.push(t);
      }
      assert.deepEqual(missing, [], '旧库升级后必须补齐全部要求的表');
      assert.equal(checkMigrations(upgraded).state, 'ok');
      observed.m1 = { legacyUsers: count(upgraded, 'users'), tables: REQUIRED_TABLES.length };
    } finally {
      upgraded.close();
    }
  });

  console.log('--- 观测 ---');
  console.log('OBSERVED ' + JSON.stringify(observed));

  db.close();
  if (failures === 0) console.log('OPS READINESS: ALL PASS 0');
  else console.log('OPS READINESS: ' + failures + ' FAILED 1');
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
