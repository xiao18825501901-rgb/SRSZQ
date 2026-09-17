/** SRSZQ Design System 基础组件（ui primitives）
 *  按钮/卡片/徽章/星级 —— 全站统一视觉（样式令牌见 styles/global.css :root 与 DesignSystem.md） */
import type { ReactNode } from 'react';


export type BtnVariant = 'primary' | 'default' | 'ghost' | 'danger';
export type BtnSize = 'small' | 'default' | 'big';

export function Btn({
  variant = 'default',
  size = 'default',
  className = '',
  children,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant; size?: BtnSize }) {
  return (
    <button className={`ds-btn ${variant} ${size} ${className}`} {...rest}>
      {children}
    </button>
  );
}

export function Card({
  hoverable = false,
  className = '',
  children,
}: {
  hoverable?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return <div className={`ds-card ${hoverable ? 'hoverable' : ''} ${className}`}>{children}</div>;
}

export type OnlineStatus = 'online' | 'offline' | 'playing' | 'matching';

export function StatusBadge({ status, label }: { status: OnlineStatus; label?: string }) {
  return (
    <span className={`ds-badge ${status}`}>
      <span className="pf-dot" style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: 'currentColor' }} />
      {label ?? status}
    </span>
  );
}

/** AI 星级（★1-5，绝不显示真实档位） */
export function Stars({ n, className = '' }: { n: number; className?: string }) {
  return (
    <span className={`ds-stars ${className}`} aria-label={`AI ${'★'.repeat(Math.min(5, Math.max(1, n)))}`}>
      {'★'.repeat(Math.min(5, Math.max(1, n)))}
    </span>
  );
}

/** 页面进入过渡（克制） */
export function PageMotion({ children }: { children: ReactNode }) {
  return <div className="page-enter">{children}</div>;
}
