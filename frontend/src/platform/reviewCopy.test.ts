import { describe, it, expect } from 'vitest';
import { modeLabel } from './reviewCopy';
import { setLocale } from '../i18n/core';
describe('review mode presentation',()=>{
 it('translates invite at render time without changing its protocol value',()=>{const mode='invite';setLocale('zh-CN');expect(modeLabel(mode)).toBe('好友对弈');setLocale('en');expect(modeLabel(mode)).toBe('Play with Friends');expect(mode).toBe('invite');setLocale('zh-CN')});
 it('preserves unknown protocol modes',()=>expect(modeLabel('future-mode')).toBe('future-mode'));
});
