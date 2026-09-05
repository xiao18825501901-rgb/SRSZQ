/** backend 纯函数单元测试（vitest，无网络） */
import { describe, expect, it } from 'vitest';
import { hashPassword, makeSalt, verifyPassword, validateEmail, validatePassword, validateUsername, avatarFor } from './auth.js';

describe('auth utils', () => {
  it('密码哈希可校验（随机盐）', () => {
    const salt = makeSalt();
    const h = hashPassword('secret1', salt);
    expect(h).not.toContain('secret1');
    expect(verifyPassword('secret1', salt, h)).toBe(true);
    expect(verifyPassword('secret2', salt, h)).toBe(false);
  });

  it('输入校验', () => {
    expect(validateEmail('a@b.com')).toBeNull();
    expect(validateEmail('nope')).not.toBeNull();
    expect(validateUsername('Alice_01')).toBeNull();
    expect(validateUsername('张三')).toBeNull();
    expect(validateUsername('x')).not.toBeNull();
    expect(validateUsername('bad name!')).not.toBeNull();
    expect(validatePassword('123456')).toBeNull();
    expect(validatePassword('123')).not.toBeNull();
  });

  it('头像 data-uri 稳定生成', () => {
    const a = avatarFor('Alice');
    expect(a.startsWith('data:image/svg+xml,')).toBe(true);
    expect(avatarFor('Alice')).toBe(a);
  });
});
