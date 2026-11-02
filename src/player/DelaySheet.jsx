// "Delay my turn": on your turn, pick the hero you will act after. You step out of your place, take your turn right after them, and
// next round you are back where your initiative puts you. Only heroes that come later this round are offered, never creatures.
import React from 'react';
import { Icon, IconButton } from '../ui';

/** `choices` is [{ token, entry }] in turn order. `onChoose(afterTokenId)` sends it. */
export function DelaySheet({ choices, onChoose, onClose }) {
  return (
    <section className="p-hero p-delay" aria-label="Delay your turn">
      <header className="p-hero__head">
        <strong><Icon name="hourglass" size={18} /> Delay your turn</strong>
        <IconButton icon="x" label="Close" variant="ghost" size="sm" onClick={onClose} />
      </header>
      {choices.length === 0
        ? <p className="p-hero__note">No other hero comes later this round.</p>
        : <ol className="p-delay__list">
            {choices.map(({ token, entry }) => (
              <li key={token.id}>
                <button type="button" className="p-delay__choice" style={{ '--token-color': token.color || 'var(--text-4)' }} onClick={() => onChoose(token.id)}>
                  <span className="p-delay__swatch" aria-hidden="true">{(token.name || '?').slice(0, 2).toUpperCase()}</span>
                  <span className="p-delay__name">After {token.name || 'Unnamed'}</span>
                  <span className="p-delay__init" aria-label={`Initiative ${entry.initiative}`}>{entry.initiative}</span>
                </button>
              </li>
            ))}
          </ol>}
    </section>
  );
}
