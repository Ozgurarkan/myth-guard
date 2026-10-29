import React from 'react';
import { Icon } from '../ui';
import { useGM } from '../store';

export function RailButton({ icon, label, hotkey, active, onClick, title, state }) {
  return (
    <button type="button" className={`rail-btn${active ? ' is-active' : ''}`} aria-pressed={active} aria-keyshortcuts={hotkey}
      title={`${title ?? label}${hotkey ? `  (${hotkey})` : ''}`} onClick={onClick}>
      <Icon name={icon} size={22} />
      <span className="rail-btn__label">{label}</span>
      {hotkey && <kbd className="rail-btn__key">{hotkey}</kbd>}
      {state && <span className={`rail-btn__state is-${state}`} aria-hidden="true" />}
    </button>
  );
}

export const TOOL_GROUPS = [
  { name: 'Map', tools: [
    { id: 'select', label: 'Select', icon: 'mouse-pointer-2', key: 'V', title: 'Select and move tokens, markers and spell areas' },
    { id: 'pan', label: 'Pan', icon: 'hand', key: 'H', title: 'Drag to move around the map (middle mouse always pans)' },
    { id: 'marker', label: 'Marker', icon: 'map-pin', key: 'M', title: 'Click the map to drop a marker' },
  ] },
  { name: 'Fog', tools: [
    { id: 'fog', label: 'Hide', icon: 'cloud-fog', key: 'F', title: 'Paint fog over the map to hide it from players' },
    { id: 'fogErase', label: 'Reveal', icon: 'eraser', key: 'E', title: 'Erase fog to reveal the map to players' },
  ] },
  { name: 'Spells', tools: [
    { id: 'areaCircle', label: 'Circle', icon: 'circle-dashed', key: 'C', title: 'Draw a circular area of effect' },
    { id: 'areaRect', label: 'Square', icon: 'square-dashed', key: 'R', title: 'Draw a rectangular area of effect' },
    { id: 'areaCone', label: 'Cone', icon: 'cone', key: 'K', title: 'Draw a cone of effect' },
  ] },
];

export function Toolbar() {
  const { state, dispatch } = useGM();
  const set = tool => dispatch({ type: 'TOOL_SET', tool });
  return (
    <nav className="rail" aria-label="Tabletop tools">
      <span className="rail__legend">Table tools</span>
      {TOOL_GROUPS.map(group => (
        <div className="rail__group" key={group.name} role="group" aria-label={group.name}>
          <span className="rail__title">{group.name}</span>
          {group.tools.map(tool => (
            <RailButton key={tool.id} icon={tool.icon} label={tool.label} hotkey={tool.key} title={tool.title}
              active={state.activeTool === tool.id} onClick={() => set(tool.id)} />
          ))}
        </div>
      ))}
      <div className="rail__group" role="group" aria-label="View">
        <span className="rail__title">View</span>
        <RailButton icon="grid-3x3" label="Grid" hotkey="G" title="Show or hide the grid"
          active={state.showGrid} onClick={() => dispatch({ type: 'GRID_TOGGLE' })} />
        <RailButton icon={state.showFog ? 'eye' : 'eye-off'} label="Fog" title="Show or hide fog on your screen (players always see it)"
          active={state.showFog} onClick={() => dispatch({ type: 'FOG_TOGGLE' })} />
        <RailButton icon="scan-eye" label="Frame" hotkey="P" title="Show the frame that marks what players can see"
          active={state.playerViewEnabled} onClick={() => dispatch({ type: 'PV_TOGGLE' })} />
      </div>
      <div className="rail__spacer" />
      <div className="rail__group" role="group" aria-label="Sheets">
        <RailButton icon="book-user" label="Sheets" hotkey="S" title="Show or hide the character-sheet viewer"
          active={state.showSheets} onClick={() => dispatch({ type: 'SHEETS_TOGGLE' })} />
      </div>
    </nav>
  );
}
