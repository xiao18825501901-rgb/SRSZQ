import { describe, expect, it } from 'vitest';
import { rewriteText } from './rewrite.js';

describe('rewriteText provider budget', () => {
  it('leaves enough completion budget for reasoning-model output', async () => {
    let requestBody: Record<string, unknown> | undefined;
    const result = await rewriteText({
      text: '请准备好。',
      style: 'meme',
      consent: true,
      apiKey: 'test-key',
      model: 'deepseek-flash',
      fetchImpl: async (_input, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({
          choices: [{ message: { content: '这盘马上开打，准备好哈。' } }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });

    expect(result).toEqual({ text: '这盘马上开打，准备好哈。', mode: 'MODEL_REWRITE' });
    expect(requestBody?.max_tokens).toBe(700);
  });
});
