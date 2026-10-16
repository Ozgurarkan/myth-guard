// Realm Forge UI kit: the small set of parts every screen is built from.
// Styles live in src/styles/components.css.
import React, { createContext, useContext, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { ICONS } from './icons.js';

const cx = (...parts) => parts.filter(Boolean).join(' ');

// ── Icons ────────────────────────────────────────────────────────────────────
export function Icon({ name, size = 18, className, title, ...rest }) {
  const nodes = ICONS[name];
  if (!nodes) return null;
  return (
    <svg className={cx('icon', className)} width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"
      role={title ? 'img' : undefined} aria-label={title} aria-hidden={title ? undefined : true} {...rest}>
      {nodes.map(([tag, attrs], i) => React.createElement(tag, { key: i, ...attrs }))}
    </svg>
  );
}

// ── Buttons ──────────────────────────────────────────────────────────────────
/** variant: primary · secondary · ghost · danger.  `active` shows a pressed/selected state. */
export const Button = React.forwardRef(function Button(
  { variant = 'secondary', size, icon, iconRight, active, block, className, children, type = 'button', ...props }, ref) {
  return (
    <button ref={ref} type={type} aria-pressed={active === undefined ? undefined : !!active}
      className={cx('btn', `btn--${variant}`, size && `btn--${size}`, active && 'is-active', block && 'btn--block', !children && 'btn--icon', className)}
      {...props}>
      {icon && <Icon name={icon} size={size === 'sm' ? 15 : 17} />}
      {children && <span className="btn__label">{children}</span>}
      {iconRight && <Icon name={iconRight} size={15} />}
    </button>
  );
});

export function ButtonLink({ variant = 'secondary', size, icon, iconRight, className, children, ...props }) {
  return (
    <a className={cx('btn', `btn--${variant}`, size && `btn--${size}`, className)} {...props}>
      {icon && <Icon name={icon} size={size === 'sm' ? 15 : 17} />}
      <span className="btn__label">{children}</span>
      {iconRight && <Icon name={iconRight} size={15} />}
    </a>
  );
}

/** A square icon button. `label` is the accessible name and the tooltip. */
export const IconButton = React.forwardRef(function IconButton({ icon, label, variant = 'ghost', size, className, ...props }, ref) {
  return (
    <button ref={ref} type="button" aria-label={label} title={label}
      className={cx('btn', `btn--${variant}`, 'btn--icon', size && `btn--${size}`, className)} {...props}>
      <Icon name={icon} size={size === 'sm' ? 15 : 18} />
    </button>
  );
});

// ── Form parts ───────────────────────────────────────────────────────────────
// A <Field> labels the first text control inside it, so every input has a proper
// accessible name (and a click on the label focuses it).
const FieldContext = createContext(null);

/** The id a control should use: its own, else the one its surrounding Field offers (first control only). */
function useFieldId(own) {
  const field = useContext(FieldContext);
  const [claimed] = useState(() => {
    if (own || !field || field.claimed) return undefined;
    field.claimed = true;
    return field.id;
  });
  return own ?? claimed;
}

export const Input = React.forwardRef(function Input({ className, id, ...props }, ref) {
  return <input ref={ref} id={useFieldId(id)} className={cx('input', className)} {...props} />;
});

export const Textarea = React.forwardRef(function Textarea({ className, id, ...props }, ref) {
  return <textarea ref={ref} id={useFieldId(id)} className={cx('input', 'textarea', className)} {...props} />;
});

/** Native select (best on phones); `options` may be strings or `{ value, label }`. */
export function Select({ options = [], className, id, ...props }) {
  return (
    <select id={useFieldId(id)} className={cx('input', 'select', className)} {...props}>
      {options.map(option => {
        const item = typeof option === 'object' ? option : { value: option, label: option };
        return <option key={item.value} value={item.value}>{item.label}</option>;
      })}
    </select>
  );
}

export function Field({ label, hint, children, className, htmlFor }) {
  const generated = useId();
  const [field] = useState(() => ({ id: htmlFor ?? generated, claimed: !!htmlFor }));
  return (
    <FieldContext.Provider value={field}>
      <div className={cx('field', className)}>
        {label && <label className="field__label" htmlFor={field.id}>{label}</label>}
        {children}
        {hint && <p className="field__hint">{hint}</p>}
      </div>
    </FieldContext.Provider>
  );
}

export function Switch({ checked, onChange, label, hint, disabled }) {
  return (
    <label className={cx('switch', disabled && 'is-disabled')}>
      <input type="checkbox" role="switch" checked={!!checked} disabled={disabled} onChange={e => onChange(e.target.checked)} />
      <span className="switch__track" aria-hidden="true"><span className="switch__thumb" /></span>
      <span className="switch__text">{label}{hint && <small>{hint}</small>}</span>
    </label>
  );
}

/** Pick one of a few options, shown as a joined row of buttons. */
export function Segmented({ value, options, onChange, label, className }) {
  return (
    <div className={cx('segmented', className)} role="group" aria-label={label}>
      {options.map(option => (
        <button key={option.value} type="button" aria-pressed={value === option.value} title={option.title}
          className={cx('segmented__item', value === option.value && 'is-active')} onClick={() => onChange(option.value)}>
          {option.icon && <Icon name={option.icon} size={15} />}
          {option.label && <span>{option.label}</span>}
        </button>
      ))}
    </div>
  );
}

export function Swatches({ colors, value, onChange, label = 'Colour' }) {
  return (
    <div className="swatches" role="group" aria-label={label}>
      {colors.map(color => {
        const hex = typeof color === 'string' ? color : color.value;
        const name = typeof color === 'string' ? color : color.label;
        return (
          <button key={hex} type="button" className={cx('swatch', value?.toLowerCase() === hex.toLowerCase() && 'is-selected')}
            style={{ '--swatch': hex }} aria-label={name} title={name} aria-pressed={value?.toLowerCase() === hex.toLowerCase()}
            onClick={() => onChange(hex)} />
        );
      })}
    </div>
  );
}

// ── Display parts ────────────────────────────────────────────────────────────
export function Badge({ tone = 'neutral', icon, children, className }) {
  return <span className={cx('badge', `badge--${tone}`, className)}>{icon && <Icon name={icon} size={12} />}{children}</span>;
}

/** An ornamental divider, optionally with a heading in the middle. */
export function Rule({ children, className }) {
  return <div className={cx('rule', className)} role="separator"><span className="rule__gem" aria-hidden="true">◆</span>{children && <span className="rule__text">{children}</span>}</div>;
}

export function SectionHead({ children, action, count }) {
  return (
    <div className="section-head">
      <h3>{children}{count !== undefined && <span className="section-head__count">{count}</span>}</h3>
      {action}
    </div>
  );
}

export function EmptyState({ icon = 'scroll-text', art, title, children, action }) {
  return (
    <div className="empty-state">
      {art ? <img className="empty-state__art" src={`/brand/empty-${art}.png`} alt="" aria-hidden="true" draggable="false" /> : <Icon name={icon} size={28} />}
      {title && <strong>{title}</strong>}
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export function Card({ className, children, ...props }) {
  return <div className={cx('card', className)} {...props}>{children}</div>;
}

/** Round portrait with a coloured ring; falls back to initials. */
export function Avatar({ src, name = '?', color, size = 36, className }) {
  const initials = name.trim().split(/\s+/).slice(0, 2).map(part => part[0]).join('').toUpperCase() || '?';
  return (
    <span className={cx('avatar', className)} style={{ '--size': `${size}px`, '--ring': color || 'var(--border-strong)' }}>
      {src ? <img src={src} alt="" draggable={false} /> : <span aria-hidden="true">{initials}</span>}
    </span>
  );
}

// ── Modal ────────────────────────────────────────────────────────────────────
export function Modal({ title, icon, onClose, children, footer, width = 480, className, labelledBy = 'modal-title' }) {
  const ref = useRef(null);
  // The latest handler, without re-running the focus logic whenever the parent re-renders.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement;
    const box = ref.current;
    // Move focus inside, unless something in the dialog (autoFocus) already took it.
    if (box && !box.contains(document.activeElement)) {
      (box.querySelector('[data-autofocus], input:not([type=hidden]), select, textarea') ?? box).focus({ preventScroll: true });
    }
    const onKey = event => {
      if (event.key === 'Escape') { event.stopPropagation(); closeRef.current?.(); return; }
      if (event.key !== 'Tab' || !box) return;
      const items = [...box.querySelectorAll('a[href], button:not(:disabled), input:not(:disabled), select, textarea, [tabindex]:not([tabindex="-1"])')]
        .filter(el => el.offsetParent !== null);
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => { document.removeEventListener('keydown', onKey, true); previous?.focus?.({ preventScroll: true }); };
  }, []);
  return (
    <div className="modal-overlay" onMouseDown={event => { if (event.target === event.currentTarget) onClose?.(); }}>
      <div ref={ref} className={cx('modal', className)} style={{ '--modal-w': `${width}px` }} role="dialog" aria-modal="true"
        aria-labelledby={labelledBy} tabIndex={-1}>
        <header className="modal__header">
          {icon && <Icon name={icon} size={20} />}
          <h2 id={labelledBy}>{title}</h2>
          {onClose && <IconButton icon="x" label="Close" onClick={onClose} size="sm" />}
        </header>
        <div className="modal__body">{children}</div>
        {footer && <footer className="modal__footer">{footer}</footer>}
      </div>
    </div>
  );
}

// ── Toasts ───────────────────────────────────────────────────────────────────
let toasts = [];
const listeners = new Set();
const emit = () => { for (const listener of listeners) listener(); };

/** Show a short message. tone: info · success · warning · danger */
export function toast(message, { tone = 'info', duration = 4200, icon } = {}) {
  const id = Math.random().toString(36).slice(2);
  toasts = [...toasts, { id, message, tone, icon }].slice(-4);
  emit();
  setTimeout(() => { toasts = toasts.filter(item => item.id !== id); emit(); }, duration);
}

const ICON_FOR_TONE = { info: 'info', success: 'circle-check', warning: 'triangle-alert', danger: 'circle-alert' };

export function ToastHost() {
  const items = useSyncExternalStore(
    listener => { listeners.add(listener); return () => listeners.delete(listener); },
    () => toasts,
  );
  return (
    <div className="toasts" role="status" aria-live="polite">
      {items.map(item => (
        <div key={item.id} className={cx('toast', `toast--${item.tone}`)}>
          <Icon name={item.icon || ICON_FOR_TONE[item.tone]} size={18} />
          <span>{item.message}</span>
        </div>
      ))}
    </div>
  );
}

// ── Confirm dialog (the browser's confirm() is blocking and unthemed) ─────────
let confirmState = null;
const confirmListeners = new Set();
const setConfirm = next => { confirmState = next; for (const listener of confirmListeners) listener(); };

/** `await ask({ title, message, confirmLabel, danger })` → true / false */
export function ask({ title = 'Are you sure?', message, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false }) {
  return new Promise(resolve => {
    setConfirm({ title, message, confirmLabel, cancelLabel, danger, resolve: answer => { setConfirm(null); resolve(answer); } });
  });
}

export function ConfirmHost() {
  const state = useSyncExternalStore(
    listener => { confirmListeners.add(listener); return () => confirmListeners.delete(listener); },
    () => confirmState,
  );
  if (!state) return null;
  return (
    <Modal title={state.title} icon={state.danger ? 'triangle-alert' : 'circle-alert'} width={420} onClose={() => state.resolve(false)}
      footer={<>
        <Button variant="ghost" onClick={() => state.resolve(false)}>{state.cancelLabel}</Button>
        <Button variant={state.danger ? 'danger' : 'primary'} data-autofocus onClick={() => state.resolve(true)}>{state.confirmLabel}</Button>
      </>}>
      <p className="modal__message">{state.message}</p>
    </Modal>
  );
}

export { cx };
