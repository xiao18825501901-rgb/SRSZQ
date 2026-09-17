// Standalone ranking pagination check against production.
const API = 'https://api.srszq.com';
const ts = Date.now().toString(36);
let failures = 0;
const check = async (name, fn) => { try { await fn(); console.log(`PASS  ${name}`); } catch (e) { failures++; console.log(`FAIL  ${name}  [${e.message}]`); } };

await check('register + pagination walk finds own user + stable ordering', async () => {
  const r = await fetch(`${API}/api/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: `rank.${ts}@srszq.test`, username: `RANK_${ts}`, password: 'rank-secret-1' }) });
  const j = await r.json();
  if (!j.token) throw new Error('register failed');
  const first = await (await fetch(`${API}/api/ranking?limit=10&offset=0`)).json();
  if (typeof first.total !== 'number' || first.ranking.length > 10) throw new Error('page shape');
  let found = false, prevRating = Infinity;
  for (let offset = 0; offset < first.total && !found; offset += 50) {
    const page = await (await fetch(`${API}/api/ranking?limit=50&offset=${offset}`)).json();
    for (const u of page.ranking) {
      if (u.rating > prevRating) throw new Error('rating order broken');
      prevRating = u.rating;
      if (u.username === j.user.username) found = true;
    }
  }
  if (!found) throw new Error('user not found across pages');
  console.log(`     total=${first.total} pages walked OK`);
});

console.log(failures === 0 ? 'RANKING CHECK: ALL PASS' : `RANKING CHECK: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
