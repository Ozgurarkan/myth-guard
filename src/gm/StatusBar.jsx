import React from 'react';
import { useGM } from '../store';
import { Icon } from '../ui';

const TOOL_NAMES = {
  select: 'Select', pan: 'Pan', marker: 'Marker', fog: 'Hide with fog', fogErase: 'Reveal', areaCircle: 'Circle spell', areaRect: 'Square spell', areaCone: 'Cone spell',
};
const HINTS = {
  select: 'Drag tokens to move them · Right-click for more · Delete removes the selection',
  pan: 'Drag to move around the map',
  marker: 'Click the map to place a marker',
  fog: 'Drag across the map to hide it from players',
  fogErase: 'Drag across the map to reveal it to players',
  areaCircle: 'Drag from the centre outward', areaRect: 'Drag from one corner to the other', areaCone: 'Drag from the tip outward',
};

export function StatusBar() {
  const { state } = useGM();
  const { status, latency } = state.net;
  return (
    <footer className="status-bar">
      <span className="status-item"><b>{TOOL_NAMES[state.activeTool] ?? state.activeTool}</b></span>
      <span className="status-item status-item--hint">{HINTS[state.activeTool]}</span>
      <span className="status-spacer" />
      <span className="status-item"><span className="status-label">Zoom</span> {Math.round(state.stageScale * 100)}%</span>
      <span className="status-item"><span className="status-label">Grid</span> {state.gridSize}px</span>
      <span className="status-item"><span className="status-label">Scale</span> 1 sq = {state.feetPerCell} ft</span>
      <span className="status-item"><span className="status-label">Fog</span> {state.fogCells.length}</span>
      <span className={`status-item status-net is-${status}`}>
        <Icon name={status === 'open' ? 'wifi' : 'wifi-off'} size={13} />
        {status === 'open' ? (latency ? `${latency} ms` : 'Table open') : 'Offline'}
      </span>
    </footer>
  );
}
