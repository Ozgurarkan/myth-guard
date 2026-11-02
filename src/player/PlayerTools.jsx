// The players' tool rail, down the right-hand side of the screen like the GM's rail:
// Ping and Measure are modes you switch on; End turn is a button that wakes up on your turn.
import React from 'react';
import { Icon } from '../ui';

function Tool({ icon, label, title, active = false, ready = false, disabled = false, pressed, onClick }) {
  return (
    <button type="button" className={`p-tool${active ? ' is-active' : ''}${ready ? ' is-ready' : ''}`} onClick={onClick} disabled={disabled}
      aria-pressed={pressed} title={title}>
      <Icon name={icon} size={22} />
      <span className="p-tool__label">{label}</span>
    </button>
  );
}

/**
 * `tool` is 'ping', 'measure', 'spell' or null. `onTool(name)` switches a mode on or off.
 * `spell` is true while the player may cast (a hero of their own on the map, and the GM allows it): it shows the Spell tool.
 * `canEndTurn` is true only while it is one of your heroes' turn; `endingTurn` is true for a moment after you tap it.
 * `delay` is { open, enabled, title, onToggle } while it is your hero's turn in a fight (the button waits until your turn), else null.
 * `hero` is { open, onToggle } while one of your heroes is in a fight (the hit points and initiative card), otherwise null.
 */
export function PlayerTools({ tool, onTool, canEndTurn, endingTurn, onEndTurn, hero = null, delay = null, spell = false }) {
  return (
    <nav className="p-tools" aria-label="Table tools">
      <Tool icon="crosshair" label="Ping" title="Ping: tap the map to show everyone a spot" active={tool === 'ping'} pressed={tool === 'ping'} onClick={() => onTool('ping')} />
      <Tool icon="ruler" label="Measure" title="Measure: drag on the map to see the distance" active={tool === 'measure'} pressed={tool === 'measure'} onClick={() => onTool('measure')} />
      {spell && <Tool icon="wand-sparkles" label="Spell" title="Cast a spell area, or a circle that follows your hero" active={tool === 'spell'} pressed={tool === 'spell'} onClick={() => onTool('spell')} />}
      {hero && <Tool icon="heart-pulse" label="Hero" title="Your hero: hit points and initiative" active={hero.open} pressed={hero.open} onClick={hero.onToggle} />}
      <span className="p-tools__sep" aria-hidden="true" />
      {delay && <Tool icon="hourglass" label="Delay" title={delay.title} active={delay.open} pressed={delay.open} disabled={!delay.enabled} onClick={delay.onToggle} />}
      <Tool icon="skip-forward" label="End turn" ready={canEndTurn && !endingTurn} disabled={!canEndTurn || endingTurn} onClick={onEndTurn}
        title={canEndTurn ? 'End your turn' : 'You can end your turn when it is your turn'} />
    </nav>
  );
}
