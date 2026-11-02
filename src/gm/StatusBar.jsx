import React from 'react';
import { useGM } from '../store';
import { useStage } from '../stageView';
import { Icon } from '../ui';

const TOOL_NAMES = {
  select: 'Select', pan: 'Pan', marker: 'Marker', fog: 'Hide with fog', fogErase: 'Reveal', areaCircle: 'Circle spell', areaRect: 'Square spell', areaCone: 'Cone spell',
};

export function StatusBar() {
  const { state } = useGM();
  const { scale: stageScale } = useStage();
  const { status, latency } = state.net;
  return (
    <footer className="status-bar">
      <span className="status-item"><b>{TOOL_NAMES[state.activeTool] ?? state.activeTool}</b></span>
      <span className="status-spacer" />
      <span className="status-item"><span className="status-label">Zoom</span> {Math.round(stageScale * 100)}%</span>
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
