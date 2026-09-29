/**
 * 查 Netlify 上真实运行的前端 bundle 里烘焙的构建提交（vite define __SRSZQ_SOURCE_SHA__）。
 *
 *   node scripts/dev/frontend-commit-probe.mjs [--site https://srszq.com] [--expect <sha>]
 *
 * 退出码：0 = 找到期望提交；1 = 提交不含期望值或找不到。
 */
const args = process.argv.slice(2);
const argOf = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const SITE = argOf('--site', 'https://srszq.com');
const EXPECT = argOf('--expect', '');

const get = async (url) => {
  const res = await fetch(url, { redirect: 'follow' });
  return { status: res.status, body: await res.text() };
};

const html = await get(SITE + '/');
const m = /assets\/(index-[A-Za-z0-9_-]+\.js)/.exec(html.body);
if (!m) { console.log('FAIL: 首页 HTML 里找不到 index-*.js（status=' + html.status + '）'); process.exit(1); }
const bundle = m[1];
const js = await get(SITE + '/assets/' + bundle);
const found = /[0-9a-f]{40}/.exec(js.body);
console.log(JSON.stringify({
  site: SITE, htmlStatus: html.status, bundle, bundleStatus: js.status, bundleBytes: js.body.length,
  embeddedSha: found ? found[0] : null,
  hasAdminBuildTestid: js.body.includes('admin-build-sha'),
  expect: EXPECT || null,
}, null, 2));
if (!EXPECT) process.exit(0);
if (!js.body.includes(EXPECT)) { console.log('FAIL: bundle 里没有期望提交 ' + EXPECT); process.exit(1); }
console.log('FRONTEND COMMIT MATCH: ' + EXPECT);
