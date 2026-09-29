/**
 * 公网行为验收（P4）：存活/就绪/版本自证。
 *
 *   npx tsx scripts/dev/public-ops-check.mts
 *
 * 这一批加的是运维门禁，公网要证明的是：
 *  - /health 只表示存活，且与依赖解耦；
 *  - /ready 三项检查都在，并给出 worker 预热与运行时指标；
 *  - /api/version 报出**实际部署的提交**（生产上应等于部署脚本给出的那个 sha）；
 *  - 版本/就绪响应不含任何密钥。
 */
// 期望的 releaseId 从 shared 唯一真源导入：硬编码会在下一次发布变成“永远 FAIL 的假警报”
// （public-ops-check 里曾写死 p4-20260930、public-provider-check 里曾写死 p3b-20260930）。
import { RELEASE_ID } from '../../shared/src/product/protocol.js';

const API = process.env.SRSZQ_API_URL ?? 'https://api.srszq.com';
const EXPECTED_SHA = process.env.EXPECTED_BACKEND_SHA ?? '';

let failures = 0;
const ok = (c: boolean, m: string): void => { if (c) console.log('  PASS ' + m); else { failures += 1; console.log('  FAIL ' + m); } };

async function main(): Promise<void> {
  console.log('=== /health（存活） ===');
  const healthRes = await fetch(API + '/health');
  const health = await healthRes.json() as Record<string, unknown>;
  ok(healthRes.status === 200, 'http=' + healthRes.status);
  ok(health.status === 'alive', 'status=' + health.status);
  ok(typeof health.serverTime === 'number', 'serverTime 存在');

  console.log('=== /ready（就绪） ===');
  const readyRes = await fetch(API + '/ready');
  const ready = await readyRes.json() as any;
  ok(readyRes.status === 200, 'http=' + readyRes.status + '（不满足应为 503）');
  ok(ready.ready === true, 'ready=' + ready.ready);
  const names = (ready.checks ?? []).map((c: any) => c.name);
  ok(JSON.stringify(names) === JSON.stringify(['MIGRATIONS', 'DB_WRITABLE', 'AI_WORKER']), '三项检查齐备：' + JSON.stringify(names));
  for (const c of ready.checks ?? []) ok(c.state === 'ok', c.name + ' -> ' + c.state + '（' + c.detail + '）');
  ok(typeof ready.metrics?.rssBytes === 'number' && ready.metrics.rssBytes > 0, 'RSS=' + Math.round((ready.metrics?.rssBytes ?? 0) / 1048576) + 'MB heap=' + Math.round((ready.metrics?.heapUsedBytes ?? 0) / 1048576) + 'MB cpu=' + ready.metrics?.cpuCount);
  ok(typeof ready.uptimeMs === 'number' && ready.uptimeMs >= 0, 'uptimeMs=' + ready.uptimeMs);

  console.log('=== /api/version（版本自证） ===');
  const versionRes = await fetch(API + '/api/version');
  const version = await versionRes.json() as any;
  ok(version.protocol?.protocolVersion === 2, 'protocolVersion=' + version.protocol?.protocolVersion);
  ok(version.protocol?.rulesetVersion === 'formal-rules-v2', 'rulesetVersion=' + version.protocol?.rulesetVersion);
  ok(version.protocol?.releaseId === RELEASE_ID, 'releaseId=' + version.protocol?.releaseId + '（期望 ' + RELEASE_ID + '）');
  const sha = version.source?.backendSourceSha;
  ok(typeof sha === 'string' && /^[0-9a-f]{7,40}$/.test(sha), 'backendSourceSha=' + sha + '（从部署树读取，不是人工填的）');
  if (EXPECTED_SHA) ok(sha === EXPECTED_SHA, 'backendSourceSha 等于本次部署提交 ' + EXPECTED_SHA);
  const blob = JSON.stringify(version) + JSON.stringify(ready) + JSON.stringify(health);
  for (const bad of ['password', 'secret', 'PRIVATE KEY', 'ghp_', 'BEGIN']) {
    ok(!blob.includes(bad), '响应不含 ' + bad);
  }

  console.log('=== 观测 ===');
  console.log('  release=' + version.protocol?.releaseId + ' backendSha=' + sha);
  console.log('  checks=' + JSON.stringify((ready.checks ?? []).map((c: any) => c.name + ':' + c.detail)));
  console.log(failures === 0 ? 'PUBLIC OPS CHECK: ALL PASS 0' : 'PUBLIC OPS CHECK: ' + failures + ' FAILED 1');
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
