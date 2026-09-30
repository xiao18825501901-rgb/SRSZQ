#!/usr/bin/env node
/**
 * SRSZQ 产品测试编排入口（P0A **新增产物**）。
 *
 * 这不是前置门禁，也不是“只要跑起来就 PASS”的占位脚本：
 *  - 每个套件都真实 spawn 一个测试文件，并把该进程的真实退出码与日志原样透出；
 *  - 未实现的套件明确记为 NOT_IMPLEMENTED，绝不因“没有匹配到文件”而算通过；
 *  - --all 只要包含未实现套件，整体就是 PARTIAL（退出码 2），不宣称全通过。
 *
 * 退出码：
 *   0 = PASS      所选套件全部已实现且全部通过
 *   1 = FAIL      至少一个已实现套件失败
 *   2 = PARTIAL   至少一个所选套件尚未实现（NOT_IMPLEMENTED / NOT_RUN）
 *   3 = 用法错误
 *
 * 用法：
 *   node scripts/product/run-tests.mjs --suite results
 *   node scripts/product/run-tests.mjs --all
 *   node scripts/product/run-tests.mjs --list
 *   node scripts/product/run-tests.mjs --suite results --out evidence/p0a
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');

/**
 * implemented=false 的套件属于**尚未实现**的产品化批次；
 * 它们会出现在报告里，但永远不会被算作 PASS。
 */
const SUITES = {
  multitab: {
    title: 'G16 多标签新连接替换旧连接（旧连接必须被关闭且不再生效）',
    entry: 'backend/tests/ws.multitab.ts',
    runner: 'tsx',
    implemented: true,
    covers: ['G16'],
    phase: 'G16',
  },
  quickaccount: {
    title: '增量 C 一键创建账号并开始（临时账号 / 原地领取 / 迁移幂等 / 不进正式排位）',
    entry: 'backend/tests/quickAccount.flow.ts',
    runner: 'tsx',
    implemented: true,
    covers: ['C_QUICK_ACCOUNT', 'C_CLAIM', 'D_SECURITY', 'E_MIGRATION', 'REGRESSION(legacy login/register)'],
    phase: 'INCREMENT_C',
  },
  matchmaking: {
    title: '增量 B Online 排队 20 秒（真实默认值 + 真实 20 秒冒烟 + 取消排队不算弃权）',
    entry: 'backend/tests/matchmaking.timeout.ts',
    runner: 'tsx',
    implemented: true,
    covers: ['B_QUEUE_20S', 'REGRESSION(30s turn clock / 10s reconnect grace)'],
    phase: 'INCREMENT_B',
  },
  results: {
    title: 'P0A 可信结果与事务结算（原子/幂等/回滚/宽限/开关）',
    entry: 'backend/tests/results.settlement.ts',
    runner: 'tsx',
    implemented: true,
    covers: ['G01', 'G02', 'G03', 'G04', 'G05', 'G06', 'G07', 'G08', 'G10(结算部分)'],
    phase: 'P0A',
  },
  baseline: {
    title: '基线回归（147+ 单测 / 后端 API / WS / build），与产品化新增分开记录',
    entry: null,
    runner: null,
    implemented: true,
    covers: ['REGRESSION'],
    phase: 'BASELINE',
  },
  recovery: {
    title: 'P0B 命令幂等 / revision / 持久事件 / ACK / 快照 / 60 秒恢复',
    entry: 'backend/tests/commands.protocol.ts',
    runner: 'tsx',
    implemented: true,
    covers: ['G10', 'G11', 'G12', 'G13', 'G14', 'G15', 'G16', 'O06'],
    phase: 'P0B',
  },
  security: {
    title: 'P0C 有界 AI Worker / 硬超时 / 合法降级 / Origin / 体积 / 限流 / 会话撤销',
    entry: 'backend/tests/security.worker.ts',
    runner: 'tsx',
    implemented: true,
    covers: ['S01', 'S02', 'S03', 'S05', 'S06', 'S07'],
    phase: 'P0C',
    deferred: ['S04 WS 单次票据', 'S08 邮件找回', 'S09 账号枚举', 'S10 活跃对局分析'],
  },
  replay: {
    title: 'P2 棋谱历史 / 全谱重放 / 关键三手 / 跨轮防守 / 去标识分享撤销',
    entry: 'backend/tests/history.replay.ts',
    runner: 'tsx',
    implemented: true,
    covers: ['R01', 'R02', 'R03', 'R04', 'R05', 'R06'],
    phase: 'P2',
    deferred: ['R07 题库 30-60 道', 'R08 每日题/错题', 'R09/R10 UI 与真实浏览器截图'],
  },
  puzzles: {
    title: 'P2 题库 V1 / 每日题 / attempt 幂等 / 进度与错题本',
    entry: 'backend/tests/puzzles.bank.ts',
    runner: 'tsx',
    implemented: true,
    covers: ['R07', 'R08'],
    phase: 'P2',
    deferred: ['R09/R10 前端界面与真实浏览器截图'],
  },
  privacy: {
    title: 'P3A 训练许可 / 数据集切分与对称去重 / 事件表 / 导出删除 / 举报屏蔽审计',
    entry: 'backend/tests/privacy.dataset.ts',
    runner: 'tsx',
    implemented: true,
    covers: ['D01', 'D02', 'D03', 'D04', 'D06(分层计数)', 'O01', 'O03', 'O04'],
    phase: 'P3A',
    deferred: ['D07/D08 续训声明与模型卡', 'O02 留存口径', 'O05 备份恢复演练'],
  },
  provider: {
    title: 'P3B provider 接口 / 续训声明校验 / 评测矩阵聚合',
    entry: 'backend/tests/ai.provider.ts',
    runner: 'tsx',
    implemented: true,
    covers: ['D06', 'D07', 'D08(失败指标)'],
    phase: 'P3B',
    deferred: ['真实训练与 checkpoint（本项目未训练任何模型）', 'GPU/搜索 scaling 与 exact oracle 残局评测'],
  },
  ops: {
    title: 'P4 备份恢复演练 / 就绪探针 / 迁移向后兼容',
    entry: 'backend/tests/ops.readiness.ts',
    runner: 'tsx',
    implemented: true,
    covers: ['O05', 'O10(预生产门禁)', 'O06(version source sha)'],
    phase: 'P4',
    deferred: ['O07 容量实测（独立脚本，跑在隔离环境）', '管理界面'],
  },
  features: {
    title: 'P1 排位资格 / V1 评分算法 / 重复对手保护 / 排行榜过滤',
    entry: 'backend/tests/rating.policy.ts',
    runner: 'tsx',
    implemented: true,
    covers: ['U05', 'U06', 'U12', 'G09(ledger)'],
    phase: 'P1',
    deferred: ['U01 游客', 'U02 三步教学', 'U03/U04 匹配分流 UI', 'U07 迁移', 'U08 24h 门禁展示', 'U09 好友链接/二维码/ready', 'U10 并发第三第四人', 'U11 再来一局'],
  },
};

function parseArgs(argv) {
  const opts = { suites: [], all: false, list: false, out: null, only: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--suite') {
      const v = argv[i + 1];
      if (!v) throw new Error('--suite 需要取值');
      opts.suites.push(v);
      i += 1;
    } else if (arg.startsWith('--suite=')) {
      opts.suites.push(arg.slice('--suite='.length));
    } else if (arg === '--all') {
      opts.all = true;
    } else if (arg === '--list') {
      opts.list = true;
    } else if (arg === '--out') {
      opts.out = argv[i + 1] ?? null;
      i += 1;
    } else if (arg === '--only') {
      opts.only = argv[i + 1] ?? null;
      i += 1;
    } else {
      throw new Error('未知参数: ' + arg);
    }
  }
  if (!opts.all && opts.suites.length === 0 && !opts.list) opts.all = true;
  const selected = opts.all ? Object.keys(SUITES) : opts.suites;
  const unknown = selected.filter((s) => !(s in SUITES));
  if (unknown.length) throw new Error('未知套件: ' + unknown.join(', '));
  return { ...opts, selected: [...new Set(selected)] };
}

const IS_WIN = process.platform === 'win32';

/**
 * 真实子进程执行。Windows 上 npx/npm 是 .cmd 垫片，必须经 shell 才能被 CreateProcess 解析，
 * 否则会得到 spawn ENOENT 而不是测试结果 —— 那会把“工具没跑起来”误报成“测试失败”。
 */
function run(command, args, env) {
  return new Promise((resolvePromise) => {
    const started = Date.now();
    const child = spawn(command, args, { cwd: ROOT, env, shell: IS_WIN, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    child.stdout.on('data', (b) => { out.push(b); process.stdout.write(b); });
    child.stderr.on('data', (b) => { err.push(b); process.stderr.write(b); });
    child.on('error', (e) => resolvePromise({ code: 127, error: String(e), ms: Date.now() - started, stdout: '', stderr: String(e) }));
    child.on('close', (code) => resolvePromise({
      code: code === null ? 1 : code,
      ms: Date.now() - started,
      stdout: Buffer.concat(out).toString('utf8'),
      stderr: Buffer.concat(err).toString('utf8'),
    }));
  });
}

const BASELINE_STEPS = [
  { name: 'typecheck', cmd: ['npm', 'run', 'typecheck'] },
  { name: 'unit', cmd: ['npm', 'test'] },
  { name: 'backend-api', cmd: ['npm', 'run', 'test:backend'] },
  { name: 'ws-integration', cmd: ['npm', 'run', 'test:ws'] },
  { name: 'build', cmd: ['npm', 'run', 'build'] },
];

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(String(e.message ?? e));
    console.error('用法: node scripts/product/run-tests.mjs [--suite <name>]... [--all] [--list] [--out <dir>]');
    process.exit(3);
  }

  if (opts.list) {
    for (const [key, s] of Object.entries(SUITES)) {
      console.log((s.implemented ? '[READY] ' : '[NOT_IMPLEMENTED] ').padEnd(20) + key.padEnd(12) + s.title);
    }
    process.exit(0);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = opts.out ? resolve(ROOT, opts.out) : join(ROOT, 'evidence', 'product', stamp);
  mkdirSync(outDir, { recursive: true });

  const report = {
    schemaVersion: 1,
    runner: 'scripts/product/run-tests.mjs',
    startedAt: new Date().toISOString(),
    cwd: ROOT,
    node: process.version,
    selected: opts.selected,
    suites: [],
  };

  console.log('[product] root=' + ROOT);
  console.log('[product] suites=' + opts.selected.join(','));
  console.log('[product] evidence=' + outDir);

  for (const key of opts.selected) {
    const suite = SUITES[key];
    const record = { suite: key, phase: suite.phase, title: suite.title, covers: suite.covers, status: 'NOT_RUN', steps: [] };
    console.log('');
    console.log('=== [' + key + '] ' + suite.title);
    if (!suite.implemented) {
      record.status = 'NOT_IMPLEMENTED';
      record.blocker = suite.blocker ?? '未实现';
      console.log('NOT_IMPLEMENTED  ' + record.blocker);
      report.suites.push(record);
      continue;
    }

    let suiteOk = true;
    // 执行方式必须**由数据决定**，而不是在这里写死套件名。
    // 曾经这里写死 results/recovery/security/features 四个键：新增的 replay 套件
    // 于是既不进 tsx 分支也不进 baseline 分支，一步都没跑，却被判成 PASS ——
    // 这是最危险的失败模式（静默假通过），所以下面还有 steps 为空的硬断言。
    if (suite.runner === 'tsx' && suite.entry) {
      const entryPath = join(ROOT, suite.entry);
      if (!existsSync(entryPath)) {
        record.status = 'FAIL';
        record.blocker = '入口文件不存在: ' + suite.entry;
        console.log('FAIL  ' + record.blocker);
        report.suites.push(record);
        continue;
      }
      const env = { ...process.env, SRSZQ_PRODUCT_SUITE: key };
      if (opts.only) env.ONLY = opts.only;
      const r = await run('npx', ['tsx', suite.entry], env);
      const logName = key + '.log';
      writeFileSync(join(outDir, logName), r.stdout + (r.stderr ? '\n[stderr]\n' + r.stderr : ''), 'utf8');
      record.steps.push({ name: suite.entry, exitCode: r.code, ms: r.ms, log: logName });
      if (r.code !== 0) suiteOk = false;
    } else if (key === 'baseline') {
      for (const step of BASELINE_STEPS) {
        const r = await run(step.cmd[0], step.cmd.slice(1), process.env);
        const logName = 'baseline-' + step.name + '.log';
        writeFileSync(join(outDir, logName), r.stdout + (r.stderr ? '\n[stderr]\n' + r.stderr : ''), 'utf8');
        record.steps.push({ name: step.name, exitCode: r.code, ms: r.ms, log: logName });
        if (r.code !== 0) suiteOk = false;
      }
    } else {
      // 未知执行方式（既不是 tsx 入口也不是 baseline）一律失败，绝不静默通过。
      record.status = 'FAIL';
      record.blocker = '未知的执行方式：entry=' + String(suite.entry) + ' runner=' + String(suite.runner);
      console.log('FAIL  ' + record.blocker);
      report.suites.push(record);
      continue;
    }

    // 硬防线：一个套件不可能“什么都没跑”却通过。
    if (suiteOk && record.steps.length === 0) {
      suiteOk = false;
      record.blocker = '没有任何执行步骤，拒绝判为 PASS';
      console.log('FAIL  ' + record.blocker);
    }

    record.status = suiteOk ? 'PASS' : 'FAIL';
    report.suites.push(record);
    console.log('=> ' + key + ': ' + record.status);
  }

  const failed = report.suites.filter((s) => s.status === 'FAIL');
  const missing = report.suites.filter((s) => s.status === 'NOT_IMPLEMENTED' || s.status === 'NOT_RUN');
  const passed = report.suites.filter((s) => s.status === 'PASS');
  report.finishedAt = new Date().toISOString();
  report.summary = {
    pass: passed.map((s) => s.suite),
    fail: failed.map((s) => s.suite),
    notImplemented: missing.map((s) => s.suite),
    overall: failed.length ? 'FAIL' : (missing.length ? 'PARTIAL' : 'PASS'),
  };
  writeFileSync(join(outDir, 'product-report.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');

  console.log('');
  console.log('=== SUMMARY ===');
  for (const s of report.suites) {
    const detail = s.status === 'NOT_IMPLEMENTED' ? '  (' + (s.blocker ?? '') + ')' : '';
    console.log('  ' + s.status.padEnd(16) + s.suite + detail);
  }
  console.log('  overall=' + report.summary.overall + '  report=' + join(outDir, 'product-report.json'));
  process.exit(failed.length ? 1 : (missing.length ? 2 : 0));
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
