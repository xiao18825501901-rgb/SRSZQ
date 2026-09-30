/**
 * 增量 C：闲置临时账号清理队列（**只报告，不删除**）。
 *
 *   npx tsx scripts/ops/cleanup-provisional.mts [--days 30] [--limit 200] [--db <path>]
 *
 * 规格 4.8：清了 cookie 的未领取临时账号可能再也回不来。允许清理，但必须：
 *  - 只挑**没有任何资产**（无对局、无好友）且超过 N 天没活动的账号；
 *  - 本批次只打印队列，不做任何破坏性操作（生产上由人确认后再执行）。
 */
import { openDb } from '../../backend/src/db.js';
import { PROVISIONAL_IDLE_MS } from '../../backend/src/quickAccount.js';

const args = process.argv.slice(2);
const argOf = (n: string, d: string): string => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const days = Number(argOf('--days', '30'));
const limit = Number(argOf('--limit', '200'));
const dbPath = argOf('--db', process.env.SRSZQ_DB ?? 'data/srszq.sqlite');
const idleMs = Number.isFinite(days) && days > 0 ? days * 24 * 3600 * 1000 : PROVISIONAL_IDLE_MS;

const db = openDb(dbPath);
const cutoff = Date.now() - idleMs;
const candidates = db.listProvisionalCleanupCandidates(cutoff, limit);
const summary = db.accountTypeSummary();
console.log(JSON.stringify({
  db: dbPath,
  idleDays: Math.round(idleMs / (24 * 3600 * 1000)),
  accounts: summary,
  cleanupQueue: candidates.length,
  candidates: candidates.slice(0, 50),
  destructive: false,
  note: '本脚本只报告。删除必须由人确认后另行执行，且只允许删除队列内的账号。',
}, null, 2));
db.close();
