/** SRSZQ primitives — presentation only; keep all existing business callbacks. */
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Icon, type IconName } from './interaction/Icon';

export type BtnVariant = 'primary' | 'default' | 'ghost' | 'danger';
export type BtnSize = 'small' | 'default' | 'big';
export interface BtnProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: BtnVariant;
  size?: BtnSize;
  icon?: IconName;
  endIcon?: IconName;
  loading?: boolean;
  /** Honest state from the caller's completed operation, never inferred from a click. */
  feedback?: 'idle' | 'success' | 'error';
}
export const Btn = forwardRef<HTMLButtonElement, BtnProps>(function Btn({
  variant='default', size='default', className='', children,
  icon, endIcon, loading, feedback='idle', disabled, ...rest
},ref) {
  const reserveStatus=loading!==undefined || feedback!=='idle';
  return <button {...rest} ref={ref} className={`ds-btn sq-button ${variant} ${size} ${className}`}
    disabled={disabled||loading} aria-busy={loading || undefined} data-feedback={feedback}>
    <span className="sq-button__wash" aria-hidden="true"/>
    {icon&&<Icon name={icon}/>}
    {children!==undefined&&<span className="sq-button__label">{children}</span>}
    {endIcon&&!reserveStatus&&<Icon name={endIcon}/>}
    {reserveStatus&&<span className="sq-button__status" aria-hidden="true">
      {loading?<span className="sq-spinner"/>:feedback==='success'?<Icon name="check"/>:feedback==='error'?<Icon name="warning"/>:endIcon?<Icon name={endIcon}/>:null}
    </span>}
  </button>;
});
/** Name is required for icon-only controls. Native button activation stays on click. */
export const IconButton = forwardRef<HTMLButtonElement, Omit<BtnProps,'children'|'icon'|'aria-label'> & {icon:IconName;label:string}>(function IconButton({icon,label,className='',...rest},ref){
  return <Btn type="button" variant="ghost" {...rest} ref={ref} icon={icon} aria-label={label} title={rest.title??label} className={`sq-icon-button ${className}`}/>;
});
export function Card({hoverable=false,className='',children}:{hoverable?:boolean;className?:string;children:ReactNode}){
  return <div className={`ds-card ${hoverable?'hoverable':''} ${className}`}>{children}</div>;
}
export type OnlineStatus='online'|'offline'|'playing'|'matching';
export function StatusBadge({status,label}:{status:OnlineStatus;label?:string}){
  return <span className={`ds-badge ${status}`}><span className="pf-dot" aria-hidden="true" style={{display:'inline-block',width:8,height:8,borderRadius:'50%',background:'currentColor'}}/>{label??status}</span>;
}
export function Stars({n,className=''}:{n:number;className?:string}){
  return <span className={`ds-stars ${className}`} aria-label={`AI ${'★'.repeat(Math.min(5,Math.max(1,n)))}`}>{'★'.repeat(Math.min(5,Math.max(1,n)))}</span>;
}
export function PageMotion({children}:{children:ReactNode}){
  return <div className="page-enter">{children}</div>;
}
