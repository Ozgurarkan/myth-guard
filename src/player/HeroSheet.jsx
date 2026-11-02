// A player's own hero during a fight: change its hit points, its maximum and its initiative.
//
// The numbers are a draft while the thumb is busy: each tap shows at once, and the new value is sent a moment after the last
// tap (so five taps on "+" are one message). The table has the final say: the server checks the hero is yours, keeps hit
// points between 0 and the maximum, and the sheet follows whatever the table answers.
import React, { useEffect, useRef, useState } from 'react';
import { Icon, IconButton } from '../ui';

const SEND_AFTER_MS = 350;
const SETTLE_MS = 1800; // if the table never confirms, show what the table has again
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

function useDraft(value, send) {
  const [draft, setDraft] = useState(value);
  const dirty = useRef(false);
  const latest = useRef(value);
  const shown = useRef(value); // the newest draft, so two quick taps in the same frame both count
  const timers = useRef({ send: 0, settle: 0 });
  latest.current = value;
  useEffect(() => {
    if (!dirty.current || value === shown.current) { dirty.current = false; shown.current = value; setDraft(value); }
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { clearTimeout(timers.current.send); clearTimeout(timers.current.settle); }, []);
  const change = step => {
    const next = typeof step === 'function' ? step(shown.current) : step;
    shown.current = next;
    setDraft(next);
    dirty.current = true;
    clearTimeout(timers.current.send);
    clearTimeout(timers.current.settle);
    timers.current.send = setTimeout(() => {
      send(next);
      timers.current.settle = setTimeout(() => { dirty.current = false; shown.current = latest.current; setDraft(latest.current); }, SETTLE_MS);
    }, SEND_AFTER_MS);
  };
  return [draft, change];
}

function Stepper({ label, value, min, max, suffix, disabled, onSend }) {
  const [draft, change] = useDraft(value, onSend);
  const set = step => change(previous => {
    const next = typeof step === 'function' ? step(previous) : step;
    return Number.isFinite(next) ? clamp(Math.round(next), min, max) : previous;
  });
  return (
    <div className="p-hero__field">
      <span className="p-hero__label">{label}</span>
      <div className="p-hero__stepper">
        <IconButton icon="minus" label={`Lower ${label.toLowerCase()}`} variant="secondary" onClick={() => set(previous => previous - 1)} disabled={disabled || draft <= min} />
        <input type="number" inputMode="numeric" value={draft} min={min} max={max} disabled={disabled} aria-label={label}
          onFocus={event => event.target.select()} onChange={event => set(parseInt(event.target.value, 10))} />
        <IconButton icon="plus" label={`Raise ${label.toLowerCase()}`} variant="secondary" onClick={() => set(previous => previous + 1)} disabled={disabled || draft >= max} />
      </div>
      {suffix && <span className="p-hero__suffix">{suffix}</span>}
    </div>
  );
}

/**
 * `heroes` is [{ token, entry }] for your heroes that are in the fight. `canEdit` is false when the GM has switched this off
 * or the table is offline. `onEdit(tokenId, { hp?, maxHp?, initiative? })` sends a change.
 */
export function HeroSheet({ heroes, canEdit, onEdit, onClose }) {
  return (
    <section className="p-hero" aria-label="Your hero">
      <header className="p-hero__head">
        <strong><Icon name="heart-pulse" size={18} /> Your hero</strong>
        <IconButton icon="x" label="Close" variant="ghost" size="sm" onClick={onClose} />
      </header>
      {!canEdit && <p className="p-hero__note">The Dungeon Master has switched editing off for now.</p>}
      {heroes.map(({ token, entry }) => (
        <div className="p-hero__card" key={token.id} style={{ '--token-color': token.color || 'var(--text-4)' }}>
          <span className="p-hero__name">{token.name || 'Unnamed'}</span>
          {entry.condition === undefined && entry.maxHp > 0 && entry.hp != null && (
            <Stepper label="Hit points" value={entry.hp} min={0} max={entry.maxHp} suffix={`of ${entry.maxHp}`} disabled={!canEdit}
              onSend={hp => onEdit(token.id, { hp })} />
          )}
          {entry.condition === undefined && (
            <Stepper label="Max hit points" value={entry.maxHp ?? 0} min={1} max={99999} disabled={!canEdit}
              onSend={maxHp => onEdit(token.id, { maxHp })} />
          )}
          <Stepper label="Initiative" value={entry.initiative} min={-99} max={99} disabled={!canEdit}
            onSend={initiative => onEdit(token.id, { initiative })} />
        </div>
      ))}
    </section>
  );
}
