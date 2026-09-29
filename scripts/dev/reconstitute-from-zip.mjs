/**
 * 交付包可重建性证明：从交付的源码 zip 解出、npm ci、typecheck、全量产品套件、构建。
 *
 *   node scripts/dev/reconstitute-from-zip.mjs --zip <path> [--out <dir>]
 *
 * 交付契约要求：源码包不是“能打开”就算数，必须能从零重建并重跑出同样的结论。
 * 任何一步非 0 退出即整体失败（退出码 1），并打印逐步结果 JSON。
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const argOf = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const ZIP = argOf('--zip', '');
const OUT = argOf('--out', join(process.env.TEMP || '/tmp', 'srszq-reconstitute-' + Date.now()));
if (!ZIP || !existsSync(ZIP)) { console.error('用法: node scripts/dev/reconstitute-from-zip.mjs --zip <path> [--out <dir>]'); process.exit(2); }

const steps = [];
const run = (label, file, argv, cwd) => {
  const t0 = Date.now();
  const r = spawnSync(file, argv, { cwd: cwd || OUT, stdio: 'inherit', shell: false });
  const row = { step: label, exitCode: r.status, seconds: Math.round((Date.now() - t0) / 100) / 10 };
  steps.push(row);
  console.log('[reconstitute] ' + label + ' exit=' + r.status + ' (' + row.seconds + 's)');
  return r.status === 0;
};
const npm = (label, argv) => run(label, 'cmd', ['/c', 'npm ' + argv.join(' ')]);

console.log('[reconstitute] zip=' + ZIP);
console.log('[reconstitute] out=' + OUT);
if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

let ok = run('extract', 'powershell', ['-NoProfile', '-Command', 'Expand-Archive -LiteralPath "' + ZIP + '" -DestinationPath "' + OUT + '" -Force']);
if (ok) ok = npm('npm-ci', ['ci', '--include=dev']);
if (ok) ok = npm('typecheck', ['run', 'typecheck']);
if (ok) ok = run('product-suites', 'cmd', ['/c', 'node scripts/product/run-tests.mjs --all']);
if (ok) ok = npm('build', ['run', 'build']);

const summary = { zip: ZIP, out: OUT, steps, ok };
writeFileSync(join(OUT, '..', 'reconstitute-result.json'), JSON.stringify(summary, null, 2));
console.log('RECONSTITUTE ' + (ok ? 'PASS' : 'FAIL') + ' ' + JSON.stringify(summary));
process.exit(ok ? 0 : 1);
