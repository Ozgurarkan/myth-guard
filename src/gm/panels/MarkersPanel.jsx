import React from 'react';
import { Button, IconButton, Input, Field, Segmented, Swatches, Switch, EmptyState } from '../../ui';
import { PanelSection } from './PanelParts';
import { useGM } from '../../store';
import { MARKER_TYPES } from '../../markerTypes';
import { ftToCells, ftToPx, roundFt } from '../../utils';
import { MARKER_COLORS } from '../palettes';

export function MarkersPanel() {
  const { state, dispatch } = useGM();
  const prop = (key, value) => dispatch({ type: 'MARKER_SET_PROP', key, value });
  // Markers store a radius in pixels; the GM thinks in feet across the shape.
  const across = roundFt(state.activeMarkerSize * 2, state.gridSize, state.feetPerCell);
  const setAcross = ft => prop('activeMarkerSize', ftToPx(ft, state.gridSize, state.feetPerCell) / 2);
  const squares = ftToCells(across, state.feetPerCell);

  return (
    <div>
      <PanelSection title="New marker" action={<Button size="sm" variant={state.activeTool === 'marker' ? 'primary' : 'secondary'} icon="map-pin" onClick={() => dispatch({ type: 'TOOL_SET', tool: 'marker' })}>Place on map</Button>}>
      <Field label="Shape">
        <Segmented label="Marker shape" value={state.activeMarkerType} onChange={value => prop('activeMarkerType', value)}
          options={MARKER_TYPES.map(type => ({ value: type.value, label: type.icon, title: type.label }))} />
      </Field>
      <Field label="Colour"><Swatches colors={MARKER_COLORS} value={state.activeMarkerColor} onChange={color => prop('activeMarkerColor', color)} label="Marker colour" /></Field>
      <Field label={`Size — ${across} ft across`} hint={`${squares} square${squares === 1 ? '' : 's'}`}>
        <div className="inline-controls">
          <Input type="number" min={1} step={state.feetPerCell} value={across} aria-label="Marker size in feet" style={{ width: 90 }} onChange={event => setAcross(Math.max(1, Number(event.target.value) || 1))} />
          <input type="range" min={1} max={state.feetPerCell * 8} step={1} value={across} aria-label="Marker size" onChange={event => setAcross(Number(event.target.value))} />
        </div>
      </Field>
      <Field label="Label"><Input value={state.activeMarkerLabel} placeholder="Optional text on the map" onChange={event => prop('activeMarkerLabel', event.target.value)} /></Field>
      <Switch checked={state.activeMarkerFilled} onChange={value => prop('activeMarkerFilled', value)} label="Filled shape" />
      <Field label={`Opacity — ${Math.round(state.activeMarkerOpacity * 100)}%`}>
        <input type="range" min={0.1} max={1} step={0.05} value={state.activeMarkerOpacity} aria-label="Marker opacity" onChange={event => prop('activeMarkerOpacity', Number(event.target.value))} />
      </Field>
      </PanelSection>

      <PanelSection title="On the map" count={state.markers.length}>
      {state.markers.length === 0 && <EmptyState icon="map-pin" title="No markers">Mark a trap, a secret door or a place worth remembering. Markers start visible to players.</EmptyState>}
      <div className="rows">
        {state.markers.map(marker => {
          const type = MARKER_TYPES.find(item => item.value === marker.type);
          return (
            <div key={marker.id} className={`row is-clickable effect-row${state.selectedId === marker.id ? ' is-selected' : ''}`} onClick={() => dispatch({ type: 'SELECT', id: marker.id })}>
              <span className="effect-dot" style={{ '--c': marker.color }}>{type?.icon}</span>
              <div className="row__main"><span className="row__title">{marker.label || type?.label}</span><span className="row__meta">{roundFt(marker.size * 2, state.gridSize, state.feetPerCell)} ft</span></div>
              <div className="row__actions" onClick={event => event.stopPropagation()}>
                <IconButton icon={marker.visibleToPlayers ? 'eye' : 'eye-off'} size="sm" variant={marker.visibleToPlayers ? 'ghost' : 'danger'}
                  label={marker.visibleToPlayers ? 'Visible to players — click to hide' : 'Hidden — click to reveal'} onClick={() => dispatch({ type: 'MARKER_TOGGLE_VISIBLE', id: marker.id })} />
                <IconButton icon="trash" size="sm" label="Delete marker" onClick={() => dispatch({ type: 'MARKER_DELETE', id: marker.id })} />
              </div>
            </div>
          );
        })}
      </div>
      </PanelSection>
    </div>
  );
}
