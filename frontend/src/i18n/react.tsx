import { useSyncExternalStore } from 'react';
import { getLocale, getServerLocale, setLocale, subscribeLocale, tx } from './core';

export function useLocale() {
  return useSyncExternalStore(subscribeLocale, getLocale, getServerLocale);
}
/** Two explicit language names; no flags and no full-page reload. */
export function LanguageSwitcher({ compact = false }: { compact?: boolean }) {
  const locale = useLocale();
  return <div className={`language-switcher${compact ? ' compact' : ''}`} role="group" aria-label={tx('界面语言')} data-testid="language-switcher">
    <svg className="language-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c5 5 5 13 0 18M12 3c-5 5-5 13 0 18"/></svg>
    <button type="button" lang="zh-CN" aria-label="切换为中文" aria-pressed={locale === 'zh-CN'} onClick={() => setLocale('zh-CN')}>中文</button>
    <button type="button" lang="en" aria-label="Switch to English" aria-pressed={locale === 'en'} onClick={() => setLocale('en')}>English</button>
  </div>;
}
