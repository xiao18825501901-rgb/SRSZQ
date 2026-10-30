import { tx } from "../i18n/core";
import { useLocale } from "../i18n/react";
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { Btn, IconButton } from '../ui';
interface Props {
    open: boolean;
    title: string;
    onClose: () => void;
    children: ReactNode;
    footer?: ReactNode;
}
/** Native top-layer dialog: background inert, focus containment and Escape.
 * Opening never executes the destructive action; confirmation focuses Cancel.
 * No delayed close timer can affect the next match or block the board. */
export function Modal({ open, title, onClose, children, footer }: Props) {
    useLocale();
    const ref = useRef<HTMLDialogElement>(null);
    const startedOutside = useRef(false);
    const titleId = useId();
    useEffect(() => {
        const dialog = ref.current;
        if (!open || !dialog)
            return;
        const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        dialog.showModal();
        const cancel = dialog.querySelector<HTMLElement>('[data-dialog-cancel]');
        if (cancel)
            cancel.focus({ preventScroll: true });
        return () => {
            if (dialog.open)
                dialog.close();
            if (previous?.isConnected)
                previous.focus({ preventScroll: true });
        };
    }, [open]);
    if (!open)
        return null;
    return <dialog ref={ref} className="modal-backdrop sq-dialog" aria-labelledby={titleId} onCancel={ev => { ev.preventDefault(); onClose(); }} onKeyDown={ev => {
            if (ev.key === 'Escape' && (ev.nativeEvent.isComposing || ev.keyCode === 229)) {
                ev.preventDefault();
                return;
            }
            if (ev.key === 'Tab') {
                const nodes = Array.from(ev.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'))
                    .filter(el => el.getClientRects().length > 0 && !el.closest('[inert]'));
                const first = nodes[0], last = nodes.at(-1);
                if (!first) {
                    ev.preventDefault();
                    ev.currentTarget.focus();
                    return;
                }
                if (ev.shiftKey && (document.activeElement === first || !ev.currentTarget.contains(document.activeElement))) {
                    ev.preventDefault();
                    last?.focus();
                }
                else if (!ev.shiftKey && (document.activeElement === last || !ev.currentTarget.contains(document.activeElement))) {
                    ev.preventDefault();
                    first.focus();
                }
            }
        }} onPointerDown={ev => { startedOutside.current = ev.target === ev.currentTarget; }} onClick={ev => { if (ev.target === ev.currentTarget && startedOutside.current)
        onClose(); }}>
    <div className="modal sq-dialog__surface">
      <div className="modal-head"><h2 id={titleId}>{title}</h2><IconButton icon="close" label={tx("关闭弹窗")} onClick={onClose}/></div>
      <div className="modal-body">{children}</div>
      {footer && <div className="modal-foot">{footer}</div>}
    </div>
  </dialog>;
}
export function ConfirmModal(props: {
    open: boolean;
    title: string;
    message: string;
    onConfirm: () => void;
    onCancel: () => void;
    pending?: boolean;
}) {
    useLocale();
    return <Modal open={props.open} title={props.title} onClose={props.onCancel} footer={<>
    <Btn type="button" onClick={props.onCancel} data-dialog-cancel>{tx("取消")}</Btn>
    <Btn type="button" variant="danger" onClick={props.onConfirm} loading={props.pending} icon="check">{tx("确认")}</Btn>
  </>}><p>{props.message}</p></Modal>;
}
