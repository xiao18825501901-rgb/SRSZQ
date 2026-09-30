/**
 * 增量 C 的生产缺陷回归：迟到的 401 不得清掉刚建立的会话。
 * 对应现场：quick-start 成功后，首屏那次 /api/me 的 401 迟到回来把状态清了，用户被踢回登录页。
 */
import { describe, expect, it } from 'vitest';
import { isAuthRejection, nextGeneration, shouldClearSessionOnError } from '../authRace';

describe('迟到的鉴权失败与会话世代', () => {
  it('识别鉴权类错误', () => {
    expect(isAuthRejection('unauthorized')).toBe(true);
    expect(isAuthRejection('HTTP 401')).toBe(true);
    expect(isAuthRejection('HTTP 403')).toBe(true);
    expect(isAuthRejection('Failed to fetch')).toBe(false);
    expect(isAuthRejection('HTTP 500')).toBe(false);
  });

  it('期间建立过新会话（世代变了）→ 不清，这正是线上踩到的顺序', () => {
    const genAtStart = 0;
    const genAfterQuickStart = nextGeneration(genAtStart);
    expect(shouldClearSessionOnError(genAtStart, genAfterQuickStart, 'unauthorized')).toBe(false);
  });

  it('没有新会话介入的 401 → 照常清（正常登出/过期路径不变）', () => {
    expect(shouldClearSessionOnError(3, 3, 'unauthorized')).toBe(true);
    expect(shouldClearSessionOnError(3, 3, 'HTTP 403')).toBe(true);
  });

  it('网络抖动 → 永不清会话（保持用户在线）', () => {
    expect(shouldClearSessionOnError(3, 3, 'Failed to fetch')).toBe(false);
    expect(shouldClearSessionOnError(0, 5, 'HTTP 502')).toBe(false);
  });
});
