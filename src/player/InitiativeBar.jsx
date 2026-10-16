// The turn order, as every player sees it.
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

export function InitiativeBar({ combat, tokens, playerId }) {
  const list = useRef(null);
  const [collapsed, setCollapsed] = useState(() => window.innerWidth < 640);
  const order = initiativeOrder(combat);
  useEffect(() => {
    list.current?.querySelector('[aria-current="step"]')?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
  }, [combat?.activeId, collapsed]);
  if (!order.length) return null;
  const active = tokens.find(token => token.id === combat.activeId);
  return (
    <section className={`p-initiative${collapsed ? ' is-collapsed' : ''}`} aria-label="Combat initiative">
      <div className="p-initiative__round" role="status"><span>Round</span><strong>{combat.round}</strong></div>
      {collapsed ? (
        <div className="p-initiative__now">
          <span className="eyebrow">{active ? 'Current turn' : 'Combat'}</span>
          <strong>{active ? active.name || 'Unnamed' : `${order.length} combatants`}</strong>
        </div>
      ) : (
        <ol className="p-initiative__list" ref={list} aria-label="Initiative order">
          {order.map(entry => {
            const token = tokens.find(t => t.id === entry.tokenId);
            if (!token) return null;
            const isActive = entry.tokenId === combat.activeId;
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
      )}
      <IconButton icon={collapsed ? 'chevron-down' : 'chevron-up'} label={collapsed ? 'Show the turn order' : 'Collapse the turn order'} size="sm" onClick={() => setCollapsed(value => !value)} />
    </section>
  );
}
