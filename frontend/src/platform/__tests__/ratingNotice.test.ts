import { describe, expect, it } from 'vitest';
import { ratingNoticeOf } from '../ratingNotice';

describe('开局的计分预判文案（规格 4.2「第 4 局起不计分且开局前提示」）', () => {
  it('计分时不显示任何提示', () => {
    expect(ratingNoticeOf({ ranked: true, policy: 'rating-beta-v1', reason: null })).toBeNull();
    expect(ratingNoticeOf({ ranked: true, policy: 'legacy-online-v1', reason: null })).toBeNull();
  });

  it('没有预判（老服务器 / 本地对局）时不显示', () => {
    expect(ratingNoticeOf(null)).toBeNull();
    expect(ratingNoticeOf(undefined)).toBeNull();
  });

  it('重复对手：说清是「24 小时内第 4 局」而不是含糊的“本局不计分”', () => {
    const text = ratingNoticeOf({ ranked: false, policy: 'none', reason: 'REPEAT_OPPONENTS' });
    expect(text).toContain('24 小时');
    expect(text).toContain('不计竞技分');
  });

  it('AI 补位 / 门禁未过 / 好友局各自给出对应原因', () => {
    expect(ratingNoticeOf({ ranked: false, policy: 'none', reason: 'NOT_THREE_HUMANS' })).toContain('AI 补位');
    expect(ratingNoticeOf({ ranked: false, policy: 'none', reason: 'NOT_TUTORIAL_COMPLETE' })).toContain('教学');
    expect(ratingNoticeOf({ ranked: false, policy: 'none', reason: 'NOT_ONLINE_MODE' })).toContain('好友');
  });

  it('未知原因也要说实话（兜底文案不得暗示计分）', () => {
    const text = ratingNoticeOf({ ranked: false, policy: 'none', reason: 'SOMETHING_NEW' });
    expect(text).toContain('不计竞技分');
  });
});
