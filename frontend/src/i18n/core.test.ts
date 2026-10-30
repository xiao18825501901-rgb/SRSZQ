import { describe, it, expect, beforeEach, vi } from 'vitest';
import { detectLocale, normalizeLocale, setLocale, getLocale, subscribeLocale, translate, encodeMessage, messageText, errorText, colorLabel, formatNumber, LOCALE_KEY } from './core';
import { EN } from './messages';
describe('presentation locale', () => {
 beforeEach(() => { setLocale('zh-CN'); });
 it.each([['en','zh-CN','en'],['zh-CN','en','zh-CN'],[null,'en-US','en'],[null,'fr','zh-CN']])('preference %s browser %s', (saved, browser, expected) => expect(detectLocale(saved,[browser!])).toBe(expected));
 it.each(['zh-TW','zh-Hans','ZH-cn'])('normalizes %s', x => expect(normalizeLocale(x)).toBe('zh-CN'));
 it('notifies once and detaches subscriptions',()=>{const f=vi.fn();const off=subscribeLocale(f);setLocale('en');setLocale('en');expect(f).toHaveBeenCalledTimes(1);off();setLocale('zh-CN');expect(f).toHaveBeenCalledTimes(1)});
 it('preserves user text during interpolation',()=>expect(translate('{p0} 邀请你对弈',{p0:'红 <script> {p2}'},'en')).toBe('红 <script> {p2} invited you to play'));
 it('translates stored notice at render time',()=>{const n=encodeMessage('邀请已发送，等待好友接受。');setLocale('en');expect(messageText(n)).toContain('Invitation sent');setLocale('zh-CN');expect(messageText(n)).toBe('邀请已发送，等待好友接受。')});
 it('keeps protocol seat identities outside presentation',()=>{setLocale('en');expect(colorLabel('C')).toBe('White');setLocale('zh-CN');expect(colorLabel('C')).toBe('白棋')});
 it('hides unknown internal errors',()=>{setLocale('en');expect(errorText('/private/database/error')).toBe('Something went wrong. Please try again.')});
 it('formats display numbers only',()=>{setLocale('en');expect(formatNumber(1250)).toBe('1,250');expect(LOCALE_KEY).toBe('srszq.locale.v1');expect(getLocale()).toBe('en')});
 it('has placeholder parity and English-only catalog values',()=>{for(const [k,v] of Object.entries(EN)){const params=(x:string)=>[...new Set(x.match(/\{[^{}]+\}/g)||[])].sort();expect(params(v),k).toEqual(params(k));expect(v,k).not.toMatch(/[\u3400-\u9fff]/)}});
});

describe('locale browser adapter (unit doubles, not browser acceptance)', () => {
 it.each([false,true])('persists safely with storage denied=%s',async denied=>{
  vi.resetModules(); const values=new Map<string,string>();const handlers:Record<string,(e:any)=>void>={};
  vi.stubGlobal('window',{get localStorage(){if(denied)throw Error('denied');return {getItem:(k:string)=>values.get(k)??null,setItem:(k:string,v:string)=>values.set(k,v)}},addEventListener:(k:string,f:any)=>handlers[k]=f});
  vi.stubGlobal('document',{documentElement:{lang:'',dir:'',dataset:{}},title:''});
  try {const core=await import('./core');core.setLocale('en');expect(core.getLocale()).toBe('en');expect(document.documentElement.lang).toBe('en');expect(values.size).toBe(denied?0:1);handlers.storage({key:core.LOCALE_KEY,newValue:'zh-CN'});expect(core.getLocale()).toBe('zh-CN');handlers.storage({key:'unrelated',newValue:'en'});expect(core.getLocale()).toBe('zh-CN');} finally {vi.unstubAllGlobals();}
 });
});
