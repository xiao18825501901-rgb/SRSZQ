/**
 * SRSZQ P4(B7) —— 就绪与存活探针（规格 7.3 / 验收 O05、O10）。
 *
 * 规格把两件事分得很清楚，这里照做、不混：
 *  - /health 只表示**存活**：进程还在、HTTP 还能回话。它不检查依赖，
 *    否则依赖抖动会让编排系统误杀一个其实能服务的进程。
 *  - /ready 验证**能否开始服务新工作**：DB 可写、迁移已完成、AI worker 可用。
 *    任何一项不满足就返回 503，并逐项说明哪一项没过。
 *
 * 纯函数 + 显式探针，便于测试注入故障（例如故意拿掉一张表）。
 */
import { cpus } from 'node:os';
import { execFileSync } from 'node:child_process';
import type { Db } from './db.js';

export const REQUIRED_TABLES: readonly string[] = [
  'users', 'sessions', 'ranking', 'games', 'matches', 'friends', 'invitations', 'tutorial_progress',
  // P0A/P0B
  'match_results', 'match_participants', 'rating_ledger', 'game_commands', 'game_events', 'game_snapshots',
  // P2/P2b
  'share_links', 'live_games', 'puzzle_attempts', 'puzzle_progress',
  // P3A
  'user_consents', 'product_events', 'dataset_runs', 'data_tasks', 'reports', 'blocks', 'admin_audit',
];

export const REQUIRED_COLUMNS: ReadonlyArray<{ table: string; column: string }> = [
  { table: 'users', column: 'source' },
  { table: 'users', column: 'role' },
  { table: 'users', column: 'deleted_at' },
  { table: 'matches', column: 'end_reason' },
];

export type CheckState = 'ok' | 'failed';

export interface ReadyCheck {
  name: 'MIGRATIONS' | 'DB_WRITABLE' | 'AI_WORKER';
  state: CheckState;
  detail: string;
}

/** 供容量记录使用的运行时元数据：不含任何用户数据或密钥。 */
export interface RuntimeMetrics {
  rssBytes: number;
  heapUsedBytes: number;
  uptimeSec: number;
  cpuCount: number;
}

export interface ReadyReport {
  ready: boolean;
  checks: ReadyCheck[];
  metrics: RuntimeMetrics;
  version: { releaseId: string; rulesetVersion: string; protocolVersion: number };
  source: { backendSourceSha: string | null; frontendSourceSha: string | null };
  uptimeMs: number;
  checkedAt: number;
}

export interface WorkerProbe { poolSize: number; warm: number }

export interface ReadyProbes {
  worker?: WorkerProbe;
  /** 允许测试注入；默认取当前进程的实际内存占用。 */
  metrics?: RuntimeMetrics;
  version: { releaseId: string; rulesetVersion: string; protocolVersion: number };
  source?: { backendSourceSha?: string | null; frontendSourceSha?: string | null };
  startedAt: number;
  now?: number;
}

/** 迁移完整性：要求的表与列必须都在（缺任何一项都不能算 ready）。 */
export function checkMigrations(db: Db): ReadyCheck {
  const missing: string[] = [];
  for (const table of REQUIRED_TABLES) {
    const row = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table) as { name?: string } | undefined;
    if (!row) missing.push('table:' + table);
  }
  for (const { table, column } of REQUIRED_COLUMNS) {
    const cols = db.raw.prepare('PRAGMA table_info(' + table + ')').all() as Array<{ name?: string }>;
    if (!cols.some((c) => c.name === column)) missing.push('column:' + table + '.' + column);
  }
  return {
    name: 'MIGRATIONS',
    state: missing.length === 0 ? 'ok' : 'failed',
    detail: missing.length === 0
      ? REQUIRED_TABLES.length + ' 张表与 ' + REQUIRED_COLUMNS.length + ' 个关键列齐备'
      : '缺失 ' + missing.join(', '),
  };
}

/**
 * 可写性：真的走一次写路径（BEGIN IMMEDIATE → INSERT → ROLLBACK）。
 * 只读打开、磁盘满、WAL 损坏都能在这里暴露；回滚保证不留副作用。
 */
export function checkDbWritable(db: Db): ReadyCheck {
  try {
    db.raw.exec('BEGIN IMMEDIATE');
    try {
      db.raw
        .prepare('INSERT INTO product_events (event_id,name,user_id,game_id,source,is_bot,is_sample,payload_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .run('readiness-probe', 'readiness_probe', null, null, 'SYSTEM', 0, 0, '{}', Date.now());
    } finally {
      db.raw.exec('ROLLBACK');
    }
    return { name: 'DB_WRITABLE', state: 'ok', detail: '写事务成功并已回滚（无副作用）' };
  } catch (e) {
    return { name: 'DB_WRITABLE', state: 'failed', detail: e instanceof Error ? e.message : String(e) };
  }
}

/** AI worker：必须存在槽位，且至少有一个已经预热（否则开局就会降级）。 */
export function checkWorker(worker: WorkerProbe | undefined): ReadyCheck {
  if (!worker) return { name: 'AI_WORKER', state: 'failed', detail: '未提供 worker 探针' };
  if (worker.poolSize <= 0) return { name: 'AI_WORKER', state: 'failed', detail: '池大小为 0' };
  if (worker.warm <= 0) return { name: 'AI_WORKER', state: 'failed', detail: '池存在但尚无预热槽位（' + worker.warm + '/' + worker.poolSize + '）' };
  return { name: 'AI_WORKER', state: 'ok', detail: '预热 ' + worker.warm + '/' + worker.poolSize };
}

export function buildReadyReport(db: Db, probes: ReadyProbes): ReadyReport {
  const checks = [checkMigrations(db), checkDbWritable(db), checkWorker(probes.worker)];
  const now = probes.now ?? Date.now();
  const mem = process.memoryUsage();
  const metrics: RuntimeMetrics = probes.metrics ?? {
    rssBytes: mem.rss,
    heapUsedBytes: mem.heapUsed,
    uptimeSec: Math.round(process.uptime()),
    cpuCount: cpus().length,
  };
  return {
    ready: checks.every((c) => c.state === 'ok'),
    checks,
    metrics,
    version: probes.version,
    source: {
      backendSourceSha: probes.source?.backendSourceSha ?? null,
      frontendSourceSha: probes.source?.frontendSourceSha ?? null,
    },
    uptimeMs: Math.max(0, now - probes.startedAt),
    checkedAt: now,
  };
}

/**
 * 后端源码标识：优先环境变量，否则从**部署树本身**读 git HEAD。
 * 这样 /version 报的是实际跑着的代码，而不是某个人记得填的字符串。
 * 读不到就返回 null —— 宁可空着，也不编一个看起来像 sha 的值。
 */
export function detectBackendSourceSha(cwd: string = process.cwd()): string | null {
  const fromEnv = process.env.SRSZQ_BACKEND_SOURCE_SHA;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  try {
    const out = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const sha = out.trim();
    return /^[0-9a-f]{7,40}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

/** /health 只表示存活：这里刻意不做任何依赖检查。 */
export function livenessPayload(now = Date.now()): { ok: true; status: 'alive'; serverTime: number } {
  return { ok: true, status: 'alive', serverTime: now };
}
