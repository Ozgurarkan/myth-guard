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
 * `tool` is 'ping', 'measure' or null. `onTool(name)` switches a mode on or off.
 * `canEndTurn` is true only while it is one of your heroes' turn; `endingTurn` is true for a moment after you tap it.
 */
export function PlayerTools({ tool, onTool, canEndTurn, endingTurn, onEndTurn }) {
  return (
    <nav className="p-tools" aria-label="Table tools">
      <Tool icon="crosshair" label="Ping" title="Ping: tap the map to show everyone a spot" active={tool === 'ping'} pressed={tool === 'ping'} onClick={() => onTool('ping')} />
      <Tool icon="ruler" label="Measure" title="Measure: drag on the map to see the distance" active={tool === 'measure'} pressed={tool === 'measure'} onClick={() => onTool('measure')} />
      <span className="p-tools__sep" aria-hidden="true" />
      <Tool icon="skip-forward" label="End turn" ready={canEndTurn && !endingTurn} disabled={!canEndTurn || endingTurn} onClick={onEndTurn}
        title={canEndTurn ? 'End your turn' : 'You can end your turn when it is your turn'} />
    </nav>
  );
}
