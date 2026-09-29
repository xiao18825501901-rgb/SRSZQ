/**
 * 生成 68 项验收的**封版**文件（ACCEPTANCE_68_SEALED.json）。
 *
 *   node scripts/dev/seal-acceptance.mjs \
 *     --working <ACCEPTANCE_68_WORKING.json> --out <ACCEPTANCE_68_SEALED.json> \
 *     --head <git sha> --zip <交付源码 zip> --release-id <id> --checks <checks.json> [--updates <updates.json>]
 *
 * 设计约束：
 *  - 不手改 JSON：封版是可重跑的脚本，输入是“工作登记 + 本轮真实证据”，输出是绑定提交与包哈希的封版文件；
 *  - 68 个原始 ID 与业务标准一字不改，只更新状态与证据字段；
 *  - 工作登记原样保留（历史策略：只读保留，不覆盖）；
 *  - IMPLEMENTED/PASS 必须有真实 command + exitCode + evidence；缺证据直接拒绝封版。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const args = process.argv.slice(2);
const argOf = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const WORKING = argOf('--working', '');
const OUT = argOf('--out', '');
const HEAD = argOf('--head', '');
const ZIP = argOf('--zip', '');
const RELEASE_ID = argOf('--release-id', '');
const CHECKS = argOf('--checks', '');
const UPDATES = argOf('--updates', '');
if (!WORKING || !OUT || !HEAD || !ZIP || !RELEASE_ID || !CHECKS) {
  console.error('缺少参数：--working --out --head --zip --release-id --checks');
  process.exit(2);
}

const zipBytes = readFileSync(ZIP);
const sourceDigest = createHash('sha256').update(zipBytes).digest('hex');
const working = JSON.parse(readFileSync(WORKING, 'utf8'));
const checks = JSON.parse(readFileSync(CHECKS, 'utf8'));
const updates = UPDATES ? JSON.parse(readFileSync(UPDATES, 'utf8')) : {};

if (working.items.length !== 68) { console.error('工作登记不是 68 项：' + working.items.length); process.exit(2); }

const items = working.items.map((item) => {
  const patch = updates[item.ID] ?? {};
  const merged = { ...item, ...patch, sourceDigest };
  if ((merged.implementationStatus === 'IMPLEMENTED' || merged.validationStatus === 'PASS')
      && (!merged.command || merged.exitCode === null || !(merged.evidence ?? []).length)) {
    console.error('封版拒绝：' + item.ID + ' 标了 IMPLEMENTED/PASS 但没有真实 command/exitCode/evidence');
    process.exit(3);
  }
  return merged;
});

const tally = (key) => items.reduce((acc, i) => { acc[i[key]] = (acc[i[key]] ?? 0) + 1; return acc; }, {});
const notRun = items.filter((i) => i.validationStatus === 'NOT_RUN')
  .map((i) => ({ ID: i.ID, scenario: i.scenario, wave: i.wave, why: i.blocker ?? i.nextAction ?? null }));
const inProgress = items.filter((i) => i.validationStatus === 'IN_PROGRESS')
  .map((i) => ({ ID: i.ID, scenario: i.scenario, why: i.blocker ?? null }));

const sealed = {
  schemaVersion: 1,
  artifactKind: 'ACCEPTANCE_RUN_SEALED',
  runId: 'P4_SEAL_20260930',
  sealedAt: new Date().toISOString(),
  sealedHead: HEAD,
  releaseId: RELEASE_ID,
  sourceMode: working.sourceMode,
  recoveredPriorProductSource: false,
  historyPolicy: working.historyPolicy ?? '旧恢复FAIL/BLOCKED文件只读保留；本登记只绑定新的实际源码。',
  note: '68 个原始 ID 与业务标准全部保留，未删减、未降级。封版绑定最终提交与交付包 sha256；'
    + 'IMPLEMENTED/PASS 一律要求真实命令、退出码与日志/证据路径。NOT_RUN 与 IN_PROGRESS 如实列出原因，不伪造通过。',
  sourceZip: { file: ZIP.split(/[\\/]/).pop(), bytes: zipBytes.length, sha256: sourceDigest },
  reconstitution: checks.reconstitution,
  production: checks.production,
  suites: checks.suites,
  summary: { total: items.length, byImplementation: tally('implementationStatus'), byValidation: tally('validationStatus') },
  notRunRegister: notRun,
  inProgressRegister: inProgress,
  items,
};

writeFileSync(OUT, JSON.stringify(sealed, null, 2) + '\n');
console.log('SEALED ' + OUT);
console.log('sealedHead=' + HEAD + ' sourceDigest=' + sourceDigest + ' bytes=' + zipBytes.length);
console.log('summary=' + JSON.stringify(sealed.summary));

