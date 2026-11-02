// The combat tracker: initiative order, turn control and hit points.
import React, { useEffect, useState } from 'react';
import { Button, IconButton, Avatar, Badge, EmptyState, Icon, ask, toast } from '../../ui';
import { useGM } from '../../store';
import { SkullMark } from '../../brand';
import { turnOrder, delayedIds, delayTargets, tokenKind, healthCondition, combatEntryFor } from '../../combat';
import { PanelSection } from './PanelParts';

const d20 = () => 1 + Math.floor(Math.random() * 20);
const QUICK_AMOUNTS = [1, 5, 10, 20];

/** A number box that lets you type freely and commits on Enter or blur. */
function NumberField({ label, value, placeholder, min, onCommit, className = '' }) {
  const [draft, setDraft] = useState(value ?? '');
  useEffect(() => { setDraft(value ?? ''); }, [value]);
  const commit = () => {
    if (draft === '' || draft === null) { if (value != null) onCommit(null); return; }
    const number = Math.floor(Number(draft));
    if (!Number.isFinite(number)) { setDraft(value ?? ''); return; }
    const next = min === undefined ? number : Math.max(min, number);
    setDraft(next);
    if (next !== value) onCommit(next);
  };
  return (
    <label className={`numfield ${className}`}>
      <span>{label}</span>
      <input className="input" type="number" inputMode="numeric" step="1" value={draft} placeholder={placeholder} aria-label={label}
        onChange={event => setDraft(event.target.value)} onBlur={commit}
        onKeyDown={event => { event.stopPropagation(); if (event.key === 'Enter') event.currentTarget.blur(); }} />
    </label>
  );
}

/** good / warn / bad / down. Each state also differs in icon, label and fill pattern, never in colour alone. */
const hpTone = entry => {
  if (!entry.maxHp) return null;
  if (entry.hp <= 0) return 'down';
  const fraction = entry.hp / entry.maxHp;
  return fraction > .5 ? 'good' : fraction > .25 ? 'warn' : 'bad';
};
const HP_ICON = { good: 'heart-pulse', warn: 'droplet', bad: 'triangle-alert', down: 'skull' };

function HealthBar({ entry }) {
  if (!entry.maxHp) return <div className="healthbar is-unset" title="No hit points set"><span>HP not set</span></div>;
  const fraction = Math.max(0, Math.min(1, entry.hp / entry.maxHp));
  const tone = hpTone(entry);
  return (
    <div className={`healthbar is-${tone}`} role="meter" aria-valuemin={0} aria-valuemax={entry.maxHp} aria-valuenow={entry.hp} aria-label="Hit points"
      aria-valuetext={`${entry.hp} of ${entry.maxHp} hit points, ${healthCondition(entry)}`}>
      <span className="healthbar__fill" style={{ width: `${fraction * 100}%` }} />
      <span className="healthbar__ticks" aria-hidden="true" />
      <span className="healthbar__text">{entry.hp} / {entry.maxHp}</span>
    </div>
  );
}

function CombatRow({ token, entry, active, amount, rank, delayed }) {
  const { state, dispatch } = useGM();
  const [delayOpen, setDelayOpen] = useState(false);
  const kind = tokenKind(token);
  // Whoever's turn it is may step out and act after a later combatant of their own kind (heroes after heroes, creatures after creatures), once a round.
  const delayChoices = active && !delayed ? delayTargets(state.combat, state.tokens, token.id) : [];
  const delayWith = afterId => { setDelayOpen(false); dispatch({ type: 'COMBAT_DELAY', tokenId: token.id, after: afterId }); };
  const upsert = patch => dispatch({ type: 'COMBAT_UPSERT', entry: { ...entry, ...patch } });
  // The maximum is remembered on the token, so the next fight starts with it already filled in.
  const rememberMax = value => dispatch({ type: 'TOKEN_UPDATE', token: { ...token, maxHp: value } });
  const hit = sign => {
    if (!entry.maxHp) { toast('Set maximum hit points first.', { tone: 'warning' }); return; }
    upsert({ hp: Math.max(0, Math.min(entry.maxHp, entry.hp + sign * amount)) });
  };
  const dead = token.dead === true;
  const down = !dead && entry.maxHp && entry.hp <= 0;
  const tone = hpTone(entry);
  const name = token.name || 'token';
  return (
    <article className={`combatant${active ? ' is-active' : ''}${down ? ' is-down' : ''}${dead ? ' is-dead' : ''}`} aria-current={active ? 'step' : undefined}>
      <header className="combatant__head">
        <span className="combatant__avatar">
          <Avatar src={token.portraitSrc || token.imageSrc} name={token.name} color={token.color} size={42} />{dead && <SkullMark size={26} className="combatant__skull" />}
          <span className="combatant__rank" title={`Position ${rank} in the initiative order`}><span className="sr-only">Position </span>{rank}</span>
        </span>
        <div className="row__main">
          <strong className="row__title">{token.name || 'Unnamed'}</strong>
          <span className="combatant__tags">
            {active && <Badge tone="accent" icon="sparkles" className="combatant__turn">Turn</Badge>}
            {dead && <Badge tone="danger" icon="skull">Dead</Badge>}
            {delayed && !active && <Badge tone="accent" icon="hourglass" title="Delayed: acts here this round, back in the usual place next round">Delayed</Badge>}
            <button type="button" className="kind-toggle" title={kind === 'npc' ? 'Creature: players see only its condition. Click to treat as a hero.' : 'Hero: players see exact hit points. Click to treat as a creature.'}
              onClick={() => dispatch({ type: 'TOKEN_UPDATE', token: { ...token, characterType: kind === 'npc' ? 'pc' : 'npc' } })}>
              <Icon name={kind === 'npc' ? 'skull' : 'shield'} size={12} />{kind === 'npc' ? 'Creature' : 'Hero'}
            </button>
            {tone && <span className={`hp-state is-${tone}`}><Icon name={HP_ICON[tone]} size={12} />{healthCondition(entry)}</span>}
          </span>
        </div>
        {delayChoices.length > 0 && <IconButton icon="hourglass" size="sm" variant={delayOpen ? 'primary' : 'ghost'} label={`Delay ${name}'s turn`} aria-expanded={delayOpen} onClick={() => setDelayOpen(open => !open)} />}
        <IconButton icon="skull" size="sm" variant={dead ? 'primary' : 'ghost'} label={dead ? `Revive ${name}` : `Mark ${name} dead`} onClick={() => dispatch({ type: 'TOKEN_TOGGLE_DEAD', id: token.id })} />
        <IconButton icon="x" size="sm" label={`Remove ${name} from combat`} onClick={() => dispatch({ type: 'COMBAT_REMOVE', id: token.id })} />
      </header>
      {delayOpen && delayChoices.length > 0 && (
        <div className="chips" role="group" aria-label={`Delay ${name} until after`}>
          {delayChoices.map(choice => {
            const other = state.tokens.find(t => t.id === choice.tokenId);
            return other && <button key={choice.tokenId} type="button" className="chip" onClick={() => delayWith(choice.tokenId)}><Avatar src={other.portraitSrc || other.imageSrc} name={other.name} color={other.color} size={20} />After {other.name || 'Unnamed'}</button>;
          })}
        </div>
      )}
      <div className="combatant__hp">
        <Button size="sm" variant="danger" icon="minus" onClick={() => hit(-1)} disabled={!entry.maxHp} title={`Deal ${amount} damage`} aria-label={`Deal ${amount} damage to ${name}`}>{amount}</Button>
        <HealthBar entry={entry} />
        <Button size="sm" icon="plus" className="btn--heal" onClick={() => hit(1)} disabled={!entry.maxHp} title={`Heal ${amount}`} aria-label={`Heal ${name} by ${amount}`}>{amount}</Button>
      </div>
      <div className="combatant__fields">
        <NumberField label="Initiative" value={entry.initiative} onCommit={value => value !== null && upsert({ initiative: value })} />
        <NumberField label="HP now" value={entry.maxHp ? entry.hp : null} min={0} placeholder="—" onCommit={value => entry.maxHp && upsert({ hp: Math.min(entry.maxHp, value ?? entry.maxHp) })} />
        <NumberField label="HP max" value={entry.maxHp} min={1} placeholder="—" onCommit={value => { upsert(value === null ? { maxHp: null, hp: null } : { maxHp: value, hp: entry.maxHp ? Math.min(entry.hp, value) : value }); rememberMax(value); }} />
      </div>
      {kind === 'npc' && entry.maxHp && <p className="combatant__players"><Icon name="eye" size={13} />Players see: <strong>{healthCondition(entry)}</strong></p>}
    </article>
  );
}

function WaitingRow({ token, onAdd }) {
  const [initiative, setInitiative] = useState('');
  const add = value => { const number = Number(value); if (Number.isFinite(number)) onAdd(token, Math.floor(number)); };
  const npc = tokenKind(token) === 'npc';
  return (
    <div className="row waiting-row">
      <Avatar src={token.portraitSrc || token.imageSrc} name={token.name} color={token.color} size={34} />
      <div className="row__main"><span className="row__title">{token.name || 'Unnamed'}</span><span className="row__meta"><Icon name={npc ? 'skull' : 'shield'} size={12} /> {npc ? 'Creature' : 'Hero'}{token.maxHp ? ` · ${token.maxHp} HP` : ''}</span></div>
      <div className="waiting-row__controls">
      <input className="input numfield__plain" type="number" inputMode="numeric" placeholder="Init" aria-label={`Initiative for ${token.name}`} value={initiative}
        onChange={event => setInitiative(event.target.value)} onKeyDown={event => { event.stopPropagation(); if (event.key === 'Enter' && initiative !== '') add(initiative); }} />
      <IconButton icon="dices" size="sm" label="Roll a d20" onClick={() => add(d20())} />
      <Button size="sm" variant="primary" disabled={initiative === ''} onClick={() => add(initiative)}>Add</Button>
      </div>
    </div>
  );
}

export function CombatPanel() {
  const { state, dispatch } = useGM();
  const [amount, setAmount] = useState(5);
  const combat = state.combat;
  const order = turnOrder(combat);
  const waitingIds = delayedIds(combat);
  const waiting = state.tokens.filter(token => !order.some(entry => entry.tokenId === token.id));
  const add = (token, initiative) => dispatch({ type: 'COMBAT_UPSERT', entry: combatEntryFor(token, initiative) });
  const activeToken = combat.activeId ? state.tokens.find(token => token.id === combat.activeId) : null;

  const rollEveryone = () => { for (const token of waiting) add(token, d20()); toast(`Rolled initiative for ${waiting.length}.`, { tone: 'success' }); };
  const clear = async () => {
    if (await ask({ title: 'End combat?', message: 'The initiative list and round counter reset. Tokens stay on the map.', confirmLabel: 'End combat', danger: true })) dispatch({ type: 'COMBAT_RESET' });
  };

  return (
    <div className="combat">
      <div className={`combat__bar${activeToken ? ' is-running' : ''}`}>
        <div className="combat__round" aria-live="polite">
          <span className="combat__sigil" aria-hidden="true">{combat.round}</span>
          <div className="combat__round-text">
            <span>Round {combat.round}</span>
            <strong>{activeToken ? <><Icon name="sparkles" size={14} />{activeToken.name || 'Unnamed'}</> : order.length ? 'Ready to begin' : 'No combat yet'}</strong>
          </div>
        </div>
        <div className="combat__buttons">
          <Button size="sm" icon="skip-back" disabled={!combat.activeId} onClick={() => dispatch({ type: 'COMBAT_PREVIOUS' })}>Back</Button>
          <Button size="sm" variant="primary" iconRight="skip-forward" disabled={!order.length} onClick={() => dispatch({ type: 'COMBAT_NEXT' })}>{combat.activeId ? 'Next turn' : 'Start combat'}</Button>
        </div>
      </div>

      {order.length > 0 && <>
        <ol className="combat__strip" aria-label="Turn order at a glance">
          {order.map(entry => {
            const token = state.tokens.find(t => t.id === entry.tokenId);
            return token && (
              <li key={token.id} className={combat.activeId === token.id ? 'is-active' : undefined} title={`${token.name || 'Unnamed'}, initiative ${entry.initiative}`}>
                <Avatar src={token.portraitSrc || token.imageSrc} name={token.name} color={token.color} size={30} />
                <span className="num">{entry.initiative}</span>
              </li>
            );
          })}
        </ol>

        <div className="combat__amount">
          <label htmlFor="combat-amount">Damage / healing per click</label>
          <div className="combat__amount-controls">
            <div className="combat__presets" role="group" aria-label="Quick amounts">
              {QUICK_AMOUNTS.map(n => <button key={n} type="button" className={`chip${amount === n ? ' is-active' : ''}`} aria-pressed={amount === n} onClick={() => setAmount(n)}>{n}</button>)}
            </div>
            <input id="combat-amount" className="input" type="number" min="1" inputMode="numeric" value={amount} aria-label="Damage or healing per click"
              onChange={event => setAmount(Math.max(1, Math.floor(Number(event.target.value)) || 1))} onKeyDown={event => event.stopPropagation()} />
          </div>
        </div>

        <PanelSection title="Initiative order" count={order.length} action={<Button size="sm" variant="ghost" icon="x" onClick={clear}>End combat</Button>}>
          <div className="combatants">
            {order.map((entry, index) => {
              const token = state.tokens.find(t => t.id === entry.tokenId);
              return token && <CombatRow key={token.id} token={token} entry={entry} rank={index + 1} active={combat.activeId === token.id} amount={amount} delayed={waitingIds.includes(token.id)} />;
            })}
          </div>
        </PanelSection>
      </>}

      <PanelSection title="Not in combat" count={waiting.length} action={waiting.length > 1 && <Button size="sm" icon="dices" onClick={rollEveryone}>Roll all</Button>}>
        {state.tokens.length === 0 && <EmptyState icon="swords" title="No combatants yet" />}
        <div className="rows">{waiting.map(token => <WaitingRow key={token.id} token={token} onAdd={add} />)}</div>
      </PanelSection>
    </div>
  );
}
