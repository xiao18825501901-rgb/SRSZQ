/** 极简哈希路由（零依赖） */
import { useEffect, useState } from 'react';

export function parseHash(): { path: string; query: URLSearchParams } {
  const raw = window.location.hash.replace(/^#/, '') || '/';
  const [path, qs] = raw.split('?');
  return { path: path || '/', query: new URLSearchParams(qs ?? '') };
}

export function useRoute(): { path: string; query: URLSearchParams; navigate: (to: string) => void } {
  const [route, setRoute] = useState(parseHash());
  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  return {
    path: route.path,
    query: route.query,
    navigate: (to: string) => {
      window.location.hash = to.startsWith('#') ? to : `#${to}`;
    },
  };
}

export function Link({ to, children, className }: { to: string; children: React.ReactNode; className?: string }) {
  return (
    <a className={className} href={`#${to}`}>
      {children}
    </a>
  );
}
