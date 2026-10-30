import {it,expect} from 'vitest';
import {setLocale,encodeMessage,errorText} from '../i18n/core';
it.each([['这个分享链接已被创建者撤销。','The creator has revoked this share link.'],['这个分享链接已过期。','This share link has expired.']])('share error remains translatable: %s',(source,en)=>{const notice=encodeMessage(source);setLocale('en');expect(errorText(notice)).toBe(en);setLocale('zh-CN');expect(errorText(notice)).toBe(source)});
