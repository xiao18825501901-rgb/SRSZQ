import { writeFileSync } from 'node:fs';

const api = process.env.SRSZQ_API_URL ?? 'http://127.0.0.1:8080';
const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 4)}`;
const register = await fetch(`${api}/api/register`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    email: `model-probe-${suffix}@example.com`,
    username: `Probe${suffix.slice(-6)}`,
    password: 'secret123',
  }),
});
const auth = await register.json();
if (!register.ok || !auth.token) throw new Error('Model probe registration failed');

const original = '这一步我要认真下一手';
const response = await fetch(`${api}/api/match-chat/rewrite`, {
  method: 'POST',
  headers: {
    authorization: `Bearer ${auth.token}`,
    'content-type': 'application/json',
  },
  body: JSON.stringify({ text: original, style: 'meme', consent: true }),
});
const body = await response.json();
const report = {
  capturedAt: new Date().toISOString(),
  provider: 'DeepSeek',
  endpoint: 'POST /api/match-chat/rewrite',
  httpStatus: response.status,
  mode: body.mode ?? 'UNKNOWN',
  status: body.mode === 'MODEL_REWRITE'
    ? 'REAL_MODEL_REWRITE'
    : body.mode === 'ORIGINAL_NO_CREDENTIAL' || body.mode === 'ORIGINAL_NO_MODEL_CONFIG'
      ? 'NOT_CONFIGURED_SERVER_SIDE'
      : 'FALLBACK_ORIGINAL',
  originalTextLength: [...original].length,
  returnedTextLength: typeof body.text === 'string' ? [...body.text].length : null,
  returnedOriginal: body.text === original,
  credentialSource: 'SERVER_ENVIRONMENT_ONLY',
  credentialOrTokenSerialized: false,
};
writeFileSync(new URL('./fourmode-20261115/DEEPSEEK_STATUS.json', import.meta.url), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
