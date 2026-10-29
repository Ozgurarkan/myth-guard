// The turn order, as every player sees it.
//
// It never floats over the map. The player screen gives it a place of its own:
//   * a phone held upright: a slim strip across the top of the screen (the map sits below it); tap the arrow for the full list
//   * a landscape phone, tablet, laptop window or TV: a column down the left side (the map fits in the space that is left)
// The same markup serves both; the stylesheet (player.css, "Turn order") decides the shape.
import React, { useEffect, useRef, useState } from 'react';
import { initiativeOrder, healthLabel, bloodLevel } from '../combat';
import { Icon, IconButton } from '../ui';
import { DEFAULT_TOKEN_COLOR } from '../canvas/shared';

const slug = text => text.toLowerCase().replace(/\s+/g, '-');

/** Colour band for a combatant: creatures arrive as a condition word, heroes as hit points. */
function toneOf(entry) {
  if (entry.condition) return slug(entry.condition);
  if (!entry.maxHp) return '';
  const fraction = entry.hp / entry.maxHp;
  if (fraction <= 0) return 'down';
  return fraction < 0.2 ? 'almost-dead' : fraction < 0.5 ? 'badly-wounded' : fraction < 0.8 ? 'wounded' : 'healthy';
}

function Portrait({ token, entry, active, mine }) {
  const damage = bloodLevel(entry);
  const down = entry.hp === 0 || entry.condition === 'Down';
  const src = token.portraitSrc || token.imageSrc;
  return (
    <div className={`portrait${active ? ' is-active' : ''}${down ? ' is-down' : ''}${mine ? ' is-mine' : ''}`} style={{ '--token-color': token.color || DEFAULT_TOKEN_COLOR }}>
      {src ? <img src={src} alt="" draggable={false} /> : <span className="portrait__initial">{(token.name || '?').slice(0, 2).toUpperCase()}</span>}
      <span className="portrait__blood" aria-hidden="true" style={{ opacity: damage * 0.55 }} />
      {down && <span className="portrait__skull"><Icon name="skull" size={22} /></span>}
      {mine && <span className="portrait__you">You</span>}
      <span className="portrait__init" aria-label={`Initiative ${entry.initiative}`}>{entry.initiative}</span>
    </div>
  );
}

/** Scroll the list, never the page, so the active combatant is in the middle of it. */
function centreOn(container, element) {
  if (!container || !element) return;
  const sideways = container.scrollWidth > container.clientWidth + 2;
  if (sideways) container.scrollTo({ left: element.offsetLeft - (container.clientWidth - element.offsetWidth) / 2, behavior: 'smooth' });
  else container.scrollTo({ top: element.offsetTop - (container.clientHeight - element.offsetHeight) / 2, behavior: 'smooth' });
}

export function InitiativeBar({ combat, tokens, playerId }) {
  const list = useRef(null);
  const [open, setOpen] = useState(false);          // the full list as a drop-down, on a phone held upright
  const order = initiativeOrder(combat);
  const activeId = combat?.activeId;
  useEffect(() => {
    centreOn(list.current, list.current?.querySelector('[aria-current="step"]'));
  }, [activeId, open, order.length]);
  // a new turn closes the drop-down: the strip already shows who is up
  useEffect(() => { setOpen(false); }, [activeId]);
  if (!order.length) return null;

  const visible = order.filter(entry => tokens.some(t => t.id === entry.tokenId));
  const active = tokens.find(token => token.id === activeId);
  const position = visible.findIndex(entry => entry.tokenId === activeId);
  const next = position >= 0 && visible.length > 1 ? tokens.find(t => t.id === visible[(position + 1) % visible.length].tokenId) : null;
  return (
    <section className={`p-initiative${open ? ' is-open' : ''}`} aria-label="Combat initiative">
      <div className="p-initiative__round" role="status"><span>Round</span><strong>{combat.round}</strong></div>
      <div className="p-initiative__now">
        <span className="eyebrow">{active ? 'Now' : 'Combat'}</span>
        <strong>{active ? active.name || 'Unnamed' : `${order.length} combatants`}</strong>
        {next && <span className="p-initiative__next">Up next: {next.name || 'Unnamed'}</span>}
      </div>
      <ol className="p-initiative__list" ref={list} aria-label="Initiative order">
        {order.map(entry => {
          const token = tokens.find(t => t.id === entry.tokenId);
          if (!token) return null;
          const isActive = entry.tokenId === activeId;
          const mine = !!playerId && token.ownerId === playerId;
          return (
            <li key={entry.tokenId} aria-current={isActive ? 'step' : undefined} title={`${token.name || 'Unnamed'} — ${healthLabel(entry)}`}>
              <Portrait token={token} entry={entry} active={isActive} mine={mine} />
              <span className="p-initiative__name">{token.name || 'Unnamed'}</span>
              <span className={`p-initiative__vitals${toneOf(entry) ? ` is-${toneOf(entry)}` : ''}`}>
                <span className="p-initiative__health">{healthLabel(entry)}</span>
                {!entry.condition && entry.maxHp ? <span className="p-initiative__hp" aria-hidden="true"><i style={{ '--hp': Math.max(0, Math.min(1, entry.hp / entry.maxHp)) }} /></span> : null}
              </span>
              {isActive && <span className="p-initiative__turn">Turn</span>}
            </li>
          );
        })}
      </ol>
      <IconButton className="p-initiative__toggle" icon={open ? 'chevron-up' : 'chevron-down'} label={open ? 'Close the turn order' : 'Show the whole turn order'} size="sm" onClick={() => setOpen(value => !value)} aria-expanded={open} />
    </section>
  );
}
